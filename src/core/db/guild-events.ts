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
