/**
 * Local HTTP server: API + minimal HTML dashboard.
 *
 * Endpoints:
 *   GET  /                              dashboard home (sessions table)
 *   GET  /sessions/:channelKey          jsonl transcript viewer
 *   GET  /jobs                          cron jobs list
 *   GET  /logs                          available daemon logs
 *   GET  /logs/:name                    last N lines of a log
 *   GET  /api/status                    daemon info
 *   GET  /api/sessions                  session metadata list
 *   GET  /api/sessions/:key/transcript  parsed jsonl events
 *   POST /api/send                      { target, text, fromLabel? }
 *   POST /api/trigger                   { target, prompt, fromLabel?, replyTo? }
 *
 * No auth — bound to 127.0.0.1 by default.
 */
import { readdir, readFile, stat } from "fs/promises";
import { homedir } from "os";
import { join } from "path";
import { appendInbox } from "./inbox";
import { parseLine, type JsonlEvent } from "./jsonl";
import { loadJobs, type Job } from "./jobs";
import { nextCronMatch } from "./cron";
import { loadSessions, type ChannelSession } from "./sessions";
import type { Channel, ReplyTarget } from "./channel";
import type { WebConfig } from "./config";

const LOGS_DIR = join(".claude", "claudeclaw", "logs");

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
  listChannels(): SessionView[];
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
    this.server = Bun.serve({
      hostname: this.config.host,
      port: this.config.port,
      fetch: (req) => this.handle(req),
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
      if (req.method === "GET" && path === "/") return this.html(await this.renderHome());
      if (req.method === "GET" && path === "/jobs") return this.html(await this.renderJobs());
      if (req.method === "GET" && path === "/logs") return this.html(await this.renderLogsList());

      const logMatch = req.method === "GET" && path.startsWith("/logs/");
      if (logMatch) {
        const name = decodeURIComponent(path.slice("/logs/".length));
        return this.html(await this.renderLog(name));
      }

      const sessMatch = req.method === "GET" && path.startsWith("/sessions/");
      if (sessMatch) {
        const key = decodeURIComponent(path.slice("/sessions/".length));
        const limitParam = url.searchParams.get("limit");
        const limit = limitParam ? Math.max(1, Math.min(5000, Number(limitParam) || 200)) : 200;
        return this.html(await this.renderTranscript(key, limit));
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
        return this.json(await this.mergedSessions());
      }
      const apiTranscript = path.match(/^\/api\/sessions\/([^/]+)\/transcript$/);
      if (req.method === "GET" && apiTranscript) {
        const key = decodeURIComponent(apiTranscript[1]);
        const events = await this.transcriptEvents(key);
        return this.json(events);
      }
      if (req.method === "POST" && path === "/api/send") {
        const body: any = await req.json().catch(() => null);
        if (!body || typeof body.target !== "string" || typeof body.text !== "string") {
          return this.json({ error: "expected { target, text, fromLabel? }" }, 400);
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
          return this.json({ error: "expected { target, prompt, fromLabel?, replyTo? }" }, 400);
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

  private html(body: string, status = 200): Response {
    return new Response(body, {
      status,
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  }

  // --- HTML pages ---

  private async renderHome(): Promise<string> {
    const channels = await this.mergedSessions();
    const rows = channels
      .map(
        (c) =>
          `<tr><td><a href="/sessions/${encodeURIComponent(c.channelKey)}">${esc(c.channelKey)}</a></td>` +
            `<td>${esc(c.kind)}</td><td>${esc(c.state)}</td><td>${esc(c.lastActivityAt)}</td>` +
            `<td><code>${esc(c.sessionId.slice(0, 8))}</code></td></tr>`,
      )
      .join("\n");
    const up = Math.round((Date.now() - this.view.startedAt) / 1000);
    return layout(
      "ClaudeClaw v2",
      `<h1>🦞 ClaudeClaw v2</h1>
<p>Project: <code>${esc(this.view.projectDir)}</code> · Uptime: ${formatDuration(up)} · Channels: ${channels.length}</p>
<table><thead><tr><th>channelKey</th><th>kind</th><th>state</th><th>last activity</th><th>session</th></tr></thead>
<tbody>${rows || `<tr><td colspan="5"><em>(no channels)</em></td></tr>`}</tbody></table>
<h3>Other views</h3>
<ul>
  <li><a href="/jobs">/jobs</a> — scheduled cron jobs</li>
  <li><a href="/logs">/logs</a> — daemon log files</li>
</ul>
<h3>API</h3>
<ul>
  <li><code>GET /api/status</code></li>
  <li><code>GET /api/sessions</code></li>
  <li><code>GET /api/sessions/:channelKey/transcript</code></li>
  <li><code>POST /api/send</code></li>
  <li><code>POST /api/trigger</code></li>
</ul>`,
    );
  }

  private async renderTranscript(channelKey: string, limit: number): Promise<string> {
    const events = await this.transcriptEvents(channelKey);
    if (!events) {
      return layout(
        `transcript ${channelKey}`,
        `<p><a href="/">← home</a></p><p>session not found for <code>${esc(channelKey)}</code></p>`,
      );
    }
    const total = events.length;
    const sliced = events.slice(Math.max(0, total - limit));
    const truncated = total - sliced.length;
    const blocks: string[] = [];
    for (const ev of sliced) {
      const time = ev.timestamp ? esc(ev.timestamp.slice(11, 19)) : "";
      switch (ev.type) {
        case "user-message":
          blocks.push(
            `<div class="msg user"><div class="meta">${time} · user</div><pre>${esc(ev.userText ?? "")}</pre></div>`,
          );
          break;
        case "assistant-text":
          blocks.push(
            `<div class="msg assistant"><div class="meta">${time} · assistant · ${esc(ev.stopReason ?? "")}</div><pre>${esc(ev.text ?? "")}</pre></div>`,
          );
          break;
        case "assistant-thinking":
          blocks.push(
            `<div class="msg thinking"><div class="meta">${time} · thinking</div><pre>${esc((ev.text ?? "").slice(0, 800))}</pre></div>`,
          );
          break;
        case "assistant-tool-use":
          blocks.push(
            `<div class="msg tool"><div class="meta">${time} · tool · ${esc(ev.toolName ?? "")}</div><pre>${esc(JSON.stringify(ev.toolInput, null, 2)).slice(0, 1200)}</pre></div>`,
          );
          break;
        case "user-tool-result":
          blocks.push(
            `<div class="msg result${ev.toolResultIsError ? " error" : ""}"><div class="meta">${time} · result${ev.toolResultIsError ? " (error)" : ""}</div><pre>${esc((ev.toolResult ?? "").slice(0, 1200))}</pre></div>`,
          );
          break;
      }
    }
    const keyEnc = encodeURIComponent(channelKey);
    const nextLimit = limit < total ? Math.min(total, limit * 2) : null;
    const navParts: string[] = [
      `${total} events`,
      truncated > 0 ? `showing latest ${sliced.length} (${truncated} earlier hidden)` : `showing all`,
    ];
    const links: string[] = [];
    if (nextLimit && nextLimit > limit) {
      links.push(`<a href="/sessions/${keyEnc}?limit=${nextLimit}">load earlier (${nextLimit})</a>`);
    }
    if (limit < total) {
      links.push(`<a href="/sessions/${keyEnc}?limit=${total}">show all ${total}</a>`);
    }
    links.push(`<a href="/api/sessions/${keyEnc}/transcript">JSON</a>`);
    return layout(
      `transcript ${channelKey}`,
      `<p><a href="/">← home</a></p>
<h1>${esc(channelKey)}</h1>
<p class="dim">${navParts.join(" · ")} · ${links.join(" · ")}</p>
<div class="transcript">${blocks.join("\n")}</div>`,
    );
  }

  private async renderJobs(): Promise<string> {
    const jobs = await loadJobs().catch(() => [] as Job[]);
    const now = new Date();
    const rows = jobs
      .map((j) => {
        let next = "—";
        try {
          next = new Date(nextCronMatch(j.schedule, now, j.timezoneOffsetMinutes)).toISOString();
        } catch {}
        return `<tr><td>${esc(j.name)}</td><td><code>${esc(j.schedule)}</code></td><td>${esc(j.target)}</td><td>${esc(next)}</td><td>${j.recurring ? "♻" : "1×"}</td></tr>`;
      })
      .join("\n");
    return layout(
      "jobs",
      `<p><a href="/">← home</a></p><h1>cron jobs</h1>
<table><thead><tr><th>name</th><th>schedule</th><th>target</th><th>next fire</th><th></th></tr></thead>
<tbody>${rows || `<tr><td colspan="5"><em>(no jobs)</em></td></tr>`}</tbody></table>`,
    );
  }

  private async renderLogsList(): Promise<string> {
    const MAX = 50;
    let names: string[] = [];
    try {
      names = (await readdir(LOGS_DIR)).filter((n) => n.endsWith(".log"));
    } catch {}
    // Sort by mtime desc — newest first.
    const stats = await Promise.all(
      names.map(async (n) => {
        const p = join(LOGS_DIR, n);
        try {
          const s = await stat(p);
          return { n, size: s.size, mtime: s.mtimeMs };
        } catch {
          return { n, size: 0, mtime: 0 };
        }
      }),
    );
    stats.sort((a, b) => b.mtime - a.mtime);
    const shown = stats.slice(0, MAX);
    const hidden = stats.length - shown.length;
    const rows = shown.map(
      ({ n, size, mtime }) => {
        const when = mtime ? new Date(mtime).toISOString().slice(0, 19).replace("T", " ") : "?";
        return `<tr><td><a href="/logs/${encodeURIComponent(n)}">${esc(n)}</a></td><td>${formatBytes(size)}</td><td class="dim">${when}</td></tr>`;
      },
    );
    const footer = hidden > 0 ? `<p class="dim">${hidden} older log file(s) not shown</p>` : "";
    return layout(
      "logs",
      `<p><a href="/">← home</a></p><h1>logs</h1>
<table><thead><tr><th>file</th><th>size</th><th>mtime</th></tr></thead>
<tbody>${rows.join("\n") || `<tr><td colspan="3"><em>(no logs yet)</em></td></tr>`}</tbody></table>
${footer}`,
    );
  }

  private async renderLog(name: string): Promise<string> {
    if (!/^[A-Za-z0-9._-]+\.log$/.test(name)) {
      return layout("log", `<p><a href="/logs">← logs</a></p><p>invalid log name</p>`);
    }
    const p = join(LOGS_DIR, name);
    let content = "";
    try {
      const raw = await readFile(p, "utf8");
      const lines = raw.split("\n");
      const tail = lines.slice(-500);
      content = tail.join("\n");
    } catch {
      return layout("log", `<p><a href="/logs">← logs</a></p><p>could not read ${esc(name)}</p>`);
    }
    return layout(
      name,
      `<p><a href="/logs">← logs</a></p><h1>${esc(name)}</h1><pre class="log">${esc(content)}</pre>`,
    );
  }

  // --- Data helpers ---

  private async mergedSessions(): Promise<SessionView[]> {
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
    merged.sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt));
    return merged;
  }

  private async transcriptEvents(channelKey: string): Promise<JsonlEvent[] | null> {
    const persisted = await loadSessions();
    const session = persisted[channelKey];
    if (!session) return null;
    const encoded = this.view.projectDir.replace(/\//g, "-");
    const path = join(homedir(), ".claude", "projects", encoded, `${session.sessionId}.jsonl`);
    let raw: string;
    try {
      raw = await readFile(path, "utf8");
    } catch {
      return [];
    }
    const events: JsonlEvent[] = [];
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      events.push(...parseLine(line));
    }
    return events;
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
  if (r.platform === "line" && typeof r.to === "string") {
    return { platform: "line", to: r.to, messageId: typeof r.messageId === "string" ? r.messageId : undefined };
  }
  return null;
}

function layout(title: string, body: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title>
<style>
body{font-family:ui-sans-serif,system-ui,sans-serif;padding:1.5rem;color:#222;max-width:1000px;margin:0 auto}
a{color:#0066cc;text-decoration:none}a:hover{text-decoration:underline}
h1{margin-top:0}
table{border-collapse:collapse;width:100%;margin:.5rem 0 1.5rem}
th,td{border-bottom:1px solid #eee;padding:.4rem .6rem;text-align:left;font-size:.9rem;vertical-align:top}
th{background:#f6f6f6;font-weight:600}
code{background:#f3f3f3;padding:0 .3rem;border-radius:3px;font-size:.85em}
.dim{color:#888;font-size:.85em}
.transcript{margin-top:1rem}
.msg{border-left:3px solid #ccc;padding:.4rem .8rem;margin:.5rem 0;background:#fafafa;border-radius:0 4px 4px 0}
.msg .meta{font-size:.75em;color:#888;margin-bottom:.2rem}
.msg pre{margin:0;white-space:pre-wrap;word-wrap:break-word;font-family:ui-monospace,monospace;font-size:.85em}
.msg.user{border-left-color:#3b82f6;background:#eff6ff}
.msg.assistant{border-left-color:#10b981;background:#ecfdf5}
.msg.thinking{border-left-color:#a78bfa;background:#f5f3ff;color:#666;font-style:italic}
.msg.tool{border-left-color:#f59e0b;background:#fffbeb}
.msg.result{border-left-color:#94a3b8;background:#f8fafc}
.msg.result.error{border-left-color:#ef4444;background:#fef2f2}
pre.log{background:#0f1116;color:#cdd6f4;padding:1rem;border-radius:4px;overflow:auto;font-size:.8em;max-height:80vh;white-space:pre-wrap;word-wrap:break-word}
</style></head><body>${body}</body></html>`;
}

function esc(s: string): string {
  return String(s).replace(/[&<>"]/g, (c) =>
    c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : "&quot;",
  );
}

function formatDuration(s: number): string {
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
