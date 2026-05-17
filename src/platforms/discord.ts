/**
 * Discord bot connector — Gateway WebSocket + REST.
 *
 * Scope (MVP):
 *   - Gateway: connect, identify, heartbeat, naive reconnect
 *   - Receive MESSAGE_CREATE; route DMs to "global", guild messages to
 *     "discord:<channelId>" with allowlist + requireMention enforcement
 *   - Outbound: REST chat send (chunked at 2000 chars) + add reaction
 *
 * Not in scope yet: voice, threads (Discord-thread), edits, slash commands,
 * Resume (we always re-Identify on reconnect — simpler, only slightly less
 * efficient).
 */
import {
  downloadAttachment,
  extFromName,
  kindFromMime,
  type InboundAttachment,
} from "../attachments";
import type { DiscordConfig, DiscordChannelConfig } from "../config";

const GATEWAY_URL = "wss://gateway.discord.gg/?v=10&encoding=json";
const REST_BASE = "https://discord.com/api/v10";

// Intents bitmask. GUILD_MESSAGES + DIRECT_MESSAGES + MESSAGE_CONTENT.
// MESSAGE_CONTENT is a privileged intent — must be enabled in dev portal.
const INTENT_GUILD_MESSAGES = 1 << 9;
const INTENT_DIRECT_MESSAGES = 1 << 12;
const INTENT_MESSAGE_CONTENT = 1 << 15;
const INTENT_GUILDS = 1 << 0; // needed for guild metadata cache (some events)
const INTENTS = INTENT_GUILDS | INTENT_GUILD_MESSAGES | INTENT_DIRECT_MESSAGES | INTENT_MESSAGE_CONTENT;

const OP_DISPATCH = 0;
const OP_HEARTBEAT = 1;
const OP_IDENTIFY = 2;
const OP_RECONNECT = 7;
const OP_INVALID_SESSION = 9;
const OP_HELLO = 10;
const OP_HEARTBEAT_ACK = 11;

export interface DiscordInbound {
  guildId: string | null;
  channelId: string;
  messageId: string;
  fromUserId: string;
  fromName: string;
  /** Discord username (the unique handle, distinct from display name). */
  fromUsername?: string;
  isBot: boolean;
  mentionsBot: boolean;
  text: string;
  attachments: InboundAttachment[];
}

// Discord message flag bits we care about. VOICE_MESSAGE marks the message
// as a "voice note" so we tag the attachment with kind="voice" instead of
// the generic "audio".
const FLAG_VOICE_MESSAGE = 1 << 13; // 8192

export interface DiscordRouter {
  handleMessage(msg: DiscordInbound): Promise<void>;
}

export interface DiscordSender {
  sendMessage(channelId: string, text: string): Promise<string | undefined>;
  editMessage(channelId: string, messageId: string, text: string): Promise<boolean>;
  deleteMessage(channelId: string, messageId: string): Promise<boolean>;
  addReaction(channelId: string, messageId: string, emoji: string): Promise<void>;
  sendTypingAction(channelId: string): Promise<void>;
}

export interface DiscordOptions {
  config: DiscordConfig;
  router: DiscordRouter;
}

export class DiscordPlatform implements DiscordSender {
  private ws: WebSocket | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private heartbeatIntervalMs = 0;
  private lastSeq: number | null = null;
  private botUserId: string | null = null;
  private running = false;
  private reconnectDelay = 1000;
  private pendingSlashCommands: Array<{ name: string; description: string }> | null = null;

  constructor(private readonly opts: DiscordOptions) {}

  async start(): Promise<void> {
    if (!this.opts.config.token) {
      console.warn("[discord] no token configured; skipping start");
      return;
    }
    if (this.running) return;
    this.running = true;
    this.connect();
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
    try {
      this.ws?.close(1000, "shutdown");
    } catch {}
    this.ws = null;
    console.log("[discord] stopped");
  }

  private connect(): void {
    if (!this.running) return;
    console.log("[discord] connecting to gateway…");
    const ws = new WebSocket(GATEWAY_URL);
    this.ws = ws;
    ws.addEventListener("open", () => {
      console.log("[discord] gateway connected");
    });
    ws.addEventListener("message", (event) => {
      let payload: any;
      try {
        payload = JSON.parse(typeof event.data === "string" ? event.data : "");
      } catch (err) {
        console.error("[discord] bad gateway frame:", err);
        return;
      }
      this.handleFrame(payload).catch((err) => console.error("[discord] handler error:", err));
    });
    ws.addEventListener("close", (event) => {
      console.warn(`[discord] gateway closed (${event.code}): ${event.reason || "no reason"}`);
      this.cleanupHeartbeat();
      this.ws = null;
      this.lastSeq = null;
      if (!this.running) return;
      // Fatal codes that mean "stop forever" per Discord docs.
      const fatal = new Set([4004, 4010, 4011, 4012, 4013, 4014]);
      if (fatal.has(event.code)) {
        console.error(`[discord] fatal close code ${event.code} — not reconnecting`);
        this.running = false;
        return;
      }
      const delay = this.reconnectDelay;
      this.reconnectDelay = Math.min(delay * 2, 30_000);
      setTimeout(() => this.connect(), delay);
    });
    ws.addEventListener("error", (err) => {
      console.error("[discord] gateway error:", err);
    });
  }

