/**
 * Detect a Claude Code permission dialog in a tmux pane snapshot and
 * extract its question + numbered options, so the daemon can delegate
 * the decision to a trusted DM with inline buttons.
 *
 * The dialog Claude Code shows looks like:
 *
 *      Bash command
 *        ls /tmp
 *        List files in /tmp
 *      Do you want to proceed?
 *      ❯ 1. Yes
 *        2. Yes, allow reading from tmp/ from this project
 *        3. No
 *      Esc to cancel · Tab to amend
 *
 * We look for the `❯ N. <text>` block. The "question" is the contiguous
 * non-empty lines above the cursor row (until a separator), which gives
 * us enough context for the operator to decide.
 */

export interface PermissionDialog {
  /** Free-form context lines above the option list (tool name, command, etc). */
  question: string;
  /** Each numbered option in display order; option N maps to (N-1) Down + Enter. */
  options: string[];
  /** A stable digest of question+options — used to de-duplicate so we don't
   *  re-send a Telegram prompt every poll while the user is still deciding. */
  fingerprint: string;
}

/** Heuristics: a dialog is detected when we see `❯ <digit>. <text>` followed
 *  by additional `<digit>. <text>` lines. We don't require specific question
 *  text so this also catches future Claude Code prompts with different
 *  phrasings (model switch confirms, plan-mode prompts, etc.) */
const DIALOG_RE = /❯\s*\d+\.\s*([^\n]+)\n((?:\s*\d+\.\s*[^\n]+\n)*)/;

export function parsePermissionDialog(pane: string): PermissionDialog | null {
  const match = pane.match(DIALOG_RE);
  if (!match) return null;

  // Build the options list. Include the first match (the `❯`-prefixed line)
  // plus the additional `N. …` lines that follow.
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

  // Walk backwards from the match to gather the dialog's question/context —
  // stop at a separator row (────…) or after 20 lines.
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

  // Filter out obvious non-permission dialogs — the bypass warning at first
  // launch is handled by init-watch, not by this scanner.
  if (/Bypass Permissions mode/i.test(question)) return null;

  // Fingerprint = simple djb2 of question + options
  const seed = `${question}\n${options.join("|")}`;
  let h = 5381 >>> 0;
  for (let i = 0; i < seed.length; i++) h = ((h * 33) ^ seed.charCodeAt(i)) >>> 0;
  const fingerprint = h.toString(16);

  return { question, options, fingerprint };
}
