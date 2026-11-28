import express from "express";
import session from "express-session";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

test("Tidal OAuth enforces PKCE, session/user binding, expiry, replay and unlink race protection", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "sashimi-tidal-oauth-"));
  Object.assign(process.env, {
    TOKEN: "test",
    CLIENT_ID: "123",
    LIBRARY_PATH: directory,
    DATABASE_URL: path.join(directory, "library.db"),
    TIDAL_CLIENT_ID: "client",
    TIDAL_CLIENT_SECRET: "secret",
    DISCORD_REDIRECT_URI: "https://dis.sashimi.zip/auth/callback",
  });
  delete process.env.TIDAL_REDIRECT_URI;
  const { db, archiveDb } = await import("../core/db/client");
  const { tidalUsers } = await import("../core/db/tidal-users");
  const { mountTidalAuth } = await import("./tidal-auth");
  const app = express();
  app.set("view engine", "ejs");
  app.set("views", path.join(process.cwd(), "src/web/views"));
  app.use(session({ secret: "test-session-secret", resave: false, saveUninitialized: false }));
  mountTidalAuth(app, (req) => req.get("X-Test-User") || null);
  const server = app.listen(0, "127.0.0.1");
  const original = globalThis.fetch;
  try {
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const address = server.address();
    assert(address && typeof address !== "string");
    const base = `http://127.0.0.1:${address.port}`;
    const request = (url: string, user = "A", cookie = "", options: RequestInit = {}) =>
      original(base + url, {
        redirect: "manual",
        ...options,
        headers: { "X-Test-User": user, Cookie: cookie, ...options.headers },
      });
    let challenge = "";
    let exchanges = 0;
    let delaying = false;
    let release!: (response: Response) => void;
    let started!: () => void;
    globalThis.fetch = async (url, options) => {
      if (String(url).includes("/oauth2/token")) {
        exchanges++;
        const params = new URLSearchParams(String(options?.body));
        assert.equal(params.get("grant_type"), "authorization_code");
        assert.equal(params.get("redirect_uri"), "https://dis.sashimi.zip/auth/tidal/callback");
        const verifier = params.get("code_verifier") || "";
        assert.match(verifier, /^[A-Za-z0-9_-]{43,128}$/);
        assert.equal(createHash("sha256").update(verifier).digest("base64url"), challenge);
        assert.equal(
          new Headers(options?.headers).get("Authorization"),
          `Basic ${Buffer.from("client:secret").toString("base64")}`,
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
          scope: "user.read playlists.read",
        });
      }
      assert.equal(String(url), "https://openapi.tidal.com/v2/users/me");
      assert.equal(new Headers(options?.headers).get("Authorization"), "Bearer private-access");
      return Response.json({
        data: {
          type: "users",
          id: "tidal-A",
          attributes: { username: "<script>Private</script>" },
        },
      });
    };
    const start = async () => {
      const response = await request("/auth/tidal");
      const location = new URL(response.headers.get("location") || "");
      assert.equal(location.origin, "https://login.tidal.com");
      assert.equal(location.searchParams.get("scope"), "user.read playlists.read");
      assert.equal(location.searchParams.get("code_challenge_method"), "S256");
      assert.equal(location.searchParams.get("client_id"), "client");
      assert(!location.href.includes("secret"));
      challenge = location.searchParams.get("code_challenge") || "";
      return {
        state: location.searchParams.get("state") || "",
        cookie: response.headers.get("set-cookie")?.split(";")[0] || "",
      };
    };
    assert.equal((await request("/auth/tidal", "")).headers.get("location"), "/auth/discord");
    const flow = await start();
    await request("/auth/tidal/callback?state=wrong&code=code", "A", flow.cookie);
    await request(`/auth/tidal/callback?state=${flow.state}&code=code`, "B", flow.cookie);
    await request(`/auth/tidal/callback?state=${flow.state}&code=code`, "A");
    assert.equal(exchanges, 0);
    const callback = `/auth/tidal/callback?state=${flow.state}&code=code`;
    const response = await request(callback, "A", flow.cookie);
    assert.equal(response.headers.get("location"), "/auth/tidal/result");
    assert.equal(response.headers.get("cache-control"), "private, no-store");
    assert.equal(tidalUsers.get("A")?.tidal_user_id, "tidal-A");
    assert.equal(tidalUsers.get("B"), undefined);
    const result = await (await request("/auth/tidal/result", "A", flow.cookie)).text();
    assert.match(
      result,
      /✅ Tidal Linked Successfully. Return to Discord and run \/tidal playlists./,
    );
    assert.doesNotMatch(result, /private-access|private-refresh|<script>Private/);
    await request(callback, "A", flow.cookie);
    assert.equal(exchanges, 1);
    const denied = await start();
    await request(
      `/auth/tidal/callback?state=${denied.state}&error=access_denied`,
      "A",
      denied.cookie,
    );
    assert(tidalUsers.get("A"), "Cancelled relink preserves the current grant");
    const expired = await start();
    db.prepare("UPDATE TidalOAuthState SET expires_at = 0").run();
    await request(`/auth/tidal/callback?state=${expired.state}&code=code`, "A", expired.cookie);
    assert.equal(exchanges, 1);
    const unlink = (cookie: string, header = true, user = "A") =>
      request("/auth/tidal/unlink", user, cookie, {
        method: "POST",
        body: "{}",
        headers: {
          "Content-Type": "application/json",
          ...(header ? { "X-Sashimi-Request": "tidal" } : {}),
        },
      });
    assert.equal((await unlink(flow.cookie, false)).status, 403);
    assert.equal((await unlink(flow.cookie, true, "")).status, 401);
    const racing = await start();
    delaying = true;
    const exchangeStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    const pending = request(
      `/auth/tidal/callback?state=${racing.state}&code=code`,
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
    assert.equal(tidalUsers.get("A"), undefined, "Late callback must not undo unlink");
    const failed = await (await request("/auth/tidal/result", "A", racing.cookie)).text();
    assert.match(failed, /Reconnect Tidal/);
  } finally {
    globalThis.fetch = original;
    server.close();
    db.close();
    archiveDb.close();
    await rm(directory, { recursive: true, force: true });
  }
});
