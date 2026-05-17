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

interface TgCallbackQuery {
  id: string;
  from: TgUser;
  message?: { message_id: number; chat: TgChat };
  data?: string;
}

interface TgUpdate {
  update_id: number;
  message?: TgMessage;
  edited_message?: TgMessage;
  callback_query?: TgCallbackQuery;
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

export interface TelegramCallbackInbound {
  callbackQueryId: string;
  fromUserId: number;
  fromName: string;
  data: string;
}

export interface TelegramRouter {
  handleMessage(msg: InboundMessage): Promise<void>;
  /** Inline-keyboard button press. The platform implementation MUST call
   *  `answerCallbackQuery` itself (best within ~3s) — we forward the raw
   *  data here so the daemon can route by token. */
  handleCallback?(cb: TelegramCallbackInbound): Promise<void>;
}

export interface InlineKeyboardButton {
  text: string;
  callback_data: string;
}

export interface TelegramSender {
  /** Send `text` (markdown → HTML, chunked). Returns the message_id of the
   *  FIRST chunk (the one we'd edit-in-place) or undefined on failure. */
  sendMessage(chatId: number, text: string): Promise<string | undefined>;
  /** Replace an already-sent message's content. Returns true on success;
   *  false if the new text would be multi-chunk or the API rejects. */
  editMessage(chatId: number, messageId: string, text: string): Promise<boolean>;
  /** Delete a previously-sent message. Returns true on success. */
  deleteMessage(chatId: number, messageId: string): Promise<boolean>;
  /** Send a message with inline keyboard. Returns message_id. */
  sendInlineKeyboard(
    chatId: number,
    text: string,
    buttons: InlineKeyboardButton[][],
  ): Promise<string | undefined>;
  /** Ack a callback_query. Telegram requires this within ~3 seconds. */
  answerCallbackQuery(callbackQueryId: string, text?: string): Promise<void>;
  setReactions(chatId: number, messageId: number, emojis: string[]): Promise<void>;
  sendTypingAction(chatId: number): Promise<void>;
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

