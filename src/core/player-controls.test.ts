import type { Provider, ProviderTrack } from "@/providers";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { test } from "node:test";

test("player pause, loop, skip, error recovery and cancellation preserve state", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "sashimi-controls-"));
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
    const { getLatestEvents } = await import("./db/guild-events");
    const track = (id: string): ProviderTrack & { addedBy: string } => ({
      id,
      providerId: "test",
      title: id,
      channelName: "Artist",
      thumbnailUrl: "",
      url: `https://example.com/${id}`,
      length: 60,
      loudness: 0,
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
    queue.tracks = ["one", "two"].map(track);
    const player = new CorePlayer("guild", queue, [provider]);
    let position = 0;
    player.onPosition = () => position;
    let paused = false;
    player.onPause = (value) => {
      paused = value;
      return true;
    };
    player.onStream = (_track, stream) => {
      position = 0;
      stream.destroy();
    };
    await player.play();
    position = 12;
    assert.equal(player.getState()?.progressPercent, 20);
    assert.equal(player.pause("user"), true);
    assert.equal(paused, true);
    assert.equal(player.getState()?.status, "paused");
    assert.equal(player.getState()?.progressSeconds, 12);
    assert.equal(player.resume("user"), true);
    assert.equal(paused, false);
    assert.equal(player.toggleLoop("user"), "track");
    await player.finish();
    assert.equal(queue.nowPlaying?.id, "one");
    await player.skip("user");
    assert.equal(queue.nowPlaying?.id, "two", "Explicit skip bypasses track repeat");
    assert.equal(player.toggleLoop("user"), "queue");
    await player.finish();
    assert.equal(queue.nowPlaying?.id, "one");
    assert.deepEqual(
      player.getState()?.nextTracks.map((item) => item.title),
      ["two", "one"],
    );
    let ended = 0;
    player.onQueueEnd = () => {
      ended++;
    };
    await player.finish(true);
    assert.equal(queue.nowPlaying?.id, "two");
    await player.finish(true);
    assert.equal(ended, 1, "A queue of failed streams does not loop forever");
    assert.equal(player.getState(), null);
    assert.equal(getLatestEvents().filter((event) => event.action === "skip").length, 1);

    let resolveStream!: (stream: Readable) => void;
    let reachedProvider!: () => void;
    const reached = new Promise<void>((resolve) => {
      reachedProvider = resolve;
    });
    const delayed: Provider = {
      ...provider,
      getStream: async () => {
        reachedProvider();
        return new Promise<Readable>((resolve) => {
          resolveStream = resolve;
        });
      },
    };
    const queue2 = new Queue();
    queue2.tracks = [track("delayed")];
    const canceled = new CorePlayer("cancel", queue2, [delayed]);
    let handoffs = 0;
    canceled.onStream = () => {
      handoffs++;
    };
    const loading = canceled.play();
    await reached;
    await canceled.stop();
    const abandoned = Readable.from(["old"]);
    resolveStream(abandoned);
    await loading;
    assert.equal(abandoned.destroyed, true);
    assert.equal(handoffs, 0);
    assert.equal(canceled.getState(), null);

    const badQueue = new Queue();
    badQueue.tracks = ["bad-one", "bad-two"].map(track);
    badQueue.loopMode = "queue";
    let attempts = 0;
    const broken = new CorePlayer("broken", badQueue, [
      {
        ...provider,
        getStream: async () => {
          attempts++;
          throw new Error("broken stream");
        },
      },
    ]);
    await broken.play();
    assert.equal(attempts, 2, "Failed stream setup traverses a looping queue only once");
    assert.equal(broken.isPlaying, false);
    const explicitQueue = new Queue();
    explicitQueue.tracks = ["one", "two"].map(track);
    explicitQueue.loopMode = "track";
    const explicit = new CorePlayer("explicit", explicitQueue, [provider]);
    explicit.onStream = (_track, stream) => {
      stream.destroy();
    };
    await explicit.next();
    assert.equal(
      explicitQueue.nowPlaying?.id,
      "two",
      "Explicit next does not invoke natural track repeat",
    );
  } finally {
    db.close();
    archiveDb.close();
    await rm(directory, { recursive: true, force: true });
  }
});
