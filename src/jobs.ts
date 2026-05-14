/**
 * Cron job loader + scheduler.
 *
 * Jobs live as markdown files at `.claude/claudeclaw/jobs/<name>.md` with
 * YAML-ish frontmatter:
 *
 *   ---
 *   schedule: "0 23 * * *"
 *   recurring: true
 *   target: "global"             # default
 *   replyTo: "telegram:116013788" # optional outbound sink
 *   timezone: "+08:00"           # optional, default UTC
 *   ---
 *   <prompt body>
 *
 * On each minute tick, jobs whose schedule matches the current minute are
 * fired into the target channel's queue. Non-recurring jobs delete the
 * file after firing so they only run once.
 */
import { readdir, readFile, unlink } from "fs/promises";
import { join, basename, extname } from "path";
import { cronMatches } from "./cron";
import type { ReplyTarget } from "./channel";
import { GLOBAL_KEY } from "./sessions";

const JOBS_DIR = join(".claude", "claudeclaw", "jobs");

export interface Job {
  name: string;
  filePath: string;
  schedule: string;
  recurring: boolean;
  target: string;
  replyTo: ReplyTarget;
  timezoneOffsetMinutes: number;
  body: string;
}

interface Frontmatter {
  meta: Record<string, string>;
  body: string;
}

function parseFrontmatter(content: string): Frontmatter {
  if (!content.startsWith("---")) return { meta: {}, body: content };
  // Match the leading "---\n" then the closing "\n---\n".
  const rest = content.slice(content.indexOf("\n") + 1);
  const end = rest.indexOf("\n---");
  if (end < 0) return { meta: {}, body: content };
  const headerBlock = rest.slice(0, end);
  const body = rest.slice(end + 4).replace(/^\n/, "");
  const meta: Record<string, string> = {};
  for (const line of headerBlock.split("\n")) {
    const m = /^([a-zA-Z_][a-zA-Z0-9_-]*)\s*:\s*(.*)$/.exec(line);
    if (!m) continue;
    let v = m[2].trim();
    if (
      (v.startsWith('"') && v.endsWith('"')) ||
      (v.startsWith("'") && v.endsWith("'"))
    ) {
      v = v.slice(1, -1);
    }
    meta[m[1]] = v;
  }
  return { meta, body: body.trim() };
}

function parseReplyTo(value: string | undefined): ReplyTarget {
  if (!value) return null;
  const v = value.trim();
  if (!v) return null;
  const colon = v.indexOf(":");
  if (colon < 0) return null;
  const platform = v.slice(0, colon);
  const id = v.slice(colon + 1);
  if (platform === "telegram") {
    const chatId = Number(id);
    if (!Number.isFinite(chatId)) return null;
    return { platform: "telegram", chatId };
  }
  if (platform === "discord") {
    return { platform: "discord", channelId: id };
  }
  return null;
}

/** Parse "+08:00" / "-05:30" / "UTC" / "" into minutes. */
function parseTimezone(value: string | undefined): number {
  if (!value) return 0;
  const v = value.trim();
  if (!v || v.toUpperCase() === "UTC") return 0;
  const m = /^([+-])(\d{1,2}):?(\d{2})?$/.exec(v);
  if (!m) return 0;
  const sign = m[1] === "-" ? -1 : 1;
  const hh = Number(m[2]);
  const mm = Number(m[3] ?? "0");
  return sign * (hh * 60 + mm);
}

export async function loadJobs(): Promise<Job[]> {
  let files: string[];
  try {
    files = await readdir(JOBS_DIR);
  } catch (err: any) {
    if (err?.code === "ENOENT") return [];
    throw err;
  }
  const jobs: Job[] = [];
  for (const name of files) {
    if (extname(name).toLowerCase() !== ".md") continue;
    const filePath = join(JOBS_DIR, name);
    let content: string;
    try {
      content = await readFile(filePath, "utf8");
    } catch (err) {
      console.warn(`[jobs] could not read ${filePath}:`, err);
      continue;
    }
    const { meta, body } = parseFrontmatter(content);
    if (!meta.schedule) {
      console.warn(`[jobs] ${name}: missing 'schedule' field — skipping`);
      continue;
    }
    const job: Job = {
      name: basename(name, ".md"),
      filePath,
      schedule: meta.schedule,
      recurring: meta.recurring === undefined ? true : meta.recurring.toLowerCase() !== "false",
      target: meta.target?.trim() || GLOBAL_KEY,
      replyTo: parseReplyTo(meta.replyTo),
      timezoneOffsetMinutes: parseTimezone(meta.timezone),
      body: body || "",
    };
    jobs.push(job);
  }
  return jobs;
}

export interface SchedulerHooks {
  fire(job: Job): Promise<void>;
}

export class CronScheduler {
  private timer: ReturnType<typeof setInterval> | null = null;
  private firedAtMinute = new Map<string, number>();

  constructor(private readonly hooks: SchedulerHooks) {}

  start(): void {
    if (this.timer) return;
    // Tick on the next 00-second boundary, then every 60s.
    const now = new Date();
    const msToNext = (60 - now.getSeconds()) * 1000 - now.getMilliseconds();
    setTimeout(() => {
      void this.tick();
      this.timer = setInterval(() => void this.tick(), 60_000);
    }, msToNext);
    console.log(`[cron] scheduler started (first tick in ${Math.round(msToNext / 1000)}s)`);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private async tick(): Promise<void> {
    const now = new Date();
    const minuteKey = `${now.getUTCFullYear()}-${now.getUTCMonth()}-${now.getUTCDate()}T${now.getUTCHours()}:${now.getUTCMinutes()}`;
    let jobs: Job[];
    try {
      jobs = await loadJobs();
    } catch (err) {
      console.error("[cron] loadJobs failed:", err);
      return;
    }
    for (const job of jobs) {
      let matches: boolean;
      try {
        matches = cronMatches(job.schedule, now, job.timezoneOffsetMinutes);
      } catch (err) {
        console.error(`[cron] ${job.name}: bad schedule "${job.schedule}":`, err);
        continue;
      }
      if (!matches) continue;
      const fireKey = `${job.name}@${minuteKey}`;
      if (this.firedAtMinute.get(job.name) === now.getMinutes() &&
          this.firedAtMinute.has(fireKey)) continue;
      this.firedAtMinute.set(fireKey, now.getMinutes());
      console.log(`[cron] firing job "${job.name}" → target=${job.target}`);
      try {
        await this.hooks.fire(job);
      } catch (err) {
        console.error(`[cron] ${job.name}: fire hook failed:`, err);
      }
      if (!job.recurring) {
        try {
          await unlink(job.filePath);
          console.log(`[cron] one-shot job "${job.name}" deleted (${job.filePath})`);
        } catch (err) {
          console.warn(`[cron] could not delete one-shot ${job.filePath}:`, err);
        }
      }
    }
  }
}
