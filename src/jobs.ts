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
import { mkdir, readdir, readFile, unlink, writeFile } from "fs/promises";
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
  /**
   * Explicit per-job timezone override (minutes from UTC).
   * `undefined` = no override, consumers should fall back to settings.timezone.
   */
  timezoneOffsetMinutes?: number;
  body: string;
}

interface Frontmatter {
  meta: Record<string, string>;
  body: string;
}

function parseFrontmatter(content: string): Frontmatter {
  // Normalise CRLF → LF first. Editors on macOS/Windows (and pasted content)
  // sometimes save with CRLF, which left a trailing \r on every line and made
  // the key/value regex below silently fail to match — `.` doesn't match \r
  // and unanchored `$` (no /m flag) only matches end-of-string.
  content = content.replace(/\r\n?/g, "\n");
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

/**
 * Parse "+08:00" / "-05:30" / "UTC" / "" into minutes. Returns `undefined`
 * for missing/unrecognised input so the caller can fall back to a default
 * (settings.timezone) instead of silently coercing to UTC.
 */
function parseTimezone(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const v = value.trim();
  if (!v) return undefined;
  if (v.toUpperCase() === "UTC") return 0;
  const m = /^([+-])(\d{1,2}):?(\d{2})?$/.exec(v);
  if (!m) return undefined;
  const sign = m[1] === "-" ? -1 : 1;
  const hh = Number(m[2]);
  const mm = Number(m[3] ?? "0");
  return sign * (hh * 60 + mm);
}

/** Filenames may only contain a-z A-Z 0-9 . _ -  — no slashes or .. */
export function isValidJobName(name: string): boolean {
  return /^[a-zA-Z0-9._-]+$/.test(name) && !name.startsWith(".");
}

export interface JobFields {
  schedule: string;
  recurring: boolean;
  target: string;
  replyTo?: string;
  timezone?: string;
  body: string;
}

/** Read a single job file by name. Returns null when missing or invalid. */
export async function loadJob(name: string): Promise<Job | null> {
  if (!isValidJobName(name)) return null;
  const filePath = join(JOBS_DIR, `${name}.md`);
  let content: string;
  try {
    content = await readFile(filePath, "utf8");
  } catch (err: any) {
    if (err?.code === "ENOENT") return null;
    throw err;
  }
  const { meta, body } = parseFrontmatter(content);
  if (!meta.schedule) return null;
  return {
    name,
    filePath,
    schedule: meta.schedule,
    recurring: meta.recurring === undefined ? true : meta.recurring.toLowerCase() !== "false",
    target: meta.target?.trim() || GLOBAL_KEY,
    replyTo: parseReplyTo(meta.replyTo),
    timezoneOffsetMinutes: parseTimezone(meta.timezone),
    body: body || "",
  };
}

function serializeFrontmatterValue(v: string | boolean): string {
  if (typeof v === "boolean") return String(v);
  if (/^[a-zA-Z0-9._:+-]+$/.test(v) && v.length > 0) return v;
  return `"${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** Write a job file. Creates the jobs dir if needed. Overwrites. */
export async function saveJob(name: string, fields: JobFields): Promise<void> {
  if (!isValidJobName(name)) throw new Error(`invalid job name "${name}"`);
  if (!fields.schedule.trim()) throw new Error("schedule is required");
  const lines: string[] = ["---"];
  lines.push(`schedule: ${serializeFrontmatterValue(fields.schedule)}`);
  lines.push(`recurring: ${fields.recurring}`);
  if (fields.target && fields.target !== GLOBAL_KEY) {
    lines.push(`target: ${serializeFrontmatterValue(fields.target)}`);
  }
  if (fields.replyTo) {
    lines.push(`replyTo: ${serializeFrontmatterValue(fields.replyTo)}`);
  }
  if (fields.timezone) {
    lines.push(`timezone: ${serializeFrontmatterValue(fields.timezone)}`);
  }
  lines.push("---");
  lines.push("");
  lines.push(fields.body.trim());
  lines.push("");
  await mkdir(JOBS_DIR, { recursive: true });
  await writeFile(join(JOBS_DIR, `${name}.md`), lines.join("\n"), "utf8");
}

export async function deleteJob(name: string): Promise<boolean> {
  if (!isValidJobName(name)) return false;
  try {
    await unlink(join(JOBS_DIR, `${name}.md`));
    return true;
  } catch (err: any) {
    if (err?.code === "ENOENT") return false;
    throw err;
  }
}

/**
 * Filenames we've already warned about for an absent schedule. loadJobs runs
 * every cron tick (~60s), so without this a stray non-job markdown left in
 * the jobs dir would log the same warning every minute forever. Warn once per
 * file; clear the flag when the file later parses as a valid job so a
 * genuinely-broken job that gets fixed-then-rebroken still re-warns.
 */
const warnedBadJobs = new Set<string>();

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
      if (!warnedBadJobs.has(name)) {
        console.warn(`[jobs] ${name}: missing 'schedule' field — skipping`);
        warnedBadJobs.add(name);
      }
      continue;
    }
    warnedBadJobs.delete(name);
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
  /** Effective default tz when a job has no explicit `timezone:` frontmatter. */
  defaultTimezoneOffsetMinutes(): number;
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
    const defaultTz = this.hooks.defaultTimezoneOffsetMinutes();
    for (const job of jobs) {
      let matches: boolean;
      const tz = job.timezoneOffsetMinutes ?? defaultTz;
      try {
        matches = cronMatches(job.schedule, now, tz);
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
