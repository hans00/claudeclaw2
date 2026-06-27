/**
 * Agent-initiated silent reply detection. When the agent decides a message
 * shouldn't trigger a reply (multi-party context, two humans talking,
 * off-topic chatter), the model is instructed to emit exactly `NO_REPLY`.
 *
 * Models routinely wrap or punctuate the token despite the prompt ("Don't
 * wrap it") — backticks, bold, code fences, trailing period, full-width
 * punctuation, etc. Tolerate the common wrappings here so a single slip
 * doesn't leak the token to the platform.
 *
 * Direct port of v1 silent.ts to keep behaviour consistent.
 */
export const SILENT_REPLY_TOKEN = "NO_REPLY";

/**
 * Whole-message sentinels that mean "produce nothing visible on the
 * platform". NO_REPLY = multi-party silence; HEARTBEAT_OK = the heartbeat
 * found nothing worth saying. Both must be suppressed, never delivered.
 */
const SILENT_SENTINELS = [SILENT_REPLY_TOKEN, "HEARTBEAT_OK"];

const WRAP_CHARS = "`\"'*_~";
const END_PUNCT = ".!?;:。！？；：,，"; // CJK punctuation intentional — matches CJK-language replies
const LEAD_RE = new RegExp(`^[${WRAP_CHARS}\\s]+`);
const TAIL_RE = new RegExp(`[${WRAP_CHARS}${END_PUNCT}\\s]+$`);
const TRAILING_RE = new RegExp(
  `\\s*[${WRAP_CHARS}]*NO_REPLY[${WRAP_CHARS}${END_PUNCT}\\s]*$`,
);

function normalizeSilent(text: string): string {
  let t = text.trim();
  // Strip fenced code wrapper if the whole thing is a code block.
  if (t.startsWith("```")) {
    t = t.replace(/^```[a-zA-Z0-9]*\s*/, "").replace(/\s*```$/, "").trim();
  }
  return t.replace(LEAD_RE, "").replace(TAIL_RE, "");
}

/** True when the entire text is a silent sentinel (tolerating wrappers). */
export function isSilentReplyText(text: string): boolean {
  if (!text) return false;
  const norm = normalizeSilent(text);
  return SILENT_SENTINELS.some(
    (s) => norm === s || new RegExp(`^\\s*${s}\\s*$`).test(text),
  );
}

/** Remove a trailing NO_REPLY marker (with optional wrappers/punct). */
export function stripSilentToken(text: string): string {
  return text.replace(TRAILING_RE, "").replace(/\s+$/, "");
}
