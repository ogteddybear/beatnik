import assert from "node:assert/strict";
import { test } from "node:test";
import type { Innertube } from "youtubei.js";

import { getPlaylistInfo, getTrackInfo, search } from "./metadata";

test("YouTube empty or missing search results produce a catchable no-results error", async () => {
  for (const videos of [[], undefined]) {
    const client = { search: async () => ({ videos }) } as unknown as Innertube;
    await assert.rejects(search(client, "nothing"), {
      name: "Error",
      message: "No YouTube search results found.",
    });
  }
});

test("YouTube metadata tolerates empty thumbnails and search still resolves a valid result", async () => {
  const client = {
    search: async () => ({ videos: [{ as: () => ({ video_id: "video" }) }] }),
    getBasicInfo: async (id: string) => ({ basic_info: { id, title: "Video", thumbnail: [] } }),
  } as unknown as Innertube;
  assert.equal((await getTrackInfo(client, "video"))?.thumbnailUrl, "Unknown");
  assert.equal((await search(client, "video"))?.id, "video");
});

test("YouTube playlists skip missing items and tolerate empty thumbnails and absent authors", async () => {
  const client = {
    getPlaylist: async () => ({
      items: {
        filterType: () => [
          { type: "LockupView" },
          {
            type: "PlaylistVideo",
            id: "video",
            title: { text: "Video" },
            duration: { seconds: 30 },
            thumbnails: [],
          },
          { type: "PlaylistVideo" },
        ],
      },
      has_continuation: false,
      info: { title: "Playlist" },
    }),
  } as unknown as Innertube;
  const playlist = await getPlaylistInfo(client, "playlist");
  assert(playlist);
  assert.equal(playlist.authorName, "Unknown");
  assert.equal(playlist.tracks.length, 1);
  assert.equal(playlist.tracks[0].id, "video");
  assert.equal(playlist.tracks[0].thumbnailUrl, "Unknown");
  assert.equal(playlist.tracks[0].channelName, "Unknown");
});

test("YouTube empty playlists return no tracks", async () => {
  const client = {
    getPlaylist: async () => ({
      items: { filterType: () => [] },
      has_continuation: false,
      info: { title: "Empty", author: { name: "Owner" } },
    }),
  } as unknown as Innertube;
  assert.deepEqual((await getPlaylistInfo(client, "empty"))?.tracks, []);
});

test("YouTube missing playlist item collections fail gracefully", async (t) => {
  t.mock.method(console, "error", () => {
    // Missing playlist items are expected to be logged and return null.
  });
  const client = { getPlaylist: async () => ({ items: undefined }) } as unknown as Innertube;
  assert.equal(await getPlaylistInfo(client, "missing"), null);
});

test("YouTube search results without a video ID produce a clean error", async () => {
  const client = {
    search: async () => ({ videos: [{ as: () => ({ video_id: undefined }) }] }),
  } as unknown as Innertube;
  await assert.rejects(search(client, "missing"), {
    name: "Error",
    message: "No YouTube search results found.",
  });
});

test("YouTube radio search chooses a fresh result rather than repeating the seed", async () => {
  const client = {
    search: async () => ({
      videos: ["seed", "fresh"].map((id) => ({ as: () => ({ video_id: id }) })),
    }),
    getBasicInfo: async (id: string) => ({ basic_info: { id, thumbnail: [] } }),
  } as unknown as Innertube;
  assert.equal((await search(client, "related", ["seed"]))?.id, "fresh");
  await assert.rejects(search(client, "related", ["seed", "fresh"]), /No YouTube search results/);
});
