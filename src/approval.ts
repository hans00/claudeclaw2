/**
 * Detect Claude Code TUI dialogs in a tmux pane snapshot and classify them
 * so the daemon can either auto-handle them or surface them to a trusted
 * operator via inline keyboard buttons.
 *
 * Three kinds are recognised:
 *
 *   - "permission" — the standard `Do you want to proceed? ❯ 1. Yes …`
 *     block that gates risky tool calls (Bash not on the allowlist, etc).
 *     Forwarded to the operator with the original title.
 *
 *   - "model-switch" — Claude Code asks "Switch model?" with two options
 *     when a /model change would invalidate an existing cache. Same `❯ N.`
 *     block format as permission, but with a recognisable question. Tagged
 *     separately so the operator UI can use a clearer title.
 *
 *   - "survey" — the periodic "How is Claude doing this session?" prompt.
 *     Format is inline single-key shortcuts (`1: Bad   2: Fine   3: Good
 *     0: Dismiss`) rather than the `❯ N.` block, so it needs its own
 *     parser. Caller decides whether to auto-dismiss (digit "0") or forward.
 */

export type DialogKind = "permission" | "model-switch" | "survey" | "question" | "login";

/**
 * Claude Code's OAuth login step: after picking a login method it prints a
 * long authorize URL (wrapped across pane lines) and waits for the operator
 * to paste a code. Detected by the "Paste code here" / "Browser didn't open"
 * wording; the wrapped URL is reconstructed by joining the unindented
 * continuation lines.
 */
export interface LoginPrompt {
  url: string;
}

export function parseLoginPrompt(pane: string): LoginPrompt | null {
  if (!/Paste code here|Browser didn't open/i.test(pane)) return null;
  const lines = pane.split("\n");
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/https?:\/\/\S*oauth\/authorize/i.test(lines[i])) {
      start = i;
      break;
    }
  }
  if (start < 0) return null;
  const parts: string[] = [];
  for (let i = start; i < lines.length; i++) {
    const t = lines[i].replace(/\s+$/, "");
    if (/paste code here|esc to cancel/i.test(t)) break;
    if (t.trim() === "") break;
    const m = t.match(/(https?:\/\/\S.*)$/);
    parts.push(i === start && m ? m[1] : t.trim());
  }
  const url = parts.join("");
  return /^https?:\/\//.test(url) ? { url } : null;
}

/** True when the session is logged out but hasn't opened the login flow yet
 *  (expired token / "Please run /login"). The daemon can auto-run /login. */
export function isLoggedOut(pane: string): boolean {
  return /Please run \/login|OAuth (?:access )?token has expired|Invalid API key.*\/login/i.test(pane);
}

export interface PermissionDialog {
  kind: DialogKind;
  /** Free-form context lines above the option list. */
  question: string;
  /** Each numbered option in display order. */
  options: string[];
  /** Stable digest used to de-duplicate so we don't re-send the operator
   *  prompt every poll. */
  fingerprint: string;
  /** When set, option N is answered by sending the literal digit key
   *  `keypressMap[N]` instead of `(N-1) Down + Enter`. Used by surveys. */
  keypressMap?: Record<number, string>;
}

const BLOCK_DIALOG_RE = /❯\s*\d+\.\s*([^\n]+)\n((?:\s*\d+\.\s*[^\n]+\n)*)/;
const SURVEY_HEADER_RE = /How is Claude doing this session\?[^\n]*\n([^\n]+)/;

function fingerprint(seed: string): string {
  let h = 5381 >>> 0;
  for (let i = 0; i < seed.length; i++) h = ((h * 33) ^ seed.charCodeAt(i)) >>> 0;
  return h.toString(16);
}

function parseSurvey(pane: string): PermissionDialog | null {
  const m = pane.match(SURVEY_HEADER_RE);
  if (!m) return null;
  // The next line is "1: Bad    2: Fine   3: Good   0: Dismiss". Extract
  // each `<digit>: <label>` pair — the label runs until ≥2 spaces or EOL.
  const optionsLine = m[1];
  const optionMatches = [...optionsLine.matchAll(/(\d+):\s*([^\s][^\n]*?)(?=\s{2,}\d+:|\s*$)/g)];
  if (optionMatches.length < 2) return null;
  const options: string[] = [];
  const keypressMap: Record<number, string> = {};
  for (let i = 0; i < optionMatches.length; i++) {
    const digit = optionMatches[i][1];
    const label = optionMatches[i][2].trim();
    options.push(label);
    keypressMap[i + 1] = digit;
  }
  return {
    kind: "survey",
    question: "How is Claude doing this session? (optional)",
    options,
    fingerprint: fingerprint(`survey:${options.join("|")}`),
    keypressMap,
  };
}

