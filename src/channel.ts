/**
 * Per-channel state machine.
 *
 * Owns:
 *   - the tmux session running `claude`
 *   - the jsonl tail for that session
 *   - the in-memory queue + busy state
 *
 * Emits outbound events via callbacks; platform connectors implement them.
 */
import { homedir } from "os";
import { join } from "path";
import { buildClaudeArgs, type SecurityConfig } from "./compose";
import { drainInbox, formatInboxForPrompt } from "./inbox";
import { type JsonlEvent, tailJsonl, type TailHandle } from "./jsonl";
import { type ChannelSession } from "./sessions";
import {
  capturePane,
  hasSession,
  killSession,
  newSession,
  pasteText,
  pressEnter,
  pressEscape,
  sendKeys,
} from "./tmux";
import { waitForReady, type InitWatchResult } from "./init-watch";

export type ChannelState = "spawning" | "idle" | "running" | "interrupting";

/**
 * Where outbound replies for this turn should go. Each inbound message
 * carries one — the channel remembers the most recent inbound's target
 * and applies it to every outbound emitted during the resulting turn.
 *
 * `null` is valid for cron-driven turns with no defined sink — the daemon
 * is expected to log such outputs but not post anywhere.
 */
export type ReplyTarget =
  | { platform: "telegram"; chatId: number }
  | { platform: "discord"; channelId: string }
  | null;

export interface ChannelCallbacks {
  /** Post a finished assistant text segment to the platform. */
  onAssistantText(text: string, replyTo: ReplyTarget): Promise<void> | void;
  /** Post a tool-call status indicator (e.g. "🛠 Bash: echo hi"). */
  onToolUse(toolName: string, input: unknown, replyTo: ReplyTarget): Promise<void> | void;
  /** Optional: invoked when the channel becomes idle after a turn ends. */
  onTurnEnd?(): Promise<void> | void;
  /** Optional: surface init failures. */
  onError?(err: Error): void;
}

export interface QueueItem {
  text: string;
  /** Display label for the sender, used in multi-party prompts. */
  fromLabel?: string;
  /** Platform message id (so the connector can reply-to or edit). */
  platformMsgId?: string;
  /** Where to send outbound responses for this message. */
  replyTo: ReplyTarget;
}

export interface ChannelOptions {
  session: ChannelSession;
  security: SecurityConfig;
  projectDir: string;
  callbacks: ChannelCallbacks;
  /** Auto-interrupt the running turn when a new message arrives. Default false. */
  autoInterrupt?: boolean;
  /** How long to wait after Esc before forcing state=idle. Default 5_000. */
  interruptSettleMs?: number;
}

