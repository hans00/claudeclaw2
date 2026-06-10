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

export type DialogKind = "permission" | "model-switch" | "survey";

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

  // Classify based on question content. "Switch model?" gets its own kind
  // so the operator UI can label it clearly instead of "Permission needed".
  const kind: DialogKind = /Switch model\?/i.test(question) ? "model-switch" : "permission";

  return {
    kind,
    question,
    options,
    fingerprint: fingerprint(`${kind}:${question}\n${options.join("|")}`),
  };
}

export function parsePermissionDialog(pane: string): PermissionDialog | null {
  return parseSurvey(pane) ?? parseBlockDialog(pane);
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
