import type { Client } from "discord.js";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
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

  const { createWebServer, canManageGuild, authorizedGuilds, guildStorageBytes } =
    await import("./server");
  assert.equal(canManageGuild("32"), true); // MANAGE_GUILD
  assert.equal(canManageGuild("8"), true); // ADMINISTRATOR
  assert.equal(canManageGuild("40"), true);
  assert.equal(canManageGuild("9007199254741024"), true); // Retain bits beyond Number.MAX_SAFE_INTEGER.
  assert.equal(canManageGuild("1024"), false);
  assert.equal(canManageGuild("not-a-bitmask"), false);
  const guilds = new Map([
    ["managed", { id: "managed", name: "Managed", icon: null }],
    ["member", { id: "member", name: "Member", icon: null }],
    ["admin", { id: "admin", name: "Admin", icon: null }],
  ]);
  const botClient = { guilds: { cache: guilds } } as unknown as Client;
  const userGuilds = [
    { id: "managed", permissions: "32" },
    { id: "member", permissions: "1024" },
    { id: "admin", permissions: "8" },
    { id: "other-bot", permissions: "8" },
  ];
  assert.deepEqual(
    authorizedGuilds(botClient, "ordinary-user", userGuilds).map((guild) => guild.id),
    ["managed", "admin"],
  );
  assert.deepEqual(
    authorizedGuilds(botClient, "258189484053495809", []).map((guild) => guild.id),
    ["managed", "member", "admin"],
  );
  await mkdir(path.join(libraryPath, "managed"));
  await mkdir(path.join(libraryPath, "global"));
  await writeFile(path.join(libraryPath, "managed", "cached.cache"), "cached audio");
  await writeFile(path.join(libraryPath, "managed", "second.cache"), "more");
  await writeFile(path.join(libraryPath, "managed", "ignore.txt"), "not audio");
  await writeFile(path.join(libraryPath, "global", "legacy.cache"), "legacy audio");
  assert.equal(await guildStorageBytes("managed"), Buffer.byteLength("cached audiomore"));
  assert.equal(await guildStorageBytes("member"), 0);
  assert.equal(await guildStorageBytes("global"), Buffer.byteLength("legacy audio"));
  assert.rejects(guildStorageBytes("../managed"), /Invalid guild ID/);
  const { default: ejs } = await import("ejs");
  const dashboard = await ejs.renderFile(path.join("src", "web", "views", "dashboard.ejs"), {
    username: "Test",
    avatarUrl: "https://cdn.discordapp.com/embed/avatars/0.png",
    guilds: [
      {
        name: "Managed",
        iconUrl: null,
        plays: 2,
        requests: 3,
        skips: 1,
        stops: 1,
        commands: 4,
        storageUsed: "12 B",
      },
    ],
    inviteUrl:
      "https://discord.com/oauth2/authorize?client_id=123&permissions=3146752&scope=bot%20applications.commands",
    isAdmin: true,
  });
  assert.match(dashboard, /Invite Sashimi/);
  assert.match(dashboard, /2<\/p>[\s\S]*?Plays/);
  assert.match(dashboard, /3<\/p>[\s\S]*?Requests/);
  assert.match(dashboard, /12 B<\/p>[\s\S]*?Storage/);
  assert.match(dashboard, /href="\/admin"/);
  assert.match(dashboard, /Skips/);
  assert.match(dashboard, /Stops/);
  assert.match(dashboard, /Commands/);
  const regularDashboard = await ejs.renderFile(path.join("src", "web", "views", "dashboard.ejs"), {
    username: "Test",
    avatarUrl: "https://cdn.discordapp.com/embed/avatars/0.png",
    guilds: [],
    inviteUrl: "https://discord.com/oauth2/authorize?client_id=123",
    isAdmin: false,
  });
  assert.doesNotMatch(regularDashboard, /href="\/admin"/);
  const admin = await ejs.renderFile(path.join("src", "web", "views", "admin.ejs"), {
    username: "Owner",
    avatarUrl: "https://cdn.discordapp.com/embed/avatars/0.png",
    isAdmin: true,
    events: [
      {
        time: new Date(0).toISOString(),
        guild: "<script>alert(1)</script>",
        user: "Test",
        eventType: "command",
        action: "play",
        metadata: '{"trackId":"one"}',
      },
    ],
  });
  assert.match(admin, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.doesNotMatch(admin, /<script>alert\(1\)<\/script>/);
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
    const home = await fetch(`http://127.0.0.1:${address.port}/`);
    assert.equal(home.status, 200);
    const html = await home.text();
    assert.match(html, /Invite Sashimi/);
    assert.match(html, /permissions=3146752&amp;scope=bot%20applications.commands/);
    const unauthorizedAdmin = await fetch(`http://127.0.0.1:${address.port}/admin`, {
      redirect: "manual",
    });
    assert.equal(unauthorizedAdmin.status, 302);
    assert.equal(unauthorizedAdmin.headers.get("location"), "/");
  } finally {
    server.close();
  }
});
