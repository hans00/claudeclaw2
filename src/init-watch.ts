/**
 * Wait for a freshly-spawned `claude` process in a tmux session to reach
 * ready-for-input state. Handles known startup prompts (bypass-permissions
 * warning, etc) along the way.
 *
 * Strategy: poll `tmux capture-pane`. On each tick:
 *   1. If pane shows ready markers → done.
 *   2. If pane matches a known-prompt pattern → respond + continue.
 *   3. If pane is unchanged for N seconds → try Esc as an unstuck attempt.
 *   4. If we hit the total timeout → fail with the last pane snapshot.
 */
import { capturePane, pressEnter, pressEscape, sendKeys } from "./tmux";

export interface WaitForReadyOptions {
  target: string;
  /** Total budget. Default 60_000. */
  timeoutMs?: number;
  /** Capture+evaluate interval. Default 500. */
  pollMs?: number;
  /** How long pane must be unchanged before we try Esc. Default 15_000. */
  stableUnstuckMs?: number;
}

export type InitWatchResult =
  | { status: "ready"; pane: string }
  | { status: "timeout"; pane: string }
  | { status: "failed"; reason: string; pane: string };

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

interface PromptPattern {
  label: string;
  match(pane: string): boolean;
  respond(target: string): Promise<void>;
}

const KNOWN_PROMPTS: PromptPattern[] = [
  {
    label: "bypass-permissions-warning",
    match: (p) =>
      p.includes("Bypass Permissions mode") &&
      p.includes("1. No, exit") &&
      p.includes("2. Yes, I accept"),
    respond: async (t) => {
      await sendKeys(t, "Down");
      await sleep(150);
      await pressEnter(t);
    },
  },
  {
    label: "compact-confirm",
    match: (p) => /Compact\?[\s\S]{0,40}\(y\/N\)/i.test(p),
    respond: async (t) => {
      await sendKeys(t, "y");
      await sleep(100);
      await pressEnter(t);
    },
  },
  {
    label: "generic-continue",
    match: (p) => /Continue\?\s*\(y\/N\)/i.test(p),
    respond: async (t) => {
      await pressEnter(t);
    },
  },
];

/**
 * Ready detection. Two cases:
 *
 *  1. Elevated permission modes (bypass / accept-edits) render the `⏵⏵`
 *     status line once interactive — fast path.
 *  2. DEFAULT permission mode renders NO `⏵⏵` line (it only appears in
 *     elevated modes). So we can't require it, or sessions launched without
 *     --dangerously-skip-permissions would never read as ready. Instead
 *     detect the bordered input box — a `❯` prompt line sandwiched between
 *     two horizontal rules — which only renders once the TUI is accepting
 *     input, independent of permission mode and version.
 */
const INPUT_BOX_RE = /─{20,}[ \t]*\n[ \t]*❯[^\n]*\n[ \t]*─{20,}/;

function isReady(pane: string): boolean {
  if (pane.includes("⏵⏵") && pane.includes("❯")) return true;
  return INPUT_BOX_RE.test(pane);
}

function detectKnownPrompt(pane: string): PromptPattern | null {
  for (const p of KNOWN_PROMPTS) {
    if (p.match(pane)) return p;
  }
  return null;
}

function paneFingerprint(pane: string): string {
  // Cheap stability check — full string compare is overkill and noisy.
  return `${pane.length}:${pane.slice(-200)}`;
}

export async function waitForReady(opts: WaitForReadyOptions): Promise<InitWatchResult> {
  const timeout = opts.timeoutMs ?? 60_000;
  const interval = opts.pollMs ?? 500;
  const stableLimit = opts.stableUnstuckMs ?? 15_000;
  const start = Date.now();
  let lastFp = "";
  let stableSince = Date.now();
  let escSent = false;
  let lastPane = "";
  let lastReadyMarkerCheck = "";

  while (Date.now() - start < timeout) {
    let pane: string;
    try {
      pane = await capturePane(opts.target);
    } catch (err) {
      return {
        status: "failed",
        reason: `capture-pane failed: ${(err as Error).message}`,
        pane: lastPane,
      };
    }
    lastPane = pane;

    if (isReady(pane)) return { status: "ready", pane };

    // Debug: every ~10s log which markers are/aren't present so we can
    // diagnose stuck cases without re-reading the entire pane in the log.
    const sinceStart = Date.now() - start;
    if (sinceStart > 10_000 && sinceStart % 10_000 < interval) {
      const dbg = `⏵⏵=${pane.includes("⏵⏵")} ❯=${pane.includes("❯")}`;
      if (dbg !== lastReadyMarkerCheck) {
        console.log(`[init-watch] ${opts.target} markers: ${dbg}`);
        lastReadyMarkerCheck = dbg;
      }
    }

    const prompt = detectKnownPrompt(pane);
    if (prompt) {
      console.log(`[init-watch] handling prompt "${prompt.label}" on ${opts.target}`);
      try {
        await prompt.respond(opts.target);
      } catch (err) {
        return {
          status: "failed",
          reason: `prompt response failed (${prompt.label}): ${(err as Error).message}`,
          pane,
        };
      }
      lastFp = "";
      stableSince = Date.now();
      escSent = false;
      await sleep(1000);
      continue;
    }

    const fp = paneFingerprint(pane);
    if (fp !== lastFp) {
      lastFp = fp;
      stableSince = Date.now();
    } else if (!escSent && Date.now() - stableSince > stableLimit) {
      console.warn(`[init-watch] pane stuck for ${stableLimit}ms on ${opts.target}; sending Esc`);
      try {
        await pressEscape(opts.target);
      } catch {}
      escSent = true;
      stableSince = Date.now();
    }

    await sleep(interval);
  }

  return { status: "timeout", pane: lastPane };
}
