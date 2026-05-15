/**
 * Tail and parse a Claude Code session jsonl file.
 *
 * Claude Code flushes entries in batches at logical boundaries (each tool_use
 * or end_turn), not per token. Each line is a complete, valid JSON object
 * (verified during the redesign spike — see docs/redesign.md appendix).
 *
 * We expose a typed event stream so the channel daemon can react to:
 *   - assistant-text       → post a message to the platform
 *   - assistant-tool-use   → post a tool-status indicator
 *   - turn-end             → release the busy state, drain queue
 * and skip everything else.
 */
import { watch, type FSWatcher } from "fs";
import { mkdir, open, stat } from "fs/promises";
import { dirname, basename } from "path";

export type JsonlEventType =
  | "user-message"
  | "user-tool-result"
  | "assistant-text"
  | "assistant-tool-use"
  | "assistant-thinking"
  | "turn-end"
  | "system"
  | "unknown";

export interface JsonlEvent {
  type: JsonlEventType;
  /** The raw JSON object from the line (for callers that need fields we don't surface). */
  raw: any;
  /** message.id when present — groups segments of a single assistant message. */
  msgId?: string;
  /** entry-level uuid (unique per jsonl line). */
  uuid?: string;
  timestamp?: string;
  stopReason?: string;

  // type-specific payload
  text?: string;
  toolName?: string;
  toolInput?: unknown;
  toolUseId?: string;
  toolResult?: string;
  toolResultIsError?: boolean;
  userText?: string;
}

/**
 * Parse one jsonl line into zero or more events.
 *
 * One line typically yields a single event, but assistant `content` arrays
 * with multiple items (text + tool_use in one message) produce multiple
 * events. End-of-turn is detected by the line's stop_reason and emitted
 * as a synthetic "turn-end" event after the content events.
 */
export function parseLine(line: string): JsonlEvent[] {
  const trimmed = line.trim();
  if (!trimmed) return [];
  let raw: any;
  try {
    raw = JSON.parse(trimmed);
  } catch {
    return [{ type: "unknown", raw: { rawLine: line } }];
  }

  const type = raw.type;
  const uuid = typeof raw.uuid === "string" ? raw.uuid : undefined;
  const timestamp = typeof raw.timestamp === "string" ? raw.timestamp : undefined;
  const msg = raw.message;
  const events: JsonlEvent[] = [];

  if (type === "assistant" && msg && typeof msg === "object") {
    const msgId: string | undefined = typeof msg.id === "string" ? msg.id : undefined;
    const stopReason: string | undefined = typeof msg.stop_reason === "string" ? msg.stop_reason : undefined;
    const content = Array.isArray(msg.content) ? msg.content : [];
    for (const item of content) {
      if (!item || typeof item !== "object") continue;
      const itemType = item.type;
      if (itemType === "text" && typeof item.text === "string") {
        events.push({
          type: "assistant-text",
          raw, msgId, uuid, timestamp, stopReason,
          text: item.text,
        });
      } else if (itemType === "tool_use") {
        events.push({
          type: "assistant-tool-use",
          raw, msgId, uuid, timestamp, stopReason,
          toolName: typeof item.name === "string" ? item.name : undefined,
          toolInput: item.input,
          toolUseId: typeof item.id === "string" ? item.id : undefined,
        });
      } else if (itemType === "thinking") {
        const thinkingText = typeof item.thinking === "string" ? item.thinking : "";
        events.push({
          type: "assistant-thinking",
          raw, msgId, uuid, timestamp, stopReason,
          text: thinkingText,
        });
      }
    }
    if (stopReason === "end_turn") {
      events.push({ type: "turn-end", raw, msgId, uuid, timestamp, stopReason });
    }
    return events;
  }

  if (type === "user" && msg && typeof msg === "object") {
    const content = msg.content;
    if (typeof content === "string") {
      events.push({ type: "user-message", raw, uuid, timestamp, userText: content });
      return events;
    }
    if (Array.isArray(content)) {
      for (const item of content) {
        if (!item || typeof item !== "object") continue;
        if (item.type === "tool_result") {
          let resultText = "";
          if (typeof item.content === "string") {
            resultText = item.content;
          } else if (Array.isArray(item.content)) {
            resultText = item.content
              .map((c: any) => (c && typeof c.text === "string" ? c.text : ""))
              .join("");
          }
          events.push({
            type: "user-tool-result",
            raw, uuid, timestamp,
            toolUseId: typeof item.tool_use_id === "string" ? item.tool_use_id : undefined,
            toolResult: resultText,
            toolResultIsError: item.is_error === true,
          });
        } else if (item.type === "text" && typeof item.text === "string") {
          events.push({ type: "user-message", raw, uuid, timestamp, userText: item.text });
        }
      }
      return events;
    }
  }

  // ai-title, file-history-snapshot, permission-mode, last-prompt, attachment, system, ...
  events.push({ type: "system", raw, uuid, timestamp });
  return events;
}

