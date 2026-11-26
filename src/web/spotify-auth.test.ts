import express from "express";
import session from "express-session";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

test("Spotify OAuth binds user, session and one-time state; unlink cancels in-flight callbacks", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "sashimi-spotify-oauth-"));
  Object.assign(process.env, {
    TOKEN: "test",
    CLIENT_ID: "123",
    LIBRARY_PATH: directory,
    DATABASE_URL: path.join(directory, "library.db"),
    SPOTIFY_CLIENT_ID: "spotify-client",
    SPOTIFY_CLIENT_SECRET: "spotify-secret",
    DISCORD_REDIRECT_URI: "https://dis.sashimi.zip/auth/callback",
  });
  delete process.env.SPOTIFY_REDIRECT_URI;
  const { db, archiveDb } = await import("../core/db/client");
  const { spotifyUsers } = await import("../core/db/spotify-users");
  const { mountSpotifyAuth } = await import("./spotify-auth");
  const app = express();
  app.set("view engine", "ejs");
  app.set("views", path.join(process.cwd(), "src/web/views"));
  app.use(session({ secret: "test-session-secret", resave: false, saveUninitialized: false }));
  mountSpotifyAuth(app, (req) => req.get("X-Test-User") ?? null);
  const server = app.listen(0, "127.0.0.1");
  const original = globalThis.fetch;
  try {
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const address = server.address();
    assert(address && typeof address !== "string");
    const base = `http://127.0.0.1:${address.port}`;
    let exchanges = 0;
    let delaying = false;
    let release!: (response: Response) => void;
    let started!: () => void;
    globalThis.fetch = async (url, options) => {
      if (String(url) === "https://accounts.spotify.com/api/token") {
        exchanges++;
        assert.equal(
          new Headers(options?.headers).get("Authorization"),
          `Basic ${Buffer.from("spotify-client:spotify-secret").toString("base64")}`,
        );
        assert.equal(
          new URLSearchParams(String(options?.body)).get("redirect_uri"),
          "https://dis.sashimi.zip/auth/spotify/callback",
        );
        if (delaying) {
          started();
          return new Promise<Response>((resolve) => {
            release = resolve;
          });
        }
        return Response.json({
          access_token: "private-access",
          refresh_token: "private-refresh",
          expires_in: 3600,
        });
      }
      if (String(url) === "https://api.spotify.com/v1/me") {
        assert.equal(new Headers(options?.headers).get("Authorization"), "Bearer private-access");
        return Response.json({ id: "spotify-A", display_name: "<script>Private account</script>" });
      }
      throw new Error("Unexpected test request");
    };
    const request = (url: string, user = "A", cookie = "", options: RequestInit = {}) =>
      original(base + url, {
        redirect: "manual",
        ...options,
        headers: { "X-Test-User": user, Cookie: cookie, ...options.headers },
      });
    const start = async () => {
      const response = await request("/auth/spotify");
      const location = new URL(response.headers.get("location") ?? "");
      assert.equal(location.origin, "https://accounts.spotify.com");
      assert.equal(
        location.searchParams.get("scope"),
        "playlist-read-private playlist-read-collaborative user-read-private",
      );
      assert.equal(location.searchParams.get("client_id"), "spotify-client");
      assert(!location.toString().includes("spotify-secret"));
      return {
        state: location.searchParams.get("state") ?? "",
        cookie: response.headers.get("set-cookie")?.split(";")[0] ?? "",
      };
    };
    assert.equal((await request("/auth/spotify", "")).headers.get("location"), "/auth/discord");
    const flow = await start();
    await request("/auth/spotify/callback?state=wrong&code=code", "A", flow.cookie);
    await request(`/auth/spotify/callback?state=${flow.state}&code=code`, "B", flow.cookie);
    await request(`/auth/spotify/callback?state=${flow.state}&code=code`, "A");
    assert.equal(exchanges, 0);
    const callback = `/auth/spotify/callback?state=${flow.state}&code=code`;
    assert.equal(
      (await request(callback, "A", flow.cookie)).headers.get("location"),
      "/auth/spotify/result",
    );
    assert.equal(spotifyUsers.get("A")?.spotify_user_id, "spotify-A");
    assert.equal(spotifyUsers.get("B"), undefined);
    const success = await (await request("/auth/spotify/result", "A", flow.cookie)).text();
    assert.match(success, /Spotify Linked Successfully/);
    assert.doesNotMatch(success, /private-access|private-refresh|spotify-secret/);
    await request(callback, "A", flow.cookie);
    assert.equal(exchanges, 1, "Replaying a consumed callback never exchanges again");
    const denied = await start();
    await request(
      `/auth/spotify/callback?state=${denied.state}&error=access_denied`,
      "A",
      denied.cookie,
    );
    assert(spotifyUsers.get("A"), "Cancelled relinking does not discard an existing account");
    const expired = await start();
    db.prepare("UPDATE SpotifyOAuthState SET expires_at = 0").run();
    await request(`/auth/spotify/callback?state=${expired.state}&code=code`, "A", expired.cookie);
    assert.equal(exchanges, 1);
    const unlink = (cookie: string, header = true) =>
      request("/auth/spotify/unlink", "A", cookie, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(header ? { "X-Sashimi-Request": "spotify" } : {}),
        },
        body: "{}",
      });
    assert.equal((await unlink(flow.cookie, false)).status, 403);
    const racing = await start();
    delaying = true;
    const exchangeStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    const pending = request(
      `/auth/spotify/callback?state=${racing.state}&code=code`,
      "A",
      racing.cookie,
    );
    await exchangeStarted;
    assert.equal((await unlink(racing.cookie)).status, 200);
    release(
      Response.json({
        access_token: "private-access",
        refresh_token: "private-refresh",
        expires_in: 3600,
      }),
    );
    await pending;
    assert.equal(spotifyUsers.get("A"), undefined, "In-flight OAuth cannot undo unlink");
  } finally {
    globalThis.fetch = original;
    server.close();
    db.close();
    archiveDb.close();
    await rm(directory, { recursive: true, force: true });
  }
});
