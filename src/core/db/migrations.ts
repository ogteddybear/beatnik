import { log } from "@/shared";
import type { Database } from "better-sqlite3";

export const applicationStateSchema = `
  CREATE TABLE IF NOT EXISTS GuildSessionState (
    guild_id TEXT PRIMARY KEY, voice_channel_id TEXT, text_channel_id TEXT,
    queue_json TEXT NOT NULL, current_index INTEGER NOT NULL, loop_mode TEXT NOT NULL,
    is_paused INTEGER NOT NULL, updated_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS UserPlaylist (
    id INTEGER PRIMARY KEY AUTOINCREMENT, owner_id TEXT NOT NULL,
    name TEXT NOT NULL COLLATE NOCASE, created_at INTEGER NOT NULL,
    UNIQUE(owner_id, name)
  );
  CREATE TABLE IF NOT EXISTS UserPlaylistTrack (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    playlist_id INTEGER NOT NULL REFERENCES UserPlaylist(id) ON DELETE CASCADE,
    provider_id TEXT NOT NULL, track_id TEXT NOT NULL, title TEXT NOT NULL,
    url TEXT NOT NULL, duration REAL NOT NULL,
    channel_name TEXT NOT NULL DEFAULT '', thumbnail_url TEXT NOT NULL DEFAULT ''
  );
  CREATE INDEX IF NOT EXISTS idx_user_playlist_tracks ON UserPlaylistTrack(playlist_id, id);
`;
export const spotifyUserSchema = `
  CREATE TABLE IF NOT EXISTS SpotifyUserTokens (
    discord_user_id TEXT PRIMARY KEY, access_token TEXT NOT NULL,
    refresh_token TEXT NOT NULL, expires_at INTEGER NOT NULL,
    spotify_user_id TEXT, spotify_display_name TEXT, updated_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS SpotifyOAuthState (
    state_hash TEXT PRIMARY KEY, discord_user_id TEXT NOT NULL,
    session_id TEXT NOT NULL, expires_at INTEGER NOT NULL, consumed INTEGER NOT NULL DEFAULT 0
  );
`;

interface Migration {
  name: string;
  up: (db: Database) => void;
}

interface ColumnInfo {
  cid: number;
  name: string;
  type: string;
  notnull: number;
  dflt_value: string | null;
  pk: number;
}

export function ensureGuildEventColumns(db: Database): void {
  const columns = new Set(
    db
      .prepare<[], ColumnInfo>("PRAGMA table_info(GuildEvents)")
      .all()
      .map((column) => column.name),
  );
  for (const name of ["username", "track_name"]) {
    if (!columns.has(name)) db.exec(`ALTER TABLE GuildEvents ADD COLUMN ${name} TEXT`);
  }
}

