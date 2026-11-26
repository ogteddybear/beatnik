import type { Provider, ProviderTrack } from "@/providers";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { test } from "node:test";

test("removal preserves queue cursors and history returns only the guild's last ten real plays", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "sashimi-queue-management-"));
  Object.assign(process.env, {
    TOKEN: "test-token",
    CLIENT_ID: "123456789012345678",
    LIBRARY_PATH: directory,
    DATABASE_URL: path.join(directory, "library.db"),
  });
  const { db, archiveDb } = await import("./db/client");
  try {
    const { CorePlayer } = await import("./player");
    const { Queue } = await import("./queue");
    const { getGuildPlaybackHistory, logEvent } = await import("./db/guild-events");
    const { archiveOldEvents } = await import("./db/event-archive");
    const track = (id: string): ProviderTrack & { addedBy: string } => ({
      id,
      providerId: "test",
      title: id,
      channelName: "Artist",
      thumbnailUrl: "",
      url: `https://example.com/${id}`,
      length: 60,
      loudness: 1,
      playlistIdx: null,
      addedBy: "user",
    });
    const provider: Provider = {
      id: "test",
      resolve: async () => null,
      getTrack: async () => null,
      getPlaylist: async () => null,
      getStream: async () => Readable.from(["audio"]),
    };
    const queue = new Queue();
    queue.tracks = ["past", "current", "next", "last"].map(track);
    queue.currentIndex = 1;
    const player = new CorePlayer("guild", queue, [provider]);
    player.isPlaying = true;
    let handoffs = 0;
    player.onStream = (_track, stream) => {
      handoffs++;
      stream.destroy();
    };
    assert.equal(await player.remove(0, "user"), undefined);
    assert.equal(await player.remove(5, "user"), undefined);
    assert.equal(await player.remove(1.5, "user"), undefined);
    await player.remove(1, "user");
    assert.equal(queue.nowPlaying?.title, "current");
    assert.equal(queue.currentIndex, 0);
    assert.equal(handoffs, 0);
    queue.loopMode = "track";
    await player.remove(1, "user");
    assert.equal(queue.nowPlaying?.title, "next", "Removing current must not skip its successor");
    assert.equal(handoffs, 1);
    await player.remove(2, "user");
    assert.equal(queue.nowPlaying?.title, "next");
    assert.equal(handoffs, 1);
    let ended = false;
    player.onQueueEnd = () => {
      ended = true;
    };
    await player.remove(1, "user");
    assert.equal(player.getState(), null);
    assert.equal(ended, true);
    queue.tracks = ["first", "last"].map(track);
    queue.currentIndex = 1;
    queue.loopMode = "queue";
    player.isPlaying = true;
    await player.remove(2, "user");
    assert.equal(queue.nowPlaying?.title, "first", "Removing final track wraps in queue loop");
    player.isLoading = true;
    await assert.rejects(player.remove(1, "user"), /changing tracks/);
    player.isLoading = false;

    for (let index = 0; index < 12; index++) {
      logEvent({
        guildId: "history",
        eventType: "player",
        action: "play",
        trackName: `Song ${index}`,
        trackId: `song-${index}`,
      });
    }
    logEvent({
      guildId: "history",
      eventType: "player",
      action: "request",
      trackName: "Not played",
    });
    logEvent({
      guildId: "history",
      eventType: "command",
      action: "play",
      trackName: "Not a stream",
    });
    logEvent({ guildId: "other", eventType: "player", action: "play", trackName: "Private" });
    const history = getGuildPlaybackHistory("history");
    assert.equal(history.length, 10);
    assert.equal(history[0].track_name, "Song 11");
    assert.equal(history[9].track_name, "Song 2");
    assert.deepEqual(getGuildPlaybackHistory("empty"), []);
    db.prepare("UPDATE GuildEvents SET created_at = ? WHERE guild_id = ?").run(
      Date.now() - 40 * 86400000,
      "history",
    );
    await archiveOldEvents();
    assert.equal(getGuildPlaybackHistory("history").length, 10);
    assert.equal(getGuildPlaybackHistory("history")[0].track_name, "Song 11");
  } finally {
    db.close();
    archiveDb.close();
    await rm(directory, { recursive: true, force: true });
  }
});
