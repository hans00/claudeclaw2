/**
 * Shared inbound-media handling for Telegram / Discord / Slack.
 *
 * Each platform's inbound message carries zero-or-more `InboundAttachment`s.
 * Files land in `.claude/claudeclaw/attachments/<scope>/<isoTs>-<kind><ext>`,
 * and the daemon prepends them as `[Attached <kind> · ...: <localPath>]`
 * lines so the agent can Read/Bash them itself.
 */
import { mkdir, writeFile } from "fs/promises";
import { join } from "path";

export type InboundAttachmentKind =
  | "photo"
  | "voice"
  | "audio"
  | "video"
  | "document"
  | "sticker";

export interface InboundAttachment {
  kind: InboundAttachmentKind;
  /** Path relative to project cwd. */
  localPath: string;
  duration?: number;
  mimeType?: string;
  fileSize?: number;
  /** Original filename when the platform supplies one. */
  originalName?: string;
}

const ATTACH_DIR = join(".claude", "claudeclaw", "attachments");

/** Pick a sensible attachment kind from a MIME type. */
export function kindFromMime(mime: string | undefined | null): InboundAttachmentKind {
  if (!mime) return "document";
  const m = mime.toLowerCase();
  if (m.startsWith("image/")) return "photo";
  if (m.startsWith("audio/")) return "audio";
  if (m.startsWith("video/")) return "video";
  return "document";
}

/** Best-effort extract a file extension (with leading dot). */
export function extFromName(name: string | undefined | null): string {
  if (!name) return "";
  const m = name.match(/\.[a-zA-Z0-9]+$/);
  return m ? m[0].toLowerCase() : "";
}

/** Replace tmux-unfriendly chars in a scope identifier. */
function safeScope(scope: string): string {
  return scope.replace(/[^a-zA-Z0-9_-]/g, "_");
}

export interface DownloadOptions {
  url: string;
  /** Optional HTTP headers (e.g. bearer auth for Slack). */
  headers?: Record<string, string>;
  /** Per-channel scoping path component, usually chatId / channelId. */
  scope: string;
  kind: InboundAttachmentKind;
  /** File extension with leading dot. Falls back to "" if absent. */
  ext?: string;
  originalName?: string;
  mimeType?: string;
  duration?: number;
  fileSize?: number;
  /** ISO-ish timestamp used as filename prefix. Default = now. */
  timestamp?: string;
}

/**
 * Fetch the URL and save to .claude/claudeclaw/attachments/<scope>/<ts>-<kind><ext>.
 * Returns null on failure (caller logs / decides whether to skip).
 */
export async function downloadAttachment(opts: DownloadOptions): Promise<InboundAttachment | null> {
  const ts = (opts.timestamp ?? new Date().toISOString()).replace(/[:.]/g, "-");
  try {
    const res = await fetch(opts.url, { headers: opts.headers });
    if (!res.ok) {
      console.error(`[attach] fetch ${opts.url} failed: ${res.status}`);
      return null;
    }
    const data = new Uint8Array(await res.arrayBuffer());
    const dir = join(ATTACH_DIR, safeScope(opts.scope));
    await mkdir(dir, { recursive: true });
    const ext = opts.ext ?? extFromName(opts.originalName);
    const localPath = join(dir, `${ts}-${opts.kind}${ext}`);
    await writeFile(localPath, data);
    return {
      kind: opts.kind,
      localPath,
      duration: opts.duration,
      mimeType: opts.mimeType,
      fileSize: opts.fileSize ?? data.length,
      originalName: opts.originalName,
    };
  } catch (err) {
    console.error(`[attach] download failed for ${opts.url}:`, err);
    return null;
  }
}

/** Format attachments + text into a single prompt string. */
export function composePromptWithAttachments(text: string, atts: InboundAttachment[]): string {
  if (!atts.length) return text;
  const lines: string[] = [];
  for (const a of atts) {
    const bits: string[] = [`Attached ${a.kind}`];
    if (a.duration !== undefined) bits.push(`${a.duration}s`);
    if (a.originalName) bits.push(`name=${a.originalName}`);
    if (a.mimeType) bits.push(`mime=${a.mimeType}`);
    lines.push(`[${bits.join(" · ")}: ${a.localPath}]`);
  }
  if (text) lines.push("", text);
  return lines.join("\n");
}