export interface TailHandle {
  /** Stop tailing. Idempotent. */
  stop(): void;
  /** Resolves when initial file-exists wait completes (or the file already existed). */
  ready: Promise<void>;
}

export interface TailOptions {
  /** Emit events for content already in the file before tail starts. Default false. */
  fromStart?: boolean;
  /** Max ms to wait for the file to be created. Default 30_000. */
  waitForCreateMs?: number;
}

/**
 * Tail a jsonl file. If the file doesn't exist yet, wait (watching the parent
 * directory) until it appears, then start tailing.
 *
 * Emits events in order. Partial lines (file not yet fully written) are
 * buffered until a newline arrives.
 */
export function tailJsonl(
  path: string,
  onEvent: (event: JsonlEvent) => void | Promise<void>,
  opts: TailOptions = {},
): TailHandle {
  let stopped = false;
  let fileWatcher: FSWatcher | null = null;
  let dirWatcher: FSWatcher | null = null;
  let position = 0;
  let buffer = "";
  let readChain = Promise.resolve();

  const handle: TailHandle = {
    stop() {
      stopped = true;
      fileWatcher?.close();
      dirWatcher?.close();
      fileWatcher = null;
      dirWatcher = null;
    },
    ready: Promise.resolve(),
  };

  async function readNewBytes(): Promise<void> {
    if (stopped) return;
    let fh: Awaited<ReturnType<typeof open>> | null = null;
    try {
      const s = await stat(path).catch(() => null);
      if (!s) return;
      if (s.size < position) {
        // File got truncated — reset and re-read everything (rare; defensive).
        position = 0;
        buffer = "";
      }
      if (s.size === position) return;
      fh = await open(path, "r");
      const length = s.size - position;
      const buf = Buffer.alloc(length);
      const { bytesRead } = await fh.read(buf, 0, length, position);
      position += bytesRead;
      buffer += buf.subarray(0, bytesRead).toString("utf8");

      let nl = buffer.indexOf("\n");
      while (nl !== -1) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        const events = parseLine(line);
        for (const ev of events) {
          if (stopped) return;
          try {
            await onEvent(ev);
          } catch (err) {
            console.error(`[jsonl] onEvent error for ${basename(path)}:`, err);
          }
        }
        nl = buffer.indexOf("\n");
      }
    } finally {
      await fh?.close().catch(() => {});
    }
  }

  function scheduleRead(): void {
    readChain = readChain.then(() => readNewBytes()).catch((err) => {
      console.error(`[jsonl] read error for ${basename(path)}:`, err);
    });
  }

  function startFileWatch(): void {
    if (stopped) return;
    try {
      fileWatcher = watch(path, (eventType) => {
        if (stopped) return;
        if (eventType === "change" || eventType === "rename") scheduleRead();
      });
    } catch (err) {
      console.error(`[jsonl] failed to watch ${path}:`, err);
    }
    // Always do an initial read in case content arrived before the watcher attached.
    scheduleRead();
  }

  async function init(): Promise<void> {
    const existing = await stat(path).catch(() => null);
    if (existing) {
      position = opts.fromStart ? 0 : existing.size;
      startFileWatch();
      return;
    }
    // Wait for file creation by watching parent dir.
    const parent = dirname(path);
    const target = basename(path);
    const deadline = Date.now() + (opts.waitForCreateMs ?? 30_000);
    // Claude Code creates this dir on first write — pre-create so fs.watch
    // has something to attach to. Safe: claude is happy with a pre-existing dir.
    await mkdir(parent, { recursive: true }).catch(() => {});

    await new Promise<void>((resolve) => {
      const tryStart = async () => {
        if (stopped) {
          resolve();
          return;
        }
        const s = await stat(path).catch(() => null);
        if (s) {
          dirWatcher?.close();
          dirWatcher = null;
          position = opts.fromStart ? 0 : s.size;
          startFileWatch();
          resolve();
        }
      };

      try {
        dirWatcher = watch(parent, (_eventType, filename) => {
          // macOS FSEvents may deliver events with filename=null; in that
          // case fall through and let tryStart() do the stat check anyway.
          if (!filename || filename === target) void tryStart();
        });
      } catch (err) {
        console.error(`[jsonl] failed to watch parent ${parent}:`, err);
      }

      // Polling backstop in case fs.watch misses the creation.
      const poll = setInterval(() => {
        if (stopped || Date.now() > deadline) {
          clearInterval(poll);
          dirWatcher?.close();
          dirWatcher = null;
          resolve();
          return;
        }
        void tryStart().then(() => {
          if (fileWatcher) clearInterval(poll);
        });
      }, 500);
    });
  }

  handle.ready = init();
  return handle;
}
