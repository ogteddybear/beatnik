import type { Statement } from "better-sqlite3";

import { db } from "./client";

export interface GuildEvent {
  id: number;
  guild_id: string | null;
  user_id: string | null;
  event_type: string;
  action: string;
  metadata: string | null;
  created_at: number;
}

type Counter = "requests" | "plays" | "skips" | "stops" | "commands_used";

const insertEvent = db.prepare<[string, string | null, string, string, string | null, number]>(`
  INSERT INTO GuildEvents (guild_id, user_id, event_type, action, metadata, created_at)
  VALUES (?, ?, ?, ?, ?, ?)
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
  ) => {
    insertEvent.run(guildId, userId, eventType, action, metadata, createdAt);
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

export function logEvent(
  guildId: string,
  userId: string | null,
  eventType: string,
  action: string,
  metadata?: Record<string, unknown>,
): void {
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
  writeEvent(guildId, userId, eventType, action, serialized, Date.now());
}

const latestEvents = db.prepare<[number], GuildEvent>(`
  SELECT id, guild_id, user_id, event_type, action, metadata, created_at
  FROM GuildEvents
  ORDER BY created_at DESC, id DESC
  LIMIT ?
`);

export function getLatestEvents(limit = 100): GuildEvent[] {
  return latestEvents.all(Math.min(Math.max(Math.trunc(limit), 0), 100));
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
      SELECT event_type, action, count(*) AS count FROM GuildEvents
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
): { events: GuildEvent[]; hasMore: boolean } {
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
    clauses.push("id < ?");
    values.push(options.before);
  }
  if (options.since !== undefined) {
    clauses.push("id > ?");
    values.push(options.since);
  }
  const limit = Math.min(Math.max(options.limit ?? 40, 1), 50);
  values.push(limit + 1);
  const rows = db
    .prepare<(string | number)[], GuildEvent>(
      `
      SELECT id, guild_id, user_id, event_type, action, metadata, created_at
      FROM GuildEvents WHERE ${clauses.join(" AND ")}
      ORDER BY id ${options.since === undefined ? "DESC" : "ASC"}
      LIMIT ?
    `,
    )
    .all(...values);
  return { events: rows.slice(0, limit), hasMore: rows.length > limit };
}
