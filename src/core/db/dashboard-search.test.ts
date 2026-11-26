import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

test("admin search is literal and paginated across archives; server totals and top tracks are scope-bound", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "sashimi-search-"));
  Object.assign(process.env, {
    TOKEN: "test",
    CLIENT_ID: "123",
    LIBRARY_PATH: directory,
    DATABASE_URL: path.join(directory, "library.db"),
  });
  const { db, archiveDb } = await import("./client");
  try {
    const { searchEvents, serverOverview } = await import("./dashboard-search");
    const insert = db.prepare(
      "INSERT INTO GuildEvents (id,guild_id,username,track_name,event_type,action,created_at) VALUES (?,?,?,?,?,?,?)",
    );
    for (let id = 1; id <= 55; id++)
      insert.run(id, "A", "Listener", "Song", "player", "request", 1000 + id);
    archiveDb
      .prepare(
        "INSERT INTO GuildEvents (id,guild_id,username,track_name,event_type,action,created_at) VALUES (100,'A','Archived','Song','player','request',1)",
      )
      .run();
    insert.run(101, "private", "Secret", "Secret", "player", "request", 1);
    insert.run(102, "B", "Other", "Other Song", "player", "request", 1);
    insert.run(103, "B", "100%_\\", null, "command", "play", 1);
    db.prepare(
      "INSERT INTO GuildStats (guild_id,plays) VALUES ('A',10),('B',20),('private',999)",
    ).run();
    const first = searchEvents("Song");
    assert.equal(first.events.length, 50);
    assert(first.nextBefore);
    const second = searchEvents("Song", first.nextBefore);
    assert.equal(second.events.length, 7);
    assert.equal(second.nextBefore, null);
    assert.equal(new Set([...first.events, ...second.events].map((event) => event.id)).size, 57);
    assert.equal(searchEvents("Archived").events[0].id, 100);
    assert.equal(searchEvents("%_\\").events.length, 1);
    assert.equal(searchEvents("' OR 1=1 --").events.length, 0);
    assert.equal(searchEvents("play").events.length, 1);
    const overview = serverOverview(["A", "B", "A"]);
    assert.equal(overview.totalPlays, 30);
    assert.equal(overview.topTrack?.title, "Song");
    assert.equal(overview.guilds.length, 2);
    assert.equal(overview.guilds[0].topTrack?.requests, 56);
    assert(!JSON.stringify(overview).includes("Secret"));
    assert.deepEqual(serverOverview([]), { totalPlays: 0, topTrack: null, guilds: [] });
  } finally {
    db.close();
    archiveDb.close();
    await rm(directory, { recursive: true, force: true });
  }
});
