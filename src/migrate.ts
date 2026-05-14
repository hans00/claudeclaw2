/**
 * Migrate v1 session state into v2 sessions.json.
 *
 * v1 layout (relative to project cwd):
 *   .claude/claudeclaw/session.json       — { sessionId, createdAt, lastUsedAt, ... }
 *   .claude/claudeclaw/sessions.json      — { threads: { <threadId>: { sessionId, ... } } }
 *
 * v2 layout:
 *   .claude/claudeclaw/sessions.json      — { "global": ChannelSession, "discord:<id>": ChannelSession, ... }
 *
 * Mapping:
 *   v1 global session.json     → v2 sessions["global"]              (kind=global, multiparty=false)
 *   v1 sessions.json.threads.* → v2 sessions["discord:<threadId>"]  (kind=discord, multiparty=true)
 *
 * Idempotent: if any v2 entry already exists for the target key, the v1
 * record is skipped for that key (we don't clobber live state).
 */
import { readFile, rename, writeFile, mkdir, stat } from "fs/promises";
import { dirname, join } from "path";
import {
  GLOBAL_KEY,
  loadSessions,
  saveSessions,
  tmuxNameFor,
  type ChannelSession,
} from "./sessions";

const V1_GLOBAL_FILE = join(".claude", "claudeclaw", "session.json");
const V1_THREADS_FILE = join(".claude", "claudeclaw", "sessions.json");
const V2_FILE = join(".claude", "claudeclaw", "sessions.json");

interface V1Global {
  sessionId: string;
  createdAt?: string;
  lastUsedAt?: string;
}

interface V1Threads {
  threads?: Record<string, { sessionId: string; createdAt?: string; lastUsedAt?: string }>;
}

