import type { Statement } from "better-sqlite3";

import { publishGuildUpdate } from "../live-updates";
import { db } from "./client";

export interface GuildEvent {
  id: number;
  guild_id: string | null;
  user_id: string | null;
  event_type: string;
  action: string;
  metadata: string | null;
  created_at: number;
  username: string | null;
  track_name: string | null;
}

export interface EventOptions {
  guildId: string;
  userId?: string | null;
  username?: string | null;
  eventType: string;
  action: string;
  trackId?: string | null;
  trackName?: string | null;
  metadata?: object;
}
export const EVENT_COLUMNS =
  "id, guild_id, user_id, event_type, action, metadata, created_at, username, track_name";
export const EVENT_HISTORY = `(SELECT ${EVENT_COLUMNS} FROM main.GuildEvents UNION ALL SELECT ${EVENT_COLUMNS} FROM event_archive.GuildEvents)`;
export const EVENT_RETENTION_MS = 30 * 86_400_000;

type Counter = "requests" | "plays" | "skips" | "stops" | "commands_used";

const insertEvent = db.prepare<
  [string, string | null, string, string, string | null, number, string | null, string | null]
>(`
  INSERT INTO GuildEvents (guild_id, user_id, event_type, action, metadata, created_at, username, track_name)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
`);

function counterFor(eventType: string, action: string): Counter | null {
  if (eventType === "command") return "commands_used";
  if (eventType !== "player") return null;
  switch (action) {
    case "request":
      return "requests";
    case "play":
      return "plays";
    case "skip":
      return "skips";
    case "stop":
      return "stops";
    default:
      return null;
  }
}

const increment = new Map<Counter, Statement<[string, number]>>(
  (["requests", "plays", "skips", "stops", "commands_used"] as const).map((column) => [
    column,
    db.prepare<[string, number]>(`
      INSERT INTO GuildStats (guild_id, ${column}, last_active_at)
      VALUES (?, 1, ?)
      ON CONFLICT (guild_id) DO UPDATE SET
        ${column} = ${column} + 1,
        last_active_at = excluded.last_active_at
    `),
  ]),
);

const touch = db.prepare<[string, number]>(`
  INSERT INTO GuildStats (guild_id, last_active_at)
  VALUES (?, ?)
  ON CONFLICT (guild_id) DO UPDATE SET last_active_at = excluded.last_active_at
`);

const writeEvent = db.transaction(
  (
    guildId: string,
    userId: string | null,
    eventType: string,
    action: string,
    metadata: string | null,
    createdAt: number,
    username: string | null,
    trackName: string | null,
  ) => {
    insertEvent.run(guildId, userId, eventType, action, metadata, createdAt, username, trackName);
    const counter = counterFor(eventType, action);
    if (counter) {
      const statement = increment.get(counter);
      if (!statement) throw new Error(`No statement for event counter: ${counter}`);
      statement.run(guildId, createdAt);
    } else {
      touch.run(guildId, createdAt);
    }
  },
);

export function logEvent(opts: EventOptions): void {
  const metadata =
    opts.trackId == null ? opts.metadata : { ...opts.metadata, trackId: opts.trackId };
  let serialized: string | null = null;
  if (metadata !== undefined) {
    try {
      serialized = JSON.stringify(metadata, (_key, value: unknown) =>
        typeof value === "bigint" ? value.toString() : value,
      );
    } catch {
      serialized = JSON.stringify({ error: "Metadata could not be serialized" });
    }
  }
  writeEvent(
    opts.guildId,
    opts.userId ?? null,
    opts.eventType,
    opts.action,
    serialized,
    Date.now(),
    opts.username ?? null,
    opts.trackName ?? null,
  );
  publishGuildUpdate(opts.guildId);
}

const latestEvents = db.prepare<[number], GuildEvent>(`
  SELECT ${EVENT_COLUMNS}
  FROM GuildEvents
  ORDER BY created_at DESC, id DESC
  LIMIT ?
`);

export function getLatestEvents(limit = 100): GuildEvent[] {
  return latestEvents.all(Math.min(Math.max(Math.trunc(limit), 0), 100));
}

export function eventExportBoundary(): number {
  return (
    db.prepare<[], { id: number | null }>(`SELECT max(id) AS id FROM ${EVENT_HISTORY}`).get()?.id ??
    0
  );
}
export function eventExportPage(after: number, through: number): GuildEvent[] {
  return db
    .prepare<[number, number], GuildEvent>(
      `
    SELECT ${EVENT_COLUMNS} FROM ${EVENT_HISTORY} WHERE id > ? AND id <= ?
    ORDER BY id LIMIT 500
  `,
    )
    .all(after, through);
}

export function getGuildPlaybackHistory(guildId: string): GuildEvent[] {
  return db
    .prepare<[string], GuildEvent>(
      `
    SELECT ${EVENT_COLUMNS} FROM ${EVENT_HISTORY}
    WHERE guild_id = ? AND event_type = 'player' AND action = 'play'
    ORDER BY created_at DESC, id DESC LIMIT 10
  `,
    )
    .all(guildId);
}

