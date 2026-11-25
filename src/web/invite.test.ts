import Database from "better-sqlite3";
import type { Client } from "discord.js";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

test("invite callback separates authorization from asynchronous bot membership", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "sashimi-invite-test-"));
  process.env.TOKEN = "test-token";
  process.env.CLIENT_ID = "123456789012345678";
  process.env.LIBRARY_PATH = directory;
  process.env.DATABASE_URL = path.join(directory, "library.db");
  process.env.DISCORD_CLIENT_SECRET = "test-secret";
  process.env.DISCORD_REDIRECT_URI = "http://localhost:8080/auth/callback";
  process.env.SESSION_SECRET = "test-session-secret-long-enough";
  const { createWebServer } = await import("./server");
  const guildId = "123456789012345679";
  const cache = new Map<string, { id: string; name: string }>();
  const client = { guilds: { cache }, users: { cache: new Map() } } as unknown as Client;
  const server = createWebServer(client).listen(0, "127.0.0.1");
  const originalFetch = globalThis.fetch;
  let exchange = () =>
    Promise.resolve(Response.json({ scope: "identify", access_token: "test-access" }));
  let membership = () => Promise.resolve(new Response("", { status: 404 }));
  let exchanges = 0;
  let membershipChecks = 0;
  try {
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const address = server.address();
    assert(address && typeof address !== "string");
    const origin = `http://127.0.0.1:${address.port}`;
    globalThis.fetch = (async (input, init) => {
      if (String(input) === "https://discord.com/api/oauth2/token") {
        exchanges++;
        const body = new URLSearchParams(init?.body as URLSearchParams);
        assert.equal(body.get("redirect_uri"), "http://localhost:8080/invite/callback");
        return exchange();
      }
      if (String(input) === `https://discord.com/api/v10/guilds/${guildId}`) {
        membershipChecks++;
        assert.equal((init?.headers as Record<string, string>).Authorization, "Bot test-token");
        return membership();
      }
      assert(String(input).startsWith(origin), "No unexpected external requests");
      return originalFetch(input, init);
    }) as typeof fetch;

    async function start() {
      const response = await originalFetch(`${origin}/invite`, { redirect: "manual" });
      const cookie = response.headers.get("set-cookie")?.split(";")[0];
      const location = response.headers.get("location");
      assert(cookie && location);
      const authorize = new URL(location);
      assert.equal(authorize.searchParams.get("response_type"), "code");
      assert.equal(authorize.searchParams.get("scope"), "bot applications.commands identify");
      const url = new URL(`${origin}/invite/callback`);
      url.searchParams.set("state", authorize.searchParams.get("state") ?? "");
      url.searchParams.set("code", "test-code");
      url.searchParams.set("iss", "https://discord.com");
      url.searchParams.set("guild_id", guildId);
      return { cookie, url };
    }
    async function complete(flow: Awaited<ReturnType<typeof start>>) {
      const response = await originalFetch(flow.url, {
        headers: { Cookie: flow.cookie },
        redirect: "manual",
      });
      assert.equal(response.status, 302);
      assert.equal(response.headers.get("location"), "/invite/result");
      const page = await originalFetch(`${origin}/invite/result`, {
        headers: { Cookie: flow.cookie },
      });
      const html = await page.text();
      assert(!html.includes("test-code") && !html.includes("test-access"));
      assert(!html.includes(flow.url.searchParams.get("state") ?? "unexpected-value"));
      return html;
    }
    async function status(cookie: string, extra = "") {
      const response = await originalFetch(`${origin}/api/invite/status${extra}`, {
        headers: { Cookie: cookie },
      });
      assert.equal(response.headers.get("cache-control"), "private, no-store");
      return response.json() as Promise<{ status: string; canCheck: boolean; message: string }>;
    }

    await t.test("already joined bot is confirmed even without bot in token scopes", async () => {
      cache.set(guildId, { id: guildId, name: "Music club" });
      const flow = await start();
      assert.match(await complete(flow), /Sashimi is in your server/);
      assert.equal(
        (
          await originalFetch(`${origin}/api/dashboard/guilds`, {
            headers: { Cookie: flow.cookie },
          })
        ).status,
        401,
        "An invite receipt is not dashboard authorization",
      );
      cache.clear();
    });
    await t.test(
      "Discord token guild is trusted proof despite empty scopes and a delayed gateway",
      async () => {
        exchange = async () =>
          Response.json({ access_token: "test-access", scope: "", guild: { id: guildId } });
        const before = membershipChecks;
        assert.match(await complete(await start()), /Sashimi is in your server/);
        assert.equal(membershipChecks, before);
        exchange = async () => Response.json({ access_token: "test-access", scope: "identify" });
      },
    );
    await t.test(
      "bot-authenticated REST confirms membership when the gateway cache lags",
      async () => {
        membership = async () => Response.json({ id: guildId });
        assert.match(await complete(await start()), /Sashimi is in your server/);
        membership = async () => new Response("", { status: 404 });
      },
    );
    await t.test(
      "missing cache and REST 404 remain pending, then gateway arrival confirms",
      async () => {
        const flow = await start();
        const html = await complete(flow);
        assert.match(html, /confirmation pending/);
        assert.match(html, /don’t need to invite it again/);
        assert.match(html, /invite-status.js/);
        assert.equal((await status(flow.cookie)).status, "pending");
        const before = exchanges;
        cache.set(guildId, { id: guildId, name: "Music club" });
        assert.equal((await status(flow.cookie)).status, "confirmed");
        assert.equal(exchanges, before, "Status checks never reuse the OAuth code");
        assert.match(
          await (
            await originalFetch(`${origin}/invite/result`, { headers: { Cookie: flow.cookie } })
          ).text(),
          /Sashimi is in your server/,
        );
        cache.clear();
      },
    );
    await t.test(
      "rate limits and Discord outages remain pending with bounded retries",
      async (context) => {
        const now = Date.now();
        let elapsed = 16_000;
        context.mock.method(Date, "now", () => now + elapsed);
        membership = async () =>
          new Response("", { status: 429, headers: { "retry-after": "60" } });
        const beforeRateLimit = membershipChecks;
        const flow = await start();
        await complete(flow);
        assert.equal(membershipChecks, beforeRateLimit + 1);
        const before = membershipChecks;
        assert.equal((await status(flow.cookie)).status, "pending");
        assert.equal((await status(flow.cookie)).status, "pending");
        assert.equal(membershipChecks, before);
        elapsed += 61_000;
        membership = async () => new Response("", { status: 503 });
        const other = await start();
        assert.match(await complete(other), /confirmation pending/);
        assert.equal(membershipChecks, before + 1);
        membership = async () => new Response("", { status: 404 });
      },
    );
    await t.test(
      "code exchange failure cannot turn an already joined bot into failure",
      async (context) => {
        const logged: unknown[][] = [];
        context.mock.method(console, "error", (...values: unknown[]) => {
          logged.push(values);
        });
        exchange = async () => {
          throw new Error("test-code test-access transport failure");
        };
        cache.set(guildId, { id: guildId, name: "Music club" });
        assert.match(await complete(await start()), /Sashimi is in your server/);
        cache.clear();
        exchange = async () => new Response("", { status: 400 });
        assert.match(await complete(await start()), /confirmation pending/);
        assert.equal(
          logged.length,
          0,
          "Transport exceptions containing credentials must not be logged",
        );
        exchange = async () => Response.json({ access_token: "test-access", scope: "identify" });
      },
    );
    await t.test(
      "no guild hint stays pending without exposing arbitrary membership lookups",
      async () => {
        const flow = await start();
        flow.url.searchParams.delete("guild_id");
        const before = membershipChecks;
        assert.match(await complete(flow), /confirmation pending/);
        const result = await status(flow.cookie, `?guild_id=${guildId}`);
        assert.equal(result.status, "pending");
        assert.equal(result.canCheck, false);
        assert.equal(membershipChecks, before);
      },
    );
    await t.test("denial and missing codes are explicit authorization outcomes", async () => {
      const denied = await start();
      denied.url.searchParams.set("error", "access_denied");
      denied.url.searchParams.delete("code");
      const before = exchanges;
      assert.match(await complete(denied), /authorization was cancelled/);
      assert.equal((await status(denied.cookie)).status, "cancelled");
      const missing = await start();
      missing.url.searchParams.delete("code");
      assert.match(await complete(missing), /Authorization could not be completed/);
      assert.equal((await status(missing.cookie)).status, "failed");
      const error = await start();
      error.url.searchParams.set("error", "invalid_request");
      assert.match(await complete(error), /Authorization could not be completed/);
      assert.equal((await status(error.cookie)).status, "failed");
      assert.equal(exchanges, before);
    });
    await t.test(
      "invalid state or issuer rejects callback without exchange or membership probes",
      async () => {
        const before = exchanges;
        const beforeMembership = membershipChecks;
        for (const change of ["state", "iss"]) {
          const flow = await start();
          flow.url.searchParams.set(
            change,
            change === "state" ? "é".repeat(64) : "https://evil.example",
          );
          assert.match(await complete(flow), /couldn’t verify this callback/);
          assert.equal((await status(flow.cookie)).status, "invalid");
        }
        assert.equal(exchanges, before);
        assert.equal(membershipChecks, beforeMembership);
      },
    );
    await t.test(
      "replayed callback cannot consume the code again or erase pending receipt",
      async () => {
        const flow = await start();
        await complete(flow);
        const before = exchanges;
        assert.match(await complete(flow), /confirmation pending/);
        assert.equal(exchanges, before);
      },
    );
    await t.test("status without this browser's receipt discloses no installation", async () => {
      assert.equal((await status("")).status, "none");
    });
    await t.test(
      "expired callback state cannot exchange a code or confirm a query guild",
      async (context) => {
        const flow = await start();
        const now = Date.now();
        context.mock.method(Date, "now", () => now + 11 * 60_000);
        const before = exchanges;
        assert.match(await complete(flow), /couldn’t verify this callback/);
        assert.equal((await status(flow.cookie)).status, "invalid");
        assert.equal(exchanges, before);
      },
    );
    await t.test(
      "confirmation expires as pending, never as an inferred failed install",
      async (context) => {
        const flow = await start();
        await complete(flow);
        const now = Date.now();
        context.mock.method(Date, "now", () => now + 11 * 60_000);
        const before = membershipChecks;
        const result = await status(flow.cookie);
        assert.equal(result.status, "pending");
        assert.equal(result.canCheck, false);
        assert.equal(membershipChecks, before);
      },
    );
    await t.test("receipts never persist exchanged credentials or authorization codes", () => {
      const sessions = new Database(path.join(directory, "sessions.db"), { readonly: true });
      try {
        const rows = sessions.prepare<[], { sess: string }>("SELECT sess FROM sessions").all();
        assert(rows.length > 0);
        for (const row of rows) {
          assert(!row.sess.includes("test-code") && !row.sess.includes("test-access"));
          assert.equal(
            "inviteState" in JSON.parse(row.sess),
            false,
            "Completed invite nonce must be consumed",
          );
        }
      } finally {
        sessions.close();
      }
    });
  } finally {
    globalThis.fetch = originalFetch;
    server.close();
  }
});
