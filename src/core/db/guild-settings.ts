import { db } from "./client";

export const MB = 1024 * 1024;
export const DEFAULT_MAX_STORAGE_BYTES = 100 * MB;
export function getDefaultTextChannel(guildId: string): string | null {
  return (
    db
      .prepare<[string], { default_text_channel_id: string | null }>(
        "SELECT default_text_channel_id FROM GuildSettings WHERE guild_id = ?",
      )
      .get(guildId)?.default_text_channel_id ?? null
  );
}
export function setDefaultTextChannel(guildId: string, channelId: string | null) {
  if (channelId !== null && !/^\d{17,20}$/.test(channelId))
    throw new Error("Invalid text channel ID.");
  db.prepare(
    `INSERT INTO GuildSettings (guild_id, default_text_channel_id) VALUES (?, ?)
    ON CONFLICT(guild_id) DO UPDATE SET default_text_channel_id=excluded.default_text_channel_id`,
  ).run(guildId, channelId);
}

export interface GuildPlayerSettings {
  volume: number;
  autoplay_enabled: boolean;
  dj_role_id: string | null;
}

export function getGuildPlayerSettings(guildId: string): GuildPlayerSettings {
  const row = db
    .prepare<
      [string],
      { volume: number | null; autoplay_enabled: number | null; dj_role_id: string | null }
    >("SELECT volume, autoplay_enabled, dj_role_id FROM GuildSettings WHERE guild_id = ?")
    .get(guildId);
  return {
    volume: row?.volume ?? 100,
    autoplay_enabled: row?.autoplay_enabled === 1,
    dj_role_id: row?.dj_role_id ?? null,
  };
}

export function updateGuildPlayerSettings(guildId: string, patch: Partial<GuildPlayerSettings>) {
  if (
    patch.volume !== undefined &&
    (!Number.isInteger(patch.volume) || patch.volume < 0 || patch.volume > 200)
  )
    throw new Error("Volume must be an integer between 0 and 200.");
  if (patch.autoplay_enabled !== undefined && typeof patch.autoplay_enabled !== "boolean")
    throw new Error("Invalid autoplay setting.");
  if (
    patch.dj_role_id !== undefined &&
    patch.dj_role_id !== null &&
    !/^\d{17,20}$/.test(patch.dj_role_id)
  )
    throw new Error("Invalid DJ role ID.");
  const settings = { ...getGuildPlayerSettings(guildId), ...patch };
  db.prepare(
    `INSERT INTO GuildSettings (guild_id, volume, autoplay_enabled, dj_role_id) VALUES (?, ?, ?, ?)
    ON CONFLICT(guild_id) DO UPDATE SET volume=excluded.volume, autoplay_enabled=excluded.autoplay_enabled, dj_role_id=excluded.dj_role_id`,
  ).run(guildId, settings.volume, settings.autoplay_enabled ? 1 : 0, settings.dj_role_id);
  return settings;
}

export function getGuildStorageLimit(guildId: string): number {
  return (
    db
      .prepare<[string], { max_storage_bytes: number }>(
        "SELECT max_storage_bytes FROM GuildSettings WHERE guild_id = ?",
      )
      .get(guildId)?.max_storage_bytes ?? DEFAULT_MAX_STORAGE_BYTES
  );
}

export function setGuildStorageLimit(guildId: string, bytes: number): void {
  if (!Number.isSafeInteger(bytes) || bytes < 0) throw new Error("Invalid storage limit");
  db.prepare(
    `INSERT INTO GuildSettings (guild_id, max_storage_bytes) VALUES (?, ?)
    ON CONFLICT (guild_id) DO UPDATE SET max_storage_bytes = excluded.max_storage_bytes`,
  ).run(guildId, bytes);
}
