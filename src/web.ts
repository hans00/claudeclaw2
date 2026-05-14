/**
 * Local-only HTTP API for status + cross-session messaging.
 *
 * Endpoints:
 *   GET  /                   minimal HTML status page
 *   GET  /api/status         { running, projectDir, uptimeMs, channelCount }
 *   GET  /api/sessions       [{ channelKey, kind, sessionId, state, multiparty, lastActivityAt }, ...]
 *   POST /api/send           { target, text, fromLabel? } → write into target's inbox
 *   POST /api/trigger        { target, prompt, fromLabel?, replyTo? } → run the agent
 *
 * No auth — bound to 127.0.0.1 by default. If you ever expose it externally
 * add an auth header check before that ever ships.
 */
import { appendInbox } from "./inbox";
import { loadSessions, type ChannelSession } from "./sessions";
import type { Channel, ReplyTarget } from "./channel";
import type { WebConfig } from "./config";

export interface SessionView {
  channelKey: string;
  kind: ChannelSession["kind"];
  sessionId: string;
  multiparty: boolean;
  state: string;
  createdAt: string;
  lastActivityAt: string;
}

export interface WebDaemonView {
  projectDir: string;
  startedAt: number;
  /** Snapshot of currently-loaded channels (in-memory). */
  listChannels(): SessionView[];
  /** Resolve a channel by key, lazy-spawning if it's not yet loaded. */
  resolveChannel(target: string): Promise<Channel | null>;
}

export class WebServer {
  private server: ReturnType<typeof Bun.serve> | null = null;

  constructor(
    private readonly config: WebConfig,
    private readonly view: WebDaemonView,
  ) {}

  start(): void {
    if (!this.config.enabled) {
      console.log("[web] disabled in settings");
      return;
    }
    if (this.server) return;
    const handle = (req: Request) => this.handle(req);
    this.server = Bun.serve({
      hostname: this.config.host,
      port: this.config.port,
      fetch: handle,
    });
    console.log(`[web] listening on http://${this.config.host}:${this.config.port}`);
  }

  stop(): void {
    this.server?.stop();
    this.server = null;
  }

  private async handle(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;
    try {
      if (req.method === "GET" && path === "/") {
        return new Response(this.renderHome(), { headers: { "content-type": "text/html; charset=utf-8" } });
      }
      if (req.method === "GET" && path === "/api/status") {
        return this.json({
          running: true,
          projectDir: this.view.projectDir,
          startedAt: this.view.startedAt,
          uptimeMs: Date.now() - this.view.startedAt,
          channelCount: this.view.listChannels().length,
        });
      }
      if (req.method === "GET" && path === "/api/sessions") {
        // Merge in-memory channels with persisted sessions.json snapshot.
        const persisted = await loadSessions();
        const inMemory = new Map(this.view.listChannels().map((c) => [c.channelKey, c]));
        const merged: SessionView[] = [];
        for (const [key, s] of Object.entries(persisted)) {
          const live = inMemory.get(key);
          merged.push({
            channelKey: key,
            kind: s.kind,
            sessionId: s.sessionId,
            multiparty: s.multiparty,
            state: live?.state ?? "cold",
            createdAt: s.createdAt,
            lastActivityAt: s.lastActivityAt,
          });
        }
        return this.json(merged);
      }
      if (req.method === "POST" && path === "/api/send") {
        const body: any = await req.json().catch(() => null);
        if (!body || typeof body.target !== "string" || typeof body.text !== "string") {
          return this.json({ error: "expected { target: string, text: string, fromLabel?: string }" }, 400);
        }
        await appendInbox(body.target, {
          kind: "external",
          from: body.fromLabel ?? "(api)",
          text: body.text,
        });
        return this.json({ ok: true, delivered: "inbox", target: body.target });
      }
      if (req.method === "POST" && path === "/api/trigger") {
        const body: any = await req.json().catch(() => null);
        if (!body || typeof body.target !== "string" || typeof body.prompt !== "string") {
          return this.json({ error: "expected { target: string, prompt: string, fromLabel?: string, replyTo?: ReplyTarget }" }, 400);
        }
        const channel = await this.view.resolveChannel(body.target);
        if (!channel) return this.json({ error: `target "${body.target}" not resolvable` }, 404);
        const replyTo = parseReplyTo(body.replyTo);
        await channel.handleIncoming({
          text: body.prompt,
          fromLabel: body.fromLabel ?? "(api)",
          replyTo,
        });
        return this.json({ ok: true, dispatched: true, target: body.target });
      }
      return this.json({ error: "not found" }, 404);
    } catch (err) {
      console.error("[web] handler error:", err);
      return this.json({ error: (err as Error).message }, 500);
    }
  }

  private json(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body, null, 2), {
      status,
      headers: { "content-type": "application/json; charset=utf-8" },
    });
  }

  private renderHome(): string {
    const channels = this.view.listChannels();
    const rows = channels
      .map(
        (c) =>
          `<tr><td>${esc(c.channelKey)}</td><td>${esc(c.kind)}</td><td>${esc(c.state)}</td><td>${esc(c.lastActivityAt)}</td></tr>`,
      )
      .join("\n");
    const up = Math.round((Date.now() - this.view.startedAt) / 1000);
    return `<!doctype html><html><head><meta charset="utf-8"><title>ClaudeClaw v2</title>
<style>body{font-family:ui-sans-serif,system-ui;padding:2rem;color:#222}
table{border-collapse:collapse;width:100%;margin-top:1rem}
th,td{border-bottom:1px solid #eee;padding:.4rem .6rem;text-align:left;font-size:.9rem}
th{background:#f6f6f6}
code{background:#f3f3f3;padding:0 .3rem;border-radius:3px}
</style></head><body>
<h1>🦞 ClaudeClaw v2</h1>
<p>Project: <code>${esc(this.view.projectDir)}</code> · Uptime: ${up}s · Channels: ${channels.length}</p>
<table><thead><tr><th>channelKey</th><th>kind</th><th>state</th><th>last activity</th></tr></thead>
<tbody>${rows || `<tr><td colspan="4"><em>(no channels)</em></td></tr>`}</tbody></table>
<h3>API</h3>
<ul>
  <li><code>GET /api/status</code></li>
  <li><code>GET /api/sessions</code></li>
  <li><code>POST /api/send</code> — body: <code>{ target, text, fromLabel? }</code></li>
  <li><code>POST /api/trigger</code> — body: <code>{ target, prompt, fromLabel?, replyTo? }</code></li>
</ul>
</body></html>`;
  }
}

function parseReplyTo(input: unknown): ReplyTarget {
  if (!input || typeof input !== "object") return null;
  const r = input as Record<string, unknown>;
  if (r.platform === "telegram" && typeof r.chatId === "number") {
    return { platform: "telegram", chatId: r.chatId, messageId: typeof r.messageId === "number" ? r.messageId : undefined };
  }
  if (r.platform === "discord" && typeof r.channelId === "string") {
    return { platform: "discord", channelId: r.channelId, messageId: typeof r.messageId === "string" ? r.messageId : undefined };
  }
  if (r.platform === "slack" && typeof r.channelId === "string") {
    return {
      platform: "slack",
      channelId: r.channelId,
      threadTs: typeof r.threadTs === "string" ? r.threadTs : undefined,
      messageTs: typeof r.messageTs === "string" ? r.messageTs : undefined,
    };
  }
  return null;
}

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) =>
    c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : "&quot;",
  );
}
