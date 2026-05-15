/**
 * Slack bot connector — Socket Mode (WebSocket) + Web API.
 *
 * Scope (MVP):
 *   - apps.connections.open → WSS endpoint (Socket Mode)
 *   - Receive `events_api` envelopes for `message` events; ACK them
 *   - Route: IM → "global", channel → "slack:<channelId>"
 *           (threads collapse into the parent channel for now)
 *   - Outbound: chat.postMessage + reactions.add
 *
 * Auth: app-level token (xapp-...) for Socket Mode, bot token (xoxb-...) for Web API.
 *
 * Not in scope yet: slash commands, interactivity, channel-listing/refresh.
 */
import {
  downloadAttachment,
  extFromName,
  kindFromMime,
  type InboundAttachment,
} from "../attachments";
import type { SlackConfig } from "../config";

const WEB_API = "https://slack.com/api";

export interface SlackInbound {
  channelId: string;
  channelType: "im" | "channel" | "group" | "mpim" | "unknown";
  threadTs?: string;
  messageTs: string;
  fromUserId: string;
  fromName: string;
  isBot: boolean;
  text: string;
  attachments: InboundAttachment[];
}

export interface SlackRouter {
  handleMessage(msg: SlackInbound): Promise<void>;
}

export interface SlackSender {
  sendMessage(channelId: string, text: string, threadTs?: string): Promise<string | undefined>;
  editMessage(channelId: string, ts: string, text: string): Promise<boolean>;
  deleteMessage(channelId: string, ts: string): Promise<boolean>;
  addReaction(channelId: string, messageTs: string, emoji: string): Promise<void>;
  /** No-op on Slack — the Bot Web API has no "typing" equivalent. */
  sendTypingAction(channelId: string): Promise<void>;
}

export interface SlackOptions {
  config: SlackConfig;
  router: SlackRouter;
}

export class SlackPlatform implements SlackSender {
  private ws: WebSocket | null = null;
  private running = false;
  private botUserId: string | null = null;
  private reconnectDelay = 1000;

  constructor(private readonly opts: SlackOptions) {}

  async start(): Promise<void> {
    const { appToken, botToken } = this.opts.config;
    if (!appToken || !botToken) {
      console.warn("[slack] missing appToken or botToken; skipping start");
      return;
    }
    if (this.running) return;
    this.running = true;
    await this.lookupSelf().catch((err) => console.warn("[slack] auth.test failed:", err));
    this.connect();
  }

  async stop(): Promise<void> {
    this.running = false;
    try { this.ws?.close(1000, "shutdown"); } catch {}
    this.ws = null;
    console.log("[slack] stopped");
  }

  private async lookupSelf(): Promise<void> {
    const res = await this.web("auth.test");
    if (res && res.ok) {
      this.botUserId = res.user_id ?? null;
      console.log(`[slack] authenticated as ${res.user} (${this.botUserId})`);
    }
  }

  private async connect(): Promise<void> {
    if (!this.running) return;
    let wssUrl: string;
    try {
      const res = await this.appLevel("apps.connections.open");
      if (!res?.ok || !res?.url) {
        throw new Error(`apps.connections.open returned ${JSON.stringify(res).slice(0, 200)}`);
      }
      wssUrl = res.url as string;
    } catch (err) {
      console.error("[slack] failed to open socket:", err);
      const delay = this.reconnectDelay;
      this.reconnectDelay = Math.min(delay * 2, 30_000);
      if (this.running) setTimeout(() => this.connect(), delay);
      return;
    }

    console.log("[slack] connecting to socket mode…");
    const ws = new WebSocket(wssUrl);
    this.ws = ws;
    ws.addEventListener("open", () => {
      console.log("[slack] socket connected");
      this.reconnectDelay = 1000;
    });
    ws.addEventListener("message", (event) => {
      let frame: any;
      try {
        frame = JSON.parse(typeof event.data === "string" ? event.data : "");
      } catch {
        return;
      }
      this.handleFrame(frame, ws).catch((err) =>
        console.error("[slack] frame handler error:", err),
      );
    });
    ws.addEventListener("close", (event) => {
      console.warn(`[slack] socket closed (${event.code}): ${event.reason || "no reason"}`);
      this.ws = null;
      if (!this.running) return;
      const delay = this.reconnectDelay;
      this.reconnectDelay = Math.min(delay * 2, 30_000);
      setTimeout(() => this.connect(), delay);
    });
    ws.addEventListener("error", (err) => console.error("[slack] socket error:", err));
  }

  private async handleFrame(frame: any, ws: WebSocket): Promise<void> {
    const t = frame?.type;
    if (t === "hello") return;
    if (t === "disconnect") {
      console.log("[slack] received disconnect — closing for reconnect");
      try { ws.close(4000, "disconnect"); } catch {}
      return;
    }
    if (t !== "events_api") return;
    const envelopeId = frame.envelope_id;
    // ACK envelope immediately so Slack doesn't redeliver.
    if (envelopeId && ws.readyState === WebSocket.OPEN) {
      try { ws.send(JSON.stringify({ envelope_id: envelopeId })); } catch {}
    }
    const event = frame.payload?.event;
    if (!event) return;
    if (event.type === "message") {
      await this.routeMessageEvent(event);
    }
  }