function encodeProjectDir(projectDir: string): string {
  return projectDir.replace(/\//g, "-");
}

function jsonlPathFor(sessionId: string, projectDir: string): string {
  const encoded = encodeProjectDir(projectDir);
  return join(homedir(), ".claude", "projects", encoded, `${sessionId}.jsonl`);
}

/**
 * POSIX shell single-quote escape. Wraps arbitrary text so it survives a
 * trip through the shell tmux is typing into (sh/bash/zsh all accept this).
 */
function shellQuote(s: string): string {
  if (s === "") return "''";
  if (/^[A-Za-z0-9_\-./=:,@%+]+$/.test(s)) return s;
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

export class Channel {
  private state: ChannelState = "spawning";
  private queue: QueueItem[] = [];
  private tailer: TailHandle | null = null;
  private interruptTimer: ReturnType<typeof setTimeout> | null = null;
  /** Reply target for the in-flight turn. Stays put until next paste. */
  private currentTurnReplyTo: ReplyTarget = null;

  constructor(private readonly opts: ChannelOptions) {}

  get currentState(): ChannelState {
    return this.state;
  }

  get tmuxSession(): string {
    return this.opts.session.tmuxSession;
  }

  /**
   * Spawn or resume the agent. Always idempotent — if the tmux session is
   * already alive, this only re-attaches the jsonl tail.
   */
  async start(opts: { resume: boolean }): Promise<void> {
    const { session, security, projectDir } = this.opts;
    const target = session.tmuxSession;

    const alreadyAlive = await hasSession(target);
    if (!alreadyAlive) {
      await newSession(target, {
        cwd: projectDir,
        width: 200,
        height: 50,
      });
      const args = await buildClaudeArgs({
        sessionId: session.sessionId,
        resume: opts.resume,
        multiparty: session.multiparty,
        security,
        projectDir,
      });
      const cmdLine = args.map(shellQuote).join(" ");
      await sendKeys(target, cmdLine);
      await new Promise((r) => setTimeout(r, 100));
      await pressEnter(target);
    }

    this.startTailing();

    const result = await waitForReady({ target });
    if (result.status !== "ready") {
      this.handleInitFailure(result);
      return;
    }
    this.state = "idle";
    void this.drainQueue();
  }

  private handleInitFailure(result: InitWatchResult): void {
    const reason =
      result.status === "timeout"
        ? `init-watch timed out`
        : `init-watch failed: ${(result as any).reason ?? "unknown"}`;
    const err = new Error(`[channel ${this.opts.session.channelKey}] ${reason}`);
    console.error(err.message);
    console.error("--- last pane snapshot ---");
    console.error(result.pane.slice(-1500));
    console.error("--- end pane ---");
    this.opts.callbacks.onError?.(err);
  }

  private startTailing(): void {
    if (this.tailer) return;
    const path = jsonlPathFor(this.opts.session.sessionId, this.opts.projectDir);
    this.tailer = tailJsonl(path, (ev) => this.onJsonlEvent(ev));
  }

  private async onJsonlEvent(ev: JsonlEvent): Promise<void> {
    try {
      switch (ev.type) {
        case "assistant-text":
          if (ev.text && ev.text.trim()) {
            await this.opts.callbacks.onAssistantText(ev.text, this.currentTurnReplyTo);
          }
          break;
        case "assistant-tool-use":
          if (ev.toolName) {
            await this.opts.callbacks.onToolUse(ev.toolName, ev.toolInput, this.currentTurnReplyTo);
          }
          break;
        case "turn-end":
          this.onTurnEnd();
          break;
        // Skipped: assistant-thinking, user-tool-result, user-message, system, unknown
      }
    } catch (err) {
      console.error(`[channel ${this.opts.session.channelKey}] event handler error:`, err);
    }
  }

  private onTurnEnd(): void {
    if (this.interruptTimer) {
      clearTimeout(this.interruptTimer);
      this.interruptTimer = null;
    }
    this.state = "idle";
    void this.opts.callbacks.onTurnEnd?.();
    void this.drainQueue();
  }

  /** Inbound message from the platform connector. */
  async handleIncoming(item: QueueItem): Promise<void> {
    if (this.state === "idle") {
      await this.paste(item);
      return;
    }
    // spawning, running, interrupting → queue
    this.queue.push(item);
    if (this.state === "running" && this.opts.autoInterrupt) {
      await this.beginInterrupt(/*keepQueue*/ true);
    }
  }

  /** User-initiated /stop. */
  async userStop(): Promise<void> {
    if (this.state !== "running") return;
    this.queue = [];
    await this.beginInterrupt(/*keepQueue*/ false);
  }

  private async beginInterrupt(keepQueue: boolean): Promise<void> {
    this.state = "interrupting";
    try {
      await pressEscape(this.opts.session.tmuxSession);
    } catch (err) {
      console.error(`[channel ${this.opts.session.channelKey}] esc failed:`, err);
    }
    if (this.interruptTimer) clearTimeout(this.interruptTimer);
    const settleMs = this.opts.interruptSettleMs ?? 5_000;
    this.interruptTimer = setTimeout(() => {
      this.interruptTimer = null;
      if (this.state !== "interrupting") return;
      this.state = "idle";
      if (keepQueue) void this.drainQueue();
    }, settleMs);
  }

  private async drainQueue(): Promise<void> {
    if (this.state !== "idle") return;
    if (this.queue.length === 0) return;
    const merged = this.mergeQueue();
    this.queue = [];
    await this.paste(merged);
  }

  private mergeQueue(): QueueItem {
    if (this.queue.length === 1) return this.queue[0];
    const parts: string[] = [];
    for (const item of this.queue) {
      const head = item.fromLabel ? `[${item.fromLabel}] ` : "";
      parts.push(head + item.text);
    }
    const last = this.queue[this.queue.length - 1];
    return {
      text: parts.join("\n\n---\n\n"),
      platformMsgId: last?.platformMsgId,
      replyTo: last?.replyTo ?? null,
    };
  }

  private async paste(item: QueueItem): Promise<void> {
    const target = this.opts.session.tmuxSession;
    const inboxText = await this.buildInboxPrefix();
    const head = item.fromLabel ? `[${item.fromLabel}] ` : "";
    const full = [inboxText, head + item.text].filter(Boolean).join("\n\n");

    this.currentTurnReplyTo = item.replyTo;
    this.state = "running";
    try {
      await pasteText(target, full);
      await new Promise((r) => setTimeout(r, 80));
      await pressEnter(target);
    } catch (err) {
      console.error(`[channel ${this.opts.session.channelKey}] paste failed:`, err);
      this.opts.callbacks.onError?.(err as Error);
      this.state = "idle";
    }
  }

  private async buildInboxPrefix(): Promise<string> {
    const entries = await drainInbox(this.opts.session.channelKey);
    return formatInboxForPrompt(entries);
  }

  /** For debugging / status endpoints. */
  async capture(): Promise<string> {
    return capturePane(this.opts.session.tmuxSession);
  }

  /** Hard shutdown: kill tmux, stop tailer. Used on daemon stop. */
  async shutdown(): Promise<void> {
    this.tailer?.stop();
    this.tailer = null;
    if (this.interruptTimer) clearTimeout(this.interruptTimer);
    this.interruptTimer = null;
    try {
      await killSession(this.opts.session.tmuxSession);
    } catch {}
  }
}
