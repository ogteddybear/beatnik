import type { Client } from "discord.js";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

test("Discord OAuth uses the existing bot client ID when no dashboard override is set", async () => {
  const libraryPath = await mkdtemp(path.join(os.tmpdir(), "sashimi-web-test-"));
  process.env.TOKEN = "test-token";
  process.env.CLIENT_ID = "123456789012345678";
  delete process.env.DISCORD_CLIENT_ID;
  process.env.DISCORD_CLIENT_SECRET = "test-client-secret";
  process.env.DISCORD_REDIRECT_URI = "http://localhost:8080/auth/callback";
  process.env.SESSION_SECRET = "test-session-secret-long-enough";
  process.env.LIBRARY_PATH = libraryPath;
  process.env.DATABASE_URL = path.join(libraryPath, "library.db");

  const { createWebServer } = await import("./server");
  const client = { guilds: { cache: new Map() } } as unknown as Client;
  const server = createWebServer(client).listen(0, "127.0.0.1");
  try {
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const address = server.address();
    assert(address && typeof address !== "string");
    const response = await fetch(`http://127.0.0.1:${address.port}/auth/discord`, {
      redirect: "manual",
    });
    assert.equal(response.status, 302);
    const location = response.headers.get("location");
    assert(location);
    const authorization = new URL(location);
    assert.equal(authorization.searchParams.get("client_id"), process.env.CLIENT_ID);
    assert.equal(authorization.searchParams.get("scope"), "identify guilds");
  } finally {
    server.close();
  }
});
