import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

test("charts aggregate live/archive events by UTC day, fill gaps and isolate authorized guilds", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "sashimi-charts-"));
  Object.assign(process.env, {
    TOKEN: "test",
    CLIENT_ID: "123",
    LIBRARY_PATH: directory,
    DATABASE_URL: path.join(directory, "library.db"),
  });
  const { db, archiveDb } = await import("./client");
  try {
    const { eventCharts } = await import("./event-charts");
    const now = Date.parse("2026-11-27T12:00:00Z");
    const first = Date.parse("2026-10-29T00:00:00Z");
    const insert = db.prepare(
      "INSERT INTO GuildEvents (guild_id,event_type,action,track_name,created_at) VALUES (?,?,?,?,?)",
    );
    insert.run("allowed", "player", "play", "Song", now);
    insert.run("allowed", "player", "skip", "Song", now);
    insert.run("allowed", "player_error", "play", "Song", now);
    insert.run("allowed", "command_error", "play", "Song", now);
    insert.run("allowed", "command", "play", null, first);
    insert.run("allowed", "player", "play", "Too old", first - 1);
    insert.run("allowed", "player", "play", "Future", now + 1000);
    insert.run("private", "player", "request", "Secret", now);
    insert.run("allowed", "player", "request", "Song", now);
    insert.run("allowed", "player", "request", null, now);
    archiveDb
      .prepare(
        "INSERT INTO GuildEvents (id,guild_id,event_type,action,track_name,created_at) VALUES (100,'allowed','player','request','Song',?)",
      )
      .run(first);
    archiveDb
      .prepare(
        "INSERT INTO GuildEvents (id,guild_id,event_type,action,created_at) VALUES (101,'allowed','player','play',?)",
      )
      .run(first);
    const result = eventCharts(["allowed", "allowed"], now);
    assert.equal(result.days.length, 30);
    assert.equal(result.days[0].day, "2026-10-29");
    assert.equal(result.days[0].plays, 1);
    assert.equal(result.days[1].plays, 0);
    assert.equal(result.days[29].errors, 2);
    assert.deepEqual(result.distribution, { plays: 2, skips: 1, commands: 1 });
    assert.deepEqual(result.topTracks, [{ title: "Song", requests: 2 }]);
    assert.deepEqual(eventCharts([], now).distribution, { plays: 0, skips: 0, commands: 0 });
    for (let index = 0; index < 12; index++)
      insert.run("allowed", "player", "request", `Track ${index}`, now);
    assert.equal(eventCharts(["allowed"], now).topTracks.length, 10);
    assert(!JSON.stringify(result).includes("Secret"));
  } finally {
    db.close();
    archiveDb.close();
    await rm(directory, { recursive: true, force: true });
  }
});
