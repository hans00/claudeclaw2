/**
 * Per-channel inbox: cross-session activity that happened while a channel's
 * agent was busy or idle. The channel state machine drains these entries
 * before each paste so the resumed agent "sees" what happened.
 *
 * Storage: .claude/claudeclaw/inbox/<safeKey>.jsonl
 *   key = channelKey from sessions.ts (e.g. "telegram:116013788")
 *
 * Single-daemon assumption: appendFile + read+unlink is atomic enough.
 */
import { appendFile, mkdir, readFile, unlink } from "fs/promises";
import { join } from "path";

const INBOX_DIR = join(".claude", "claudeclaw", "inbox");
const MAX_ENTRIES_BEFORE_TRUNCATE = 50;
const MAX_TEXT_PREVIEW = 400;

export type InboxKind = "send" | "trigger-result" | "external";

export interface InboxEntry {
  ts: string;
  kind: InboxKind;
  /** Origin label, e.g. "telegram:116013788" or "(bridge)". */
  from?: string;
  text: string;
  /** Optional structured note (e.g. "target=discord:123"). */
  note?: string;
}

function safeKey(key: string): string {
  return key.replace(/[^a-zA-Z0-9._-]+/g, "_");
}

function filePath(key: string): string {
  return join(INBOX_DIR, `${safeKey(key)}.jsonl`);
}

export async function appendInbox(
  channelKey: string,
  entry: Omit<InboxEntry, "ts"> & { ts?: string },
): Promise<void> {
  await mkdir(INBOX_DIR, { recursive: true });
  const record: InboxEntry = {
    ts: entry.ts ?? new Date().toISOString(),
    kind: entry.kind,
    from: entry.from,
    text: entry.text,
    note: entry.note,
  };
  await appendFile(filePath(channelKey), JSON.stringify(record) + "\n", "utf8");
}

/** Read all entries for this key, delete the file, return parsed entries. */
export async function drainInbox(channelKey: string): Promise<InboxEntry[]> {
  let raw: string;
  try {
    raw = await readFile(filePath(channelKey), "utf8");
  } catch {
    return [];
  }
  try {
    await unlink(filePath(channelKey));
  } catch {}
  const entries: InboxEntry[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      entries.push(JSON.parse(trimmed) as InboxEntry);
    } catch {}
  }
  if (entries.length <= MAX_ENTRIES_BEFORE_TRUNCATE) return entries;
  const headCount = entries.length - MAX_ENTRIES_BEFORE_TRUNCATE;
  const tail = entries.slice(headCount);
  return [
    {
      ts: entries[0].ts,
      kind: "external",
      text: `[${headCount} earlier inbox entries omitted]`,
    },
    ...tail,
  ];
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + "…";
}

/** Format drained entries as a system-note block to prepend to the user prompt. */
export function formatInboxForPrompt(entries: InboxEntry[]): string {
  if (!entries.length) return "";
  const lines: string[] = [
    "[Activity on this channel since your last turn — including outgoing messages dispatched on your behalf via /api/send. Already-seen context.]",
  ];
  for (const e of entries) {
    const time = e.ts.length >= 16 ? e.ts.slice(11, 16) : e.ts;
    const from = e.from ? ` from ${e.from}` : "";
    const noteParens = e.note ? ` (${e.note})` : "";
    let label: string;
    switch (e.kind) {
      case "send":
        // Outgoing message dispatched via /api/send from this session's
        // POV — the note carries the target ("to=telegram:123" etc.) and
        // `from` carries the API caller's fromLabel.
        label = `you sent${noteParens}${from}`;
        break;
      case "trigger-result":
        label = `trigger response${from}${noteParens}`;
        break;
      case "external":
      default:
        label = `system${noteParens}`;
        break;
    }
    lines.push(`- ${time} — ${label}: ${truncate(e.text, MAX_TEXT_PREVIEW)}`);
  }
  lines.push("");
  lines.push(
    "Treat this as already-seen context. Do NOT re-post or echo it. Reference it only if relevant.",
  );
  return lines.join("\n");
}
