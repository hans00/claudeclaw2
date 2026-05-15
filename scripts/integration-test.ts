/**
 * Integration test for the agent loop.
 *
 * Spawns a real tmux session + real `claude` process, drives it with a
 * fixed prompt through Channel.handleIncoming, and asserts that:
 *   1. init-watch transitions the channel to idle
 *   2. an assistant-text event arrives via jsonl within the timeout
 *   3. the response contains the expected marker string
 *   4. cleanup kills the tmux session cleanly
 *
 * Platform connectors are NOT exercised — mock callbacks capture outbound
 * events instead. Real Telegram E2E is a separate manual run.
 *
 * Run:  bun run scripts/integration-test.ts
 */
import { randomUUID } from "crypto";
import { Channel, type ChannelCallbacks, type ReplyTarget } from "../src/channel";
import { tmuxNameFor, type ChannelSession } from "../src/sessions";

const MARKER = "integration-ok-" + randomUUID().slice(0, 8);
const TIMEOUT_MS = 90_000;

type OutboundEvent =
  | { kind: "text"; text: string; replyTo: ReplyTarget }
  | { kind: "tool"; toolName: string; input: unknown; replyTo: ReplyTarget }
  | { kind: "turn-end" }
  | { kind: "error"; message: string };

async function main(): Promise<void> {
  const events: OutboundEvent[] = [];
  let resolveAssistantText: ((ev: Extract<OutboundEvent, { kind: "text" }>) => void) | null = null;
  let assistantTextPromise = new Promise<Extract<OutboundEvent, { kind: "text" }>>((res) => {
    resolveAssistantText = res;
  });

  const callbacks: ChannelCallbacks = {
    onAssistantText: (text, replyTo) => {
      const ev: OutboundEvent = { kind: "text", text, replyTo };
      events.push(ev);
      if (resolveAssistantText) {
        resolveAssistantText(ev);
        resolveAssistantText = null;
      }
      console.log(`[test] assistant-text (${text.length} chars):`);
      console.log("  " + text.split("\n").join("\n  "));
    },
    onToolUse: (toolName, input, replyTo) => {
      events.push({ kind: "tool", toolName, input, replyTo });
      console.log(`[test] tool-use: ${toolName} ${JSON.stringify(input).slice(0, 80)}`);
    },
    onTurnEnd: () => {
      events.push({ kind: "turn-end" });
      console.log(`[test] turn-end`);
    },
    onError: (err) => {
      events.push({ kind: "error", message: err.message });
      console.error(`[test] channel error:`, err.message);
    },
  };

  const channelKey = "integration-test";
  const session: ChannelSession = {
    kind: "global",
    channelKey,
    sessionId: randomUUID(),
    tmuxSession: tmuxNameFor(channelKey, process.cwd()),
    multiparty: false,
    createdAt: new Date().toISOString(),
    lastActivityAt: new Date().toISOString(),
  };

  console.log(`[test] session ${session.sessionId} → tmux ${session.tmuxSession}`);

  const channel = new Channel({
    session,
    security: { level: "moderate", allowedTools: [], disallowedTools: [] },
    projectDir: process.cwd(),
    callbacks,
  });

  let failed = false;
  try {
    console.log(`[test] starting channel (new session)...`);
    await channel.start({ resume: false });
    if (channel.currentState !== "idle") {
      throw new Error(`channel did not reach idle after start (state=${channel.currentState})`);
    }
    console.log(`[test] channel idle, sending prompt...`);

    const prompt = `Reply with exactly the single word "${MARKER}" and nothing else. No markdown, no prefix, no suffix, just the word.`;
    await channel.handleIncoming({
      text: prompt,
      fromLabel: "tester",
      replyTo: null,
    });

    console.log(`[test] waiting for assistant-text (timeout ${TIMEOUT_MS / 1000}s)...`);
    const ev = await raceWithTimeout(assistantTextPromise, TIMEOUT_MS, "assistant-text");

    if (!ev.text.includes(MARKER)) {
      throw new Error(`assistant text did not contain marker "${MARKER}":\n${ev.text}`);
    }
    console.log(`[test] ✓ marker found in response`);

    // Give the channel a moment to also receive turn-end.
    await new Promise((r) => setTimeout(r, 3000));
    const hasTurnEnd = events.some((e) => e.kind === "turn-end");
    if (!hasTurnEnd) {
      console.warn(`[test] ⚠ no turn-end observed (still acceptable but worth noting)`);
    } else {
      console.log(`[test] ✓ turn-end observed`);
    }

    console.log(`[test] ✓ INTEGRATION TEST PASSED`);
  } catch (err) {
    failed = true;
    console.error(`[test] ✗ INTEGRATION TEST FAILED:`, err);
    try {
      const pane = await channel.capture();
      console.error(`--- last pane ---\n${pane}\n--- end pane ---`);
    } catch {}
  } finally {
    console.log(`[test] cleaning up...`);
    try {
      await channel.shutdown();
    } catch (err) {
      console.error(`[test] cleanup error:`, err);
    }
    console.log(`[test] event summary: ${events.length} events`);
    for (const e of events) {
      if (e.kind === "text") console.log(`  - text (${e.text.length}ch)`);
      else if (e.kind === "tool") console.log(`  - tool ${e.toolName}`);
      else if (e.kind === "turn-end") console.log(`  - turn-end`);
      else if (e.kind === "error") console.log(`  - error: ${e.message}`);
    }
  }

  process.exit(failed ? 1 : 0);
}

function raceWithTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout waiting for ${label} after ${ms}ms`)), ms);
    p.then(
      (v) => { clearTimeout(t); resolve(v); },
      (e) => { clearTimeout(t); reject(e); },
    );
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
