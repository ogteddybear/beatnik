import type { Provider, ProviderTrack } from "@/providers";
import SoundCloud from "@zibot/scdl";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { test } from "node:test";

test("SoundCloud download failures warn, record unplayable and advance to the next track", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "sashimi-sc-playback-"));
  Object.assign(process.env, {
    TOKEN: "test",
    CLIENT_ID: "123",
    LIBRARY_PATH: directory,
    DATABASE_URL: path.join(directory, "library.db"),
  });
  const { db, archiveDb } = await import("./db/client");
  try {
    t.mock.method(SoundCloud.prototype, "init", async () => "test-client");
    t.mock.method(SoundCloud.prototype, "downloadTrack", async () => undefined);
    const { SoundCloudProvider } = await import("../providers/soundcloud");
    const soundcloud = new SoundCloudProvider();
    const track = (id: string, providerId: string): ProviderTrack => ({
      id,
      providerId,
      title: id,
      url: "https://soundcloud.com/artist/track",
      thumbnailUrl: "",
      channelName: "Artist",
      length: 60,
      loudness: 0,
      playlistIdx: null,
    });
    t.mock.method(soundcloud, "getTrack", async (id: string) => track(id, "soundcloud"));
    const good: Provider = {
      id: "good",
      resolve: async () => null,
      getPlaylist: async () => null,
      getTrack: async (id) => track(id, "good"),
      getStream: async () => Readable.from(["audio"]),
    };
    const { Queue } = await import("./queue");
    const { CorePlayer } = await import("./player");
    const { getLatestEvents } = await import("./db/guild-events");
    const queue = new Queue();
    const player = new CorePlayer("sc-guild", queue, [soundcloud, good]);
    const warnings: string[] = [];
    t.mock.method(console, "info", (...args: unknown[]) => {
      warnings.push(args.join(" "));
    });
    let generalErrors = 0;
    const played: string[] = [];
    player.onError = () => {
      generalErrors++;
    };
    player.onStream = (item, stream) => {
      played.push(item.id);
      stream.destroy();
    };
    player.enqueueTracks([track("missing", "soundcloud"), track("next", "good")], "listener");
    await player.play();
    assert.deepEqual(played, ["next"]);
    assert.equal(generalErrors, 0, "Expected unavailable streams use the warning/skip path");
    assert(warnings.some((line) => line.includes("Skipping unplayable track soundcloud:missing")));
    assert(
      getLatestEvents().some(
        (event) => event.action === "unplayable" && event.track_name === "missing",
      ),
    );
    await player.stop();
    player.enqueueTracks([track("last", "soundcloud")], "listener");
    await player.play();
    assert.equal(player.isPlaying, false, "An entirely unplayable queue finishes without throwing");
  } finally {
    db.close();
    archiveDb.close();
    await rm(directory, { recursive: true, force: true });
  }
});
