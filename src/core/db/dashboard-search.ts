import { db } from "./client";
import { EVENT_HISTORY, type GuildEvent } from "./guild-events";

export function searchEvents(query: string, before = Number.MAX_SAFE_INTEGER) {
  const pattern = `%${query.replace(/[\\%_]/g, (value) => `\\${value}`)}%`;
  const rows = db
    .prepare<[number, string, string, string], Omit<GuildEvent, "metadata" | "user_id">>(
      `
    SELECT id, guild_id, username, track_name, event_type, action, created_at
    FROM ${EVENT_HISTORY}
    WHERE id < ? AND (username LIKE ? ESCAPE '\\' OR track_name LIKE ? ESCAPE '\\' OR action LIKE ? ESCAPE '\\')
    ORDER BY id DESC LIMIT 51
  `,
    )
    .all(before, pattern, pattern, pattern);
  const events = rows.slice(0, 50);
  return { events, nextBefore: rows.length > 50 ? events[events.length - 1].id : null };
}

export function serverOverview(guildIds: string[]) {
  const scope = JSON.stringify([...new Set(guildIds)]);
  const totals = db
    .prepare<[string], { guild_id: string; plays: number }>(
      `
    SELECT guild_id, coalesce(plays, 0) AS plays FROM GuildStats
    WHERE guild_id IN (SELECT value FROM json_each(?))
  `,
    )
    .all(scope);
  const top = db
    .prepare<[string], { guild_id: string; title: string; requests: number }>(
      `
    WITH requested AS (
      SELECT guild_id, track_name AS title, count(*) AS requests FROM ${EVENT_HISTORY}
      WHERE guild_id IN (SELECT value FROM json_each(?)) AND event_type = 'player' AND action = 'request'
        AND track_name IS NOT NULL AND trim(track_name) <> ''
      GROUP BY guild_id, track_name
    ), ranked AS (
      SELECT *, row_number() OVER (PARTITION BY guild_id ORDER BY requests DESC, title ASC) AS rank FROM requested
    ) SELECT guild_id, title, requests FROM ranked WHERE rank = 1
  `,
    )
    .all(scope);
  const overall = db
    .prepare<[string], { title: string; requests: number }>(
      `
    SELECT track_name AS title, count(*) AS requests FROM ${EVENT_HISTORY}
    WHERE guild_id IN (SELECT value FROM json_each(?)) AND event_type = 'player' AND action = 'request'
      AND track_name IS NOT NULL AND trim(track_name) <> ''
    GROUP BY track_name ORDER BY requests DESC, title ASC LIMIT 1
  `,
    )
    .get(scope);
  const plays = new Map(totals.map((row) => [row.guild_id, row.plays]));
  const tracks = new Map(
    top.map((row) => [row.guild_id, { title: row.title, requests: row.requests }]),
  );
  return {
    totalPlays: totals.reduce((sum, row) => sum + row.plays, 0),
    topTrack: overall ?? null,
    guilds: [...new Set(guildIds)].map((id) => ({
      id,
      plays: plays.get(id) ?? 0,
      topTrack: tracks.get(id) ?? null,
    })),
  };
}
