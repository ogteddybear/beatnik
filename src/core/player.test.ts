import type { Provider, ProviderTrack } from "@/providers";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { test } from "node:test";

test("enqueue records per-track requests and successful stream handoffs record plays", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "sashimi-player-test-"));
  process.env.TOKEN = "test-token";
  process.env.CLIENT_ID = "123456789012345678";
  process.env.LIBRARY_PATH = directory;
  process.env.DATABASE_URL = path.join(directory, "library.db");

  const { db, archiveDb } = await import("./db/client");
  try {
    const { guildStats } = await import("./db/guild-stats");
    const { getOrCreateSession, providers } = await import("./manager");
    const track = (id: string): ProviderTrack => ({
      id,
      providerId: "test",
      title: id,
      url: `https://example.com/${id}`,
      thumbnailUrl: "",
      channelName: "Test",
      length: 10,
      loudness: 0,
      playlistIdx: null,
    });
    const provider: Provider = {
      id: "test",
      async resolve(query) {
        if (query === "unplayable") return null;
        return query === "playlist"
          ? { type: "playlist", resolvedQuery: query }
          : { type: "track", resolvedQuery: query };
      },
      async getTrack(id) {
        return track(id);
      },
      async getPlaylist(id) {
        return {
          id,
          providerId: "test",
          title: "Test playlist",
          authorName: "Test",
          url: "https://example.com/playlist",
          tracks: [track("one"), track("two")],
        };
      },
      async getStream() {
        return Readable.from([Buffer.from("audio")]);
      },
    };
    const unplayableProvider: Provider = {
      ...provider,
      id: "youtube",
      async resolve(query) {
        return query === "unplayable" ? { type: "track", resolvedQuery: query } : null;
      },
      async getTrack(id) {
        return { ...track(id), providerId: "youtube" };
      },
      async getStream() {
        throw new Error("No compatible streams found: UNPLAYABLE");
      },
    };
    providers.push(provider, unplayableProvider);

    const { player } = getOrCreateSession("guild-a");
    assert.equal(player.guildId, "guild-a");
    assert.equal((await player.enqueue("playlist", "user", false, false, "Listener")).length, 2);
    assert.deepEqual(guildStats.get("guild-a"), {
      requests: 2,
      plays: 0,
      skips: 0,
      stops: 0,
      commands_used: 0,
    });
    assert.deepEqual(guildStats.getTrackIds("guild-a").sort(), ["one", "two"]);

    player.onStream = async () => {
      throw new Error("Audio handoff failed");
    };
    await player.play();
    assert.equal(guildStats.get("guild-a").plays, 0);
    assert.equal(guildStats.get("guild-a").skips, 0);

    await player.enqueue("one", "user");
    player.onStream = async (playingTrack) => {
      assert.equal(playingTrack.id, "one");
    };
    await player.play();
    assert.equal(guildStats.get("guild-a").requests, 3);
    assert.equal(guildStats.get("guild-a").plays, 1);
    assert.deepEqual(guildStats.getTrackIds("guild-a").sort(), ["one", "two"]);
    const { getLatestEvents } = await import("./db/guild-events");
    const requestEvent = getLatestEvents().find(
      (event) => event.action === "request" && event.username === "Listener",
    );
    assert.equal(requestEvent?.track_name, "two");
    assert.equal(
      getLatestEvents().filter((event) => event.event_type === "player_error").length,
      2,
    );
    assert.equal(
      getLatestEvents().filter((event) => event.event_type === "player" && event.action === "play")
        .length,
      1,
    );
    await player.skip("user");
    assert.equal(guildStats.get("guild-a").skips, 1);
    await player.enqueue("unplayable", "user");
    await player.play();
    assert.equal(
      getLatestEvents().filter(
        (event) => event.event_type === "player_error" && event.action === "unplayable",
      ).length,
      1,
    );
    assert.equal(guildStats.get("guild-a").skips, 1);
    await player.stop("user");
    assert.equal(guildStats.get("guild-a").stops, 1);
    player.queue.tracks = [
      { ...track("current"), addedBy: "user" },
      { ...track("upcoming"), addedBy: "user" },
    ];
    player.queue.currentIndex = 0;
    assert.equal(player.clear("user", "Listener"), 1);
    assert.equal(player.queue.nowPlaying?.id, "current");
    let volume = 100;
    player.onVolume = (value) => {
      volume = value;
    };
    player.setVolume(50, "user", "Listener");
    assert.equal(volume, 50);
    assert(
      getLatestEvents().some(
        (event) => event.event_type === "volume" && event.username === "Listener",
      ),
    );
    assert.throws(() => player.setVolume(201, "user"), /Volume must/);
  } finally {
    db.close();
    archiveDb.close();
    await rm(directory, { recursive: true, force: true });
  }
});