const migrations: Migration[] = [
  // Keep new migrations at the end: existing installations retain event data.
  {
    name: "001_loudness_nullable_and_real",
    up: (db) => {
      const tableInfo = db.prepare<[], ColumnInfo>("PRAGMA table_info(Track)").all();
      const loudnessCol = tableInfo.find((col) => col.name === "loudness");
      if (loudnessCol?.notnull === 0 && loudnessCol?.type === "REAL") return;

      db.exec(`
        BEGIN TRANSACTION;
        CREATE TABLE Track_new (
          int_id       INTEGER PRIMARY KEY AUTOINCREMENT,
          id           TEXT NOT NULL,
          url          TEXT NOT NULL,
          title        TEXT NOT NULL,
          thumbnailUrl TEXT NOT NULL,
          length       INTEGER NOT NULL,
          channelName  TEXT NOT NULL,
          loudness     REAL,
          playlistId   INTEGER REFERENCES Playlist(int_id) ON DELETE CASCADE ON UPDATE CASCADE,
          playlistIdx  INTEGER
        );
        INSERT INTO Track_new SELECT * FROM Track;
        UPDATE Track_new SET loudness = NULL;
        DROP TABLE Track;
        ALTER TABLE Track_new RENAME TO Track;
        COMMIT;
      `);
    },
  },
  {
    name: "002_provider_id",
    up: (db) => {
      const trackHasProviderId = db
        .prepare<[], ColumnInfo>("PRAGMA table_info(Track)")
        .all()
        .some((column) => column.name === "providerId");
      const playlistHasProviderId = db
        .prepare<[], ColumnInfo>("PRAGMA table_info(Playlist)")
        .all()
        .some((column) => column.name === "providerId");

      if (!trackHasProviderId) {
        db.exec("ALTER TABLE Track ADD COLUMN providerId TEXT NOT NULL DEFAULT 'youtube'");
      }
      if (!playlistHasProviderId) {
        db.exec("ALTER TABLE Playlist ADD COLUMN providerId TEXT NOT NULL DEFAULT 'youtube'");
      }
    },
  },
  {
    name: "003_guild_stats_event_counters",
    up: (db) => {
      const existing = new Set(
        db
          .prepare<[], ColumnInfo>("PRAGMA table_info(GuildStats)")
          .all()
          .map((column) => column.name),
      );
      for (const column of ["skips", "stops", "commands_used"]) {
        if (!existing.has(column)) {
          db.exec(`ALTER TABLE GuildStats ADD COLUMN ${column} INTEGER DEFAULT 0`);
        }
      }
    },
  },
  { name: "004_guild_event_names", up: ensureGuildEventColumns },
  {
    name: "005_guild_storage_quota",
    up: (db) => {
      db.exec(`CREATE TABLE IF NOT EXISTS GuildSettings (
        guild_id TEXT PRIMARY KEY,
        max_storage_bytes INTEGER NOT NULL DEFAULT 104857600 CHECK (max_storage_bytes >= 0)
      )`);
    },
  },
  {
    name: "006_sessions_and_user_playlists",
    up: (db) => {
      db.exec(applicationStateSchema);
    },
  },
  {
    name: "007_spotify_user_tokens",
    up: (db) => {
      db.exec(spotifyUserSchema);
    },
  },
  {
    name: "008_guild_player_settings",
    up: (db) => {
      const columns = new Set(
        db
          .prepare<[], ColumnInfo>("PRAGMA table_info(GuildSettings)")
          .all()
          .map((c) => c.name),
      );
      for (const [name, definition] of [
        ["volume", "INTEGER DEFAULT 100"],
        ["autoplay_enabled", "INTEGER DEFAULT 0"],
        ["dj_role_id", "TEXT"],
      ]) {
        if (!columns.has(name))
          db.exec(`ALTER TABLE GuildSettings ADD COLUMN ${name} ${definition}`);
      }
    },
  },
  {
    name: "009_playlist_order",
    up: (db) => {
      const columns = db.prepare<[], ColumnInfo>("PRAGMA table_info(UserPlaylistTrack)").all();
      if (!columns.some((column) => column.name === "position")) {
        db.exec("ALTER TABLE UserPlaylistTrack ADD COLUMN position INTEGER NOT NULL DEFAULT 0");
        db.exec("UPDATE UserPlaylistTrack SET position = id");
      }
    },
  },
  {
    name: "010_guild_onboarding",
    up: (db) => {
      if (
        !db
          .prepare<[], ColumnInfo>("PRAGMA table_info(GuildSettings)")
          .all()
          .some((column) => column.name === "default_text_channel_id")
      )
        db.exec("ALTER TABLE GuildSettings ADD COLUMN default_text_channel_id TEXT");
    },
  },
  {
    name: "011_bot_settings",
    up: (db) => {
      db.exec(
        "CREATE TABLE IF NOT EXISTS BotSettings (id INTEGER PRIMARY KEY CHECK(id = 1), settings_json TEXT NOT NULL)",
      );
    },
  },
];

export function runMigrations(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS Migration (
      id     INTEGER PRIMARY KEY AUTOINCREMENT,
      name   TEXT NOT NULL UNIQUE,
      ran_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  for (const migration of migrations) {
    const already = db
      .prepare<[string], Migration>("SELECT 1 FROM Migration WHERE name = ?")
      .get(migration.name);
    if (already) continue;

    migration.up(db);
    db.prepare<[string], Migration>("INSERT INTO Migration (name) VALUES (?)").run(migration.name);
    log({ message: `Ran migration: ${migration.name}`, component: "CORE", name: "DB" });
  }
}