  private async routeMessageEvent(e: any): Promise<void> {
    // Skip bot's own messages and message_changed/deleted/etc subtypes.
    if (e.subtype && e.subtype !== "bot_message") return;
    const userId: string | undefined = e.user ?? e.bot_id;
    if (!userId) return;
    if (this.botUserId && userId === this.botUserId) return;

    const isBot = !!e.bot_id && !e.user;
    const config = this.opts.config;
    if (isBot) {
      if (!config.allowedBotIds.includes(userId)) return;
    } else {
      if (config.allowedUserIds.length > 0 && !config.allowedUserIds.includes(userId)) return;
    }

    const channelType: SlackInbound["channelType"] =
      e.channel_type === "im" ? "im"
        : e.channel_type === "channel" ? "channel"
        : e.channel_type === "group" ? "group"
        : e.channel_type === "mpim" ? "mpim"
        : "unknown";

    const attachments = await this.collectAttachments(e);
    await this.opts.router.handleMessage({
      channelId: e.channel,
      channelType,
      threadTs: e.thread_ts,
      messageTs: e.ts,
      fromUserId: userId,
      fromName: e.username ?? userId,
      isBot,
      text: e.text ?? "",
      attachments,
    });
  }

  private async collectAttachments(e: any): Promise<InboundAttachment[]> {
    const results: InboundAttachment[] = [];
    const files = Array.isArray(e.files) ? e.files : [];
    if (!files.length) return results;
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    const headers = { authorization: `Bearer ${this.opts.config.botToken}` };

    for (const f of files) {
      const url = f?.url_private_download ?? f?.url_private;
      if (!url) continue;
      const mime: string | undefined = f.mimetype;
      const name: string | undefined = f.name;
      let kind = kindFromMime(mime);
      // Slack voice memos surface as audio with subtype hints; the file
      // type "vorbis" / "webm" with mode "transcription" is the strongest
      // hint we can rely on without extra API calls.
      if (kind === "audio" && (f.subtype === "slack_audio" || f.mode === "transcription")) {
        kind = "voice";
      }
      const att = await downloadAttachment({
        url,
        headers,
        scope: e.channel,
        kind,
        ext: extFromName(name) || (mime ? `.${mime.split("/").pop()}` : ""),
        originalName: name,
        mimeType: mime,
        fileSize: typeof f.size === "number" ? f.size : undefined,
        duration: typeof f.duration_ms === "number" ? Math.round(f.duration_ms / 1000) : undefined,
        timestamp: ts,
      });
      if (att) results.push(att);
    }
    return results;
  }

  // --- REST outbound ---

  async sendMessage(channelId: string, text: string, threadTs?: string): Promise<string | undefined> {
    if (!text) return undefined;
    const chunks = chunkText(text);
    let firstTs: string | undefined;
    for (const chunk of chunks) {
      const res = await this.web("chat.postMessage", {
        channel: channelId,
        text: chunk,
        ...(threadTs ? { thread_ts: threadTs } : {}),
      });
      if (!res?.ok) {
        console.error(`[slack] chat.postMessage failed:`, res?.error ?? res);
        continue;
      }
      if (firstTs === undefined && typeof res.ts === "string") firstTs = res.ts;
    }
    return firstTs;
  }

  async editMessage(channelId: string, ts: string, text: string): Promise<boolean> {
    if (!text) return false;
    const chunks = chunkText(text);
    if (chunks.length !== 1) return false;
    const res = await this.web("chat.update", {
      channel: channelId,
      ts,
      text: chunks[0],
    });
    if (res?.ok) return true;
    console.error(`[slack] chat.update failed:`, res?.error ?? res);
    return false;
  }

  async deleteMessage(channelId: string, ts: string): Promise<boolean> {
    const res = await this.web("chat.delete", { channel: channelId, ts });
    if (res?.ok) return true;
    if (res?.error === "message_not_found") return true;
    console.error(`[slack] chat.delete failed:`, res?.error ?? res);
    return false;
  }

  async sendTypingAction(_channelId: string): Promise<void> {
    // Slack does not expose a bot typing indicator; intentional no-op.
  }

  async addReaction(channelId: string, messageTs: string, emoji: string): Promise<void> {
    // Slack reactions use shortcode (without colons). Strip colons if present.
    const name = emoji.replace(/^:|:$/g, "");
    const res = await this.web("reactions.add", {
      channel: channelId,
      timestamp: messageTs,
      name,
    });
    if (!res?.ok && res?.error !== "already_reacted") {
      console.error(`[slack] reactions.add failed:`, res?.error ?? res);
    }
  }

  private async web(method: string, body?: Record<string, unknown>): Promise<any> {
    const res = await fetch(`${WEB_API}/${method}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.opts.config.botToken}`,
        "content-type": "application/json; charset=utf-8",
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    return res.json().catch(() => null);
  }

  private async appLevel(method: string, body?: Record<string, unknown>): Promise<any> {
    const res = await fetch(`${WEB_API}/${method}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.opts.config.appToken}`,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: body ? new URLSearchParams(body as Record<string, string>).toString() : undefined,
    });
    return res.json().catch(() => null);
  }
}

const SLACK_MSG_LIMIT = 3500;

export function chunkText(text: string, max: number = SLACK_MSG_LIMIT): string[] {
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
