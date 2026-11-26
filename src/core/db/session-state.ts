import type { LoopMode, QueuedTrack } from "../queue";
import { db } from "./client";

export interface SavedSession {
  guild_id: string;
  voice_channel_id: string;
  text_channel_id: string | null;
  queue_json: string;
  current_index: number;
  loop_mode: LoopMode;
  is_paused: number;
  updated_at: number;
}
export const savedSessions = {
  all: () => db.prepare<[], SavedSession>("SELECT * FROM GuildSessionState").all(),
  delete: (guildId: string) =>
    db.prepare("DELETE FROM GuildSessionState WHERE guild_id = ?").run(guildId),
  save: (row: SavedSession) =>
    db
      .prepare(
        `INSERT INTO GuildSessionState
    (guild_id, voice_channel_id, text_channel_id, queue_json, current_index, loop_mode, is_paused, updated_at)
    VALUES (@guild_id, @voice_channel_id, @text_channel_id, @queue_json, @current_index, @loop_mode, @is_paused, @updated_at)
    ON CONFLICT(guild_id) DO UPDATE SET voice_channel_id=excluded.voice_channel_id,
    text_channel_id=excluded.text_channel_id, queue_json=excluded.queue_json,
    current_index=excluded.current_index, loop_mode=excluded.loop_mode,
    is_paused=excluded.is_paused, updated_at=excluded.updated_at`,
      )
      .run(row),
};

export function decodeSession(row: SavedSession): QueuedTrack[] | null {
  try {
    const tracks: unknown = JSON.parse(row.queue_json);
    if (
      !row.voice_channel_id ||
      !Array.isArray(tracks) ||
      !tracks.length ||
      !Number.isInteger(row.current_index) ||
      row.current_index < 0 ||
      row.current_index >= tracks.length ||
      !["off", "track", "queue"].includes(row.loop_mode) ||
      ![0, 1].includes(row.is_paused)
    )
      return null;
    for (const item of tracks) {
      if (!item || typeof item !== "object") return null;
      for (const key of [
        "id",
        "providerId",
        "title",
        "url",
        "thumbnailUrl",
        "channelName",
        "addedBy",
      ])
        if (typeof item[key] !== "string") return null;
      if (
        !Number.isFinite(item.length) ||
        item.length < 0 ||
        (item.loudness !== null && !Number.isFinite(item.loudness))
      )
        return null;
    }
    return tracks as QueuedTrack[];
  } catch {
    return null;
  }
}
