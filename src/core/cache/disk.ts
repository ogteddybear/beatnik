import type { Provider, ProviderPlaylist, ProviderTrack } from "@/providers";
import { log } from "@/shared";
import { randomUUID } from "node:crypto";
import { createReadStream, createWriteStream, existsSync } from "node:fs";
import { mkdir, readdir, rename, rm } from "node:fs/promises";
import path from "node:path";
import { type Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

import { config } from "../config";
import { isProviderEnabled } from "../db/bot-settings";
import { type EventOptions, logEvent } from "../db/guild-events";
import { getGuildStorageLimit } from "../db/guild-settings";
import { calculateGuildStorage, guildCacheDirectory } from "./storage";

const libDir = config.libraryPath;
const globalCache = "global";

async function ensureLibraryDirectory() {
  await mkdir(libDir, { recursive: true });
}

const cacheDirectory = guildCacheDirectory;
type CacheEventContext = Pick<EventOptions, "userId" | "username" | "trackName">;
const guildWrites = new Map<string, Promise<void>>();
class QuotaExceeded extends Error {}

function getItemPath(guildId: string, id: string) {
  if (!id || id === "." || id === ".." || /[\\/:]/.test(id)) {
    throw new Error("Invalid track ID for cache");
  }
  const itemPath = path.join(cacheDirectory(guildId), id + ".cache");
  const exists = existsSync(itemPath);
  return { path: itemPath, exists };
}

export function hasDownload(guildId: string, id: string): boolean {
  return getItemPath(guildId, id).exists;
}

export async function migrateCacheNames() {
  await ensureLibraryDirectory();
  const globalDir = cacheDirectory(globalCache);
  await mkdir(globalDir, { recursive: true });
  let moved = 0;
  for (const entry of await readdir(libDir, { withFileTypes: true })) {
    if (!entry.isFile() || (!entry.name.endsWith(".opus") && !entry.name.endsWith(".cache")))
      continue;
    const target = path.join(globalDir, entry.name.replace(/\.opus$/, ".cache"));
    if (existsSync(target)) {
      throw new Error(`Cannot migrate ${entry.name}: destination already exists in global cache`);
    }
    await rename(path.join(libDir, entry.name), target);
    moved++;
  }
  return moved;
}

export async function countCacheFiles() {
  await ensureLibraryDirectory();
  let count = 0;
  for (const entry of await readdir(libDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    for (const file of await readdir(path.join(libDir, entry.name), { withFileTypes: true })) {
      if (file.isFile() && file.name.endsWith(".cache")) count++;
    }
  }
  return count;
}

export async function downloadToCache(
  guildId: string,
  id: string,
  stream: Readable,
  onDownloaded?: () => void,
  eventContext?: CacheEventContext,
) {
  // Providers can emit a late error while this stream waits for another guild
  // write. Keep it handled until pipeline takes ownership.
  let streamError: Error | undefined;
  const rememberError = (error: Error) => {
    streamError = error;
  };
  stream.on("error", rememberError);
  // Serialize writes within each guild, not across guilds. This avoids two
  // playlist workers both reserving the same free bytes.
  const previous = guildWrites.get(guildId) ?? Promise.resolve();
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  guildWrites.set(guildId, pending);
  await previous;
  let temporaryPath: string | undefined;
  try {
    if (streamError) throw streamError;
    const targetPath = getItemPath(guildId, id);
    await mkdir(cacheDirectory(guildId), { recursive: true });
    if (targetPath.exists) {
      stream.destroy();
      return false;
    }
    const used = await calculateGuildStorage(guildId);
    if (used >= getGuildStorageLimit(guildId)) throw new QuotaExceeded();
    log({ component: "CORE", name: "CACHE", message: "Downloading " + id + "..." });

    // Providers don't expose the final encoded size. Reject the first chunk
    // that would exceed the quota, before it reaches disk.
    let received = 0;
    const guard = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        try {
          if (used + received + chunk.length > getGuildStorageLimit(guildId)) {
            callback(new QuotaExceeded());
            return;
          }
          received += chunk.length;
          callback(null, chunk);
        } catch (error) {
          callback(error as Error);
        }
      },
    });
    if (streamError) throw streamError;
    temporaryPath = path.join(cacheDirectory(guildId), `${randomUUID()}.partial`);
    await pipeline(stream, guard, createWriteStream(temporaryPath, { flags: "wx" }));
    // The owner may lower the limit while a download is running.
    if ((await calculateGuildStorage(guildId)) > getGuildStorageLimit(guildId))
      throw new QuotaExceeded();
    await rename(temporaryPath, targetPath.path);
    temporaryPath = undefined;
    try {
      onDownloaded?.();
    } catch (error) {
      console.error("Unable to record download event:", error);
    }

    log({ component: "CORE", name: "CACHE", message: "Finished downloading " + id });
    return true;
  } catch (err) {
    stream.destroy();
    if (err instanceof QuotaExceeded) {
      console.warn(`Storage quota exceeded for guild ${guildId}; skipping cache write for ${id}.`);
      try {
        logEvent({
          guildId,
          ...eventContext,
          eventType: "library",
          action: "quota_exceeded",
          trackId: id,
        });
      } catch (error) {
        console.error("Unable to record quota event:", error);
      }
    } else console.error(err);
    return false;
  } finally {
    try {
      if (temporaryPath) await rm(temporaryPath, { force: true });
    } finally {
      stream.off("error", rememberError);
      release();
      if (guildWrites.get(guildId) === pending) guildWrites.delete(guildId);
    }
  }
}

export async function removeDownload(guildId: string, id: string) {
  const targetPath = getItemPath(guildId, id);
  if (!targetPath.exists) {
    return;
  }
  log({ component: "CORE", name: "CACHE", message: "Deleting " + id + " from disk." });

  return rm(targetPath.path);
}

export async function downloadPlaylist(
  guildId: string,
  playlist: ProviderPlaylist,
  provider: Provider,
  onProgress?: (track: ProviderTrack, index: number, total: number) => void,
  onDownloaded?: (track: ProviderTrack) => void,
  actor?: Pick<CacheEventContext, "userId" | "username">,
) {
  const tracksToDownload = playlist.tracks.filter((t) => !getItemPath(guildId, t.id).exists);
  const concurrency = 10;
  const queue = [...tracksToDownload];
  let completed = 0;
  let errors = 0;

  async function worker() {
    while (queue.length > 0) {
      const track = queue.shift();
      if (!track) break;
      try {
        if (!isProviderEnabled(provider.id))
          throw new Error("This provider is disabled by the bot owner.");
        const stream = await provider.getStream(track.id);
        if (
          await downloadToCache(guildId, track.id, stream, () => onDownloaded?.(track), {
            ...actor,
            trackName: track.title,
          })
        ) {
          completed++;
          onProgress?.(track, completed, tracksToDownload.length);
        } else errors++;
      } catch (err) {
        log({
          component: "CORE",
          name: "CACHE",
          message: "Failed to download " + track.id,
          level: "ERROR",
        });
        console.error(err);
        errors++;
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, tracksToDownload.length) }, worker));
  return { completed, errors };
}

export function getDownloadedIdStream(guildId: string, id: string) {
  const guildFile = getItemPath(guildId, id);
  const globalFile = getItemPath(globalCache, id);
  const target = guildFile.exists ? guildFile : globalFile;
  if (!target.exists) {
    log({
      component: "CORE",
      name: "CACHE",
      message: "Unable to locate " + id + " in cache.",
    });
    return undefined;
  }
  return createReadStream(target.path);
}
