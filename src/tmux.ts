/**
 * Thin wrappers over the `tmux` CLI. Stateless — every call shells out.
 *
 * All inputs are passed as argv arrays (no shell interpolation) to avoid
 * injection from channel/session names or pasted user content.
 */
import { spawn } from "bun";
import { writeFile, unlink } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { randomBytes } from "crypto";

const TMUX = "tmux";

interface RunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

async function run(args: string[]): Promise<RunResult> {
  const proc = spawn(args, { stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  await proc.exited;
  return { stdout, stderr, exitCode: proc.exitCode ?? -1 };
}

function fail(args: string[], r: RunResult): never {
  throw new Error(`tmux failed (exit ${r.exitCode}): ${args.join(" ")}\n${r.stderr.trim()}`);
}

export async function hasSession(name: string): Promise<boolean> {
  const r = await run([TMUX, "has-session", "-t", name]);
  return r.exitCode === 0;
}

export async function listSessions(): Promise<string[]> {
  const r = await run([TMUX, "list-sessions", "-F", "#{session_name}"]);
  if (r.exitCode !== 0) {
    // tmux returns non-zero when no server is running; that just means empty.
    if (r.stderr.includes("no server running") || r.stderr.includes("No such file")) {
      return [];
    }
    fail(["list-sessions"], r);
  }
  return r.stdout.split("\n").filter(Boolean);
}

export interface NewSessionOptions {
  cwd?: string;
  width?: number;
  height?: number;
}

export async function newSession(name: string, opts: NewSessionOptions = {}): Promise<void> {
  const args = [
    TMUX, "new-session", "-d", "-s", name,
    "-x", String(opts.width ?? 200),
    "-y", String(opts.height ?? 50),
    // Scope HISTFILE=/dev/null to this session so the `claude --session-id …
    // --append-system-prompt …` launch line (and anything else we drive into
    // the pane) never lands in the user's shell history. Session-scoped via
    // -e, so other tmux sessions are untouched. Shell-agnostic: both zsh and
    // bash honour HISTFILE, and oh-my-zsh only sets it when empty so this
    // non-empty value wins. Requires tmux ≥ 3.0.
    "-e", "HISTFILE=/dev/null",
  ];
  if (opts.cwd) args.push("-c", opts.cwd);
  const r = await run(args);
  if (r.exitCode !== 0) fail(args, r);
}

export async function killSession(name: string): Promise<void> {
  const args = [TMUX, "kill-session", "-t", name];
  const r = await run(args);
  // Already gone is fine.
  if (r.exitCode !== 0 && !r.stderr.includes("can't find session")) fail(args, r);
}

/** Rename an existing tmux session. Returns false if the source doesn't exist. */
export async function renameSession(from: string, to: string): Promise<boolean> {
  const args = [TMUX, "rename-session", "-t", from, to];
  const r = await run(args);
  if (r.exitCode === 0) return true;
  if (r.stderr.includes("can't find session") || r.stderr.includes("no such session")) return false;
  fail(args, r);
}

/**
 * Send key sequence(s). Each element is one tmux key argument — special keys
 * like "Enter", "Escape", "Down", "C-c", or a literal text string.
 *
 * Do NOT use this for multi-line user content — newlines inside a literal
 * string would submit early. Use pasteText() instead.
 */
export async function sendKeys(target: string, ...keys: string[]): Promise<void> {
  if (keys.length === 0) return;
  const args = [TMUX, "send-keys", "-t", target, ...keys];
  const r = await run(args);
  if (r.exitCode !== 0) fail(args, r);
}

/**
 * Paste arbitrary text (multi-line safe) into the target session via the
 * tmux buffer + bracketed paste. The receiving program sees this as a
 * single paste, not a stream of keystrokes.
 */
export async function pasteText(target: string, text: string): Promise<void> {
  const tmpFile = join(tmpdir(), `claudeclaw-paste-${Date.now()}-${randomBytes(4).toString("hex")}`);
  await writeFile(tmpFile, text, "utf8");
  try {
    const loadArgs = [TMUX, "load-buffer", "-t", target, tmpFile];
    const loadR = await run(loadArgs);
    if (loadR.exitCode !== 0) fail(loadArgs, loadR);

    const pasteArgs = [TMUX, "paste-buffer", "-t", target, "-p"];
    const pasteR = await run(pasteArgs);
    if (pasteR.exitCode !== 0) fail(pasteArgs, pasteR);
  } finally {
    await unlink(tmpFile).catch(() => {});
  }
}

export interface CaptureOptions {
  /** Negative offsets capture scrollback (e.g. -50 for last 50 lines above visible). */
  startLine?: number;
  endLine?: number;
  /** Include ANSI escape sequences. Default false (cleaner for pattern matching). */
  includeEscapes?: boolean;
}

export async function capturePane(target: string, opts: CaptureOptions = {}): Promise<string> {
  const args = [TMUX, "capture-pane", "-p", "-t", target];
  if (opts.startLine !== undefined) args.push("-S", String(opts.startLine));
  if (opts.endLine !== undefined) args.push("-E", String(opts.endLine));
  if (opts.includeEscapes) args.push("-e");
  const r = await run(args);
  if (r.exitCode !== 0) fail(args, r);
  return r.stdout;
}

/** Convenience: send Enter to submit the current input. */
export async function pressEnter(target: string): Promise<void> {
  await sendKeys(target, "Enter");
}

/** Convenience: send Escape (interrupts Claude Code mid-stream). */
export async function pressEscape(target: string): Promise<void> {
  await sendKeys(target, "Escape");
}
