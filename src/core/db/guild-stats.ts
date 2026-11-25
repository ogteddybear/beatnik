import { db } from "./client";
import { logEvent } from "./guild-events";

interface GuildStats {
  requests: number;
  plays: number;
  skips: number;
  stops: number;
  commands_used: number;
}

const trackRequest = db.prepare<[string, string, number]>(`
  INSERT INTO GuildTrackMap (guild_id, track_id, last_requested_at)
  VALUES (?, ?, ?)
  ON CONFLICT (guild_id, track_id) DO UPDATE SET
    last_requested_at = excluded.last_requested_at
`);

const recordRequests = db.transaction((guildId: string, userId: string, trackIds: string[]) => {
  const now = Date.now();
  for (const trackId of trackIds) {
    logEvent(guildId, userId, "player", "request", { trackId });
    trackRequest.run(guildId, trackId, now);
  }
});

export const guildStats = {
  recordRequests,
  get(guildId: string): GuildStats {
    return (
      db
        .prepare<[string], GuildStats>(
          "SELECT requests, plays, skips, stops, commands_used FROM GuildStats WHERE guild_id = ?",
        )
        .get(guildId) ?? { requests: 0, plays: 0, skips: 0, stops: 0, commands_used: 0 }
    );
  },
  getTrackIds(guildId: string): string[] {
    return db
      .prepare<[string], { track_id: string }>(
        "SELECT track_id FROM GuildTrackMap WHERE guild_id = ?",
      )
      .all(guildId)
      .map(({ track_id }) => track_id);
  },
};