  private async handleFrame(p: any): Promise<void> {
    const { op, t, s, d } = p;
    if (typeof s === "number") this.lastSeq = s;
    if (op === OP_HELLO) {
      this.heartbeatIntervalMs = d?.heartbeat_interval ?? 41_250;
      this.startHeartbeat();
      this.sendIdentify();
    } else if (op === OP_HEARTBEAT) {
      this.sendHeartbeat();
    } else if (op === OP_HEARTBEAT_ACK) {
      // ok
    } else if (op === OP_RECONNECT) {
      console.warn("[discord] gateway asked us to reconnect");
      try {
        this.ws?.close(4000, "reconnect requested");
      } catch {}
    } else if (op === OP_INVALID_SESSION) {
      console.warn("[discord] invalid session — re-identifying after delay");
      setTimeout(() => this.sendIdentify(), 2000);
    } else if (op === OP_DISPATCH) {
      this.reconnectDelay = 1000; // healthy traffic → reset backoff
      await this.handleDispatch(t, d);
    }
  }

  private startHeartbeat(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    // First heartbeat after random 0..interval jitter, then every interval.
    const jitter = Math.random() * this.heartbeatIntervalMs;
    setTimeout(() => {
      if (!this.running) return;
      this.sendHeartbeat();
      this.heartbeatTimer = setInterval(() => this.sendHeartbeat(), this.heartbeatIntervalMs);
    }, jitter);
  }

  private cleanupHeartbeat(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }

  private sendHeartbeat(): void {
    this.sendOp(OP_HEARTBEAT, this.lastSeq);
  }

  private sendIdentify(): void {
    this.sendOp(OP_IDENTIFY, {
      token: this.opts.config.token,
      intents: INTENTS,
      properties: {
        os: process.platform,
        browser: "claudeclaw",
        device: "claudeclaw",
      },
    });
  }

  private sendOp(op: number, d: unknown): void {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    try {
      ws.send(JSON.stringify({ op, d }));
    } catch (err) {
      console.error(`[discord] send op=${op} failed:`, err);
    }
  }

  private async handleDispatch(t: string, d: any): Promise<void> {
    if (t === "READY") {
      this.botUserId = d?.user?.id ?? null;
      console.log(`[discord] READY as ${d?.user?.username} (${this.botUserId})`);
      if (this.pendingSlashCommands) {
        void this.doRegisterGlobalCommands(this.pendingSlashCommands);
        this.pendingSlashCommands = null;
      }
      return;
    }
    if (t === "MESSAGE_CREATE") {
      await this.routeMessageCreate(d);
    }
  }

  private async routeMessageCreate(m: any): Promise<void> {
    if (!m || !m.author) return;
    if (this.botUserId && m.author.id === this.botUserId) return;

    const config = this.opts.config;
    const userId = m.author.id as string;
    const isBot = m.author.bot === true;
    const text: string = m.content ?? "";
    const guildId: string | null = m.guild_id ?? null;
    const channelId = m.channel_id as string;

    // Allowlist: users (always) + bots (only when explicitly allowed).
    if (isBot) {
      if (!config.allowedBotIds.includes(userId)) return;
    } else {
      if (config.allowedUserIds.length > 0 && !config.allowedUserIds.includes(userId)) return;
    }

    // Guild channel allowlist + per-channel requireMention.
    let mentionsBot = false;
    if (Array.isArray(m.mentions) && this.botUserId) {
      mentionsBot = m.mentions.some((u: any) => u?.id === this.botUserId);
    }
    if (guildId) {
      const chConfig: DiscordChannelConfig | undefined = config.channels[channelId];
      if (!chConfig?.enabled) return;
      if (chConfig.requireMention && !mentionsBot) return;
      if (chConfig.ignoreOtherMentions && !mentionsBot && Array.isArray(m.mentions) && m.mentions.length > 0) {
        // someone else is being mentioned but not us — stay quiet
        return;
      }
    }

    const fromName = String(m.author.global_name ?? m.author.username ?? userId);
    const fromUsername = typeof m.author.username === "string" ? m.author.username : undefined;
    const attachments = await this.collectAttachments(m, channelId);
    await this.opts.router.handleMessage({
      guildId,
      channelId,
      messageId: m.id,
      fromUserId: userId,
      fromName,
      fromUsername,
      isBot,
      mentionsBot,
      text,
      attachments,
    });
  }

