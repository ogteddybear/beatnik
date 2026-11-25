import type { Provider, ProviderPlaylist, ProviderTrack } from "@/providers";
import { log } from "@/shared";
import { createReadStream, createWriteStream, existsSync } from "node:fs";
import { mkdir, readdir, rename, rm } from "node:fs/promises";
import path from "node:path";
import type { Readable } from "node:stream";
import { finished } from "node:stream/promises";

import { config } from "../config";

const libDir = config.libraryPath;
const globalCache = "global";

async function ensureLibraryDirectory() {
  await mkdir(libDir, { recursive: true });
}

function cacheDirectory(guildId: string) {
  if (!guildId || guildId === "." || guildId === ".." || /[\\/:]/.test(guildId)) {
    throw new Error("Invalid guild ID for cache");
  }
  return path.join(libDir, guildId);
}

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

export async function downloadToCache(guildId: string, id: string, stream: Readable) {
  // download stream to cache dir
  try {
    const targetPath = getItemPath(guildId, id);
    await mkdir(cacheDirectory(guildId), { recursive: true });
    if (targetPath.exists) {
      return false;
    }
    log({ component: "CORE", name: "CACHE", message: "Downloading " + id + "..." });

    const diskStream = createWriteStream(targetPath.path);
    await finished(stream.pipe(diskStream));

    log({ component: "CORE", name: "CACHE", message: "Finished downloading " + id });
    return true;
  } catch (err) {
    console.error(err);
    return false;
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
        const stream = await provider.getStream(track.id);
        await downloadToCache(guildId, track.id, stream);
        onProgress?.(track, ++completed, tracksToDownload.length);
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
