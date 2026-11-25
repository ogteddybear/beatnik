import { lstat, readdir } from "node:fs/promises";
import path from "node:path";

import { config } from "../config";
import { getGuildStorageLimit } from "../db/guild-settings";

export function guildCacheDirectory(guildId: string): string {
  if (!guildId || guildId === "." || guildId === ".." || /[\\/:]/.test(guildId))
    throw new Error("Invalid guild ID for cache");
  return path.join(config.libraryPath, guildId);
}

// Only regular files directly in this guild's directory; never global audio,
// databases, other guilds or symbolic-link targets. Includes in-flight files.
export async function calculateGuildStorage(guildId: string): Promise<number> {
  const directory = guildCacheDirectory(guildId);
  let files;
  try {
    files = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw error;
  }
  let bytes = 0;
  for (const file of files) {
    if (!file.isFile()) continue;
    try {
      const info = await lstat(path.join(directory, file.name));
      if (info.isFile()) bytes += info.size;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return bytes;
}

export function storagePercentage(used: number, max: number): number {
  return max === 0 ? (used > 0 ? 100 : 0) : (used / max) * 100;
}

export async function guildStorageSummary(guildId: string) {
  const storageBytes = await calculateGuildStorage(guildId);
  const maxStorageBytes = getGuildStorageLimit(guildId);
  return {
    storageBytes,
    maxStorageBytes,
    storagePercentage: storagePercentage(storageBytes, maxStorageBytes),
    storageOverQuota: storageBytes > maxStorageBytes,
  };
}
