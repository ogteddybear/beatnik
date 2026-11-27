import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

test("radio analytics isolate stations, deduplicate reconnects, clip connection time and preserve queue counts", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "sashimi-radio-charts-"));
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
    const from = Date.parse("2026-10-29T00:00:00Z");
    const insert = db.prepare(
      "INSERT INTO GuildEvents (guild_id,event_type,action,track_name,metadata,created_at) VALUES (?,'live',?,?,?,?)",
    );
    const event = (
      time: number,
      action: string,
      sessionId = "s1",
      station = "TechnoBase.FM",
      title = "",
      guild = "allowed",
    ) => {
      insert.run(
        guild,
        action,
        title || station,
        JSON.stringify({
          sessionId,
          station,
          service: "We aRe oNe",
          streamTitle: title,
          artist: title ? "Cascada" : "",
        }),
        time,
      );
    };
    event(from - 2000, "start");
    event(from - 1000, "connected");
    event(from - 500, "track_change", "s1", "TechnoBase.FM", "Song A");
    event(from + 1000, "track_change", "s1", "TechnoBase.FM", "Song A");
    event(from + 2000, "track_change", "s1", "TechnoBase.FM", "Song B");
    event(from + 3000, "reconnect");
    event(from + 5000, "connected");
    event(from + 6000, "track_change", "s1", "TechnoBase.FM", "Song B");
    event(from + 7000, "track_change", "s1", "TechnoBase.FM", "Song A");
    event(from + 10000, "stop");
    archiveDb
      .prepare(
        "INSERT INTO GuildEvents (id,guild_id,event_type,action,track_name,metadata,created_at) VALUES (10000,'allowed','live','track_change','Archived song',?,?)",
      )
      .run(
        JSON.stringify({
          sessionId: "s1",
          station: "TechnoBase.FM",
          service: "We aRe oNe",
          streamTitle: "Archived song",
        }),
        from + 8000,
      );
    event(now - 5000, "start", "s2", "HouseTime.FM");
    event(now - 5000, "connected", "s2", "HouseTime.FM");
    event(now - 4500, "connected", "s2", "HouseTime.FM");
    event(now - 4000, "track_change", "s2", "HouseTime.FM", "Song A");
    event(now - 3000, "connected", "orphan", "TranceBase.FM");
    event(from + 86_400_000 - 1000, "start", "midnight", "TranceBase.FM");
    event(from + 86_400_000 - 1000, "connected", "midnight", "TranceBase.FM");
    event(from + 86_400_000 + 2000, "stop", "midnight", "TranceBase.FM");
    event(now - 1000, "track_change", "secret", "Private station", "Secret song", "private");
    db.prepare(
      "INSERT INTO GuildEvents (guild_id,event_type,action,track_name,created_at) VALUES ('allowed','player','play','Queue song',?)",
    ).run(now);
    const result = eventCharts(["allowed"], now, ["s2"]);
    assert.equal(result.distribution.plays, 1);
    assert.equal(result.radio.totals.songsObserved, 4);
    assert.equal(result.radio.totals.connectedSeconds, 16);
    assert.equal(result.radio.days[0].songsObserved, 3);
    assert.equal(result.radio.days[0].connectedSeconds, 9);
    assert.equal(result.radio.days[1].connectedSeconds, 2);
    assert.equal(result.radio.days[29].connectedSeconds, 5);
    assert.equal(result.radio.totals.reconnects, 1);
    const sameTitle = result.radio.topTracks.filter((track) => track.title === "Song A");
    assert.deepEqual(
      new Set(sameTitle.map((track) => track.station)),
      new Set(["TechnoBase.FM", "HouseTime.FM"]),
    );
    assert.equal(result.radio.topArtists[0].station, "TechnoBase.FM");
    assert.equal(
      eventCharts(["allowed"], now).radio.totals.connectedSeconds,
      11,
      "an unconfirmed historical connection must not be extended to now",
    );
    assert.equal(eventCharts([], now, ["s2"]).radio.totals.songsObserved, 0);
    assert.doesNotMatch(JSON.stringify(result), /Secret|Private station/);
  } finally {
    db.close();
    archiveDb.close();
    await rm(directory, { recursive: true, force: true });
  }
});
