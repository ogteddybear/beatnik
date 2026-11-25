import Database from "better-sqlite3";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

test("event migration and atomic archival preserve names, IDs, counters and chronological cursors", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "sashimi-archive-test-"));
  process.env.TOKEN = "test-token";
  process.env.CLIENT_ID = "123456789012345678";
  process.env.LIBRARY_PATH = directory;
  process.env.DATABASE_URL = path.join(directory, "library.db");
  const now = Date.now();
  const day = 86_400_000;
  const legacy = new Database(process.env.DATABASE_URL);
  legacy.exec(`CREATE TABLE GuildEvents (id INTEGER PRIMARY KEY AUTOINCREMENT,
    guild_id TEXT, user_id TEXT, event_type TEXT, action TEXT, metadata TEXT, created_at INTEGER)`);
  legacy
    .prepare(
      "INSERT INTO GuildEvents (guild_id, user_id, event_type, action, created_at) VALUES (?, ?, ?, ?, ?)",
    )
    .run("a", "1", "player", "play", now - 40 * day);
  legacy.close();
  const { db, archiveDb } = await import("./client");
  try {
    const { archiveOldEvents } = await import("./event-archive");
    const { logEvent, guildEventPage, getArchivedEvents, guildEventCounts } =
      await import("./guild-events");
    const { guildStats } = await import("./guild-stats");
    const insert = (guildId: string, action: string, date: number) => {
      logEvent({
        guildId,
        userId: "1",
        username: "Recorded listener",
        eventType: "player",
        action,
        trackId: "track-id",
        trackName: "Recorded track",
        metadata: { providerId: "test" },
      });
      const id = db.prepare<[], { id: number }>("SELECT max(id) AS id FROM GuildEvents").get()?.id;
      assert(id);
      db.prepare("UPDATE GuildEvents SET created_at = ? WHERE id = ?").run(date, id);
      return id;
    };
    const oldest = insert("a", "request", now - 50 * day);
    const tied = insert("a", "play", now - 40 * day);
    const recent = insert("a", "play", now - day);
    const other = insert("b", "play", now - 45 * day);
    const totals = guildStats.get("a");
    assert.equal(await archiveOldEvents(now), 4);
    assert.equal(await archiveOldEvents(now), 0);
    assert.deepEqual(guildStats.get("a"), totals, "Archival never replays counter increments");
    assert.equal(db.prepare("SELECT id FROM GuildEvents WHERE id = ?").get(tied), undefined);
    const archived = archiveDb
      .prepare<[number], { username: string; track_name: string }>(
        "SELECT username, track_name FROM GuildEvents WHERE id = ?",
      )
      .get(tied);
    assert.deepEqual(archived, { username: "Recorded listener", track_name: "Recorded track" });
    const filters = { from: now - 60 * day, to: now + 1 };
    const first = guildEventPage("a", filters, { limit: 2 });
    assert.deepEqual(
      first.events.map((event) => event.id),
      [recent, tied],
    );
    assert.deepEqual(
      guildEventPage("a", filters, { before: tied }).events.map((event) => event.id),
      [1, oldest],
    );
    assert.deepEqual(
      guildEventPage("a", filters, { since: 1 }).events.map((event) => event.id),
      [tied, recent],
    );
    assert.deepEqual(
      getArchivedEvents({ guildId: "a", from: now - 41 * day, to: now - 39 * day }).events.map(
        (event) => event.id,
      ),
      [tied, 1],
      "Short date ranges in the archive are included",
    );
    assert.equal(
      getArchivedEvents({ guildId: "a", ...filters, userId: "not-this-user" }).events.length,
      0,
    );
    assert.equal(guildEventCounts("a", filters.from, filters.to).plays, 3);
    assert(
      getArchivedEvents({ guildId: "b", ...filters }).events.some((event) => event.id === other),
    );
    const boundary = insert("a", "play", now - 30 * day);
    assert.equal(await archiveOldEvents(now), 0, "Exactly 30 days is not older than retention");
    assert(db.prepare("SELECT id FROM GuildEvents WHERE id = ?").get(boundary));
    const valid = insert("a", "play", now - 35 * day);
    const invalid = insert("a", "rollback", now - 34 * day);
    archiveDb.exec(`CREATE TRIGGER reject_test BEFORE INSERT ON GuildEvents
      WHEN NEW.action = 'rollback' BEGIN SELECT RAISE(ABORT, 'test archive failure'); END`);
    await assert.rejects(archiveOldEvents(now), /test archive failure/);
    assert(db.prepare("SELECT id FROM GuildEvents WHERE id = ?").get(valid));
    assert(db.prepare("SELECT id FROM GuildEvents WHERE id = ?").get(invalid));
    assert.equal(
      archiveDb.prepare("SELECT id FROM GuildEvents WHERE id = ?").get(valid),
      undefined,
      "Copy and delete roll back together",
    );
    archiveDb.exec("DROP TRIGGER reject_test");
    assert.equal(await archiveOldEvents(now), 2);
    const newest = insert("a", "play", now);
    assert(newest > invalid, "Main AUTOINCREMENT sequence survives archival");
  } finally {
    db.close();
    archiveDb.close();
    await rm(directory, { recursive: true, force: true });
  }
});
