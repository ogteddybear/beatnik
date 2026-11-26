import type { ProviderTrack } from "@/providers";

import { db } from "./client";

interface Playlist {
  id: number;
  owner_id: string;
  name: string;
  created_at: number;
}
interface TrackRow {
  provider_id: string;
  track_id: string;
  title: string;
  url: string;
  duration: number;
  channel_name: string;
  thumbnail_url: string;
}
export interface CustomPlaylist extends Playlist {
  tracks: ProviderTrack[];
}
const MAX_TRACKS = 1000;
const get = (owner: string, id: number) =>
  db
    .prepare<[string, number], Playlist>("SELECT * FROM UserPlaylist WHERE owner_id = ? AND id = ?")
    .get(owner, id);
function tracks(id: number): ProviderTrack[] {
  return db
    .prepare<[number], TrackRow>(
      "SELECT * FROM UserPlaylistTrack WHERE playlist_id = ? ORDER BY id",
    )
    .all(id)
    .map((row) => ({
      id: row.track_id,
      providerId: row.provider_id,
      title: row.title,
      url: row.url,
      length: row.duration,
      channelName: row.channel_name,
      thumbnailUrl: row.thumbnail_url,
      loudness: null,
      playlistIdx: null,
    }));
}
function insertTrack(id: number, track: ProviderTrack) {
  db.prepare(
    `INSERT INTO UserPlaylistTrack (playlist_id, provider_id, track_id, title, url, duration, channel_name, thumbnail_url)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    track.providerId,
    track.id,
    track.title,
    track.url,
    track.length,
    track.channelName,
    track.thumbnailUrl,
  );
}
export const userPlaylists = {
  get(owner: string, id: number): CustomPlaylist | undefined {
    const playlist = get(owner, id);
    return playlist ? { ...playlist, tracks: tracks(id) } : undefined;
  },
  byName(owner: string, name: string): CustomPlaylist | undefined {
    const row = db
      .prepare<[string, string], Playlist>(
        "SELECT * FROM UserPlaylist WHERE owner_id = ? AND name = ?",
      )
      .get(owner, name);
    return row ? { ...row, tracks: tracks(row.id) } : undefined;
  },
  list(owner: string): CustomPlaylist[] {
    return db
      .prepare<[string], Playlist>(
        "SELECT * FROM UserPlaylist WHERE owner_id = ? ORDER BY created_at DESC, id DESC",
      )
      .all(owner)
      .map((row) => ({ ...row, tracks: tracks(row.id) }));
  },
  create: db.transaction((owner: string, name: string, items: ProviderTrack[] = []) => {
    if (!name.trim() || name.trim().length > 100 || items.length > MAX_TRACKS)
      throw new Error("Invalid playlist");
    const count =
      db
        .prepare<[string], { count: number }>(
          "SELECT count(*) AS count FROM UserPlaylist WHERE owner_id = ?",
        )
        .get(owner)?.count ?? 0;
    if (count >= 100) throw new Error("Playlist limit reached");
    const result = db
      .prepare("INSERT INTO UserPlaylist (owner_id, name, created_at) VALUES (?, ?, ?)")
      .run(owner, name.trim(), Date.now());
    const id = Number(result.lastInsertRowid);
    for (const track of items) insertTrack(id, track);
    return id;
  }),
  add: db.transaction((owner: string, id: number, track: ProviderTrack) => {
    if (!get(owner, id)) return false;
    const count =
      db
        .prepare<[number], { count: number }>(
          "SELECT count(*) AS count FROM UserPlaylistTrack WHERE playlist_id = ?",
        )
        .get(id)?.count ?? 0;
    if (count >= MAX_TRACKS) throw new Error("Track limit reached");
    insertTrack(id, track);
    return true;
  }),
  delete(owner: string, id: number) {
    return (
      db.prepare("DELETE FROM UserPlaylist WHERE owner_id = ? AND id = ?").run(owner, id).changes >
      0
    );
  },
};
