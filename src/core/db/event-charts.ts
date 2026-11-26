import { db } from "./client";
import { EVENT_HISTORY } from "./guild-events";

const DAY = 86_400_000;
export interface ChartDay {
  day: string;
  plays: number;
  skips: number;
  errors: number;
  commands: number;
}
export function eventCharts(guildIds: string[], now = Date.now()) {
  // Thirty UTC calendar days, including today's partial day.
  const today = Math.floor(now / DAY) * DAY;
  const from = today - 29 * DAY;
  const through = now + 1;
  const scope = JSON.stringify([...new Set(guildIds)]);
  const where = `guild_id IN (SELECT value FROM json_each(?)) AND created_at >= ? AND created_at < ?`;
  const rows = db
    .prepare<[string, number, number], ChartDay>(
      `
    SELECT strftime('%Y-%m-%d', created_at / 1000, 'unixepoch') AS day,
      sum(event_type = 'player' AND action = 'play') AS plays,
      sum(event_type = 'player' AND action = 'skip') AS skips,
      sum(event_type IN ('player_error', 'command_error')) AS errors,
      sum(event_type = 'command') AS commands
    FROM ${EVENT_HISTORY} WHERE ${where} GROUP BY day ORDER BY day
  `,
    )
    .all(scope, from, through);
  const byDay = new Map(rows.map((row) => [row.day, row]));
  const days = Array.from({ length: 30 }, (_, index) => {
    const day = new Date(from + index * DAY).toISOString().slice(0, 10);
    const row = byDay.get(day);
    return {
      day,
      plays: row?.plays ?? 0,
      skips: row?.skips ?? 0,
      errors: row?.errors ?? 0,
      commands: row?.commands ?? 0,
    };
  });
  // Older events without a title cannot identify a track and are omitted.
  const topTracks = db
    .prepare<[string, number, number], { title: string; requests: number }>(
      `
    SELECT track_name AS title, count(*) AS requests FROM ${EVENT_HISTORY}
    WHERE ${where} AND event_type = 'player' AND action = 'request'
      AND track_name IS NOT NULL AND trim(track_name) <> ''
    GROUP BY track_name ORDER BY requests DESC, title ASC LIMIT 10
  `,
    )
    .all(scope, from, through);
  const distribution = days.reduce(
    (totals, day) => ({
      commands: totals.commands + day.commands,
      plays: totals.plays + day.plays,
      skips: totals.skips + day.skips,
    }),
    { commands: 0, plays: 0, skips: 0 },
  );
  return { from, through, timezone: "UTC", days, topTracks, distribution };
}
