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
import { mkdir, writeFile } from "fs/promises";
import { homedir } from "os";
import { join } from "path";
import type { AgenticConfig, QueueConfig } from "./config";
import { parseModelPicker, parsePermissionDialog, type ModelPickerOption, type PermissionDialog } from "./approval";
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
  /** Post a finished assistant text segment to the platform. `claudeMsgId`
   *  is Claude Code's stable id for this assistant "bubble" — segments that
   *  share the same id should be edited-in-place when the platform supports
   *  it; a different id means a new bubble (e.g. after a tool result).
   *  `stopReason` lets the receiver tell intermediate text (more tools coming)
   *  apart from the actual final answer (`end_turn`). */
  onAssistantText(text: string, replyTo: ReplyTarget, claudeMsgId?: string, stopReason?: string): Promise<void> | void;
  /** Post a tool-call status indicator (e.g. "🛠 Bash: echo hi"). */
  onToolUse(toolName: string, input: unknown, replyTo: ReplyTarget): Promise<void> | void;
  /** Append a tool execution result preview under the current tool bubble.
   *  Skipped when there's no active tool bubble. */
  onToolResult?(toolUseId: string | undefined, result: string, replyTo: ReplyTarget): Promise<void> | void;
  /** Post / extend a reasoning ("thinking") bubble for the agent's
   *  visible deliberation before tool calls or the final answer. */
  onReasoning?(text: string, replyTo: ReplyTarget, claudeMsgId?: string): Promise<void> | void;
  /** Optional: invoked when the channel becomes idle after a turn ends. */
  onTurnEnd?(): Promise<void> | void;
  /** Optional: fire a platform "typing…" indicator. Called repeatedly while
   *  the channel is mid-turn (most platforms time out their indicator after
   *  ~5–10s, so this gets retriggered until the turn ends). */
  onTyping?(replyTo: ReplyTarget): Promise<void> | void;
  /** Optional: surface init failures. */
  onError?(err: Error): void;
  /** Optional: a Claude Code permission dialog is visible in the pane.
   *  Daemon should route to the trusted approver and reply via `selectOption`
   *  (1-indexed) or `cancel()` (Esc). */
  onApprovalNeeded?(
    dialog: PermissionDialog,
    replyTo: ReplyTarget,
    api: ApprovalApi,
  ): Promise<void> | void;
}

export interface ApprovalApi {
  /** Send the (1-indexed) option choice into the tmux session. */
  selectOption(index: number): Promise<void>;
  /** Cancel the dialog (Esc). */
  cancel(): Promise<void>;
}

/** Poll the pane this often while the channel is running, looking for
 *  a permission dialog blocking the agent. */
const APPROVAL_POLL_MS = 1500;

/** Resend a typing indicator every N ms while the channel is mid-turn.
 *  Telegram's chat-action expires after 5s, Discord's after ~10s. */
const TYPING_PULSE_MS = 4000;

/** Synthesise turn-end this long after a passthrough slash command if no
 *  jsonl event came in — covers UI-only commands like `/reload-plugins`. */
const SLASH_IDLE_TIMEOUT_MS = 2000;

/** Wait this long after the user picks a model-switch dialog option (or
 *  cancels) before synthesising turn-end. Long enough for the optional
 *  `Set model to ...` jsonl echo to land if "Yes" was picked; short enough
 *  that "Cancel" doesn't leave the channel stuck. */
const MODEL_SWITCH_DIALOG_SETTLE_MS = 1500;

/** How long with no jsonl activity before the stall watchdog fires. */
const STALL_TIMEOUT_MS = 120_000;
/** Absolute maximum stall time before forcing recovery regardless of pane state. */
const STALL_MAX_MS = 600_000;
/** How long to wait for the /model echo before giving up and proceeding. */
const MODEL_ECHO_TIMEOUT_MS = 3_000;

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
  /** Paste text verbatim, skipping the `[ts][source]\nMessage:` wrapper.
   *  Used for cron + heartbeat firings to match v1 behaviour. */
  rawPrompt?: boolean;
  /**
   * Skip agentic model routing for this item. Used for scheduled prompts
   * (heartbeat, cron, daemon restart notice) — these are meta/system prompts
   * whose classification is unstable (heartbeat is always "ambiguous", cron
   * bodies look planning-ish on phrasing but should inherit the channel's
   * current mode). Without this, scheduled prompts cause repeated cache-
   * busting model swaps with no user intent behind them.
   */
  skipModelRouting?: boolean;
  /** When this item entered the queue. Set automatically by handleIncoming(). */
  receivedAt?: Date;
}

