/**
 * LINE Messaging API connector — webhook + REST.
 *
 * Scope (MVP):
 *   - Bun.serve webhook on settings.line.webhookPort (user is expected to
 *     terminate TLS / tunnel publicly themselves — cloudflared etc)
 *   - HMAC-SHA256 signature verification (LINE requires it)
 *   - Inbound: text + image/audio/video/file/sticker via the content API
 *   - Routing: 1:1 user → "global"; group → "line:<groupId>"; room → "line:<roomId>"
 *   - Outbound: push messages (we don't track replyTokens for now)
 *   - Reactions: sendReaction API (LINE 2024+)
 *
 * Not in scope yet: replyToken-based replies (cheaper, but 30s window),
 * outbound stickers, postback events, follow/unfollow, rich messages.
 */
import { createHmac } from "node:crypto";
import {
  downloadAttachment,
  type InboundAttachment,
  type InboundAttachmentKind,
} from "../attachments";
import type { LineConfig } from "../config";

const LINE_API = "https://api.line.me/v2";
const LINE_DATA_API = "https://api-data.line.me/v2";

export type LineSourceType = "user" | "group" | "room";

export interface LineInbound {
  /** Stable per-source chat id we route on (userId / groupId / roomId). */
  sourceType: LineSourceType;
  sourceId: string;
  /** The sender's user id (always present for messages from users; bots/system may omit). */
  fromUserId: string;
  fromName: string;
  /** Inbound message id, used for reactions. */
  messageId: string;
  /** Reply token usable within 30s of receiving (we keep it but don't use yet). */
  replyToken: string;
  text: string;
  attachments: InboundAttachment[];
}

export interface LineRouter {
  handleMessage(msg: LineInbound): Promise<void>;
}

export interface LineSender {
  /** LINE messages cannot be edited — always sends new. Returns undefined
   *  (no useful per-message id for editing). */
  pushText(to: string, text: string): Promise<string | undefined>;
  /** Always returns false. LINE has no message-edit endpoint. */
  editMessage(to: string, messageId: string, text: string): Promise<boolean>;
  /** Always returns false. LINE has no message-delete endpoint. */
  deleteMessage(to: string, messageId: string): Promise<boolean>;
  sendReaction(messageId: string, emoji: string): Promise<void>;
  sendTypingAction(chatId: string): Promise<void>;
}

export interface LineOptions {
  config: LineConfig;
  router: LineRouter;
}

interface LineMessageEvent {
  type: "message";
  replyToken: string;
  source: { type: LineSourceType; userId?: string; groupId?: string; roomId?: string };
  message: {
    id: string;
    type: "text" | "image" | "video" | "audio" | "file" | "sticker" | "location";
    text?: string;
    fileName?: string;
    packageId?: string;
    stickerId?: string;
    title?: string;
    address?: string;
  };
}

const MIME_FOR_TYPE: Record<string, { mime: string; ext: string; kind: InboundAttachmentKind }> = {
  image: { mime: "image/jpeg", ext: ".jpg", kind: "photo" },
  video: { mime: "video/mp4", ext: ".mp4", kind: "video" },
  audio: { mime: "audio/m4a", ext: ".m4a", kind: "audio" },
  file:  { mime: "application/octet-stream", ext: "", kind: "document" },
};

export class LinePlatform implements LineSender {
  private server: ReturnType<typeof Bun.serve> | null = null;
  private botUserId: string | null = null;

  constructor(private readonly opts: LineOptions) {}

  async start(): Promise<void> {
    const c = this.opts.config;
    if (!c.channelAccessToken || !c.channelSecret || c.webhookPort <= 0) {
      console.log("[line] disabled (missing tokens or webhookPort=0)");
      return;
    }
    await this.fetchBotInfo().catch((err) =>
      console.warn("[line] could not fetch bot info:", err),
    );
    this.server = Bun.serve({
      port: c.webhookPort,
      hostname: "0.0.0.0",
      fetch: (req) => this.handle(req),
    });
    console.log(`[line] webhook listening on :${c.webhookPort}${c.webhookPath}`);
  }

  async stop(): Promise<void> {
    this.server?.stop();
    this.server = null;
    console.log("[line] stopped");
  }

  private async handle(req: Request): Promise<Response> {
    const url = new URL(req.url);
    if (req.method === "POST" && url.pathname === this.opts.config.webhookPath) {
      const body = await req.text();
      const signature = req.headers.get("x-line-signature") ?? "";
      if (!this.verifySignature(body, signature)) {
        console.error("[line] invalid webhook signature");
        return new Response("invalid signature", { status: 401 });
      }
      // Ack immediately; process async.
      void this.processWebhook(body).catch((err) =>
        console.error("[line] webhook error:", err),
      );
      return new Response("OK", { status: 200 });
    }
    return new Response("not found", { status: 404 });
  }

  private verifySignature(body: string, signature: string): boolean {
    const hmac = createHmac("sha256", this.opts.config.channelSecret);
    hmac.update(body);
    const expected = hmac.digest("base64");
    return signature === expected;
  }

  private async processWebhook(body: string): Promise<void> {
    let payload: { events?: any[] };
    try {
      payload = JSON.parse(body);
    } catch {
      console.error("[line] webhook body not JSON");
      return;
    }
    for (const event of payload.events ?? []) {
      if (event.type === "message") {
        await this.routeMessage(event as LineMessageEvent);
      }
    }
  }

