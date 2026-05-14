/**
 * Settings loader. Reads `.claude/claudeclaw/settings.json` (relative to
 * cwd) and supplies defaults for missing fields. Settings define WHAT IS
 * ALLOWED (tokens, allowlists, security level) — runtime state lives in
 * sessions.json instead.
 */
import { readFile } from "fs/promises";
import { join } from "path";
import type { SecurityConfig } from "./compose";

export interface TelegramConfig {
  token: string;
  allowedUserIds: number[];
}

export interface DiscordChannelConfig {
  enabled: boolean;
  requireMention: boolean;
  ignoreOtherMentions: boolean;
}

export interface DiscordConfig {
  token: string;
  allowedUserIds: string[];
  allowedBotIds: string[];
  channels: Record<string, DiscordChannelConfig>;
}

export interface Settings {
  telegram: TelegramConfig;
  discord: DiscordConfig;
  security: SecurityConfig;
  /** Polling interval for Telegram long-poll, in seconds. Default 25. */
  telegramPollSeconds: number;
}

const SETTINGS_PATH = join(".claude", "claudeclaw", "settings.json");

const DEFAULTS: Settings = {
  telegram: { token: "", allowedUserIds: [] },
  discord: { token: "", allowedUserIds: [], allowedBotIds: [], channels: {} },
  security: { level: "moderate", allowedTools: [], disallowedTools: [] },
  telegramPollSeconds: 25,
};

export async function loadSettings(): Promise<Settings> {
  let raw: any;
  try {
    raw = JSON.parse(await readFile(SETTINGS_PATH, "utf8"));
  } catch (err: any) {
    if (err?.code === "ENOENT") {
      console.warn(`[config] no settings file at ${SETTINGS_PATH}; using defaults`);
      return structuredClone(DEFAULTS);
    }
    throw err;
  }
  return {
    telegram: {
      token: raw?.telegram?.token ?? DEFAULTS.telegram.token,
      allowedUserIds: Array.isArray(raw?.telegram?.allowedUserIds)
        ? raw.telegram.allowedUserIds.filter((x: unknown) => typeof x === "number")
        : DEFAULTS.telegram.allowedUserIds,
    },
    discord: {
      token: raw?.discord?.token ?? DEFAULTS.discord.token,
      allowedUserIds: Array.isArray(raw?.discord?.allowedUserIds)
        ? raw.discord.allowedUserIds.filter((x: unknown) => typeof x === "string")
        : DEFAULTS.discord.allowedUserIds,
      allowedBotIds: Array.isArray(raw?.discord?.allowedBotIds)
        ? raw.discord.allowedBotIds.filter((x: unknown) => typeof x === "string")
        : DEFAULTS.discord.allowedBotIds,
      channels: raw?.discord?.channels ?? DEFAULTS.discord.channels,
    },
    security: {
      level: raw?.security?.level ?? DEFAULTS.security.level,
      allowedTools: Array.isArray(raw?.security?.allowedTools) ? raw.security.allowedTools : [],
      disallowedTools: Array.isArray(raw?.security?.disallowedTools)
        ? raw.security.disallowedTools
        : [],
    },
    telegramPollSeconds: typeof raw?.telegramPollSeconds === "number"
      ? raw.telegramPollSeconds
      : DEFAULTS.telegramPollSeconds,
  };
}