export interface ChannelOptions {
  session: ChannelSession;
  security: SecurityConfig;
  projectDir: string;
  callbacks: ChannelCallbacks;
  /** Busy-channel queue behaviour (mode, debounce, cap, drop). */
  queue?: QueueConfig;
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
  /** Timestamps of the last enqueue, for debounce calculation. */
  private lastEnqueuedAt = 0;
  /** Summary lines for messages that overflowed the cap (for drop policy "summarize"). */
  private droppedSummaries: string[] = [];
  /** Count of messages dropped due to cap overflow. */
  private droppedCount = 0;
  private tailer: TailHandle | null = null;
  private interruptTimer: ReturnType<typeof setTimeout> | null = null;
  private typingTimer: ReturnType<typeof setInterval> | null = null;
  private approvalTimer: ReturnType<typeof setInterval> | null = null;
  private stallTimer: ReturnType<typeof setTimeout> | null = null;
  private stallStartTime: number | null = null;
  /** Resolved by onJsonlEvent when the /model echo arrives. */
  private modelEchoResolve: (() => void) | null = null;
  /**
   * Fallback timer for passthrough slash commands. Some Claude Code slash
   * commands (`/reload-plugins`, `/help`, `/clear`, …) are UI-only and never
   * touch the conversation jsonl — without a synthetic end-turn the channel
   * would stay stuck in "running" forever. Cleared the moment any real jsonl
   * event arrives, since those commands that DO emit jsonl take care of the
   * turn-end themselves via the classifier path.
   */
  private slashIdleTimer: ReturnType<typeof setTimeout> | null = null;
  /** Fingerprint of the dialog we last raised an approval for, so we don't
   *  spam the operator with duplicate prompts each poll. Cleared when the
   *  pane no longer shows a dialog OR the operator responded. */
  private activeApprovalFp: string | null = null;
  /** Reply target for the in-flight turn. Stays put until next paste. */
  private currentTurnReplyTo: ReplyTarget = null;
  /** The model the running `claude` process believes it's using. Updated on
   *  spawn and after each /model switch. */
  private currentModel: string = "";
  /** Which agentic mode name the channel is currently considered to be in.
   *  Mirrors `currentModel` but in router terms — used by the hysteresis
   *  margin check to compare new mode's keyword score against THIS mode's
   *  score in the same prompt, not just top-vs-second. */
  private currentMode: string = "";
  /** True while we're waiting for the jsonl echo from a daemon-initiated
   *  `/model` switch. The corresponding `Set model to …` entry should NOT
   *  end the current turn — the user's actual prompt is what we're waiting on. */
  private expectingModelEcho: boolean = false;
  /** Hysteresis state — see AgenticHysteresis docs. */
  private lastModelSwitchAtMs: number = 0;
  /** Counts user/manual turns (NOT scheduled). Used by stickyWindowTurns. */
  private userTurnCounter: number = 0;
  /** userTurnCounter snapshot at the last actual model switch. */
  private userTurnAtLastSwitch: number = 0;

  constructor(private readonly opts: ChannelOptions) {
    this.currentModel = opts.defaultModel ?? "";
  }

  get currentState(): ChannelState {
    return this.state;
  }

