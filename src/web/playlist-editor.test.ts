import type { Provider, ProviderTrack } from "@/providers";
import express from "express";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

test("playlist editor isolates owners, preserves duplicate entry IDs, validates order and imports using the linked user", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "sashimi-editor-"));
  Object.assign(process.env, {
    TOKEN: "test",
    CLIENT_ID: "123",
    LIBRARY_PATH: directory,
    DATABASE_URL: path.join(directory, "library.db"),
  });
  const { db, archiveDb } = await import("../core/db/client");
  const { userPlaylists } = await import("../core/db/user-playlists");
  const { spotifyUsers } = await import("../core/db/spotify-users");
  const { providers } = await import("../core/manager");
  const { mountPlaylistEditor } = await import("./playlist-editor");
  const track: ProviderTrack = {
    id: "song",
    providerId: "youtube",
    title: "<script>Song</script>",
    url: "https://youtu.be/song",
    length: 60,
    channelName: "Artist",
    thumbnailUrl: "",
    loudness: null,
    playlistIdx: null,
  };
  const id = userPlaylists.create("A", "Original", [track, track]);
  const entries = userPlaylists.get("A", id)?.tracks ?? [];
  assert.equal(entries.length, 2);
  assert.notEqual(entries[0].playlistTrackId, entries[1].playlistTrackId);
  const youtube: Provider = {
    id: "youtube",
    resolve: async () => null,
    getTrack: async () => track,
    getPlaylist: async () => null,
    getStream: async () => {
      throw new Error("not used");
    },
    search: async () => track,
  };
  let importedFor: string | undefined;
  const spotify: Provider = {
    ...youtube,
    id: "spotify-link-resolver",
    getPlaylist: async (_id, context) => {
      importedFor = context?.requestingUserId;
      return {
        id: "sp",
        title: "Spotify",
        providerId: "spotify",
        url: "",
        authorName: "",
        tracks: [track],
      };
    },
  };
  providers.push(youtube, spotify);
  const app = express();
  app.set("view engine", "ejs");
  app.set("views", path.join(process.cwd(), "src/web/views"));
  mountPlaylistEditor(
    app,
    (req, res, next) => {
      if (!req.get("X-User")) return res.sendStatus(401);
      if (req.method !== "GET" && req.get("X-Sashimi-Request") !== "playlists")
        return res.sendStatus(403);
      next();
    },
    (req) => req.get("X-User") ?? null,
  );
  const server = app.listen(0, "127.0.0.1");
  try {
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const address = server.address();
    assert(address && typeof address !== "string");
    const request = (route: string, method = "GET", body?: object, user = "A") =>
      fetch(`http://127.0.0.1:${address.port}${route}`, {
        method,
        headers: {
          "X-User": user,
          "X-Sashimi-Request": "playlists",
          "Content-Type": "application/json",
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
    const base = `/api/playlists/${id}`;
    assert.equal((await request(base, "GET", undefined, "")).status, 401);
    assert.equal((await request(base, "GET", undefined, "B")).status, 404);
    assert.equal((await request(base, "PUT", { name: "Hijack" }, "B")).status, 404);
    assert.equal((await request(base, "PUT", { name: "" })).status, 400);
    assert.equal((await request(base, "PUT", { name: "Renamed" })).status, 200);
    assert.equal(userPlaylists.get("A", id)?.name, "Renamed");
    const ids = entries.map((entry) => entry.playlistTrackId).reverse();
    assert.equal(
      (await request(base + "/reorder", "POST", { trackIds: [ids[0], ids[0]] })).status,
      409,
    );
    assert.equal((await request(base + "/reorder", "POST", { trackIds: ids })).status, 200);
    assert.deepEqual(
      userPlaylists.get("A", id)?.tracks.map((item) => item.playlistTrackId),
      ids,
    );
    assert.equal((await request(base + `/tracks/${ids[0]}`, "DELETE", undefined, "B")).status, 404);
    assert.equal((await request(base + `/tracks/${ids[0]}`, "DELETE")).status, 200);
    assert.equal(userPlaylists.get("A", id)?.tracks.length, 1);
    const search = await (await request("/api/search/youtube?q=music")).json();
    assert.equal(search.tracks[0].title, track.title);
    assert.equal((await request("/api/search/youtube?q=")).status, 400);
    assert.equal(
      (await request(base + "/import/spotify", "POST", { playlist: "abc" })).status,
      409,
    );
    spotifyUsers.save({
      discord_user_id: "A",
      access_token: "token",
      refresh_token: "refresh",
      expires_at: Date.now() + 3600000,
      spotify_user_id: "sp",
      spotify_display_name: "A",
      updated_at: Date.now(),
    });
    assert.equal(
      (await request(base + "/import/spotify", "POST", { playlist: "https://evil.example/abc" }))
        .status,
      400,
    );
    assert.equal(
      (await request(base + "/import/spotify", "POST", { playlist: "abc" })).status,
      200,
    );
    assert.equal(importedFor, "A");
    assert.equal(userPlaylists.get("A", id)?.tracks.length, 2);
    assert.equal((await request(`/playlists/${id}`, "GET", undefined, "B")).status, 404);
    assert.match(await (await request(`/playlists/${id}`)).text(), /Sortable.min.js/);
  } finally {
    providers.splice(providers.indexOf(youtube), 1);
    providers.splice(providers.indexOf(spotify), 1);
    server.close();
    db.close();
    archiveDb.close();
    await rm(directory, { recursive: true, force: true });
  }
});
