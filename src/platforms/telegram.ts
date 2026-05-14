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
import type { TelegramConfig } from "../config";

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

interface TgMessage {
  message_id: number;
  from?: TgUser;
  chat: TgChat;
  date: number;
  text?: string;
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
  text: string;
  messageId: number;
}

export interface TelegramRouter {
  handleMessage(msg: InboundMessage): Promise<void>;
}

export interface TelegramSender {
  sendMessage(chatId: number, text: string): Promise<void>;
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
    if (!token) return;
    const chunks = chunkText(text);
    for (const chunk of chunks) {
      const res = await fetch(`${API_BASE}/bot${token}/sendMessage`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, text: chunk, disable_web_page_preview: true }),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        console.error(`[telegram] sendMessage failed (${res.status}): ${body.slice(0, 200)}`);
        return;
      }
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
    if (!msg || !msg.text || !msg.from) return;
    if (msg.from.is_bot) return;

    const allowed = this.opts.config.allowedUserIds;
    if (allowed.length > 0 && !allowed.includes(msg.from.id)) return;

    const name = [msg.from.first_name, msg.from.last_name].filter(Boolean).join(" ").trim()
      || msg.from.username
      || String(msg.from.id);

    try {
      await this.opts.router.handleMessage({
        chatId: msg.chat.id,
        chatType: msg.chat.type,
        fromUserId: msg.from.id,
        fromName: name,
        text: msg.text,
        messageId: msg.message_id,
      });
    } catch (err) {
      console.error("[telegram] router error:", err);
    }
  }
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
