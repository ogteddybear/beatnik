import type { Provider, ProviderTrack } from "@/providers";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { test } from "node:test";

test("downloads log names and actors only for successful new cache writes", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "sashimi-download-test-"));
  process.env.TOKEN = "test-token";
  process.env.CLIENT_ID = "123456789012345678";
  process.env.LIBRARY_PATH = directory;
  process.env.DATABASE_URL = path.join(directory, "library.db");
  const { db, archiveDb } = await import("../db/client");
  try {
    const { addTrackToLibrary, addPlaylistToLibrary } = await import("./operations");
    const { getLatestEvents } = await import("../db/guild-events");
    const track = (id: string): ProviderTrack => ({
      id,
      title: `Track ${id}`,
      url: `https://example.com/${id}`,
      providerId: "test",
      thumbnailUrl: "",
      channelName: "Test",
      length: 10,
      loudness: 0,
      playlistIdx: null,
    });
    const provider: Provider = {
      id: "test",
      resolve: async () => null,
      getTrack: async () => null,
      getPlaylist: async () => null,
      getStream: async (id) => {
        if (id === "failed") throw new Error("test stream failure");
        return Readable.from(["audio"]);
      },
    };
    const actor = { userId: "1", username: "Downloader" };
    assert.equal((await addTrackToLibrary("a", track("one"), provider, actor)).completed, 1);
    assert.equal((await addTrackToLibrary("a", track("one"), provider, actor)).error, "EXISTS");
    assert.equal((await addTrackToLibrary("a", track("failed"), provider, actor)).errors, 1);
    const playlist = {
      id: "list",
      providerId: "test",
      url: "https://example.com/list",
      title: "List",
      authorName: "Test",
      tracks: [track("two"), track("three")],
    };
    assert.equal(
      (await addPlaylistToLibrary("a", playlist, provider, undefined, actor)).completed,
      2,
    );
    const events = getLatestEvents().filter((event) => event.action === "download");
    assert.equal(events.length, 3);
    assert(
      events.every(
        (event) =>
          event.event_type === "library" &&
          event.username === "Downloader" &&
          event.user_id === "1",
      ),
    );
    assert.deepEqual(events.map((event) => event.track_name).sort(), [
      "Track one",
      "Track three",
      "Track two",
    ]);
  } finally {
    db.close();
    archiveDb.close();
    await rm(directory, { recursive: true, force: true });
  }
});