export interface MigrationReport {
  /** True when a migration actually wrote new entries. */
  performed: boolean;
  /** New entries added. */
  added: string[];
  /** Entries skipped because they already existed in v2 sessions.json. */
  skippedExisting: string[];
  /** v1 files inspected. */
  inspected: { v1Global: boolean; v1Threads: boolean };
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Decide whether migration should run. Skip when there's no v1 state to
 * read, OR when v2 sessions.json already has a "global" entry (the strong
 * signal that v2 has been operating).
 */
async function shouldMigrate(): Promise<{ run: boolean; reason: string }> {
  const v1Global = await fileExists(V1_GLOBAL_FILE);
  // v1 and v2 both use ".claude/claudeclaw/sessions.json" — we have to detect
  // shape, not presence. If the file parses to v2 shape (global / discord:* keys),
  // v2 is already active.
  let v1Threads = false;
  let v2Active = false;
  try {
    const raw = await readFile(V2_FILE, "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") {
      // v2 shape: top-level keys look like "global" or "<kind>:<id>"
      const keys = Object.keys(parsed);
      v2Active = keys.some((k) => k === GLOBAL_KEY || /^[a-z]+:/i.test(k));
      // v1 shape: top-level "threads" object
      if (!v2Active && parsed.threads && typeof parsed.threads === "object") {
        v1Threads = true;
      }
    }
  } catch {
    // missing or unparseable
  }
  if (v2Active) return { run: false, reason: "v2 sessions.json already populated" };
  if (!v1Global && !v1Threads) return { run: false, reason: "no v1 state found" };
  return { run: true, reason: "v1 state present, v2 empty" };
}

export async function migrateFromV1(): Promise<MigrationReport> {
  const report: MigrationReport = {
    performed: false,
    added: [],
    skippedExisting: [],
    inspected: { v1Global: false, v1Threads: false },
  };

  const decision = await shouldMigrate();
  if (!decision.run) {
    console.log(`[migrate] skipping: ${decision.reason}`);
    return report;
  }

  // If we're reading and writing the same file path (sessions.json), we
  // need to read v1 contents first, then save v2 contents over top.
  let v1ThreadsContent: V1Threads | null = null;
  try {
    const raw = await readFile(V1_THREADS_FILE, "utf8");
    const parsed = JSON.parse(raw);
    // Only v1 shape has "threads" key; bail if it's already v2.
    if (parsed && typeof parsed === "object" && parsed.threads && typeof parsed.threads === "object") {
      v1ThreadsContent = parsed;
      report.inspected.v1Threads = true;
    }
  } catch (err: any) {
    if (err?.code !== "ENOENT") {
      console.warn(`[migrate] could not read ${V1_THREADS_FILE}:`, err);
    }
  }

  let v1GlobalContent: V1Global | null = null;
  try {
    const raw = await readFile(V1_GLOBAL_FILE, "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && typeof parsed.sessionId === "string") {
      v1GlobalContent = parsed;
      report.inspected.v1Global = true;
    }
  } catch (err: any) {
    if (err?.code !== "ENOENT") {
      console.warn(`[migrate] could not read ${V1_GLOBAL_FILE}:`, err);
    }
  }

  // Backup v1 sessions.json (threads file) before overwriting with v2 shape.
  if (v1ThreadsContent) {
    const backup = `${V1_THREADS_FILE}.v1-backup`;
    try {
      await mkdir(dirname(backup), { recursive: true });
      await rename(V1_THREADS_FILE, backup);
      console.log(`[migrate] backed up v1 threads file → ${backup}`);
    } catch (err) {
      console.error(`[migrate] failed to backup ${V1_THREADS_FILE}:`, err);
    }
  }

  // Now compose v2 sessions.json — start from anything that's already there
  // (post-backup the file may not exist anymore, so this returns {}).
  const v2 = await loadSessions();

  const now = new Date().toISOString();

  if (v1GlobalContent) {
    if (v2[GLOBAL_KEY]) {
      report.skippedExisting.push(GLOBAL_KEY);
    } else {
      const entry: ChannelSession = {
        kind: "global",
        channelKey: GLOBAL_KEY,
        sessionId: v1GlobalContent.sessionId,
        tmuxSession: tmuxNameFor(GLOBAL_KEY),
        multiparty: false,
        createdAt: v1GlobalContent.createdAt ?? now,
        lastActivityAt: v1GlobalContent.lastUsedAt ?? now,
      };
      v2[GLOBAL_KEY] = entry;
      report.added.push(GLOBAL_KEY);
    }
  }

  if (v1ThreadsContent?.threads) {
    for (const [threadId, t] of Object.entries(v1ThreadsContent.threads)) {
      const key = `discord:${threadId}`;
      if (v2[key]) {
        report.skippedExisting.push(key);
        continue;
      }
      const entry: ChannelSession = {
        kind: "discord",
        channelKey: key,
        sessionId: t.sessionId,
        tmuxSession: tmuxNameFor(key),
        multiparty: true,
        createdAt: t.createdAt ?? now,
        lastActivityAt: t.lastUsedAt ?? now,
      };
      v2[key] = entry;
      report.added.push(key);
    }
  }

  if (report.added.length === 0) {
    console.log(`[migrate] nothing to migrate (added=0)`);
    return report;
  }

  await mkdir(dirname(V2_FILE), { recursive: true });
  // saveSessions writes V2_FILE atomically.
  await saveSessions(v2);
  report.performed = true;

  console.log(`[migrate] migrated ${report.added.length} entries:`);
  for (const k of report.added) console.log(`  + ${k} → ${v2[k]!.sessionId.slice(0, 8)}`);
  if (report.skippedExisting.length > 0) {
    console.log(`[migrate] skipped ${report.skippedExisting.length} existing entries`);
  }
  return report;
}

/** Optional: hand-rolled v1 backup of session.json (we don't auto-rename it). */
export async function backupV1GlobalIfExists(): Promise<void> {
  if (!(await fileExists(V1_GLOBAL_FILE))) return;
  const backup = `${V1_GLOBAL_FILE}.v1-backup`;
  if (await fileExists(backup)) return; // already backed up
  try {
    const content = await readFile(V1_GLOBAL_FILE, "utf8");
    await writeFile(backup, content, "utf8");
    console.log(`[migrate] copied v1 global session → ${backup}`);
  } catch (err) {
    console.warn(`[migrate] failed to backup ${V1_GLOBAL_FILE}:`, err);
  }
}

// CLI entry: `bun run src/migrate.ts`
if (import.meta.main) {
  migrateFromV1()
    .then((r) => {
      console.log("[migrate] result:", r);
      process.exit(r.performed || r.skippedExisting.length > 0 ? 0 : 0);
    })
    .catch((err) => {
      console.error("[migrate] fatal:", err);
      process.exit(1);
    });
}
