import Database from "better-sqlite3";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

test("guild requests, plays, and requested tracks remain isolated", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "sashimi-stats-test-"));
  process.env.TOKEN = "test-token";
  process.env.CLIENT_ID = "123456789012345678";
  process.env.LIBRARY_PATH = directory;
  process.env.DATABASE_URL = path.join(directory, "library.db");

  // Simulate the schema deployed before event counters were added.
  const legacy = new Database(process.env.DATABASE_URL);
  legacy.exec(`
    CREATE TABLE GuildStats (
      guild_id TEXT PRIMARY KEY,
      requests INTEGER DEFAULT 0,
      plays INTEGER DEFAULT 0,
      last_active_at INTEGER
    );
    INSERT INTO GuildStats (guild_id, requests, plays) VALUES ('guild-a', 2, 3);
  `);
  legacy.close();

  const { db, archiveDb } = await import("./client");
  try {
    const { guildStats } = await import("./guild-stats");
    const { logEvent, getLatestEvents } = await import("./guild-events");
    assert.deepEqual(guildStats.get("guild-a"), {
      requests: 2,
      plays: 3,
      skips: 0,
      stops: 0,
      commands_used: 0,
    });
    guildStats.recordRequests(
      "guild-a",
      "user-a",
      ["track-1", "track-1", "track-2"].map((id) => ({ id })),
    );
    guildStats.recordRequests("guild-b", "user-b", [{ id: "track-1" }]);
    logEvent({
      guildId: "guild-a",
      userId: "user-a",
      eventType: "player",
      action: "play",
      trackId: "track-1",
    });
    logEvent({ guildId: "guild-a", userId: "user-a", eventType: "command", action: "skip" });
    logEvent({ guildId: "guild-a", userId: "user-a", eventType: "player", action: "skip" });
    logEvent({ guildId: "guild-a", eventType: "player", action: "stop" });
    logEvent({
      guildId: "guild-a",
      userId: "user-a",
      eventType: "player_error",
      action: "unplayable",
    });

    assert.deepEqual(guildStats.get("guild-a"), {
      requests: 5,
      plays: 4,
      skips: 1,
      stops: 1,
      commands_used: 1,
    });
    assert.deepEqual(guildStats.getTrackIds("guild-a").sort(), ["track-1", "track-2"]);
    assert.deepEqual(guildStats.get("guild-b"), {
      requests: 1,
      plays: 0,
      skips: 0,
      stops: 0,
      commands_used: 0,
    });
    assert.deepEqual(guildStats.getTrackIds("guild-b"), ["track-1"]);
    const events = getLatestEvents();
    assert.equal(events.length, 9);
    assert.equal(events[0].event_type, "player_error");
    assert.equal(events[0].action, "unplayable");
    assert.equal(events[events.length - 1].metadata, '{"trackId":"track-1"}');
    assert.equal(getLatestEvents(2).length, 2);
    const lastActive = db
      .prepare<[string], { last_active_at: number }>(
        "SELECT last_active_at FROM GuildStats WHERE guild_id = ?",
      )
      .get("guild-a");
    assert(lastActive && lastActive.last_active_at > 0);
  } finally {
    db.close();
    archiveDb.close();
    await rm(directory, { recursive: true, force: true });
  }
});
