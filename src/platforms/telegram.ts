/**
 * Minimal Telegram bot connector.
 *
 * Scope (MVP):
 *   - long-poll getUpdates
 *   - filter messages by settings.telegram.allowedUserIds
 *   - route each accepted message via TelegramRouter.handleMessage
 *   - sendMessage chunked at ~4000 chars
 *
 * Not in scope yet: voice, photos, MarkdownV2, reactions, edited messages.
 */
import { basename } from "path";
import {
  downloadAttachment,
  extFromName,
  type InboundAttachment,
  type InboundAttachmentKind,
} from "../attachments";
import type { TelegramConfig } from "../config";

export type { InboundAttachment, InboundAttachmentKind } from "../attachments";

const API_BASE = "https://api.telegram.org";

interface TgUser {
  id: number;
  first_name?: string;
  last_name?: string;
  username?: string;
  is_bot?: boolean;
}

interface TgChat {
  id: number;
  type: "private" | "group" | "supergroup" | "channel";
}

interface TgPhotoSize {
  file_id: string;
  file_unique_id: string;
  width: number;
  height: number;
  file_size?: number;
}

interface TgFile {
  file_id: string;
  duration?: number;
  mime_type?: string;
  file_size?: number;
  file_name?: string;
}

interface TgMessage {
  message_id: number;
  from?: TgUser;
  chat: TgChat;
  date: number;
  text?: string;
  caption?: string;
  photo?: TgPhotoSize[];
  voice?: TgFile;
  audio?: TgFile;
  video?: TgFile;
  document?: TgFile;
  sticker?: TgFile;
}

interface TgUpdate {
  update_id: number;
  message?: TgMessage;
  edited_message?: TgMessage;
}

export interface InboundMessage {
  chatId: number;
  chatType: "private" | "group" | "supergroup" | "channel";
  fromUserId: number;
  fromName: string;
  /** @-handle without the leading @, when the user has one. */
  fromUsername?: string;
  /** Text body (msg.text OR msg.caption if it was a media message). */
  text: string;
  messageId: number;
  attachments: InboundAttachment[];
}

export interface TelegramRouter {
  handleMessage(msg: InboundMessage): Promise<void>;
}

export interface TelegramSender {
  sendMessage(chatId: number, text: string): Promise<void>;
  setReactions(chatId: number, messageId: number, emojis: string[]): Promise<void>;
}

export interface TelegramOptions {
  config: TelegramConfig;
  pollSeconds: number;
  router: TelegramRouter;
}

export class TelegramPlatform implements TelegramSender {
  private offset = 0;
  private running = false;
  private abort: AbortController | null = null;
  private loopPromise: Promise<void> | null = null;

  constructor(private readonly opts: TelegramOptions) {}

  async start(): Promise<void> {
    if (!this.opts.config.token) {
      console.warn("[telegram] no token configured; skipping start");
      return;
    }
    if (this.running) return;
    this.running = true;
    this.abort = new AbortController();
    this.loopPromise = this.loop();
    console.log("[telegram] started long-poll");
  }

  async stop(): Promise<void> {
    this.running = false;
    this.abort?.abort();
    await this.loopPromise?.catch(() => {});
    console.log("[telegram] stopped");
  }

