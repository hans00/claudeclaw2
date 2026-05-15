/**
 * Durable per-channel session metadata, stored at
 * `.claude/claudeclaw/sessions.json` relative to the daemon's cwd.
 *
 * Only fields that need to survive a restart go here. Transient state
 * (busy/idle/queue/inflight) lives in memory inside the channel state
 * machine — losing it on restart is fine because the channel just starts
 * fresh and the user's next message kicks it off.
 */
import { createHash } from "crypto";
import { mkdir, readFile, rename, writeFile } from "fs/promises";
import { dirname, join } from "path";

export type ChannelKind = "global" | "telegram" | "discord" | "slack" | "line";

/** The cross-platform DM sink. All Telegram + Discord DMs route here. */
export const GLOBAL_KEY = "global";

export interface ChannelSession {
  kind: ChannelKind;
  /** Stable channel identifier, e.g. "telegram:116013788" or "discord:1492947...". */
  channelKey: string;
  /** Claude Code session UUID — used as both --session-id and jsonl filename. */
  sessionId: string;
  /** tmux session name hosting this channel's `claude` process. */
  tmuxSession: string;
  /** Whether this channel has multiple participants (affects SILENT_REPLY_PROMPT). */
  multiparty: boolean;
  createdAt: string;
  lastActivityAt: string;
}

const FILE_PATH = join(".claude", "claudeclaw", "sessions.json");

export type SessionMap = Record<string, ChannelSession>;

export async function loadSessions(): Promise<SessionMap> {
  try {
    const raw = await readFile(FILE_PATH, "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as SessionMap;
    }
    return {};
  } catch (err: any) {
    if (err?.code === "ENOENT") return {};
    throw err;
  }
}

export async function saveSessions(sessions: SessionMap): Promise<void> {
  await mkdir(dirname(FILE_PATH), { recursive: true });
  const tmp = `${FILE_PATH}.tmp.${process.pid}`;
  await writeFile(tmp, JSON.stringify(sessions, null, 2) + "\n", "utf8");
  await rename(tmp, FILE_PATH);
}

export async function getSession(channelKey: string): Promise<ChannelSession | undefined> {
  const all = await loadSessions();
  return all[channelKey];
}

export async function upsertSession(session: ChannelSession): Promise<void> {
  const all = await loadSessions();
  all[session.channelKey] = session;
  await saveSessions(all);
}

export async function touchActivity(channelKey: string): Promise<void> {
  const all = await loadSessions();
  const entry = all[channelKey];
  if (!entry) return;
  entry.lastActivityAt = new Date().toISOString();
  await saveSessions(all);
}

export async function deleteSession(channelKey: string): Promise<void> {
  const all = await loadSessions();
  if (!(channelKey in all)) return;
  delete all[channelKey];
  await saveSessions(all);
}

/**
 * Compose a channel key from kind + id. The id grammar mirrors the platform's
 * native identifiers (chat id, channel id, thread root); callers are
 * responsible for choosing the right scope per platform.
 *
 * The special "global" kind has no id — it returns just "global".
 */
export function channelKey(kind: ChannelKind, id: string): string {
  if (kind === "global") return GLOBAL_KEY;
  return `${kind}:${id}`;
}

/**
 * Short stable hash of an absolute project directory. Used as the prefix
 * of every tmux session name so two daemons running from different
 * project roots on the same host don't collide on names like
 * "claudeclaw-global".
 */
export function projectHash(projectDir: string): string {
  return createHash("sha256").update(projectDir).digest("hex").slice(0, 8);
}

/**
 * Derive a deterministic tmux session name from a channel key + project
 * dir. `claudeclaw-<8-char project hash>-<safe channel key>`. The project
 * hash isolates concurrent daemons; the channel key keeps the name
 * readable in `tmux ls`.
 */
export function tmuxNameFor(channelKey: string, projectDir: string): string {
  const safe = channelKey.replace(/[^a-zA-Z0-9_-]/g, "-");
  return `claudeclaw-${projectHash(projectDir)}-${safe}`;
}