function parseBlockDialog(pane: string): PermissionDialog | null {
  const match = pane.match(BLOCK_DIALOG_RE);
  if (!match) return null;

  const optionsBlock = `1. ${match[1]}\n${match[2]}`;
  const options: string[] = [];
  for (const line of optionsBlock.split("\n")) {
    const m = line.match(/^\s*\d+\.\s*(.+?)$/);
    if (m) {
      const txt = m[1].trim();
      if (txt) options.push(txt);
    }
  }
  if (options.length < 2) return null;

  const matchIdx = match.index ?? 0;
  const beforeLines = pane.slice(0, matchIdx).split("\n");
  const ctx: string[] = [];
  for (let i = beforeLines.length - 1; i >= 0; i--) {
    const raw = beforeLines[i];
    const trimmed = raw.trim();
    if (/^─+$/.test(trimmed)) break;
    ctx.unshift(raw);
    if (ctx.length >= 20) break;
  }
  const question = ctx.join("\n").trim();

  if (/Bypass Permissions mode/i.test(question)) return null;

  // Classify based on question content. "Switch model?" and the /login
  // method picker get their own kinds so the daemon can handle them
  // specially instead of treating them as generic permissions.
  const kind: DialogKind =
    /Switch model\?/i.test(question) ? "model-switch"
    : /Select login method/i.test(question) ? "login"
    : "permission";

  return {
    kind,
    question,
    options,
    fingerprint: fingerprint(`${kind}:${question}\n${options.join("|")}`),
  };
}

/**
 * Claude Code's AskUserQuestion menu. Unlike a permission dialog, each option
 * carries a multi-line description, and the footer reads "Enter to select ·
 * ↑/↓ to navigate · Esc to cancel". parseBlockDialog can't parse it (the
 * description lines break its consecutive-`N.` capture), so it needs its own
 * parser. Options are answered by (N-1) Down + Enter, same as a block dialog.
 */
const QUESTION_OPTION_RE = /^\s{0,3}(?:❯\s+)?(\d+)\.\s+(.+?)\s*$/;

function parseQuestionDialog(pane: string): PermissionDialog | null {
  if (!/Enter to select/.test(pane)) return null;
  if (!/(?:↑\/↓|to navigate)/.test(pane)) return null;
  const lines = pane.split("\n");
  const options: string[] = [];
  let firstOptLine = -1;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(QUESTION_OPTION_RE);
    if (m) {
      if (firstOptLine < 0) firstOptLine = i;
      options.push(m[2].trim());
    }
  }
  if (options.length < 2) return null;
  // Question = the non-empty lines just above the first option, back to a
  // separator rule (strips the leading ☐ header marker).
  const ctx: string[] = [];
  for (let i = firstOptLine - 1; i >= 0 && ctx.length < 8; i--) {
    const t = lines[i].trim();
    if (!t) continue;
    if (/^[─▔╌—_-]{3,}$/.test(t)) break;
    ctx.unshift(t.replace(/^☐\s*/, ""));
  }
  const question = ctx.join("\n").trim();
  return {
    kind: "question",
    question,
    options,
    fingerprint: fingerprint(`question:${question}\n${options.join("|")}`),
  };
}

export function parsePermissionDialog(pane: string): PermissionDialog | null {
  return parseSurvey(pane) ?? parseQuestionDialog(pane) ?? parseBlockDialog(pane);
}

/**
 * One row of Claude Code's `/model` picker. The picker is the live source of
 * truth for available models (it updates when the CLI updates), so we parse
 * it rather than hardcoding a model list.
 *
 * Picker rendering (indented, numbered, two-space gap before description):
 *
 *     Select model
 *       1. Default (recommended)  Opus 4.8 with 1M context · …
 *       2. Fable                  Fable 5 · …
 *     ❯ 6. Opus ✔                 Opus 4.8 · …
 *     Enter to set as default · s to use this session only · Esc to cancel
 */
export interface ModelPickerOption {
  index: number;
  /** Short label, e.g. "Opus" or "Sonnet (1M context)". ✔/cursor stripped. */
  label: string;
  /** Right-hand description, e.g. "Opus 4.8 with 1M context · …". */
  description: string;
  /** True for the row the cursor (❯) is currently on. */
  isCursor: boolean;
  /** True for the row marked as the active model (✔). */
  isCurrent: boolean;
}

export function parseModelPicker(pane: string): ModelPickerOption[] {
  // Guard: only parse when the picker header is present, so we don't latch
  // onto unrelated numbered lists elsewhere in the pane.
  if (!/Select model/i.test(pane)) return [];
  const out: ModelPickerOption[] = [];
  for (const line of pane.split("\n")) {
    const m = line.match(/^\s*(❯)?\s*(\d+)\.\s+(.+?)\s{2,}(.+?)\s*$/);
    if (!m) continue;
    const isCursor = !!m[1];
    const index = Number(m[2]);
    const rawLabel = m[3];
    const isCurrent = /✔/.test(rawLabel);
    const label = rawLabel.replace(/✔/g, "").trim();
    const description = m[4].trim();
    if (label) out.push({ index, label, description, isCursor, isCurrent });
  }
  return out;
}