  private async collectAttachments(m: any, channelId: string): Promise<InboundAttachment[]> {
    const results: InboundAttachment[] = [];
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    const isVoiceMsg = typeof m.flags === "number" && (m.flags & FLAG_VOICE_MESSAGE) !== 0;

    if (Array.isArray(m.attachments)) {
      for (const a of m.attachments) {
        if (!a?.url) continue;
        const mime: string | undefined = a.content_type;
        const filename: string | undefined = a.filename;
        let kind = kindFromMime(mime);
        // A voice-flagged message's audio attachment is a "voice" note.
        if (isVoiceMsg && kind === "audio") kind = "voice";
        const att = await downloadAttachment({
          url: a.url,
          scope: channelId,
          kind,
          ext: extFromName(filename),
          originalName: filename,
          mimeType: mime,
          fileSize: typeof a.size === "number" ? a.size : undefined,
          duration: typeof a.duration_secs === "number" ? a.duration_secs : undefined,
          timestamp: ts,
        });
        if (att) results.push(att);
      }
    }

    // Stickers come as separate objects with CDN urls. Pull each as a webp.
    if (Array.isArray(m.sticker_items)) {
      for (const s of m.sticker_items) {
        if (!s?.id) continue;
        const url = `https://media.discordapp.net/stickers/${s.id}.webp`;
        const att = await downloadAttachment({
          url,
          scope: channelId,
          kind: "sticker",
          ext: ".webp",
          originalName: s.name,
          mimeType: "image/webp",
          timestamp: ts,
        });
        if (att) results.push(att);
      }
    }

    return results;
  }

  // --- REST outbound ---

  async sendMessage(channelId: string, text: string): Promise<string | undefined> {
    if (!text) return undefined;
    const chunks = chunkText(text);
    let firstId: string | undefined;
    for (const chunk of chunks) {
      const res = await this.rest("POST", `/channels/${channelId}/messages`, { content: chunk });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        console.error(`[discord] sendMessage ${res.status}: ${body.slice(0, 200)}`);
        continue;
      }
      const data: any = await res.json().catch(() => null);
      if (firstId === undefined && typeof data?.id === "string") firstId = data.id;
    }
    return firstId;
  }

  async editMessage(channelId: string, messageId: string, text: string): Promise<boolean> {
    if (!text) return false;
    const chunks = chunkText(text);
    if (chunks.length !== 1) return false;
    const res = await this.rest(
      "PATCH",
      `/channels/${channelId}/messages/${messageId}`,
      { content: chunks[0] },
    );
    if (res.ok) return true;
    const body = await res.text().catch(() => "");
    console.error(`[discord] editMessage ${res.status}: ${body.slice(0, 200)}`);
    return false;
  }

  async deleteMessage(channelId: string, messageId: string): Promise<boolean> {
    const res = await this.rest("DELETE", `/channels/${channelId}/messages/${messageId}`);
    if (res.ok || res.status === 204 || res.status === 404) return true;
    const body = await res.text().catch(() => "");
    console.error(`[discord] deleteMessage ${res.status}: ${body.slice(0, 200)}`);
    return false;
  }

  async sendTypingAction(channelId: string): Promise<void> {
    try {
      await this.rest("POST", `/channels/${channelId}/typing`);
    } catch (err) {
      console.error(`[discord] typing failed:`, err instanceof Error ? err.message : err);
    }
  }

  async addReaction(channelId: string, messageId: string, emoji: string): Promise<void> {
    const encoded = encodeURIComponent(emoji);
    const res = await this.rest(
      "PUT",
      `/channels/${channelId}/messages/${messageId}/reactions/${encoded}/@me`,
    );
    if (!res.ok && res.status !== 204) {
      const body = await res.text().catch(() => "");
      console.error(`[discord] addReaction ${res.status}: ${body.slice(0, 200)}`);
    }
  }

  /** Register (or overwrite) global application slash commands.
   *  Safe to call before READY — queued and replayed on connect. */
  async registerGlobalCommands(commands: Array<{ name: string; description: string }>): Promise<void> {
    if (!this.opts.config.token) return;
    if (this.botUserId) {
      void this.doRegisterGlobalCommands(commands);
    } else {
      this.pendingSlashCommands = commands;
    }
  }

  private async doRegisterGlobalCommands(commands: Array<{ name: string; description: string }>): Promise<void> {
    if (!this.botUserId) return;
    const body = commands.map((c) => ({ name: c.name, description: c.description || "-", type: 1 }));
    try {
      const res = await this.rest("PUT", `/applications/${this.botUserId}/commands`, body);
      if (res.ok) {
        console.log(`[discord] registered ${commands.length} global slash command(s)`);
      } else {
        const detail = await res.text().catch(() => "");
        console.error(`[discord] slash command registration failed ${res.status}: ${detail}`);
      }
    } catch (err) {
      console.error("[discord] slash command registration error:", err);
    }
  }

  private async rest(method: string, path: string, body?: unknown): Promise<Response> {
    return fetch(`${REST_BASE}${path}`, {
      method,
      headers: {
        authorization: `Bot ${this.opts.config.token}`,
        "content-type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }
}

const DISCORD_MSG_LIMIT = 1900; // Discord hard limit 2000; reserve some for splitting.

export function chunkText(text: string, max: number = DISCORD_MSG_LIMIT): string[] {
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
