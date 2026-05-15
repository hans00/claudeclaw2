/**
 * Heartbeat: periodic ambient prompt fired into "global" so the agent
 * checks in on its own (e.g. summarize recent git, react to inbox, etc).
 *
 * Behaviour:
 *   - Fires `prompt` every `intervalMinutes` minutes
 *   - Skips any tick that falls inside an excludeWindow (quiet hours in
 *     user-local time)
 *   - Skips when the target channel is currently busy — heartbeat is
 *     ambient, never preempts real work
 *   - Tracks lastFiredAt in memory (intentionally resets on daemon restart)
 */
import type { HeartbeatConfig, HeartbeatWindow } from "./config";

export interface HeartbeatHooks {
  /** Returns true when fire-attempt was actually dispatched (false = skipped). */
  fire(prompt: string): Promise<boolean>;
  /** True when the target channel is mid-turn; the tick should skip. */
  isBusy(): boolean;
}

export interface HeartbeatOptions {
  config: HeartbeatConfig;
  timezoneOffsetMinutes: number;
  hooks: HeartbeatHooks;
}

export function parseTimezoneOffset(value: string | undefined): number {
  if (!value) return 0;
  const m = /^(?:UTC)?\s*([+-])(\d{1,2})(?::?(\d{2}))?$/.exec(value.trim());
  if (!m) return 0;
  const sign = m[1] === "-" ? -1 : 1;
  return sign * (Number(m[2]) * 60 + Number(m[3] ?? "0"));
}

function localMinutesOfDay(d: Date, offsetMinutes: number): number {
  const shifted = new Date(d.getTime() + offsetMinutes * 60_000);
  return shifted.getUTCHours() * 60 + shifted.getUTCMinutes();
}

function hhmmToMinutes(s: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(s.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const mi = Number(m[2]);
  if (h < 0 || h > 23 || mi < 0 || mi > 59) return null;
  return h * 60 + mi;
}

export function inExcludeWindow(
  now: Date,
  windows: HeartbeatWindow[],
  tzOffsetMinutes: number,
): boolean {
  if (!windows.length) return false;
  const cur = localMinutesOfDay(now, tzOffsetMinutes);
  for (const w of windows) {
    const start = hhmmToMinutes(w.start);
    const end = hhmmToMinutes(w.end);
    if (start === null || end === null) continue;
    if (start === end) continue;
    if (start < end) {
      if (cur >= start && cur < end) return true;
    } else {
      // wraps midnight
      if (cur >= start || cur < end) return true;
    }
  }
  return false;
}

export class HeartbeatScheduler {
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastFiredAt = Date.now();

  constructor(private readonly opts: HeartbeatOptions) {}

  start(): void {
    if (this.timer) return;
    if (!this.opts.config.enabled) {
      console.log("[heartbeat] disabled");
      return;
    }
    if (!this.opts.config.prompt.trim()) {
      console.warn("[heartbeat] enabled but no prompt — skipping start");
      return;
    }
    this.timer = setInterval(() => void this.tick(), 60_000);
    console.log(
      `[heartbeat] scheduler started (interval=${this.opts.config.interval}m, ` +
        `excludeWindows=${this.opts.config.excludeWindows.length})`,
    );
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  get lastFiredAtMs(): number {
    return this.lastFiredAt;
  }

  private async tick(): Promise<void> {
    const { config, hooks, timezoneOffsetMinutes } = this.opts;
    if (!config.enabled) return;

    const now = new Date();
    const elapsedMs = now.getTime() - this.lastFiredAt;
    if (elapsedMs < config.interval * 60_000) return;

    if (inExcludeWindow(now, config.excludeWindows, timezoneOffsetMinutes)) {
      // Quiet hours: don't fire AND don't advance lastFiredAt — we want
      // to fire ASAP once the window ends, not push it another interval.
      return;
    }

    if (hooks.isBusy()) {
      // Channel busy — defer one tick.
      return;
    }

    this.lastFiredAt = now.getTime();
    try {
      await hooks.fire(config.prompt);
      console.log(`[heartbeat] fired at ${now.toISOString()}`);
    } catch (err) {
      console.error("[heartbeat] fire failed:", err);
    }
  }
}