  private async routeMessage(event: LineMessageEvent): Promise<void> {
    const c = this.opts.config;
    const source = event.source;
    const sourceId =
      source.type === "user" ? source.userId :
      source.type === "group" ? source.groupId :
      source.type === "room" ? source.roomId : undefined;
    if (!sourceId) return;
    const fromUserId = source.userId ?? sourceId;

    if (source.type === "user") {
      if (c.allowedUserIds.length > 0 && !c.allowedUserIds.includes(fromUserId)) return;
    } else if (source.type === "group") {
      if (c.allowedGroupIds.length > 0 && !c.allowedGroupIds.includes(sourceId)) return;
    }

    const fromName = await this.getDisplayName(fromUserId).catch(() => fromUserId);
    const attachments: InboundAttachment[] = [];
    let text = "";

    const m = event.message;
    if (m.type === "text") {
      text = m.text ?? "";
    } else if (m.type === "sticker") {
      // No file download — sticker is identified by packageId/stickerId.
      text = `[sticker pkg=${m.packageId} id=${m.stickerId}]`;
    } else if (m.type === "location") {
      text = `[location ${m.title ?? ""} ${m.address ?? ""}]`.trim();
    } else if (m.type === "image" || m.type === "video" || m.type === "audio" || m.type === "file") {
      const att = await this.downloadContent(m.id, m.type, sourceId, m.fileName);
      if (att) attachments.push(att);
    }

    await this.opts.router.handleMessage({
      sourceType: source.type,
      sourceId,
      fromUserId,
      fromName,
      messageId: m.id,
      replyToken: event.replyToken,
      text,
      attachments,
    });
  }

  private async downloadContent(
    messageId: string,
    type: "image" | "video" | "audio" | "file",
    sourceId: string,
    filename?: string,
  ): Promise<InboundAttachment | null> {
    const map = MIME_FOR_TYPE[type];
    return downloadAttachment({
      url: `${LINE_DATA_API}/bot/message/${messageId}/content`,
      headers: { authorization: `Bearer ${this.opts.config.channelAccessToken}` },
      scope: sourceId,
      kind: map.kind,
      ext: map.ext,
      mimeType: map.mime,
      originalName: filename,
    });
  }

  private async getDisplayName(userId: string): Promise<string> {
    const res = await this.api(`/bot/profile/${userId}`);
    if (!res?.ok) return userId;
    const data: any = await res.json().catch(() => null);
    return data?.displayName ?? userId;
  }

  private async fetchBotInfo(): Promise<void> {
    const res = await this.api(`/bot/info`);
    if (!res?.ok) return;
    const data: any = await res.json().catch(() => null);
    this.botUserId = data?.userId ?? null;
    console.log(`[line] bot info: ${data?.displayName ?? "?"} (${this.botUserId})`);
  }

  // --- Outbound ---

  async pushText(to: string, text: string): Promise<string | undefined> {
    if (!text) return undefined;
    const chunks = chunkText(text);
    for (const chunk of chunks) {
      const res = await this.api(`/bot/message/push`, "POST", {
        to,
        messages: [{ type: "text", text: chunk }],
      });
      if (!res?.ok) {
        const body = await res?.text().catch(() => "");
        console.error(`[line] pushText failed (${res?.status}): ${body?.slice(0, 200)}`);
        return undefined;
      }
    }
    return undefined; // LINE doesn't surface useful per-message ids on push
  }

  async editMessage(_to: string, _messageId: string, _text: string): Promise<boolean> {
    return false; // LINE has no message-edit endpoint
  }

  async deleteMessage(_to: string, _messageId: string): Promise<boolean> {
    return false; // LINE has no message-delete endpoint
  }

  async sendTypingAction(chatId: string): Promise<void> {
    // LINE has a "loading indicator" endpoint; it animates the three dots
    // for up to 60s. We invoke it every few seconds so it stays visible
    // until the turn ends (matches the Telegram/Discord typing cadence).
    try {
      await this.api("/bot/chat/loading/start", "POST", {
        chatId,
        loadingSeconds: 20,
      });
    } catch (err) {
      console.error(`[line] loading-indicator failed:`, err instanceof Error ? err.message : err);
    }
  }

  async sendReaction(messageId: string, emoji: string): Promise<void> {
    const res = await this.api(`/bot/message/${messageId}/reaction`, "POST", {
      reactionType: { type: "emoji", emoji },
    });
    if (!res?.ok && res?.status !== 200 && res?.status !== 202) {
      const body = await res?.text().catch(() => "");
      console.error(`[line] sendReaction failed (${res?.status}): ${body?.slice(0, 200)}`);
    }
  }

  private async api(path: string, method: "GET" | "POST" = "GET", body?: unknown): Promise<Response | null> {
    try {
      return await fetch(`${LINE_API}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${this.opts.config.channelAccessToken}`,
          "content-type": "application/json",
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (err) {
      console.error(`[line] api ${method} ${path} failed:`, err);
      return null;
    }
  }
}

const LINE_MSG_LIMIT = 4500;

export function chunkText(text: string, max: number = LINE_MSG_LIMIT): string[] {
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