export interface EventFilters {
  from: number;
  to: number;
  eventType?: string;
  action?: string;
  userId?: string;
}

export interface EventCounts {
  adds: number;
  requests: number;
  plays: number;
  skips: number;
  stops: number;
  commands: number;
  errors: number;
}

const emptyCounts = (): EventCounts => ({
  adds: 0,
  requests: 0,
  plays: 0,
  skips: 0,
  stops: 0,
  commands: 0,
  errors: 0,
});

function addCounts(
  counts: EventCounts,
  row: { event_type: string; action: string; count: number },
) {
  if (row.event_type === "library" && row.action === "add") counts.adds += row.count;
  if (row.event_type === "command") counts.commands += row.count;
  if (row.event_type === "command_error" || row.event_type === "player_error")
    counts.errors += row.count;
  if (row.event_type !== "player") return;
  if (row.action === "request") counts.requests += row.count;
  if (row.action === "play") counts.plays += row.count;
  if (row.action === "skip") counts.skips += row.count;
  if (row.action === "stop") counts.stops += row.count;
}

export function guildEventCounts(guildId: string, from: number, to: number): EventCounts {
  const counts = emptyCounts();
  const rows = db
    .prepare<[string, number, number], { event_type: string; action: string; count: number }>(
      `
      SELECT event_type, action, count(*) AS count FROM ${EVENT_HISTORY}
      WHERE guild_id = ? AND created_at >= ? AND created_at < ?
      GROUP BY event_type, action
    `,
    )
    .all(guildId, from, to);
  for (const row of rows) addCounts(counts, row);
  return counts;
}

export function recentGuildCounts(from: number, to: number): Map<string, EventCounts> {
  const rows = db
    .prepare<
      [number, number],
      { guild_id: string; event_type: string; action: string; count: number }
    >(
      `
      SELECT guild_id, event_type, action, count(*) AS count FROM GuildEvents
      WHERE created_at >= ? AND created_at < ? AND guild_id IS NOT NULL
      GROUP BY guild_id, event_type, action
    `,
    )
    .all(from, to);
  const result = new Map<string, EventCounts>();
  for (const row of rows) {
    let counts = result.get(row.guild_id);
    if (!counts) {
      counts = emptyCounts();
      result.set(row.guild_id, counts);
    }
    addCounts(counts, row);
  }
  return result;
}

export function guildEventPage(
  guildId: string,
  filters: EventFilters,
  options: { before?: number; since?: number; limit?: number } = {},
  archiveOnly = false,
): { events: GuildEvent[]; hasMore: boolean } {
  const source = archiveOnly
    ? "event_archive.GuildEvents"
    : filters.from < Date.now() - EVENT_RETENTION_MS
      ? EVENT_HISTORY
      : "main.GuildEvents";
  const clauses = ["guild_id = ?", "created_at >= ?", "created_at < ?"];
  const values: (string | number)[] = [guildId, filters.from, filters.to];
  if (filters.eventType) {
    clauses.push("event_type = ?");
    values.push(filters.eventType);
  }
  if (filters.action) {
    clauses.push("action = ?");
    values.push(filters.action);
  }
  if (filters.userId) {
    clauses.push("user_id = ?");
    values.push(filters.userId);
  }
  if (options.before !== undefined) {
    const event = db
      .prepare<[number, string], { created_at: number }>(
        `SELECT created_at FROM ${source} WHERE id = ? AND guild_id = ?`,
      )
      .get(options.before, guildId);
    if (!event) return { events: [], hasMore: false };
    clauses.push("(created_at, id) < (?, ?)");
    values.push(event.created_at, options.before);
  }
  if (options.since !== undefined) {
    const event = db
      .prepare<[number, string], { created_at: number }>(
        `SELECT created_at FROM ${source} WHERE id = ? AND guild_id = ?`,
      )
      .get(options.since, guildId);
    if (!event) return { events: [], hasMore: false };
    clauses.push("(created_at, id) > (?, ?)");
    values.push(event.created_at, options.since);
  }
  const limit = Math.min(Math.max(options.limit ?? 40, 1), 50);
  values.push(limit + 1);
  const rows = db
    .prepare<(string | number)[], GuildEvent>(
      `
      SELECT ${EVENT_COLUMNS}
      FROM ${source} WHERE ${clauses.join(" AND ")}
      ORDER BY created_at ${options.since === undefined ? "DESC" : "ASC"}, id ${options.since === undefined ? "DESC" : "ASC"}
      LIMIT ?
    `,
    )
    .all(...values);
  return { events: rows.slice(0, limit), hasMore: rows.length > limit };
}

export function getArchivedEvents(
  filters: EventFilters & { guildId: string; before?: number; since?: number; limit?: number },
) {
  return guildEventPage(filters.guildId, filters, filters, true);
}
