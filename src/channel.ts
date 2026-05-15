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
import type { AgenticConfig } from "./config";
import { buildClaudeArgs, type SecurityConfig } from "./compose";
import { drainInbox, formatInboxForPrompt } from "./inbox";
import { type JsonlEvent, tailJsonl, type TailHandle } from "./jsonl";
import { selectModel } from "./model-router";
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
  | { platform: "telegram"; chatId: number; messageId?: number }
  | { platform: "discord"; channelId: string; messageId?: string }
  | { platform: "slack"; channelId: string; threadTs?: string; messageTs?: string }
  | { platform: "line"; to: string; messageId?: string }
  | null;

export interface ChannelCallbacks {
  /** Post a finished assistant text segment to the platform. */
  onAssistantText(text: string, replyTo: ReplyTarget): Promise<void> | void;
  /** Post a tool-call status indicator (e.g. "🛠 Bash: echo hi"). */
  onToolUse(toolName: string, input: unknown, replyTo: ReplyTarget): Promise<void> | void;
  /** Optional: invoked when the channel becomes idle after a turn ends. */
  onTurnEnd?(): Promise<void> | void;
  /** Optional: fire a platform "typing…" indicator. Called repeatedly while
   *  the channel is mid-turn (most platforms time out their indicator after
   *  ~5–10s, so this gets retriggered until the turn ends). */
  onTyping?(replyTo: ReplyTarget): Promise<void> | void;
  /** Optional: surface init failures. */
  onError?(err: Error): void;
}

/** Resend a typing indicator every N ms while the channel is mid-turn.
 *  Telegram's chat-action expires after 5s, Discord's after ~10s. */
const TYPING_PULSE_MS = 4000;

export interface SourceInfo {
  platform: "telegram" | "discord" | "slack" | "line";
  /** Display name (first+last, global_name, etc). */
  name: string;
  /** Platform-native username when available (@-handle without the @). */
  username?: string;
  /** Platform-native id (numeric for telegram, snowflake for discord, U... for slack/line). */
  id: string;
}

export interface QueueItem {
  text: string;
  /** Display label used when there's no structured `source` (cron, heartbeat, api). */
  fromLabel?: string;
  /** Platform message id (so the connector can reply-to or edit). */
  platformMsgId?: string;
  /** Where to send outbound responses for this message. */
  replyTo: ReplyTarget;
  /** Structured sender info for platform inbounds — used to render the prompt prefix. */
  source?: SourceInfo;
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
  /** Default model — passed via --model at spawn. Empty = Claude Code default. */
  defaultModel?: string;
  /** Per-turn agentic routing config. When enabled, paste() classifies the
   *  prompt and sends /model &lt;name&gt; via tmux if the routed model differs
   *  from the channel's currentModel. */
  agentic?: AgenticConfig;
  /** Timezone offset in minutes (e.g. +480 for UTC+8). Used to render the
   *  timestamp line on the prompt prefix. */
  timezoneOffsetMinutes?: number;
}

