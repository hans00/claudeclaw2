/**
 * Status snapshot writer for the Claude Code plugin's statusline script
 * (the "🦞 ClaudeClaw 🦞" box rendered inside the tmux-hosted agents).
 *
 * v1 wrote `.claude/claudeclaw/state.json` periodically and the plugin
 * reads it to populate the indicators. We preserve the schema so the
 * existing plugin keeps working without modification.
 */
import { writeFile, mkdir } from "fs/promises";
import { dirname, join } from "path";
import { nextCronMatch } from "./cron";
import { loadJobs } from "./jobs";
import type { Settings } from "./config";
import { parseTimezoneOffset } from "./heartbeat";

const STATE_FILE = join(".claude", "claudeclaw", "state.json");

export interface StateSnapshot {
  heartbeat?: { nextAt: number };
  jobs: { name: string; nextAt: number }[];
  security: string;
  telegram: boolean;
  discord: boolean;
  slack: boolean;
  line: boolean;
  startedAt: number;
  web?: { enabled: boolean; host: string; port: number };
}

export interface StatuslineHooks {
  settings(): Settings;
  startedAt(): number;
  /** Last heartbeat fire time in ms (0 if never). */
  heartbeatLastFiredAt(): number;
  /** Which platforms actually started successfully. */
  platforms(): { telegram: boolean; discord: boolean; slack: boolean; line: boolean };
}

export class StatuslineWriter {
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly hooks: StatuslineHooks) {}

  start(): void {
    if (this.timer) return;
    // Write once immediately, then every 30s — fast enough to keep the
    // statusline countdown roughly fresh, light enough to ignore.
    void this.tick();
    this.timer = setInterval(() => void this.tick(), 30_000);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private async tick(): Promise<void> {
    const settings = this.hooks.settings();
    const startedAt = this.hooks.startedAt();
    const plats = this.hooks.platforms();
    const tzOffset = parseTimezoneOffset(settings.timezone);

    let heartbeatNextAt: number | undefined;
    if (settings.heartbeat.enabled && settings.heartbeat.interval > 0) {
      const last = this.hooks.heartbeatLastFiredAt();
      heartbeatNextAt = last + settings.heartbeat.interval * 60_000;
    }

    const jobs: StateSnapshot["jobs"] = [];
    try {
      const all = await loadJobs();
      const now = new Date();
      for (const j of all) {
        const tz = j.timezoneOffsetMinutes ?? tzOffset;
        try {
          const next = nextCronMatch(j.schedule, now, tz);
          jobs.push({ name: j.name, nextAt: next.getTime() });
        } catch {
          /* bad schedule — skip */
        }
      }
    } catch {
      /* no jobs dir — fine */
    }

    const snap: StateSnapshot = {
      heartbeat: heartbeatNextAt ? { nextAt: heartbeatNextAt } : undefined,
      jobs,
      security: settings.security.level,
      telegram: plats.telegram,
      discord: plats.discord,
      slack: plats.slack,
      line: plats.line,
      startedAt,
      web: settings.web.enabled
        ? { enabled: true, host: settings.web.host, port: settings.web.port }
        : undefined,
    };

    try {
      await mkdir(dirname(STATE_FILE), { recursive: true });
      await writeFile(STATE_FILE, JSON.stringify(snap) + "\n", "utf8");
    } catch (err) {
      console.error("[statusline] write failed:", err);
    }
  }
}