  /**
   * Hot-reload mutable runtime config. Snapshots of these are taken at
   * construction time; this updater lets the daemon push fresh values
   * after a settings.json reload without re-creating the channel.
   *
   * Fields baked into the tmux process (`security`, `defaultModel`,
   * `--append-system-prompt`) can't change without respawning the
   * underlying `claude` — those still require a restart.
   */
  updateRuntime(updates: { agentic?: AgenticConfig; timezoneOffsetMinutes?: number }): void {
    if (updates.agentic !== undefined) this.opts.agentic = updates.agentic;
    if (updates.timezoneOffsetMinutes !== undefined) {
      this.opts.timezoneOffsetMinutes = updates.timezoneOffsetMinutes;
    }
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
      // Any real jsonl event means the slash command did produce output —
      // cancel the UI-only-slash fallback so its normal handler (classifier
      // path or end_turn) takes care of the turn-end.
      this.clearSlashIdleTimer();
      // Any activity resets the stall watchdog.
      this.resetStallTimer();

      // Auto-wake detection: if we receive a fresh assistant event while
      // the channel is idle, the agent has triggered itself (ScheduleWakeup,
      // /loop self-pace, etc) without an inbound paste. Bump state so a
      // concurrent user message doesn't race ahead with its own paste.
      if (
        this.state === "idle" &&
        (ev.type === "assistant-text" ||
          ev.type === "assistant-tool-use" ||
          ev.type === "assistant-thinking")
      ) {
        this.state = "running";
        this.startTypingPulse();
      }

      switch (ev.type) {
        case "assistant-text":
          if (ev.text && ev.text.trim()) {
            await this.opts.callbacks.onAssistantText(
              ev.text,
              this.currentTurnReplyTo,
              ev.msgId,
              ev.stopReason,
            );
          }
          break;
        case "assistant-tool-use":
          if (ev.toolName) {
            await this.opts.callbacks.onToolUse(ev.toolName, ev.toolInput, this.currentTurnReplyTo);
          }
          break;
        case "assistant-thinking":
          if (ev.text && ev.text.trim() && this.opts.callbacks.onReasoning) {
            await this.opts.callbacks.onReasoning(ev.text, this.currentTurnReplyTo, ev.msgId);
          }
          break;
        case "user-tool-result":
          if (ev.toolResult && this.opts.callbacks.onToolResult) {
            await this.opts.callbacks.onToolResult(ev.toolUseId, ev.toolResult, this.currentTurnReplyTo);
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
              this.modelEchoResolve?.();
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
        // Skipped: system, unknown
      }
    } catch (err) {
      console.error(`[channel ${this.opts.session.channelKey}] event handler error:`, err);
    }
  }

  private startApprovalPoll(): void {
    if (this.approvalTimer) return;
    if (!this.opts.callbacks.onApprovalNeeded) return;
    this.approvalTimer = setInterval(() => void this.checkForApprovalDialog(), APPROVAL_POLL_MS);
  }

  private stopApprovalPoll(): void {
    if (this.approvalTimer) clearInterval(this.approvalTimer);
    this.approvalTimer = null;
    this.activeApprovalFp = null;
  }