function encodeProjectDir(projectDir: string): string {
  return projectDir.replace(/\//g, "-");
}

function jsonlPathFor(sessionId: string, projectDir: string): string {
  const encoded = encodeProjectDir(projectDir);
  return join(homedir(), ".claude", "projects", encoded, `${sessionId}.jsonl`);
}

/**
 * Classify an internal user-role jsonl entry that Claude Code wrote on
 * the user's behalf (slash command output, model-switch echo, etc).
 *
 *   `## Context Usage …`                                → context-report (forward)
 *   `<local-command-stdout>Set model to …</…>`           → model-switch (swallow or end-turn)
 *   `<local-command-stdout>…</…>` (anything else)        → command-stdout (forward inner)
 *   anything else (our own paste, <command-name>, etc.)  → none
 */
type InternalClassification =
  | { kind: "context-report"; forward: string }
  | { kind: "command-stdout"; forward: string | null }
  | { kind: "model-switch" }
  | { kind: "none" };

function classifyInternalOutput(text: string): InternalClassification {
  const t = text.trimStart();
  if (t.startsWith("## Context Usage")) {
    return { kind: "context-report", forward: t };
  }
  const wrapped = t.match(/^<local-command-stdout>([\s\S]*?)<\/local-command-stdout>\s*$/);
  if (wrapped) {
    const inner = stripAnsi(wrapped[1]).trim();
    if (/^set model to\b/i.test(inner)) {
      return { kind: "model-switch" };
    }
    return { kind: "command-stdout", forward: inner || null };
  }
  return { kind: "none" };
}

/** Strip ANSI SGR escape sequences (color/bold/etc) from a string. */
function stripAnsi(s: string): string {
  return s
    .replace(/\u001b\[[0-9;]*[A-Za-z]/g, "")
    .replace(/\[[0-9;]+m/g, "");
}

function renderSourceLine(item: QueueItem): string {
  if (item.source) {
    const s = item.source;
    const platform = s.platform.charAt(0).toUpperCase() + s.platform.slice(1);
    const ident: string[] = [];
    if (s.username) ident.push(`@${s.username}`);
    ident.push(s.id);
    return `[${platform} from ${s.name} (${ident.join(" · ")})]`;
  }
  if (item.fromLabel) return `[${item.fromLabel}]`;
  return `[anonymous]`;
}

function formatUtcOffset(offsetMinutes: number): string {
  if (offsetMinutes === 0) return "UTC";
  const sign = offsetMinutes > 0 ? "+" : "-";
  const abs = Math.abs(offsetMinutes);
  const h = Math.floor(abs / 60);
  const m = abs % 60;
  return m === 0 ? `UTC${sign}${h}` : `UTC${sign}${h}:${String(m).padStart(2, "0")}`;
}

function formatTimestamp(d: Date, offsetMinutes: number): string {
  const shifted = new Date(d.getTime() + offsetMinutes * 60_000);
  const pad = (n: number) => String(n).padStart(2, "0");
  const y = shifted.getUTCFullYear();
  const mo = pad(shifted.getUTCMonth() + 1);
  const da = pad(shifted.getUTCDate());
  const h = pad(shifted.getUTCHours());
  const mi = pad(shifted.getUTCMinutes());
  const s = pad(shifted.getUTCSeconds());
  return `${y}-${mo}-${da} ${h}:${mi}:${s} ${formatUtcOffset(offsetMinutes)}`;
}

/**
 * Detect a single-line slash command. Matches `/name`, `/name arg arg`,
 * `/name:sub`, `/skill-foo` — anything that's a single line starting with
 * `/<letter>` followed by an identifier-ish run.
 *
 * Rejects paths like `/etc/foo` (slash inside the identifier) and
 * multi-line messages that just happen to start with `/`.
 */
export function isPassthroughSlashCommand(text: string): boolean {
  const t = text.trim();
  if (!t || t.includes("\n")) return false;
  return /^\/[a-zA-Z][\w:-]*(\s+\S.*?)?$/.test(t);
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
  private typingTimer: ReturnType<typeof setInterval> | null = null;
  /** Reply target for the in-flight turn. Stays put until next paste. */
  private currentTurnReplyTo: ReplyTarget = null;
  /** The model the running `claude` process believes it's using. Updated on
   *  spawn and after each /model switch. */
  private currentModel: string = "";
  /** True while we're waiting for the jsonl echo from a daemon-initiated
   *  `/model` switch. The corresponding `Set model to …` entry should NOT
   *  end the current turn — the user's actual prompt is what we're waiting on. */
  private expectingModelEcho: boolean = false;

  constructor(private readonly opts: ChannelOptions) {
    this.currentModel = opts.defaultModel ?? "";
  }

  get currentState(): ChannelState {
    return this.state;
  }

  get tmuxSession(): string {
    return this.opts.session.tmuxSession;
  }

  get session(): ChannelSession {
    return this.opts.session;
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
        model: this.opts.defaultModel,
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
        case "user-message": {
          if (!ev.userText) break;
          const cls = classifyInternalOutput(ev.userText);
          if (cls.kind === "model-switch") {
            // /model switch echo: swallow when daemon initiated it (mid-turn,
            // the agent's response is still coming); treat as a turn boundary
            // when the user typed /model themselves and nothing else follows.
            if (this.expectingModelEcho) {
              this.expectingModelEcho = false;
            } else {
              this.onTurnEnd();
            }
            break;
          }
          if (cls.kind === "context-report" || cls.kind === "command-stdout") {
            // User-initiated slash command output. Forward to platform and
            // synthesize a turn-end — these don't emit assistant end_turn.
            if (cls.forward) {
              await this.opts.callbacks.onAssistantText(cls.forward, this.currentTurnReplyTo);
            }
            this.onTurnEnd();
          }
          break;
        }
        case "turn-end":
          this.onTurnEnd();
          break;
        // Skipped: assistant-thinking, user-tool-result, system, unknown
      }
    } catch (err) {
      console.error(`[channel ${this.opts.session.channelKey}] event handler error:`, err);
    }
  }

  private startTypingPulse(): void {
    if (this.typingTimer) return;
    const fire = () => {
      const target = this.currentTurnReplyTo;
      if (!target) return;
      if (this.state !== "running" && this.state !== "interrupting") return;
      void this.opts.callbacks.onTyping?.(target);
    };
    fire();
    this.typingTimer = setInterval(fire, TYPING_PULSE_MS);
  }

  private stopTypingPulse(): void {
    if (this.typingTimer) clearInterval(this.typingTimer);
    this.typingTimer = null;
  }

  private onTurnEnd(): void {
    if (this.interruptTimer) {
      clearTimeout(this.interruptTimer);
      this.interruptTimer = null;
    }
    this.stopTypingPulse();
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
    this.currentTurnReplyTo = item.replyTo;
    this.state = "running";

    // Slash commands (Claude Code built-ins, skills, etc) must reach the
    // input box CLEAN — any "[fromLabel] " prefix or inbox preamble would
    // turn them into ordinary text that claude routes to the model instead
    // of intercepting client-side.
    if (isPassthroughSlashCommand(item.text)) {
      this.startTypingPulse();
      try {
        await pasteText(target, item.text.trim());
        await new Promise((r) => setTimeout(r, 80));
        await pressEnter(target);
      } catch (err) {
        console.error(`[channel ${this.opts.session.channelKey}] slash paste failed:`, err);
        this.opts.callbacks.onError?.(err as Error);
        this.stopTypingPulse();
        this.state = "idle";
      }
      return;
    }

    const inboxText = await this.buildInboxPrefix();
    const promptBody = this.formatPromptBody(item);
    const full = [inboxText, promptBody].filter(Boolean).join("\n\n");

    this.startTypingPulse();
    try {
      await this.maybeSwitchModel(item.text);
      await pasteText(target, full);
      await new Promise((r) => setTimeout(r, 80));
      await pressEnter(target);
    } catch (err) {
      console.error(`[channel ${this.opts.session.channelKey}] paste failed:`, err);
      this.opts.callbacks.onError?.(err as Error);
      this.stopTypingPulse();
      this.state = "idle";
    }
  }

  /**
   * Render the prompt body the agent sees. Format (v1 parity):
   *
   *   [2026-05-15 14:32:17 UTC+8]
   *   [Telegram from Hans (@HansX · 116013788)]
   *   Message: <user text>
   *
   * For non-platform sources (cron, heartbeat, api) the second line falls
   * back to the fromLabel, with no @username/id triplet.
   */
  private formatPromptBody(item: QueueItem): string {
    const tz = this.opts.timezoneOffsetMinutes ?? 0;
    const stamp = formatTimestamp(new Date(), tz);
    const sourceLine = renderSourceLine(item);
    return `[${stamp}]\n${sourceLine}\nMessage: ${item.text}`;
  }

  /**
   * If agentic routing is enabled, classify the next prompt and send
   * `/model <name>` to the tmux session when the routed model differs
   * from what the channel last left the session on. The slash command
   * is processed client-side by Claude Code, so a short wait is enough.
   */
  private async maybeSwitchModel(promptText: string): Promise<void> {
    const agentic = this.opts.agentic;
    if (!agentic || !agentic.enabled || agentic.modes.length === 0) return;
    const routed = selectModel(promptText, agentic.modes, agentic.defaultMode);
    if (!routed.model) return;
    if (routed.model === this.currentModel) return;

    const target = this.opts.session.tmuxSession;
    console.log(
      `[channel ${this.opts.session.channelKey}] /model ${routed.model} ` +
        `(was ${this.currentModel || "(default)"}, ${routed.reasoning})`,
    );
    try {
      // Mark the next "Set model to …" jsonl echo as ours so it doesn't
      // get treated as a turn boundary or forwarded to the platform.
      this.expectingModelEcho = true;
      await sendKeys(target, `/model ${routed.model}`);
      await new Promise((r) => setTimeout(r, 80));
      await pressEnter(target);
      await new Promise((r) => setTimeout(r, 300));
      this.currentModel = routed.model;
    } catch (err) {
      this.expectingModelEcho = false;
      console.error(`[channel ${this.opts.session.channelKey}] /model send failed:`, err);
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
    this.stopTypingPulse();
    try {
      await killSession(this.opts.session.tmuxSession);
    } catch {}
  }
}
