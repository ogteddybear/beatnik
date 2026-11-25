import { db } from "./client";

export const MB = 1024 * 1024;
export const DEFAULT_MAX_STORAGE_BYTES = 100 * MB;

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