  async sendMessage(chatId: number, text: string): Promise<string | undefined> {
    const token = this.opts.config.token;
    if (!token || !text) return undefined;
    const html = markdownToTelegramHtml(text);
    const chunks = chunkHtml(html, TG_HTML_LIMIT);
    let firstId: string | undefined;
    for (const chunk of chunks) {
      const res = await fetch(`${API_BASE}/bot${token}/sendMessage`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          chat_id: chatId,
          text: chunk,
          parse_mode: "HTML",
          disable_web_page_preview: true,
        }),
      });
      if (res.ok) {
        const data: any = await res.json().catch(() => null);
        const id = data?.result?.message_id;
        if (firstId === undefined && typeof id === "number") firstId = String(id);
        continue;
      }
      const body = await res.text().catch(() => "");
      console.error(`[telegram] sendMessage failed (${res.status}): ${body.slice(0, 200)}`);
      // Fallback: retry as plain text in case the HTML payload broke
      const plainRes = await fetch(`${API_BASE}/bot${token}/sendMessage`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, text: chunk.slice(0, 4000), disable_web_page_preview: true }),
      });
      if (plainRes.ok) {
        const data: any = await plainRes.json().catch(() => null);
        const id = data?.result?.message_id;
        if (firstId === undefined && typeof id === "number") firstId = String(id);
      } else {
        const b = await plainRes.text().catch(() => "");
        console.error(`[telegram] plain fallback also failed (${plainRes.status}): ${b.slice(0, 200)}`);
      }
    }
    return firstId;
  }

  async editMessage(chatId: number, messageId: string, text: string): Promise<boolean> {
    const token = this.opts.config.token;
    if (!token) return false;
    const id = Number(messageId);
    if (!Number.isFinite(id)) return false;
    const html = markdownToTelegramHtml(text);
    const chunks = chunkHtml(html, TG_HTML_LIMIT);
    if (chunks.length !== 1) return false; // multi-chunk edits unsupported
    const res = await fetch(`${API_BASE}/bot${token}/editMessageText`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        message_id: id,
        text: chunks[0],
        parse_mode: "HTML",
        disable_web_page_preview: true,
      }),
    });
    if (res.ok) return true;
    const body = await res.text().catch(() => "");
    // "message is not modified" is harmless — same content, treat as success.
    if (body.includes("message is not modified")) return true;
    console.error(`[telegram] editMessage failed (${res.status}): ${body.slice(0, 200)}`);
    return false;
  }

  /**
   * Atomically replace the bot's reactions on a message. Telegram's
   * setMessageReaction replaces — not appends — so multiple emojis must
   * be sent in a single call. Passing an empty array clears the reaction.
   *
   * Telegram restricts bot reactions to a fixed allowlist; anything else
   * (custom emojis, newer additions, etc) is dropped here with a warning
   * rather than burning the whole reaction batch on a 400.
   */
  async sendInlineKeyboard(
    chatId: number,
    text: string,
    buttons: InlineKeyboardButton[][],
  ): Promise<string | undefined> {
    const token = this.opts.config.token;
    if (!token) return undefined;
    const html = markdownToTelegramHtml(text);
    const chunks = chunkHtml(html, TG_HTML_LIMIT);
    if (chunks.length === 0) return undefined;
    const res = await fetch(`${API_BASE}/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text: chunks[0],
        parse_mode: "HTML",
        disable_web_page_preview: true,
        reply_markup: { inline_keyboard: buttons },
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      console.error(`[telegram] sendInlineKeyboard failed (${res.status}): ${body.slice(0, 200)}`);
      return undefined;
    }
    const data: any = await res.json().catch(() => null);
    const id = data?.result?.message_id;
    return typeof id === "number" ? String(id) : undefined;
  }

  async answerCallbackQuery(callbackQueryId: string, text?: string): Promise<void> {
    const token = this.opts.config.token;
    if (!token) return;
    try {
      await fetch(`${API_BASE}/bot${token}/answerCallbackQuery`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          callback_query_id: callbackQueryId,
          ...(text ? { text, show_alert: false } : {}),
        }),
      });
    } catch (err) {
      console.error(`[telegram] answerCallbackQuery failed:`, err);
    }
  }

  async deleteMessage(chatId: number, messageId: string): Promise<boolean> {
    const token = this.opts.config.token;
    if (!token) return false;
    const id = Number(messageId);
    if (!Number.isFinite(id)) return false;
    const res = await fetch(`${API_BASE}/bot${token}/deleteMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, message_id: id }),
    });
    if (res.ok) return true;
    const body = await res.text().catch(() => "");
    // Already deleted / not found is acceptable.
    if (body.includes("message to delete not found")) return true;
    console.error(`[telegram] deleteMessage failed (${res.status}): ${body.slice(0, 200)}`);
    return false;
  }

  /** Register bot commands visible in the Telegram menu (the / autocomplete). */
  async setCommands(commands: Array<{ name: string; description: string }>): Promise<void> {
    const token = this.opts.config.token;
    if (!token) return;
    try {
      const res = await fetch(`${API_BASE}/bot${token}/setMyCommands`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          commands: commands.map((c) => ({ command: c.name, description: c.description || "-" })),
        }),
      });
      if (res.ok) {
        console.log(`[telegram] registered ${commands.length} command(s)`);
      } else {
        const detail = await res.text().catch(() => "");
        console.error(`[telegram] setMyCommands failed ${res.status}: ${detail}`);
      }
    } catch (err) {
      console.error("[telegram] setMyCommands error:", err);
    }
  }

  async sendTypingAction(chatId: number): Promise<void> {
    const token = this.opts.config.token;
    if (!token) return;
    try {
      await fetch(`${API_BASE}/bot${token}/sendChatAction`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, action: "typing" }),
      });
    } catch (err) {
      // Non-critical — typing indicator is a UX nicety, swallow errors.
      console.error(`[telegram] sendChatAction failed:`, err instanceof Error ? err.message : err);
    }
  }

  async setReactions(chatId: number, messageId: number, emojis: string[]): Promise<void> {
    const token = this.opts.config.token;
    if (!token) return;
    const supported = emojis.filter((e) => TG_REACTION_EMOJIS.has(normalizeEmoji(e)));
    const dropped = emojis.filter((e) => !TG_REACTION_EMOJIS.has(normalizeEmoji(e)));
    if (dropped.length > 0) {
      console.warn(`[telegram] dropping unsupported reactions: ${dropped.join(" ")}`);
    }
    if (supported.length === 0) return;
    const res = await fetch(`${API_BASE}/bot${token}/setMessageReaction`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        message_id: messageId,
        reaction: supported.map((emoji) => ({ type: "emoji", emoji })),
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
    if (update.callback_query) {
      const cb = update.callback_query;
      if (!cb.from || !cb.data) return;
      const allowed = this.opts.config.allowedUserIds;
      if (allowed.length > 0 && !allowed.includes(cb.from.id)) {
        // Reject silently — don't even ack.
        return;
      }
      const name = [cb.from.first_name, cb.from.last_name].filter(Boolean).join(" ").trim()
        || cb.from.username
        || String(cb.from.id);
      try {
        await this.opts.router.handleCallback?.({
          callbackQueryId: cb.id,
          fromUserId: cb.from.id,
          fromName: name,
          data: cb.data,
        });
      } catch (err) {
        console.error("[telegram] callback router error:", err);
      }
      return;
    }

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

const TG_MSG_LIMIT = 4000; // markdown-source-side limit for non-HTML callers
const TG_HTML_LIMIT = 3800; // HTML-side limit (Telegram caps at 4096, leave headroom)

/**
 * Split already-converted HTML into Telegram-sized chunks at SAFE boundaries —
 * paragraph breaks (`\n\n`) first, then single newlines. Never splits inside
 * a tag, so each chunk is independently well-formed.
 *
 * If a single paragraph already exceeds the limit (rare: a very tall <pre>),
 * it is emitted alone and Telegram may reject it — better than truncating
 * mid-tag.
 */
export function chunkHtml(html: string, max: number = TG_HTML_LIMIT): string[] {
  if (!html) return [];
  if (html.length <= max) return [html];
  const out: string[] = [];
  let buf = "";
  const paras = html.split(/\n\n+/);
  for (const p of paras) {
    if (p.length > max) {
      if (buf) { out.push(buf); buf = ""; }
      // Try to split this paragraph on single newlines.
      const lines = p.split("\n");
      let inner = "";
      for (const line of lines) {
        if (inner.length + 1 + line.length > max) {
          if (inner) out.push(inner);
          inner = line.length > max ? line.slice(0, max) : line;
        } else {
          inner = inner ? `${inner}\n${line}` : line;
        }
      }
      if (inner) out.push(inner);
      continue;
    }
    if (buf.length + 2 + p.length > max) {
      out.push(buf);
      buf = p;
    } else {
      buf = buf ? `${buf}\n\n${p}` : p;
    }
  }
  if (buf) out.push(buf);
  return out;
}

/**
 * Telegram's bot-reactions allowlist (as of late 2024). Anything outside
 * this set returns REACTION_INVALID and trashes the whole batch.
 */
const TG_REACTION_EMOJIS = new Set([
  "👍","👎","❤","🔥","🥰","👏","😁","🤔","🤯","😱","🤬","😢","🎉","🤩",
  "🤮","💩","🙏","👌","🕊","🤡","🥱","🥴","😍","🐳","❤‍🔥","🌚","🌭","💯",
  "🤣","⚡","🍌","🏆","💔","🤨","😐","🍓","🍾","💋","🖕","😈","😴","😭",
  "🤓","👻","👨‍💻","👀","🎃","🙈","😇","😨","🤝","✍","🤗","🫡","🎅","🎄",
  "☃","💅","🤪","🗿","🆒","💘","🙉","🦄","😘","💊","🙊","😎","👾","🤷‍♂",
  "🤷","🤷‍♀","😡",
]);

/** Strip variation selector U+FE0F so ❤️ and ❤ compare equal. */
function normalizeEmoji(s: string): string {
  return s.replace(/️/g, "");
}

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