  private async checkForApprovalDialog(): Promise<void> {
    if (this.state !== "running" && this.state !== "interrupting") return;
    if (!this.opts.callbacks.onApprovalNeeded) return;
    let pane: string;
    try {
      pane = await capturePane(this.opts.session.tmuxSession);
    } catch {
      return;
    }
    const dialog = parsePermissionDialog(pane);
    if (!dialog) {
      this.activeApprovalFp = null;
      return;
    }
    if (dialog.fingerprint === this.activeApprovalFp) return; // already raised
    this.activeApprovalFp = dialog.fingerprint;
    // A dialog is up: the slash command DID produce output (a TUI dialog),
    // so cancel the slash-idle synth-end timer — the dialog handler owns
    // resolution from here.
    this.clearSlashIdleTimer();

    const target = this.opts.session.tmuxSession;
    const api: ApprovalApi = {
      selectOption: async (index) => {
        // Survey dialogs accept a literal digit keypress. Block dialogs use
        // arrow navigation: option N needs (N-1) Down + Enter (cursor starts
        // on option 1).
        if (dialog.keypressMap && dialog.keypressMap[index]) {
          await sendKeys(target, dialog.keypressMap[index]);
        } else {
          const downs = Math.max(0, index - 1);
          for (let i = 0; i < downs; i++) {
            await sendKeys(target, "Down");
            await new Promise((r) => setTimeout(r, 50));
          }
          await pressEnter(target);
        }
        this.activeApprovalFp = null;
        // model-switch dialogs are the only kind that may not produce a
        // jsonl event after the user picks (Cancel = no echo). Synthesise
        // a turn-end after a grace period so the channel doesn't stick.
        if (dialog.kind === "model-switch") {
          setTimeout(() => {
            if (this.state === "running" && !this.activeApprovalFp) this.onTurnEnd();
          }, MODEL_SWITCH_DIALOG_SETTLE_MS);
        }
      },
      cancel: async () => {
        await pressEscape(target);
        this.activeApprovalFp = null;
        if (dialog.kind === "model-switch" || dialog.kind === "survey") {
          // No jsonl event will follow an Esc on these — synth turn-end so
          // we don't stall.
          setTimeout(() => {
            if (this.state === "running" && !this.activeApprovalFp) this.onTurnEnd();
          }, MODEL_SWITCH_DIALOG_SETTLE_MS);
        }
      },
    };
    try {
      await this.opts.callbacks.onApprovalNeeded(dialog, this.currentTurnReplyTo, api);
    } catch (err) {
      console.error(`[channel ${this.opts.session.channelKey}] approval cb failed:`, err);
      this.activeApprovalFp = null;
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
    this.clearSlashIdleTimer();
    this.clearStallTimer();
    this.stopTypingPulse();
    this.stopApprovalPoll();
    this.state = "idle";
    void this.opts.callbacks.onTurnEnd?.();
    void this.drainQueue();
  }

  /**
   * Arm the slash-idle fallback (see field comment). Fires synthetic
   * turn-end if the slash never produced any jsonl events within the
   * window — Claude Code UI-only commands like `/reload-plugins`, `/help`,
   * `/clear` don't touch the session file at all.
   */
  private armSlashIdleTimer(): void {
    this.clearSlashIdleTimer();
    this.slashIdleTimer = setTimeout(() => {
      this.slashIdleTimer = null;
      if (this.state !== "running") return;
      console.log(
        `[channel ${this.opts.session.channelKey}] slash command produced no jsonl events — synthesising turn-end`,
      );
      this.onTurnEnd();
    }, SLASH_IDLE_TIMEOUT_MS);
  }

  private clearSlashIdleTimer(): void {
    if (this.slashIdleTimer) {
      clearTimeout(this.slashIdleTimer);
      this.slashIdleTimer = null;
    }
  }

  private armStallTimer(): void {
    this.clearStallTimer();
    this.stallStartTime = Date.now();
    this.stallTimer = setTimeout(() => void this.onStall(), STALL_TIMEOUT_MS);
  }

  private resetStallTimer(): void {
    if (!this.stallTimer) return; // not armed — only reset when running
    clearTimeout(this.stallTimer);
    this.stallTimer = setTimeout(() => void this.onStall(), STALL_TIMEOUT_MS);
  }

  private clearStallTimer(): void {
    if (this.stallTimer) {
      clearTimeout(this.stallTimer);
      this.stallTimer = null;
    }
    this.stallStartTime = null;
  }

  private async onStall(): Promise<void> {
    this.stallTimer = null;
    if (this.state !== "running" && this.state !== "interrupting") return;

    const key = this.opts.session.channelKey;
    const stallMs = this.stallStartTime ? Date.now() - this.stallStartTime : STALL_TIMEOUT_MS;
    const forceRecover = stallMs >= STALL_MAX_MS;

    let pane = "(capture failed)";
    try {
      pane = await capturePane(this.opts.session.tmuxSession);
    } catch {}

    // Context compaction produces no jsonl output but is not a stall.
    // Skip diagnosis and recovery — just recheck until compaction finishes.
    if (/Compacting conversation/i.test(pane)) {
      this.stallTimer = setTimeout(() => void this.onStall(), 60_000);
      return;
    }

    // Long-running Bash (gradle builds, slow npm installs, long curls) shows
    // a `Running… (Xm Ys · timeout 10m)` indicator and produces no jsonl
    // until the tool returns. Don't count this as a stall — Claude Code's
    // own timeout will eventually fire if the command really hangs.
    if (/Running…|Running\.\.\./.test(pane)) {
      this.stallTimer = setTimeout(() => void this.onStall(), 60_000);
      return;
    }

    // Approval dialog up — ownership is with the operator (or the auto-
    // dismiss handler). Don't false-alarm; just recheck.
    if (this.activeApprovalFp) {
      this.stallTimer = setTimeout(() => void this.onStall(), 60_000);
      return;
    }

    await this.writeStallDiagnosis(pane, stallMs);

    const atPrompt = /❯\s*$/.test(pane.trimEnd()) || />\s*$/.test(pane.trimEnd());

    if (atPrompt || forceRecover) {
      console.warn(
        `[channel ${key}] stall: no jsonl activity for ${Math.round(stallMs / 1000)}s` +
          (forceRecover && !atPrompt ? " (max exceeded, forcing recovery)" : " — claude at prompt, recovering"),
      );
      this.onTurnEnd();
    } else {
      console.warn(
        `[channel ${key}] stall: no jsonl activity for ${Math.round(stallMs / 1000)}s — pane not at prompt, re-checking in 30s`,
      );
      this.stallTimer = setTimeout(() => void this.onStall(), 30_000);
    }
  }

  private async writeStallDiagnosis(pane: string, stallMs: number): Promise<void> {
    const key = this.opts.session.channelKey;
    const now = new Date();
    const stamp = now.toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const safeKey = key.replace(/[^a-zA-Z0-9_-]/g, "_");
    const logDir = join(this.opts.projectDir, ".claude", "claudeclaw", "logs");
    const path = join(logDir, `stall-${safeKey}-${stamp}.txt`);
    const queueSnippet = this.queue
      .map((q, i) => `  [${i}] ${q.text.slice(0, 120)}`)
      .join("\n");
    const report = [
      `stall diagnosis — ${now.toISOString()}`,
      `channel: ${key}`,
      `state:   ${this.state}`,
      `stall:   ${Math.round(stallMs / 1000)}s`,
      `queue:   ${this.queue.length} item(s)`,
      queueSnippet || "  (empty)",
      "",
      "--- tmux pane ---",
      pane,
    ].join("\n");
    try {
      await mkdir(logDir, { recursive: true });
      await writeFile(path, report, "utf8");
      console.log(`[channel ${key}] stall: diagnosis written to ${path}`);
    } catch (err) {
      console.error(`[channel ${key}] stall: failed to write diagnosis:`, err);
    }
  }

  /** Inbound message from the platform connector. */
  async handleIncoming(item: QueueItem): Promise<void> {
    item.receivedAt = new Date();
    if (this.state === "idle") {
      await this.paste(item);
      return;
    }
    // spawning, running, interrupting → enqueue with cap enforcement
    this.enqueue(item);
    if (this.state === "running" && this.opts.queue?.mode === "interrupt") {
      await this.beginInterrupt(/*keepQueue*/ true);
    }
  }

  private enqueue(item: QueueItem): void {
    const cfg = this.opts.queue;
    const cap = cfg?.cap ?? 20;
    const dropPolicy = cfg?.dropPolicy ?? "summarize";
    this.lastEnqueuedAt = Date.now();
    if (this.queue.length >= cap) {
      if (dropPolicy === "new") return; // reject incoming
      // drop oldest, optionally summarise it
      const dropped = this.queue.splice(0, this.queue.length - cap + 1);
      if (dropPolicy === "summarize") {
        for (const d of dropped) {
          this.droppedCount++;
          this.droppedSummaries.push(d.text.replace(/\s+/g, " ").slice(0, 160));
        }
      }
    }
    this.queue.push(item);
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
    const debounceMs = this.opts.queue?.debounceMs ?? 1500;
    if (debounceMs > 0) {
      const waitMs = debounceMs - (Date.now() - this.lastEnqueuedAt);
      if (waitMs > 0) {
        await new Promise<void>((r) => setTimeout(r, waitMs));
      }
      // re-check after debounce — new messages may have arrived
      if (this.state !== "idle") return;
    }
    if (this.queue.length === 0) return;
    const merged = this.mergeQueue();
    this.queue = [];
    this.droppedSummaries = [];
    this.droppedCount = 0;
    await this.paste(merged);
  }

  private mergeQueue(): QueueItem {
    if (this.queue.length === 1 && this.droppedCount === 0) return this.queue[0];
    const tz = this.opts.timezoneOffsetMinutes ?? 0;
    const blocks: string[] = ["[Queued messages while agent was busy]"];

    if (this.droppedCount > 0) {
      const lines = [
        `[${this.droppedCount} earlier message${this.droppedCount === 1 ? "" : "s"} dropped due to queue cap]`,
      ];
      for (const s of this.droppedSummaries) lines.push(`  - ${s}`);
      blocks.push(lines.join("\n"));
    }

    for (let i = 0; i < this.queue.length; i++) {
      const item = this.queue[i];
      const stamp = item.receivedAt ? formatTimestamp(item.receivedAt, tz) : "";
      const sourceLine = renderSourceLine(item);
      const header = [stamp ? `[${stamp}]` : "", sourceLine].filter(Boolean).join("\n");
      const body = item.rawPrompt ? item.text : `Message: ${item.text}`;
      blocks.push(`---\nQueued #${i + 1}\n${header}\n${body}`);
    }

    const last = this.queue[this.queue.length - 1];
    return {
      text: blocks.join("\n\n"),
      rawPrompt: true,
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
      this.startApprovalPoll();
      this.armStallTimer();
      this.armSlashIdleTimer();
      try {
        await pasteText(target, item.text.trim());
        await new Promise((r) => setTimeout(r, 80));
        await pressEnter(target);
      } catch (err) {
        console.error(`[channel ${this.opts.session.channelKey}] slash paste failed:`, err);
        this.opts.callbacks.onError?.(err as Error);
        this.clearStallTimer();
        this.stopTypingPulse();
        this.clearSlashIdleTimer();
        this.state = "idle";
      }
      return;
    }

    const inboxText = await this.buildInboxPrefix();
    const promptBody = item.rawPrompt ? item.text : this.formatPromptBody(item);
    const full = [inboxText, promptBody].filter(Boolean).join("\n\n");

    this.startTypingPulse();
    this.startApprovalPoll();
    this.armStallTimer();
    // Count user turns (non-scheduled) for the sticky-window-turns gate
    // in maybeSwitchModel. Bumped before classification so the new
    // count is visible to the check on THIS turn.
    if (!item.skipModelRouting) this.userTurnCounter++;
    try {
      if (!item.skipModelRouting) await this.maybeSwitchModel(item.text);
      await pasteText(target, full);
      await new Promise((r) => setTimeout(r, 250));
      await pressEnter(target);
    } catch (err) {
      console.error(`[channel ${this.opts.session.channelKey}] paste failed:`, err);
      this.opts.callbacks.onError?.(err as Error);
      this.clearStallTimer();
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
    if (routed.model === this.currentModel) {
      // Stayed in the same mode — track it so the hysteresis margin check
      // has the current mode name to compare against next time.
      if (routed.mode) this.currentMode = routed.mode;
      return;
    }

    // Hysteresis gates — see AgenticHysteresis docs. Phrase matches
    // (confidence ≥ 0.95) bypass all gates because they represent explicit
    // user intent. Everything else requires confidence + score margin +
    // sticky-window passes.
    const h = agentic.hysteresis;
    const key = this.opts.session.channelKey;
    if (routed.confidence < 0.95 && h) {
      const reasonsToSkip: string[] = [];
      if (routed.confidence < h.confidenceThreshold) {
        reasonsToSkip.push(
          `confidence ${routed.confidence.toFixed(2)} < threshold ${h.confidenceThreshold}`,
        );
      }
      // Margin: new mode's score minus the current mode's score on THIS
      // prompt. If the current mode isn't in the scores list (e.g. first
      // turn), treat its score as 0.
      const newScore = routed.scores.find((s) => s.mode === routed.mode)?.score ?? 0;
      const curScore = routed.scores.find((s) => s.mode === this.currentMode)?.score ?? 0;
      if (newScore - curScore < h.scoreMargin) {
        reasonsToSkip.push(
          `margin ${(newScore - curScore).toFixed(1)} < ${h.scoreMargin} (${routed.mode}:${newScore} vs ${this.currentMode || "?"}:${curScore})`,
        );
      }
      // Sticky window — only meaningful after at least one prior switch.
      if (this.lastModelSwitchAtMs > 0) {
        const minsSince = (Date.now() - this.lastModelSwitchAtMs) / 60_000;
        if (minsSince < h.stickyWindowMinutes) {
          reasonsToSkip.push(
            `sticky-window minutes ${minsSince.toFixed(1)} < ${h.stickyWindowMinutes}`,
          );
        }
        const turnsSince = this.userTurnCounter - this.userTurnAtLastSwitch;
        if (turnsSince < h.stickyWindowTurns) {
          reasonsToSkip.push(
            `sticky-window turns ${turnsSince} < ${h.stickyWindowTurns}`,
          );
        }
      }
      if (reasonsToSkip.length > 0) {
        console.log(
          `[channel ${key}] /model ${routed.model} suppressed by hysteresis: ${reasonsToSkip.join("; ")} (${routed.reasoning})`,
        );
        return;
      }
    }

    const target = this.opts.session.tmuxSession;
    console.log(
      `[channel ${key}] /model ${routed.model} ` +
        `(was ${this.currentModel || "(default)"}, ${routed.reasoning}, confidence ${routed.confidence.toFixed(2)})`,
    );
    try {
      // Mark the next "Set model to …" jsonl echo as ours so it doesn't
      // get treated as a turn boundary or forwarded to the platform.
      this.expectingModelEcho = true;
      const echoReady = new Promise<void>((r) => {
        this.modelEchoResolve = r;
      });
      await sendKeys(target, `/model ${routed.model}`);
      await new Promise((r) => setTimeout(r, 150));
      await pressEnter(target);
      // Wait for the tool-call response (the "Set model to …" stdout event)
      // to land in the jsonl before pasting the user prompt. Falls back to a
      // hard timeout so a missed echo doesn't deadlock the channel.
      await Promise.race([echoReady, new Promise((r) => setTimeout(r, MODEL_ECHO_TIMEOUT_MS))]);
      this.modelEchoResolve = null;
      // Give the TUI a moment to clear the input box after the echo.
      await new Promise((r) => setTimeout(r, 300));
      this.currentModel = routed.model;
      this.currentMode = routed.mode;
      this.lastModelSwitchAtMs = Date.now();
      this.userTurnAtLastSwitch = this.userTurnCounter;
    } catch (err) {
      this.expectingModelEcho = false;
      this.modelEchoResolve = null;
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

  /** The model the channel believes its claude process is on. Used by the
   *  /model command to render "current" in the menu. */
  get model(): string {
    return this.currentModel;
  }

  /**
   * Explicitly pin a model on this channel. Issues `/model <name>` to tmux
   * and updates the hysteresis state so subsequent agentic routing respects
   * the sticky window (i.e. won't immediately flip the user out of a model
   * they just asked for).
   *
   * Returns false if we're not actually mid-turn and the input box may not
   * be ready — the caller should handle that by retrying later or telling
   * the user.
   */
  async pinModel(model: string): Promise<boolean> {
    if (!model.trim()) return false;
    const target = this.opts.session.tmuxSession;
    try {
      this.expectingModelEcho = true;
      const echoReady = new Promise<void>((r) => {
        this.modelEchoResolve = r;
      });
      await sendKeys(target, `/model ${model}`);
      await new Promise((r) => setTimeout(r, 150));
      await pressEnter(target);
      await Promise.race([echoReady, new Promise((r) => setTimeout(r, MODEL_ECHO_TIMEOUT_MS))]);
      this.modelEchoResolve = null;
      await new Promise((r) => setTimeout(r, 300));
      this.currentModel = model;
      // Look up the mode name in the configured router so subsequent
      // margin checks have an accurate `currentMode`. Falls back to "" so
      // routing decisions just compare against score 0.
      const mode = this.opts.agentic?.modes.find((m) => m.model === model);
      this.currentMode = mode?.name ?? "";
      this.lastModelSwitchAtMs = Date.now();
      this.userTurnAtLastSwitch = this.userTurnCounter;
      return true;
    } catch (err) {
      this.expectingModelEcho = false;
      this.modelEchoResolve = null;
      console.error(`[channel ${this.opts.session.channelKey}] pinModel failed:`, err);
      return false;
    }
  }

  /**
   * Query the live `/model` picker for the available model list. This is the
   * auto-maintaining source of truth — it reflects whatever the installed
   * Claude Code knows, so the menu never goes stale.
   *
   * Only runs when the channel is idle (poking the picker mid-turn would
   * corrupt the running interaction). Returns null when busy or on parse
   * failure — caller should fall back to a static list.
   */
  async listModels(): Promise<ModelPickerOption[] | null> {
    if (this.state !== "idle") return null;
    const target = this.opts.session.tmuxSession;
    try {
      await pasteText(target, "/model");
      await new Promise((r) => setTimeout(r, 200));
      await pressEnter(target);
      await new Promise((r) => setTimeout(r, 1000));
      const pane = await capturePane(target);
      const options = parseModelPicker(pane);
      await pressEscape(target);
      await new Promise((r) => setTimeout(r, 200));
      return options.length ? options : null;
    } catch (err) {
      console.error(`[channel ${this.opts.session.channelKey}] listModels failed:`, err);
      try {
        await pressEscape(target);
      } catch {}
      return null;
    }
  }

  /**
   * Select a model by its picker index, driving the live `/model` picker:
   * open it, read the current cursor row, press Down the right number of
   * times (the picker wraps, so we navigate relative to the cursor, never
   * by homing), then press `s` to apply for this session only — so a remote
   * pick doesn't change the operator's global default.
   *
   * Bumps the hysteresis sticky window so agentic routing won't immediately
   * flip the user back out of the model they just picked.
   */
  async pickModelByIndex(targetIndex: number): Promise<{ ok: boolean; label?: string }> {
    if (this.state !== "idle") return { ok: false };
    const target = this.opts.session.tmuxSession;
    try {
      this.expectingModelEcho = true;
      await pasteText(target, "/model");
      await new Promise((r) => setTimeout(r, 200));
      await pressEnter(target);
      await new Promise((r) => setTimeout(r, 1000));
      const options = parseModelPicker(await capturePane(target));
      const targetOpt = options.find((o) => o.index === targetIndex);
      const cursor = options.find((o) => o.isCursor)?.index;
      if (!targetOpt || cursor === undefined || options.length === 0) {
        await pressEscape(target);
        this.expectingModelEcho = false;
        return { ok: false };
      }
      const n = options.length;
      const downs = (((targetIndex - cursor) % n) + n) % n;
      for (let i = 0; i < downs; i++) {
        await sendKeys(target, "Down");
        await new Promise((r) => setTimeout(r, 80));
      }
      // `s` = apply for this session only (leaves the global default alone).
      await sendKeys(target, "s");
      await new Promise((r) => setTimeout(r, 400));
      this.expectingModelEcho = false;
      this.modelEchoResolve = null;
      // Record state for hysteresis. We don't have the canonical model id
      // from the picker (only the display label), so currentMode is cleared;
      // the sticky window covers the resulting label/id mismatch until it
      // expires, after which routing resumes from a clean classification.
      this.currentModel = targetOpt.label;
      this.currentMode = "";
      this.lastModelSwitchAtMs = Date.now();
      this.userTurnAtLastSwitch = this.userTurnCounter;
      return { ok: true, label: targetOpt.label };
    } catch (err) {
      this.expectingModelEcho = false;
      this.modelEchoResolve = null;
      console.error(`[channel ${this.opts.session.channelKey}] pickModelByIndex failed:`, err);
      try {
        await pressEscape(target);
      } catch {}
      return { ok: false };
    }
  }

  /** Hard shutdown: kill tmux, stop tailer. Used on daemon stop. */
  async shutdown(): Promise<void> {
    this.tailer?.stop();
    this.tailer = null;
    if (this.interruptTimer) clearTimeout(this.interruptTimer);
    this.interruptTimer = null;
    this.clearSlashIdleTimer();
    this.clearStallTimer();
    this.stopTypingPulse();
    this.stopApprovalPoll();
    try {
      await killSession(this.opts.session.tmuxSession);
    } catch {}
  }
}
