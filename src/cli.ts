/**
 * Small CLI for managing a running daemon.
 *
 *   bun run src/cli.ts status
 *   bun run src/cli.ts send <target> <text...>
 *   bun run src/cli.ts trigger <target> <prompt...>
 *   bun run src/cli.ts stop
 *
 * status / send / trigger call the daemon's web API (requires web.enabled
 * in settings.json). stop reads .claude/claudeclaw/daemon.pid and signals
 * the daemon directly, so it works regardless of web.
 */
import { readFile } from "fs/promises";
import { join } from "path";
import { loadSettings } from "./config";

const PID_FILE = join(".claude", "claudeclaw", "daemon.pid");

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2);
  if (!cmd || cmd === "help" || cmd === "--help" || cmd === "-h") {
    printHelp();
    return;
  }
  switch (cmd) {
    case "status":  await runStatus(); return;
    case "send":    await runSend(rest); return;
    case "trigger": await runTrigger(rest); return;
    case "stop":    await runStop(); return;
    default:
      console.error(`unknown subcommand: ${cmd}`);
      printHelp();
      process.exit(1);
  }
}

function printHelp(): void {
  console.log(`claudeclaw CLI

  status                      Show daemon status (requires web API enabled)
  send <target> <text...>     Deliver text into target channel's inbox
  trigger <target> <prompt..> Run the agent on target channel with prompt
  stop                        Send SIGTERM to the running daemon (via pid file)

  Targets:  global  |  telegram:<chatId>  |  discord:<channelId>  |  slack:<channelId>[:<threadTs>]
`);
}

async function webBaseOrExit(): Promise<string> {
  const settings = await loadSettings();
  if (!settings.web.enabled) {
    console.error("[cli] web API is disabled in settings.json — enable web.enabled to use this command");
    process.exit(1);
  }
  return `http://${settings.web.host}:${settings.web.port}`;
}

async function runStatus(): Promise<void> {
  const base = await webBaseOrExit();
  const res = await fetchOrExit(`${base}/api/status`);
  console.log(await res.text());
}

async function runSend(args: string[]): Promise<void> {
  const [target, ...textParts] = args;
  if (!target || textParts.length === 0) {
    console.error("usage: send <target> <text...>");
    process.exit(1);
  }
  const base = await webBaseOrExit();
  const res = await fetchOrExit(`${base}/api/send`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ target, text: textParts.join(" "), fromLabel: "cli" }),
  });
  console.log(await res.text());
}

async function runTrigger(args: string[]): Promise<void> {
  const [target, ...promptParts] = args;
  if (!target || promptParts.length === 0) {
    console.error("usage: trigger <target> <prompt...>");
    process.exit(1);
  }
  const base = await webBaseOrExit();
  const res = await fetchOrExit(`${base}/api/trigger`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ target, prompt: promptParts.join(" "), fromLabel: "cli" }),
  });
  console.log(await res.text());
}

async function runStop(): Promise<void> {
  let pid: number;
  try {
    pid = Number((await readFile(PID_FILE, "utf8")).trim());
  } catch {
    console.error(`[cli] no pid file at ${PID_FILE} — daemon not running`);
    process.exit(1);
  }
  if (!Number.isFinite(pid) || pid <= 0) {
    console.error(`[cli] invalid pid in ${PID_FILE}`);
    process.exit(1);
  }
  try {
    process.kill(pid, "SIGTERM");
    console.log(`[cli] SIGTERM sent to pid ${pid}`);
  } catch (err) {
    console.error(`[cli] kill ${pid} failed:`, err);
    process.exit(1);
  }
}

async function fetchOrExit(url: string, init?: RequestInit): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(url, init);
  } catch (err) {
    console.error(`[cli] cannot reach ${url}: ${(err as Error).message}`);
    process.exit(1);
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    console.error(`[cli] ${url} returned ${res.status}: ${body}`);
    process.exit(1);
  }
  return res;
}

main().catch((err) => {
  console.error("[cli] fatal:", err);
  process.exit(1);
});
