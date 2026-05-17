/**
 * Discover slash commands from plugin caches and project-level commands.
 * Produces normalized names suitable for platform registration (Discord, Telegram).
 */
import { readdir, readFile } from "fs/promises";
import { homedir } from "os";
import { join } from "path";

export interface SlashCommandDef {
  /** Platform-safe name: special chars replaced with _, max 32 chars, lowercase. */
  name: string;
  /** Original slash command as typed in claude (e.g. "claudeclaw2:status"). */
  originalName: string;
  description: string;
}

function normalizeCommandName(raw: string): string {
  return raw
    .replace(/[^a-z0-9_]/gi, "_")
    .toLowerCase()
    .replace(/__+/g, "_")
    .replace(/^_|_$/g, "")
    .slice(0, 32);
}

async function parseDescription(filePath: string): Promise<string> {
  try {
    const content = await readFile(filePath, "utf8");
    const m = content.match(/^---[\s\S]*?^description:\s*(.+?)$/m);
    if (m) return m[1].trim().slice(0, 100);
  } catch {}
  return "";
}

export async function discoverCommands(): Promise<SlashCommandDef[]> {
  const pluginsCacheDir = join(homedir(), ".claude", "plugins", "cache");
  const commands: SlashCommandDef[] = [];
  const seen = new Set<string>();

  function add(originalName: string, description: string): void {
    if (!description) return;
    const name = normalizeCommandName(originalName);
    if (!name || seen.has(name)) return;
    seen.add(name);
    commands.push({ name, originalName, description });
  }

  // Plugin commands from cache
  try {
    const publishers = await readdir(pluginsCacheDir);
    for (const publisher of publishers) {
      const publisherDir = join(pluginsCacheDir, publisher);
      const pluginNames = await readdir(publisherDir).catch(() => [] as string[]);
      for (const pluginName of pluginNames) {
        const pluginDir = join(publisherDir, pluginName);
        const versions = await readdir(pluginDir).catch(() => [] as string[]);
        // Use the latest version (last lexicographically)
        const version = versions.sort().at(-1);
        if (!version) continue;
        const commandsDir = join(pluginDir, version, "commands");
        const files = await readdir(commandsDir).catch(() => [] as string[]);
        for (const file of files) {
          if (!file.endsWith(".md")) continue;
          const base = file.slice(0, -3);
          const description = await parseDescription(join(commandsDir, file));
          add(`${pluginName}:${base}`, description);
        }
      }
    }
  } catch {}

  return commands;
}
