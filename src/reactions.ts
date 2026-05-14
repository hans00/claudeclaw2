/**
 * Reactions: the agent can emit `[react:<emoji>]` anywhere in its reply,
 * and the daemon strips the tag from the text and applies the emoji as
 * a native platform reaction on the original inbound message.
 *
 * Multiple `[react:...]` tags are allowed in a single reply (each becomes
 * its own reaction). If the cleaned text is empty after stripping, only
 * the reactions fire — useful for "just acknowledge with an emoji" cases.
 *
 * Format precedent: matches the v1 syntax documented in user CLAUDE.md.
 */

const REACT_TAG_RE = /\[react:([^\]]+)\]/g;

export interface ExtractedReactions {
  /** Text with all `[react:...]` tags removed and adjacent whitespace tidied. */
  cleanText: string;
  /** Emoji strings in order of appearance. May contain duplicates. */
  reactions: string[];
}

export function extractReactions(text: string): ExtractedReactions {
  if (!text || !text.includes("[react:")) {
    return { cleanText: text ?? "", reactions: [] };
  }
  const reactions: string[] = [];
  const stripped = text.replace(REACT_TAG_RE, (_m, emoji) => {
    const trimmed = String(emoji).trim();
    if (trimmed) reactions.push(trimmed);
    return "";
  });
  // Collapse runs of whitespace that the removed tag left behind, but
  // preserve intentional newline structure as best we can.
  const cleaned = stripped
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/^[ \t\n]+|[ \t\n]+$/g, "");
  return { cleanText: cleaned, reactions };
}
