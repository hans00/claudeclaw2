/**
 * Render a tool-use status line with per-tool emoji + the single most
 * relevant input field as the "detail" — inspired by OpenClaw's
 * `tool-display.json` registry. Falls back to a generic puzzle icon +
 * best-effort detail extraction for unknown tools.
 *
 * Examples (vs. previous `JSON.stringify(input).slice(0,200)` behaviour):
 *   formatToolStatus("Bash", {command: "git status"})
 *     → "🛠️ Bash · git status"
 *   formatToolStatus("Read", {file_path: "src/foo.ts"})
 *     → "📖 Read · src/foo.ts"
 *   formatToolStatus("WebFetch", {url: "https://example.com"})
 *     → "🌐 WebFetch · https://example.com"
 */

interface ToolSpec {
  emoji: string;
  title?: string;
  detailKeys: string[];
}

const FALLBACK: ToolSpec = {
  emoji: "🧩",
  detailKeys: [
    "command", "path", "file_path", "url", "targetUrl", "target",
    "query", "pattern", "name", "id", "messageId", "to",
    "description",
  ],
};

const TOOL_MAP: Record<string, ToolSpec> = {
  bash:          { emoji: "🛠️", title: "Bash",         detailKeys: ["command"] },
  read:          { emoji: "📖", title: "Read",         detailKeys: ["file_path", "path"] },
  write:         { emoji: "✍️", title: "Write",        detailKeys: ["file_path", "path"] },
  edit:          { emoji: "📝", title: "Edit",         detailKeys: ["file_path", "path"] },
  multiedit:     { emoji: "📝", title: "MultiEdit",    detailKeys: ["file_path", "path"] },
  glob:          { emoji: "🔎", title: "Glob",         detailKeys: ["pattern", "path"] },
  grep:          { emoji: "🔎", title: "Grep",         detailKeys: ["pattern", "path"] },
  ls:            { emoji: "📂", title: "Ls",           detailKeys: ["path"] },
  webfetch:      { emoji: "🌐", title: "WebFetch",     detailKeys: ["url"] },
  websearch:     { emoji: "🌐", title: "WebSearch",    detailKeys: ["query"] },
  webview:       { emoji: "🌐", title: "WebView",      detailKeys: ["url"] },
  browser:       { emoji: "🌐", title: "Browser",      detailKeys: ["targetUrl", "url"] },
  task:          { emoji: "🤖", title: "Task",         detailKeys: ["description", "subagent_type"] },
  agent:         { emoji: "🤖", title: "Agent",        detailKeys: ["description", "subagent_type"] },
  notebookedit:  { emoji: "📓", title: "NotebookEdit", detailKeys: ["notebook_path", "path"] },
  notebookread:  { emoji: "📓", title: "NotebookRead", detailKeys: ["notebook_path", "path"] },
  todowrite:     { emoji: "✅", title: "TodoWrite",    detailKeys: [] },
  taskcreate:    { emoji: "✅", title: "TaskCreate",   detailKeys: ["subject", "description"] },
  taskupdate:    { emoji: "✅", title: "TaskUpdate",   detailKeys: ["taskId", "status"] },
  schedulewakeup:{ emoji: "⏰", title: "ScheduleWakeup",detailKeys: ["delaySeconds", "reason"] },
  croncreate:    { emoji: "⏰", title: "CronCreate",   detailKeys: ["name", "schedule"] },
  crondelete:    { emoji: "⏰", title: "CronDelete",   detailKeys: ["name"] },
  cronlist:      { emoji: "⏰", title: "CronList",     detailKeys: [] },
  remotetrigger: { emoji: "📡", title: "RemoteTrigger",detailKeys: ["target"] },
  enterplanmode: { emoji: "🧭", title: "PlanMode",     detailKeys: ["plan"] },
  exitplanmode:  { emoji: "🧭", title: "ExitPlan",     detailKeys: [] },
  enterworktree: { emoji: "🌿", title: "Worktree",     detailKeys: ["name", "branch"] },
  exitworktree:  { emoji: "🌿", title: "ExitWorktree", detailKeys: [] },
  lsp:           { emoji: "🔌", title: "LSP",          detailKeys: ["operation", "file_path"] },
  monitor:       { emoji: "👀", title: "Monitor",      detailKeys: ["target"] },
  pushnotification: { emoji: "🔔", title: "Notification", detailKeys: ["message", "title"] },
  toolsearch:    { emoji: "🔌", title: "ToolSearch",   detailKeys: ["query"] },
  askuserquestion:{ emoji: "❓", title: "AskUser",     detailKeys: [] },
  exit_plan_mode:{ emoji: "🧭", title: "ExitPlan",     detailKeys: [] },
  killshell:     { emoji: "🛑", title: "KillShell",    detailKeys: ["shell_id"] },
  bashoutput:    { emoji: "🛠️", title: "BashOutput",   detailKeys: ["bash_id"] },
  fetch:         { emoji: "🌐", title: "Fetch",        detailKeys: ["url"] },
};

function lookup(toolName: string): ToolSpec {
  const norm = toolName.toLowerCase().replace(/[^a-z0-9]/g, "");
  return TOOL_MAP[norm] ?? FALLBACK;
}

function pickDetail(input: unknown, keys: string[]): string {
  if (!input || typeof input !== "object") {
    return typeof input === "string" ? input : "";
  }
  const obj = input as Record<string, unknown>;
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === "string" && v) return v;
    if (typeof v === "number" || typeof v === "boolean") return String(v);
  }
  return "";
}

const DETAIL_MAX = 180;

function truncateDetail(s: string): string {
  const normalized = s.replace(/\s+/g, " ").trim();
  if (normalized.length <= DETAIL_MAX) return normalized;
  return normalized.slice(0, DETAIL_MAX - 1) + "…";
}

export function formatToolStatus(toolName: string, input: unknown): string {
  const spec = lookup(toolName);
  const title = spec.title ?? toolName;
  const detail = truncateDetail(pickDetail(input, spec.detailKeys));
  return detail ? `${spec.emoji} ${title} · ${detail}` : `${spec.emoji} ${title}`;
}
