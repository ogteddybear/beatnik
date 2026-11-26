import type { Provider, ProviderPlaylist, ProviderTrack } from "@/providers";
import { log } from "@/shared";

import { isProviderEnabled } from "../db/bot-settings";
import { logEvent } from "../db/guild-events";
import { playlists } from "../db/playlist";
import { tracks } from "../db/track";
import { providers } from "../manager";
import { resolveQuery } from "../resolvers";
import {
  countCacheFiles,
  downloadPlaylist,
  downloadToCache,
  hasDownload,
  migrateCacheNames,
  removeDownload,
} from "./disk";

export interface LibraryOperationResult {
  added: boolean;
  updated?: boolean;
  error?: "EXISTS";
  completed: number;
  errors: number;
}
export interface LibraryActor {
  userId: string;
  username: string;
}
function recordDownload(guildId: string, actor?: LibraryActor) {
  return (track: ProviderTrack) =>
    logEvent({
      guildId,
      ...actor,
      eventType: "library",
      action: "download",
      trackId: track.id,
      trackName: track.title,
      metadata: { providerId: track.providerId },
    });
}

export async function testLibraryConnection() {
  try {
    const migratedCacheCount = await migrateCacheNames();
    if (migratedCacheCount) {
      log({
        component: "CORE",
        name: "CACHE",
        message: `Migrated ${migratedCacheCount} files to new cache format`,
      });
    }
    const cacheCount = await countCacheFiles();
    log({
      component: "CORE",
      name: "CACHE",
      message: `Found ${cacheCount} cache files.`,
    });
    const playlistCount = playlists.count();
    const trackCount = tracks.count();
    log({
      component: "CORE",
      name: "DB",
      message: `Connected to library database! (${playlistCount} playlists, ${trackCount} tracks)`,
    });
  } catch (err) {
    console.error(err);
    process.exit();
  }
}

export async function addTrackToLibrary(
  guildId: string,
  track: ProviderTrack,
  provider: Provider,
  actor?: LibraryActor,
): Promise<LibraryOperationResult> {
  // add track to db and save file
  const existingTrack = tracks.get(track.id);
  if (existingTrack && hasDownload(guildId, track.id)) {
    return {
      added: false,
      updated: false,
      error: "EXISTS",
      completed: 0,
      errors: 0,
    };
  }
  try {
    if (!isProviderEnabled(provider.id))
      throw new Error("This provider is disabled by the bot owner.");
    const stream = await provider.getStream(track.id);
    if (
      !(await downloadToCache(
        guildId,
        track.id,
        stream,
        () => recordDownload(guildId, actor)(track),
        { ...actor, trackName: track.title },
      ))
    ) {
      return { added: false, completed: 0, errors: 1 };
    }
    // only create track in db if download succeeds
    if (!existingTrack) tracks.create({ ...track, playlistId: null, playlistIdx: null });
    return {
      added: !existingTrack,
      updated: !!existingTrack,
      completed: 1,
      errors: 0,
    };
  } catch (_err) {
    return {
      added: false,
      updated: false,
      completed: 0,
      errors: 1,
    };
  }
}

export async function deleteTrackFromLibrary(guildId: string, int_id: number) {
  const trackRecord = tracks.getInternal(int_id);
  if (!trackRecord) return;
  await removeDownload(guildId, trackRecord.id);
  await removeDownload("global", trackRecord.id);
  tracks.delete(int_id);
  return { title: trackRecord.title };
}

export async function addPlaylistToLibrary(
  guildId: string,
  playlistData: ProviderPlaylist,
  provider: Provider,
  onProgress?: (track: ProviderTrack, index: number, total: number) => void,
  actor?: LibraryActor,
): Promise<LibraryOperationResult> {
  const playlistExists = playlists.exists(playlistData.id);
  if (playlistExists) {
    playlists.update(playlistData);
  } else {
    playlists.create(playlistData);
  }
  const { completed, errors } = await downloadPlaylist(
    guildId,
    playlistData,
    provider,
    onProgress,
    recordDownload(guildId, actor),
    actor,
  );
  return {
    added: !playlistExists,
    updated: playlistExists,
    completed,
    errors,
  };
}

export async function updatePlaylistInLibrary(
  guildId: string,
  playlistIntId: number,
  onProgress?: (track: ProviderTrack, index: number, total: number) => void,
  actor?: LibraryActor,
) {
  const existingPlaylistData = playlists.getInfo(playlistIntId);
  if (!existingPlaylistData) throw new Error(`${playlistIntId} Playlist does not exist`);

  const provider = providers.find((p) => p.id === existingPlaylistData.providerId);
  if (!provider) throw new Error(`No provider found for ${existingPlaylistData.providerId}`);

  // don't resolve metadata through resolver (would use DB)
  const query = await resolveQuery(existingPlaylistData.url, false);
  if (!query) throw new Error(`${existingPlaylistData.url} metadata was not found from provider.`);

  if (query.type !== "playlist")
    throw new Error(`Query ${existingPlaylistData.url} is not a playlist!`);

  const freshMetadata = await provider.getPlaylist(query.resolvedQuery);
  log({
    message: `Fresh playlist metadata found for ${freshMetadata?.id}: ${freshMetadata?.tracks.length} tracks. `,
    component: "CORE",
    name: "CACHE",
  });
  if (!freshMetadata)
    throw new Error(`${query.resolvedQuery} metadata was not found from provider.`);

  if (freshMetadata.tracks.length < 1) {
    throw new Error(`No tracks found for playlist ${freshMetadata?.title}`);
  }

  return {
    operation: await addPlaylistToLibrary(guildId, freshMetadata, provider, onProgress, actor),
    playlistData: freshMetadata,
  };
}

export async function deletePlaylistFromLibrary(guildId: string, playlist_int_id: number) {
  const trackRecords = tracks.inPlaylist(playlist_int_id);
  const rmPromises = trackRecords.flatMap((t) => [
    removeDownload(guildId, t.id),
    removeDownload("global", t.id),
  ]);
  await Promise.all(rmPromises);

  return playlists.delete(playlist_int_id);
}
