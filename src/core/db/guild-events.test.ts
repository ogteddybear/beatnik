import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

test("guild events are filtered, ordered, and paginated without crossing guilds", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "sashimi-events-test-"));
  process.env.TOKEN = "test-token";
  process.env.CLIENT_ID = "123456789012345678";
  process.env.LIBRARY_PATH = directory;
  process.env.DATABASE_URL = path.join(directory, "library.db");
  const { db } = await import("./client");
  try {
    const { guildEventCounts, guildEventPage, recentGuildCounts } = await import("./guild-events");
    const insert = db.prepare(
      "INSERT INTO GuildEvents (guild_id, user_id, event_type, action, metadata, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    );
    insert.run("a", "1", "command", "play", null, 1_000);
    insert.run("a", "1", "player", "request", '{"trackId":"abc"}', 2_000);
    insert.run("b", "2", "player_error", "unplayable", null, 3_000);
    insert.run("a", "2", "player", "play", '{"trackId":"abc"}', 4_000);
    insert.run("a", "1", "command_error", "play", null, 5_000);
    insert.run("a", "1", "library", "add", '{"count":2}', 6_000);
    const filters = { from: 0, to: 7_000 };
    const first = guildEventPage("a", filters, { limit: 2 });
    assert.deepEqual(
      first.events.map((event) => event.id),
      [6, 5],
    );
    assert.equal(first.hasMore, true);
    assert.equal(guildEventPage("a", filters, { limit: 500 }).events.length, 5);
    assert.deepEqual(
      guildEventPage("a", filters, { before: 5, limit: 2 }).events.map((event) => event.id),
      [4, 2],
    );
    assert.deepEqual(
      guildEventPage("a", filters, { since: 2, limit: 2 }).events.map((event) => event.id),
      [4, 5],
    );
    assert.deepEqual(
      guildEventPage("a", { ...filters, eventType: "player", userId: "2" }).events.map(
        (event) => event.id,
      ),
      [4],
    );
    assert.deepEqual(
      guildEventPage("a", { ...filters, action: "play", from: 4_000 }).events.map(
        (event) => event.id,
      ),
      [5, 4],
    );
    assert.deepEqual(guildEventCounts("a", 0, 7_000), {
      adds: 1,
      requests: 1,
      plays: 1,
      skips: 0,
      stops: 0,
      commands: 1,
      errors: 1,
    });
    assert.equal(recentGuildCounts(0, 7_000).get("b")?.errors, 1);
    assert.equal(guildEventCounts("a", 0, 4_000).plays, 0);
  } finally {
    db.close();
    await rm(directory, { recursive: true, force: true });
  }
});