  async sendMessage(chatId: number, text: string): Promise<void> {
    const token = this.opts.config.token;
    if (!token || !text) return;
    const chunks = chunkText(text);
    for (const chunk of chunks) {
      const html = markdownToTelegramHtml(chunk);
      const res = await fetch(`${API_BASE}/bot${token}/sendMessage`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          chat_id: chatId,
          text: html,
          parse_mode: "HTML",
          disable_web_page_preview: true,
        }),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        console.error(`[telegram] sendMessage failed (${res.status}): ${body.slice(0, 200)}`);
        // Fallback: retry as plain text in case the HTML payload broke
        // (unbalanced tags from weird markdown, etc).
        const plainRes = await fetch(`${API_BASE}/bot${token}/sendMessage`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ chat_id: chatId, text: chunk, disable_web_page_preview: true }),
        });
        if (!plainRes.ok) {
          const b = await plainRes.text().catch(() => "");
          console.error(`[telegram] plain fallback also failed (${plainRes.status}): ${b.slice(0, 200)}`);
        }
        return;
      }
    }
  }

  /**
   * Atomically replace the bot's reactions on a message. Telegram's
   * setMessageReaction replaces — not appends — so multiple emojis must
   * be sent in a single call. Passing an empty array clears the reaction.
   */
  async setReactions(chatId: number, messageId: number, emojis: string[]): Promise<void> {
    const token = this.opts.config.token;
    if (!token) return;
    const res = await fetch(`${API_BASE}/bot${token}/setMessageReaction`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        message_id: messageId,
        reaction: emojis.map((emoji) => ({ type: "emoji", emoji })),
        is_big: false,
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      console.error(`[telegram] setMessageReaction failed (${res.status}): ${body.slice(0, 200)}`);
    }
  }

  private async loop(): Promise<void> {
    const token = this.opts.config.token;
    const timeout = this.opts.pollSeconds;
    let backoff = 1000;

    while (this.running) {
      try {
        const url = `${API_BASE}/bot${token}/getUpdates?offset=${this.offset}&timeout=${timeout}`;
        const res = await fetch(url, { signal: this.abort?.signal ?? undefined });
        if (!res.ok) {
          const body = await res.text().catch(() => "");
          console.error(`[telegram] getUpdates ${res.status}: ${body.slice(0, 200)}`);
          await sleep(backoff);
          backoff = Math.min(backoff * 2, 30_000);
          continue;
        }
        backoff = 1000;
        const data = (await res.json()) as { ok: boolean; result?: TgUpdate[] };
        if (!data.ok || !Array.isArray(data.result)) continue;
        for (const update of data.result) {
          this.offset = Math.max(this.offset, update.update_id + 1);
          await this.handleUpdate(update);
        }
      } catch (err) {
        if (this.abort?.signal.aborted) break;
        console.error("[telegram] loop error:", err);
        await sleep(backoff);
        backoff = Math.min(backoff * 2, 30_000);
      }
    }
  }

  private async handleUpdate(update: TgUpdate): Promise<void> {
    const msg = update.message ?? update.edited_message;
    if (!msg || !msg.from) return;
    if (msg.from.is_bot) return;

    const allowed = this.opts.config.allowedUserIds;
    if (allowed.length > 0 && !allowed.includes(msg.from.id)) return;

    const text = (msg.text ?? msg.caption ?? "").trim();
    const attachments = await this.collectAttachments(msg);
    if (!text && attachments.length === 0) return; // nothing to forward

    const name = [msg.from.first_name, msg.from.last_name].filter(Boolean).join(" ").trim()
      || msg.from.username
      || String(msg.from.id);

    try {
      await this.opts.router.handleMessage({
        chatId: msg.chat.id,
        chatType: msg.chat.type,
        fromUserId: msg.from.id,
        fromName: name,
        fromUsername: msg.from.username,
        text,
        messageId: msg.message_id,
        attachments,
      });
    } catch (err) {
      console.error("[telegram] router error:", err);
    }
  }

  /** Detect + download any media on the message. Best-effort: a failed
   *  download logs and is omitted, so a partial set still flows through. */
  private async collectAttachments(msg: TgMessage): Promise<InboundAttachment[]> {
    const results: InboundAttachment[] = [];
    const ts = new Date().toISOString().replace(/[:.]/g, "-");

    if (Array.isArray(msg.photo) && msg.photo.length > 0) {
      const largest = msg.photo[msg.photo.length - 1];
      const att = await this.downloadById(largest.file_id, "photo", ts, msg.chat.id, {
        fileSize: largest.file_size,
      });
      if (att) results.push(att);
    }
    const single: Array<[InboundAttachmentKind, TgFile | undefined]> = [
      ["voice", msg.voice],
      ["audio", msg.audio],
      ["video", msg.video],
      ["document", msg.document],
      ["sticker", msg.sticker],
    ];
    for (const [kind, file] of single) {
      if (!file) continue;
      const att = await this.downloadById(file.file_id, kind, ts, msg.chat.id, {
        duration: file.duration,
        mimeType: file.mime_type,
        fileSize: file.file_size,
        originalName: file.file_name,
      });
      if (att) results.push(att);
    }
    return results;
  }

  private async downloadById(
    fileId: string,
    kind: InboundAttachmentKind,
    ts: string,
    chatId: number,
    extra: { duration?: number; mimeType?: string; fileSize?: number; originalName?: string } = {},
  ): Promise<InboundAttachment | null> {
    const token = this.opts.config.token;
    if (!token) return null;
    let filePath: string | undefined;
    try {
      const meta = await fetch(`${API_BASE}/bot${token}/getFile?file_id=${encodeURIComponent(fileId)}`);
      if (!meta.ok) {
        console.error(`[telegram] getFile ${meta.status}`);
        return null;
      }
      const metaJson = (await meta.json()) as { ok: boolean; result?: { file_path?: string } };
      filePath = metaJson?.result?.file_path;
    } catch (err) {
      console.error(`[telegram] getFile failed:`, err);
      return null;
    }
    if (!filePath) {
      console.error(`[telegram] getFile returned no file_path for ${fileId}`);
      return null;
    }
    return downloadAttachment({
      url: `${API_BASE}/file/bot${token}/${filePath}`,
      scope: String(chatId),
      kind,
      ext: extFromName(basename(filePath)),
      timestamp: ts,
      ...extra,
    });
  }
}

