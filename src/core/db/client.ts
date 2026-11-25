import Database from "better-sqlite3";

import { config } from "../config";
import { runMigrations } from "./migrations";

const url = config.databaseUrl;

const tableInit = `
  CREATE TABLE IF NOT EXISTS Playlist (
    int_id      INTEGER PRIMARY KEY AUTOINCREMENT,
    id          TEXT NOT NULL,
    url         TEXT NOT NULL,
    title       TEXT NOT NULL,
    authorName  TEXT NOT NULL,
    lastUpdated TEXT NOT NULL,
    providerId  TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS Track (
    int_id       INTEGER PRIMARY KEY AUTOINCREMENT,
    id           TEXT NOT NULL,
    url          TEXT NOT NULL,
    title        TEXT NOT NULL,
    thumbnailUrl TEXT NOT NULL,
    length       INTEGER NOT NULL,
    channelName  TEXT NOT NULL,
    loudness     REAL,
    playlistId   INTEGER REFERENCES Playlist(int_id) ON DELETE CASCADE ON UPDATE CASCADE,
    playlistIdx  INTEGER,
    providerId  TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS GuildStats (
    guild_id        TEXT PRIMARY KEY,
    requests        INTEGER DEFAULT 0,
    plays           INTEGER DEFAULT 0,
    skips           INTEGER DEFAULT 0,
    stops           INTEGER DEFAULT 0,
    commands_used   INTEGER DEFAULT 0,
    last_active_at  INTEGER
  );

  CREATE TABLE IF NOT EXISTS GuildTrackMap (
    guild_id           TEXT,
    track_id           TEXT,
    last_requested_at  INTEGER,
    PRIMARY KEY (guild_id, track_id)
  );

  CREATE TABLE IF NOT EXISTS GuildEvents (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    guild_id    TEXT,
    user_id     TEXT,
    event_type  TEXT,
    action      TEXT,
    metadata    TEXT,
    created_at  INTEGER
  );

  CREATE INDEX IF NOT EXISTS idx_guild_events_latest
    ON GuildEvents (created_at DESC, id DESC);

  CREATE INDEX IF NOT EXISTS idx_guild_events_guild_date
    ON GuildEvents (guild_id, created_at DESC, id DESC);

  CREATE INDEX IF NOT EXISTS idx_guild_events_guild_id
    ON GuildEvents (guild_id, id DESC);
`;

async function getDatabaseClient() {
  const db = new Database(url);
  db.pragma("journal_mode = DELETE");
  db.pragma("foreign_keys = ON");
  db.exec(tableInit);
  runMigrations(db);
  return db;
}

export const db = await getDatabaseClient();
