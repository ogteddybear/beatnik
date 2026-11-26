import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

test("Spotify user refresh is isolated, coalesced and cannot resurrect unlinked or overwritten accounts", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "sashimi-spotify-tokens-"));
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
    const { getValidSpotifyAccessToken } = await import("./tokens");
    const row = (id: string, expires = 0) => ({
      discord_user_id: id,
      access_token: `access-${id}`,
      refresh_token: `refresh-${id}`,
      expires_at: expires,
      spotify_user_id: id,
      spotify_display_name: id,
      updated_at: Date.now(),
    });
    spotifyUsers.save(row("A"));
    spotifyUsers.save(row("B", Date.now() + 3600000));
    let calls = 0;
    let release!: (response: Response) => void;
    globalThis.fetch = async (_url, options) => {
      calls++;
      assert.equal(
        new Headers(options?.headers).get("Authorization"),
        `Basic ${Buffer.from("client:secret").toString("base64")}`,
      );
      assert.equal(new URLSearchParams(String(options?.body)).get("refresh_token"), "refresh-A");
      return new Promise<Response>((resolve) => {
        release = resolve;
      });
    };
    assert.equal(await getValidSpotifyAccessToken("missing"), null);
    assert.equal(await getValidSpotifyAccessToken("B"), "access-B");
    const first = getValidSpotifyAccessToken("A");
    const second = getValidSpotifyAccessToken("A");
    assert.equal(calls, 1);
    release(
      Response.json({ access_token: "fresh-A", refresh_token: "rotated-A", expires_in: 3600 }),
    );
    assert.deepEqual(await Promise.all([first, second]), ["fresh-A", "fresh-A"]);
    assert.equal(spotifyUsers.get("A")?.refresh_token, "rotated-A");
    assert.equal(spotifyUsers.get("B")?.access_token, "access-B");
    spotifyUsers.save(row("A"));
    const unlinked = getValidSpotifyAccessToken("A");
    spotifyUsers.unlink("A");
    release(Response.json({ access_token: "must-not-return", expires_in: 3600 }));
    assert.equal(await unlinked, null);
    assert.equal(spotifyUsers.get("A"), undefined);
    spotifyUsers.save(row("A"));
    const old = getValidSpotifyAccessToken("A");
    spotifyUsers.save({
      ...row("A", Date.now() + 3600000),
      access_token: "relinked",
      refresh_token: "new-account-refresh",
    });
    release(Response.json({ access_token: "stale-refresh", expires_in: 3600 }));
    assert.equal(await old, null);
    assert.equal(spotifyUsers.get("A")?.access_token, "relinked");
    spotifyUsers.save(row("A"));
    globalThis.fetch = async () => Response.json({ access_token: "renewed", expires_in: 3600 });
    assert.equal(await getValidSpotifyAccessToken("A"), "renewed");
    assert.equal(
      spotifyUsers.get("A")?.refresh_token,
      "refresh-A",
      "Missing rotated refresh token retains the previous one",
    );
    spotifyUsers.save(row("A"));
    globalThis.fetch = async () => new Response("", { status: 503 });
    assert.equal(await getValidSpotifyAccessToken("A"), null);
    assert(spotifyUsers.get("A"), "Outages must not delete credentials");
    globalThis.fetch = async () => Response.json({ error: "invalid_grant" }, { status: 400 });
    assert.equal(await getValidSpotifyAccessToken("A"), null);
    assert.equal(spotifyUsers.get("A"), undefined);
  } finally {
    globalThis.fetch = original;
    db.close();
    archiveDb.close();
    await rm(directory, { recursive: true, force: true });
  }
});
