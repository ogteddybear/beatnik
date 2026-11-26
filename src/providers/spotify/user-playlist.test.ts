import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import type { YoutubeProvider } from "../youtube";

test("Spotify playlists use per-user authorization, paginate and fall back only for access failures", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "sashimi-spotify-playlist-"));
  Object.assign(process.env, {
    TOKEN: "test",
    CLIENT_ID: "123",
    LIBRARY_PATH: directory,
    DATABASE_URL: path.join(directory, "library.db"),
    SPOTIFY_CLIENT_ID: "client",
    SPOTIFY_CLIENT_SECRET: "secret",
  });
  const { db, archiveDb } = await import("../../core/db/client");
  const original = globalThis.fetch;
  try {
    const { spotifyUsers } = await import("../../core/db/spotify-users");
    const { SpotifyLinkResolver } = await import("../spotify-link-resolver");
    const { SpotDl } = await import("spotdl-api");
    const save = SpotDl.prototype.save;
    let publicRequests = 0;
    SpotDl.prototype.save = async () => {
      publicRequests++;
      return [];
    };
    try {
      const youtube = {
        id: "youtube",
        search: async () => ({
          id: "yt",
          providerId: "youtube",
          title: "Mapped",
          url: "https://youtu.be/yt",
          channelName: "Artist",
          length: 180,
          thumbnailUrl: "",
          playlistIdx: null,
        }),
      } as unknown as YoutubeProvider;
      const resolver = SpotifyLinkResolver.createIfConfigured(youtube);
      assert(resolver);
      spotifyUsers.save({
        discord_user_id: "A",
        access_token: "private-A",
        refresh_token: "refresh-A",
        expires_at: Date.now() + 3600000,
        spotify_user_id: "spotify-A",
        spotify_display_name: "A",
        updated_at: Date.now(),
      });
      const track = {
        id: "one",
        type: "track",
        name: "Song",
        artists: [{ name: "Artist" }],
        duration_ms: 180000,
      };
      const calls: string[] = [];
      globalThis.fetch = async (url, options) => {
        calls.push(String(url));
        assert.equal(new Headers(options?.headers).get("Authorization"), "Bearer private-A");
        if (String(url).includes("offset=1"))
          return Response.json({ items: [{ item: track }], next: null });
        return Response.json({
          name: "Private A",
          owner: { display_name: "A" },
          items: {
            items: [{ item: track }],
            next: "https://api.spotify.com/v1/playlists/Private/items?offset=1",
          },
        });
      };
      const playlist = await resolver.getPlaylist("spotify:playlist:Private", {
        requestingUserId: "A",
      });
      assert.equal(playlist?.title, "Private A");
      assert.equal(playlist?.tracks.length, 2);
      assert.equal(calls.length, 2);
      assert.equal(publicRequests, 0);
      await resolver.getPlaylist("spotify:playlist:Private", { requestingUserId: "B" });
      assert.equal(calls.length, 2, "Unlinked B must never reuse A's authorization");
      assert.equal(publicRequests, 1);
      globalThis.fetch = async () => new Response("", { status: 403 });
      await resolver.getPlaylist("spotify:playlist:Private", { requestingUserId: "A" });
      assert.equal(publicRequests, 2);
      globalThis.fetch = async () => new Response("", { status: 503 });
      assert.equal(
        await resolver.getPlaylist("spotify:playlist:Private", { requestingUserId: "A" }),
        null,
      );
      assert.equal(publicRequests, 2, "Server errors must not silently change authorization paths");
    } finally {
      SpotDl.prototype.save = save;
    }
  } finally {
    globalThis.fetch = original;
    db.close();
    archiveDb.close();
    await rm(directory, { recursive: true, force: true });
  }
});