/**
 * Convert a markdown subset to Telegram-flavoured HTML so the bot can use
 * `parse_mode: "HTML"`. Telegram's HTML mode supports `<b>`, `<i>`, `<u>`,
 * `<s>`, `<code>`, `<pre>`, `<a href>`, `<tg-spoiler>`, and `<blockquote>`.
 *
 * What we translate:
 *   - ```` ```lang\nblock``` ```` → `<pre>block</pre>`
 *   - markdown tables (`| col | col |` rows + `|---|---|` separator) →
 *     monospace `<pre>` with cells column-padded
 *   - `` `inline` `` → `<code>inline</code>`
 *   - `## heading` (any depth) → `<b>heading</b>`
 *   - `**bold**` → `<b>bold</b>`
 *   - everything else → HTML-escaped plaintext
 *
 * Lists, italics and links are intentionally left as escaped literal text
 * — they read fine and never break the HTML parser.
 */
export function markdownToTelegramHtml(md: string): string {
  const blocks: string[] = [];
  const stash = (html: string): string => {
    blocks.push(html);
    return `\x00BLOCK${blocks.length - 1}\x00`;
  };

  // 1. Fenced code blocks — verbatim contents.
  let s = md.replace(/```(\w*)\n?([\s\S]*?)```/g, (_, _lang, code) => {
    const trimmed = code.replace(/\n$/, "");
    return stash(`<pre>${escapeHtml(trimmed)}</pre>`);
  });

  // 2. Markdown tables — re-render with padded columns inside <pre> so
  //    the cells line up under Telegram's monospace font. We require the
  //    canonical "header / |---|---| / body rows" shape.
  s = s.replace(
    /(^\|[^\n]+\|[ \t]*\n\|[-:\s|]+\|[ \t]*\n(?:\|[^\n]+\|[ \t]*\n?)+)/gm,
    (block) => {
      const lines = block.trimEnd().split("\n");
      if (lines.length < 2) return block;
      const rows: string[][] = [];
      for (let i = 0; i < lines.length; i++) {
        if (i === 1) continue; // separator
        rows.push(parseTableRow(lines[i]));
      }
      return stash(`<pre>${escapeHtml(formatTableAligned(rows))}</pre>`);
    },
  );

  // 3. Inline code.
  const inlines: string[] = [];
  s = s.replace(/`([^`\n]+)`/g, (_, code) => {
    inlines.push(`<code>${escapeHtml(code)}</code>`);
    return `\x00INLINE${inlines.length - 1}\x00`;
  });

  // 4. Escape the rest, then apply inline formatting on the escaped text.
  s = escapeHtml(s);
  s = s.replace(/^(#{1,6})\s+(.+)$/gm, (_, _h, txt) => `<b>${txt}</b>`);
  s = s.replace(/\*\*([^\n]+?)\*\*/g, "<b>$1</b>");

  s = s.replace(/\x00INLINE(\d+)\x00/g, (_, n) => inlines[Number(n)] ?? "");
  s = s.replace(/\x00BLOCK(\d+)\x00/g, (_, n) => blocks[Number(n)] ?? "");
  return s;
}

function parseTableRow(line: string): string[] {
  const t = line.trim();
  // Strip leading/trailing pipes then split.
  const inner = t.replace(/^\|/, "").replace(/\|$/, "");
  return inner.split("|").map((c) => c.trim());
}

function formatTableAligned(rows: string[][]): string {
  if (rows.length === 0) return "";
  const cols = Math.max(...rows.map((r) => r.length));
  const widths = new Array(cols).fill(0);
  for (const row of rows) {
    for (let j = 0; j < row.length; j++) {
      const w = visibleWidth(row[j]);
      if (w > widths[j]) widths[j] = w;
    }
  }
  const sep = "  ";
  const out: string[] = [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const padded = row.map((cell, j) => padToWidth(cell, widths[j]));
    out.push(padded.join(sep));
    if (i === 0) {
      // header underline using the same widths
      out.push(widths.map((w) => "─".repeat(w)).join(sep));
    }
  }
  return out.join("\n");
}

/** Width counting CJK chars as 2 (so monospace alignment looks right). */
function visibleWidth(s: string): number {
  let w = 0;
  for (const ch of s) {
    const code = ch.codePointAt(0) ?? 0;
    w += isWide(code) ? 2 : 1;
  }
  return w;
}

function padToWidth(s: string, target: number): string {
  const w = visibleWidth(s);
  if (w >= target) return s;
  return s + " ".repeat(target - w);
}

function isWide(code: number): boolean {
  return (
    (code >= 0x1100 && code <= 0x115f) ||  // Hangul Jamo
    (code >= 0x2e80 && code <= 0x303e) ||  // CJK Radicals + Kangxi
    (code >= 0x3041 && code <= 0x33ff) ||  // Hiragana + Katakana + CJK Symbols
    (code >= 0x3400 && code <= 0x4dbf) ||  // CJK Ext A
    (code >= 0x4e00 && code <= 0x9fff) ||  // CJK Unified
    (code >= 0xa000 && code <= 0xa4cf) ||  // Yi Syllables
    (code >= 0xac00 && code <= 0xd7a3) ||  // Hangul Syllables
    (code >= 0xf900 && code <= 0xfaff) ||  // CJK Compat
    (code >= 0xfe30 && code <= 0xfe4f) ||  // CJK Compat Forms
    (code >= 0xff00 && code <= 0xff60) ||  // Fullwidth ASCII
    (code >= 0xffe0 && code <= 0xffe6) ||  // Fullwidth signs
    (code >= 0x20000 && code <= 0x2fffd) ||// CJK Ext B-F
    (code >= 0x30000 && code <= 0x3fffd)
  );
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

const TG_MSG_LIMIT = 4000; // a bit under the 4096 hard limit, leaves room for splits

export function chunkText(text: string, max: number = TG_MSG_LIMIT): string[] {
  if (text.length <= max) return text ? [text] : [];
  const result: string[] = [];
  let i = 0;
  while (i < text.length) {
    let end = Math.min(i + max, text.length);
    if (end < text.length) {
      const nl = text.lastIndexOf("\n", end);
      if (nl > i + max / 2) end = nl;
    }
    result.push(text.slice(i, end));
    i = end;
    if (text[i] === "\n") i++;
  }
  return result;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
