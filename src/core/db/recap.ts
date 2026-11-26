import { db } from "./client";
import { EVENT_HISTORY } from "./guild-events";

export function userRecap(userId: string, now = Date.now()) {
  const cte = `WITH plays AS (
    SELECT track_name, CASE WHEN json_valid(metadata) THEN metadata ELSE '{}' END AS data
    FROM ${EVENT_HISTORY} WHERE user_id = ? AND event_type = 'player' AND action = 'play' AND created_at >= ? AND created_at <= ?
  )`;
  const args: [string, number, number] = [userId, now - 30 * 86400000, now];
  const totals = db
    .prepare<typeof args, { plays: number; durationSeconds: number; measuredPlays: number }>(
      `${cte}
    SELECT count(*) AS plays,
      coalesce(sum(CASE WHEN json_type(data,'$.durationSeconds') IN ('integer','real') AND json_extract(data,'$.durationSeconds') BETWEEN 0 AND 86400 THEN json_extract(data,'$.durationSeconds') ELSE 0 END),0) AS durationSeconds,
      coalesce(sum(json_type(data,'$.durationSeconds') IN ('integer','real') AND json_extract(data,'$.durationSeconds') BETWEEN 0 AND 86400),0) AS measuredPlays FROM plays`,
    )
    .get(...args);
  const topTrack = db
    .prepare<typeof args, { name: string; count: number }>(
      `${cte}
    SELECT track_name AS name, count(*) AS count FROM plays WHERE track_name IS NOT NULL AND trim(track_name) <> ''
    GROUP BY track_name ORDER BY count DESC, name ASC LIMIT 1`,
    )
    .get(...args);
  const topArtist = db
    .prepare<typeof args, { name: string; count: number }>(
      `${cte}
    SELECT json_extract(data,'$.artist') AS name, count(*) AS count FROM plays WHERE json_type(data,'$.artist') = 'text' AND trim(json_extract(data,'$.artist')) <> ''
    GROUP BY name ORDER BY count DESC, name ASC LIMIT 1`,
    )
    .get(...args);
  return { ...totals, topTrack: topTrack ?? null, topArtist: topArtist ?? null };
}
