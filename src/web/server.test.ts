import type { CorePlayer } from "@/core/player";
import Database from "better-sqlite3";
import type { Client } from "discord.js";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { proxyImageUrl } from "../utils/image-proxy";

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

  const {
    createWebServer,
    canManageGuild,
    authorizedGuilds,
    guildStorageBytes,
    parseEventFilters,
  } = await import("./server");
  assert.equal(parseEventFilters({ from: "0", to: "1000", type: "player" })?.eventType, "player");
  assert.equal(parseEventFilters({ from: "1000", to: "0" }), null);
  assert.equal(parseEventFilters({ from: "0", to: String(91 * 86_400_000) }), null);
  assert.equal(parseEventFilters({ type: "unknown" }), null);
  assert.equal(canManageGuild("32"), true); // MANAGE_GUILD
  assert.equal(canManageGuild("8"), true); // ADMINISTRATOR
  assert.equal(canManageGuild("40"), true);
  assert.equal(canManageGuild("9007199254741024"), true); // Retain bits beyond Number.MAX_SAFE_INTEGER.
  assert.equal(canManageGuild("1024"), false);
  assert.equal(canManageGuild("not-a-bitmask"), false);
  const guilds = new Map([
    ["managed", { id: "managed", name: "Managed", icon: "guild-icon-hash" }],
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
  assert.equal(await guildStorageBytes("managed"), Buffer.byteLength("cached audiomorenot audio"));
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
        id: "managed",
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
    guilds: [],
  });
  assert.match(admin, /All bot servers/);
  const detail = await ejs.renderFile(path.join("src", "web", "views", "guild-detail.ejs"), {
    username: "Owner",
    avatarUrl: "https://cdn.discordapp.com/embed/avatars/0.png",
    isAdmin: true,
    guildId: "managed",
    guildName: "<script>alert(1)</script>",
  });
  assert.match(detail, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.doesNotMatch(detail, /<script>alert\(1\)<\/script>/);
  const client = { guilds: { cache: guilds }, users: { cache: new Map() } } as unknown as Client;
  let controlBusy = false;
  let controlCalls = 0;
  const remoteSessions = new Map<
    string,
    {
      player: CorePlayer;
      voice: {
        channelId: string;
        isCurrentMessage(id: string): boolean;
        runControl(action: () => Promise<void>): Promise<boolean>;
      };
    }
  >();
  let resolvedTrackCalls = 0;
  const server = createWebServer(
    client,
    (id) => remoteSessions.get(id),
    async () => {
      resolvedTrackCalls++;
      return {
        id: "custom-track",
        providerId: "test",
        title: "Custom song",
        url: "https://youtube.com/watch?v=custom",
        length: 120,
        channelName: "Artist",
        thumbnailUrl: "",
        loudness: null,
        playlistIdx: null,
      };
    },
  ).listen(0, "127.0.0.1");
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
    assert.match(html, /href="\/invite"/);
    const unauthorizedAdmin = await fetch(`http://127.0.0.1:${address.port}/admin`, {
      redirect: "manual",
    });
    assert.equal(unauthorizedAdmin.status, 302);
    assert.equal(unauthorizedAdmin.headers.get("location"), "/");
    assert.equal((await fetch(`http://127.0.0.1:${address.port}/api/admin/guilds`)).status, 401);
    const origin = `http://127.0.0.1:${address.port}`;
    const faviconRedirect = await fetch(`${origin}/favicon.ico`, { redirect: "manual" });
    assert.equal(faviconRedirect.status, 302);
    assert.equal(faviconRedirect.headers.get("location"), "/static/icon.svg");
    const iconResponse = await fetch(`${origin}/static/icon.svg`);
    assert.equal(iconResponse.status, 200);
    assert.match(iconResponse.headers.get("content-type") ?? "", /image\/svg\+xml/);
    assert.equal(iconResponse.headers.get("cache-control"), "public, max-age=86400");
    assert.equal(
      await (await fetch(`${origin}/static/favicon.svg`)).text(),
      await iconResponse.text(),
    );
    const invite = await fetch(`${origin}/invite`, { redirect: "manual" });
    assert.equal(invite.status, 302);
    const inviteCookie = invite.headers.get("set-cookie")?.split(";")[0];
    assert(inviteCookie);
    const inviteLocation = invite.headers.get("location");
    assert(inviteLocation);
    const inviteUrl = new URL(inviteLocation);
    assert.equal(inviteUrl.searchParams.get("scope"), "bot applications.commands identify");
    assert.equal(inviteUrl.searchParams.get("response_type"), "code");
    assert.equal(
      inviteUrl.searchParams.get("redirect_uri"),
      "http://localhost:8080/invite/callback",
    );
    const state = inviteUrl.searchParams.get("state");
    assert(state);
    const invalid = await fetch(`${origin}/invite/callback?state=wrong&code=secret-code`, {
      headers: { Cookie: inviteCookie },
      redirect: "manual",
    });
    assert.equal(invalid.headers.get("location"), "/invite/result");
    const invalidResult = await fetch(`${origin}/invite/result`, {
      headers: { Cookie: inviteCookie },
    });
    assert.match(await invalidResult.text(), /couldn’t verify this callback/);
    const retry = await fetch(`${origin}/invite`, {
      headers: { Cookie: inviteCookie },
      redirect: "manual",
    });
    const retryLocation = retry.headers.get("location");
    assert(retryLocation);
    const retryState = new URL(retryLocation).searchParams.get("state");
    assert(retryState);
    const wrongIssuer = await fetch(
      `${origin}/invite/callback?state=${retryState}&code=secret-code&iss=https%3A%2F%2Fevil.example`,
      { headers: { Cookie: inviteCookie }, redirect: "manual" },
    );
    assert.equal(wrongIssuer.headers.get("location"), "/invite/result");
    const deniedStart = await fetch(`${origin}/invite`, {
      headers: { Cookie: inviteCookie },
      redirect: "manual",
    });
    const deniedLocation = deniedStart.headers.get("location");
    assert(deniedLocation);
    const deniedState = new URL(deniedLocation).searchParams.get("state");
    assert(deniedState);
    const denied = await fetch(
      `${origin}/invite/callback?state=${deniedState}&error=access_denied&iss=https%3A%2F%2Fdiscord.com`,
      { headers: { Cookie: inviteCookie }, redirect: "manual" },
    );
    assert.equal(denied.headers.get("location"), "/invite/result");
    const cancelled = await fetch(`${origin}/invite/result`, { headers: { Cookie: inviteCookie } });
    assert.match(await cancelled.text(), /authorization was cancelled/);
    const replay = await fetch(`${origin}/invite/callback?state=${deniedState}&code=secret-code`, {
      headers: { Cookie: inviteCookie },
    });
    assert.match(await replay.text(), /couldn’t verify this callback/);

    const originalFetch = globalThis.fetch;
    let permissionsUnavailable = false;
    globalThis.fetch = (async (url: string | URL | Request, options?: RequestInit) => {
      const target = String(url);
      if (target === "https://discord.com/api/users/@me/guilds") {
        if (permissionsUnavailable) return new Response("", { status: 503 });
        return Response.json(userGuilds);
      }
      if (target === "https://discord.com/api/oauth2/token") {
        const body = new URLSearchParams(options?.body as string);
        assert.equal(body.get("code"), "secret-code");
        assert.equal(body.get("redirect_uri"), "http://localhost:8080/invite/callback");
        return Response.json({
          scope: "bot applications.commands identify",
          access_token: "test-access",
        });
      }
      return originalFetch(url, options);
    }) as typeof fetch;
    try {
      const install = await originalFetch(`${origin}/invite`, {
        headers: { Cookie: inviteCookie },
        redirect: "manual",
      });
      const installLocation = install.headers.get("location");
      assert(installLocation);
      const installState = new URL(installLocation).searchParams.get("state");
      const done = await originalFetch(
        `${origin}/invite/callback?state=${installState}&code=secret-code&iss=https%3A%2F%2Fdiscord.com`,
        { headers: { Cookie: inviteCookie }, redirect: "manual" },
      );
      assert.equal(done.headers.get("location"), "/invite/result");
      const result = await originalFetch(`${origin}/invite/result`, {
        headers: { Cookie: inviteCookie },
      });
      assert.match(await result.text(), /authorization completed/i);

      const cookieFor = (id: string) => {
        const sid = `test-${id}`;
        const sessionSecret = process.env.SESSION_SECRET;
        assert(sessionSecret);
        const signature = createHmac("sha256", sessionSecret)
          .update(sid)
          .digest("base64")
          .replace(/=+$/, "");
        const sessions = new Database(path.join(libraryPath, "sessions.db"));
        sessions
          .prepare("INSERT OR REPLACE INTO sessions (sid, expired, sess) VALUES (?, ?, ?)")
          .run(
            sid,
            Date.now() + 60_000,
            JSON.stringify({
              cookie: { originalMaxAge: 60_000, expires: new Date(Date.now() + 60_000), path: "/" },
              passport: {
                user: { id, username: "Test", avatar: "test-avatar", accessToken: "test-access" },
              },
            }),
          );
        sessions.close();
        return `connect.sid=${encodeURIComponent(`s:${sid}.${signature}`)}`;
      };
      const memberCookie = cookieFor("ordinary-user");
      const ownerCookie = cookieFor("258189484053495809");
      const { getOrCreateSession } = await import("@/core/manager");
      for (const [id, title] of [
        ["managed", "Managed song"],
        ["member", "Private song"],
      ]) {
        const session = getOrCreateSession(id);
        session.queue.tracks = Array.from({ length: 8 }, (_, index) => ({
          id: `${id}-${index}`,
          title: index ? `Next ${index}` : title,
          providerId: "test",
          url: "https://example.com/song",
          thumbnailUrl: "",
          channelName: "Artist",
          length: 60,
          loudness: 0,
          playlistIdx: null,
          addedBy: "listener",
        }));
        session.player.isPlaying = true;
        session.player.onPosition = () => 15;
        session.player.onPause = () => true;
        remoteSessions.set(id, {
          player: session.player,
          voice: {
            channelId: "voice",
            isCurrentMessage: () => true,
            runControl: async (action) => {
              controlCalls++;
              if (controlBusy) return false;
              await action();
              return true;
            },
          },
        });
      }
      const request = (uri: string, cookie: string) =>
        originalFetch(`${origin}${uri}`, { headers: { Cookie: cookie }, redirect: "manual" });
      assert.equal((await originalFetch(`${origin}/api/admin/search?q=play`)).status, 401);
      assert.equal((await request("/api/admin/search?q=play", memberCookie)).status, 403);
      assert.equal((await request("/api/admin/search?q=", ownerCookie)).status, 400);
      assert.equal(
        (await request("/api/admin/search?q=play&before=nope", ownerCookie)).status,
        400,
      );
      assert.equal((await request("/api/admin/search?q=play", ownerCookie)).status, 200);
      const serversResponse = await request("/servers", memberCookie);
      assert.equal(serversResponse.status, 200);
      const serversHtml = await serversResponse.text();
      assert.match(serversHtml, /\/dashboard\/guilds\/managed/);
      assert.doesNotMatch(serversHtml, /\/dashboard\/guilds\/member"/);
      assert.match(
        await (await request("/servers", ownerCookie)).text(),
        /\/dashboard\/guilds\/member/,
      );
      assert.equal((await originalFetch(`${origin}/api/dashboard/statistics`)).status, 401);
      assert.equal(
        (await request("/api/admin/guilds/managed/statistics", memberCookie)).status,
        403,
      );
      assert.equal(
        (await request("/api/admin/guilds/missing/statistics", ownerCookie)).status,
        404,
      );
      const chartResponse = await request("/api/dashboard/statistics", memberCookie);
      assert.equal(chartResponse.status, 200);
      assert.match(chartResponse.headers.get("cache-control") ?? "", /no-store/);
      const chartBody = await chartResponse.json();
      assert.equal(chartBody.days.length, 30);
      assert.equal(chartBody.timezone, "UTC");
      assert.equal(
        (await request("/api/admin/guilds/managed/statistics", ownerCookie)).status,
        200,
      );
      const memberStats = await request("/api/dashboard/guilds", memberCookie);
      const memberBody = await memberStats.json();
      assert.equal(memberBody.guilds[0].player.track.title, "Managed song");
      assert.equal(memberBody.guilds[0].player.progressSeconds, 15);
      assert.equal(memberBody.guilds[0].player.nextTracks.length, 5);
      assert.equal(JSON.stringify(memberBody).includes("Private song"), false);
      assert.equal(
        memberBody.guilds[0].iconUrl,
        proxyImageUrl("https://cdn.discordapp.com/icons/managed/guild-icon-hash.png"),
      );
      assert.deepEqual(
        memberBody.guilds.map((guild: { id: string }) => guild.id),
        ["managed", "admin"],
      );
      assert.equal((await request("/api/admin/guilds", memberCookie)).status, 403);
      assert.equal((await request("/api/admin/infrastructure", memberCookie)).status, 403);
      assert.equal((await request("/api/admin/infrastructure", "")).status, 401);
      const infrastructureResponse = await request("/api/admin/infrastructure", ownerCookie);
      assert.equal(infrastructureResponse.status, 200);
      const infrastructureJson = await infrastructureResponse.json();
      assert.equal(typeof infrastructureJson.uptime, "string");
      assert.doesNotMatch(
        JSON.stringify(infrastructureJson),
        /FLY_API_TOKEN|FLY_ORG_SLUG|Authorization/,
      );
      assert.equal((await request("/api/admin/guilds/managed/events", memberCookie)).status, 403);
      assert.equal((await request("/admin/guild/managed", memberCookie)).status, 302);
      assert.equal((await request("/api/admin/guilds/member/summary", memberCookie)).status, 403);
      const overview = await request("/api/admin/guilds", ownerCookie);
      const overviewBody = await overview.json();
      assert(
        overviewBody.guilds.some(
          (guild: { player: { track: { title: string } } | null }) =>
            guild.player?.track.title === "Private song",
        ),
      );
      assert.equal(overviewBody.guilds[0].iconUrl, memberBody.guilds[0].iconUrl);
      assert.deepEqual(
        overviewBody.guilds.map((guild: { id: string }) => guild.id),
        ["managed", "member", "admin"],
      );
      assert.equal((await request("/admin/guild/managed", ownerCookie)).status, 200);
      assert.equal((await request("/api/admin/guilds/missing/events", ownerCookie)).status, 404);
      const updateQuota = (body: unknown, cookie = ownerCookie, guild = "managed", header = true) =>
        originalFetch(`${origin}/api/admin/guilds/${guild}/settings`, {
          method: "POST",
          headers: {
            Cookie: cookie,
            "Content-Type": "application/json",
            ...(header ? { "X-Sashimi-Request": "quota" } : {}),
          },
          body: JSON.stringify(body),
        });
      assert.equal((await updateQuota({ max_storage_mb: 1 }, "")).status, 401);
      assert.equal((await updateQuota({ max_storage_mb: 1 }, memberCookie)).status, 403);
      assert.equal((await updateQuota({ max_storage_mb: 1 }, ownerCookie, "missing")).status, 404);
      assert.equal(
        (await updateQuota({ max_storage_mb: 1 }, ownerCookie, "managed", false)).status,
        403,
      );
      for (const body of [
        {},
        { max_storage_mb: -1 },
        { max_storage_mb: "1" },
        { max_storage_mb: 1e20 },
        { max_storage_mb: null },
      ]) {
        assert.equal((await updateQuota(body)).status, 400);
      }
      assert.equal(memberBody.guilds[0].maxStorageBytes, 104857600);
      const quotaResponse = await updateQuota({ max_storage_mb: 1.5 });
      assert.equal(quotaResponse.status, 200);
      const quota = await quotaResponse.json();
      assert.equal(quota.maxStorageBytes, 1.5 * 1048576);
      assert.equal(quota.storageBytes, await guildStorageBytes("managed"));
      const updatedSummary = await (
        await request("/api/admin/guilds/managed/summary", ownerCookie)
      ).json();
      assert.equal(updatedSummary.maxStorageBytes, quota.maxStorageBytes);
      assert.equal((await updateQuota({ max_storage_mb: 0 })).status, 200);
      const noCache = await (await request("/api/dashboard/guilds", memberCookie)).json();
      assert.equal(noCache.guilds[0].maxStorageBytes, 0);
      assert.equal(noCache.guilds[0].storageOverQuota, true);
      assert.equal((await updateQuota({ max_storage_mb: 100 })).status, 200);
      const { logEvent } = await import("@/core/db/guild-events");
      logEvent({ guildId: "managed", userId: "123", eventType: "command", action: "play" });
      logEvent({ guildId: "member", userId: "456", eventType: "player", action: "skip" });
      logEvent({
        guildId: "managed",
        userId: "123",
        username: "Recorded listener",
        trackName: "Recorded song",
        eventType: "player",
        action: "request",
        trackId: "track-one",
        metadata: { secret: "hide-me" },
      });
      const events = await request("/api/admin/guilds/managed/events?user=123", ownerCookie);
      const eventBody = await events.json();
      assert.deepEqual(
        eventBody.events.map((event: { action: string }) => event.action),
        ["request", "play"],
      );
      assert.equal(eventBody.events[0].details, "trackId: track-one");
      assert.equal(eventBody.events[0].user, "Recorded listener");
      assert.equal(eventBody.events[0].trackName, "Recorded song");
      assert.equal(JSON.stringify(eventBody).includes("hide-me"), false);
      const since = await request(
        `/api/admin/guilds/managed/events?since=${eventBody.events[1].id}`,
        ownerCookie,
      );
      assert.deepEqual(
        (await since.json()).events.map((event: { action: string }) => event.action),
        ["request"],
      );
      const onlyCommand = await request(
        "/api/admin/guilds/managed/events?type=command&action=play&user=123",
        ownerCookie,
      );
      assert.deepEqual(
        (await onlyCommand.json()).events.map((event: { action: string }) => event.action),
        ["play"],
      );
      const summary = await request("/api/admin/guilds/managed/summary", ownerCookie);
      assert.equal((await summary.json()).ranges.week.commands, 1);
      assert.equal(
        (await request("/api/admin/guilds/managed/events?before=oops", ownerCookie)).status,
        400,
      );
      const { db } = await import("@/core/db/client");
      logEvent({
        guildId: "managed",
        userId: "123",
        username: "Archived listener",
        trackName: "Archived song",
        eventType: "library",
        action: "download",
        trackId: "old-track",
      });
      db.prepare("UPDATE GuildEvents SET created_at = ? WHERE action = 'download'").run(
        Date.now() - 45 * 86_400_000,
      );
      const { archiveOldEvents } = await import("@/core/db/event-archive");
      await archiveOldEvents();
      const archivedPath = `/api/admin/guilds/managed/events?from=${Date.now() - 46 * 86_400_000}&to=${Date.now() - 44 * 86_400_000}&type=library&action=download&user=123`;
      assert.equal((await request(archivedPath, memberCookie)).status, 403);
      const archivedBody = await (await request(archivedPath, ownerCookie)).json();
      assert.equal(archivedBody.events.length, 1);
      assert.equal(archivedBody.events[0].username, "Archived listener");
      assert.equal(archivedBody.events[0].trackName, "Archived song");
      const playlistRequest = (
        path: string,
        method: string,
        body?: unknown,
        cookie = memberCookie,
        header = true,
      ) =>
        originalFetch(`${origin}${path}`, {
          method,
          headers: {
            Cookie: cookie,
            "Content-Type": "application/json",
            ...(header ? { "X-Sashimi-Request": "playlists" } : {}),
          },
          ...(body ? { body: JSON.stringify(body) } : {}),
        });
      assert.equal((await request("/api/playlists", "")).status, 401);
      assert.equal((await request("/playlists", memberCookie)).status, 200);
      assert.equal(
        (
          await playlistRequest(
            "/api/playlists",
            "POST",
            { name: "No header" },
            memberCookie,
            false,
          )
        ).status,
        403,
      );
      assert.equal((await playlistRequest("/api/playlists", "POST", { name: "" })).status, 400);
      const created = await playlistRequest("/api/playlists", "POST", { name: "Chill Vibes" });
      assert.equal(created.status, 201);
      const custom = (await created.json()).playlist;
      assert.equal(
        (await playlistRequest("/api/playlists", "POST", { name: "chill vibes" })).status,
        409,
      );
      assert.equal(
        (await (await request("/api/playlists", ownerCookie)).json()).playlists.length,
        0,
      );
      assert.equal(
        (
          await playlistRequest(
            `/api/playlists/${custom.id}/tracks`,
            "POST",
            { url: "https://youtube.com/watch?v=a" },
            ownerCookie,
          )
        ).status,
        404,
      );
      assert.equal(
        (await playlistRequest(`/api/playlists/${custom.id}`, "DELETE", undefined, ownerCookie))
          .status,
        404,
      );
      assert.equal(
        resolvedTrackCalls,
        0,
        "Other users cannot trigger metadata lookups against a private playlist",
      );
      assert.equal(
        (
          await playlistRequest(`/api/playlists/${custom.id}/tracks`, "POST", {
            url: "http://127.0.0.1/private",
          })
        ).status,
        400,
      );
      const added = await playlistRequest(`/api/playlists/${custom.id}/tracks`, "POST", {
        url: "https://youtube.com/watch?v=a",
        provider_id: "forged",
      });
      assert.equal(added.status, 200);
      assert.equal((await added.json()).playlist.tracks[0].providerId, "test");
      assert.equal(resolvedTrackCalls, 1);
      assert.equal(
        (
          await playlistRequest("/api/playlists", "POST", {
            name: "Private queue",
            guildId: "member",
          })
        ).status,
        403,
      );
      const snapshot = await playlistRequest("/api/playlists", "POST", {
        name: "Queue snapshot",
        guildId: "managed",
      });
      assert.equal(snapshot.status, 201);
      assert.equal((await snapshot.json()).playlist.tracks.length, 8);
      assert.equal((await playlistRequest(`/api/playlists/${custom.id}`, "DELETE")).status, 204);
      assert.equal(
        db
          .prepare<[], { count: number }>(
            "SELECT count(*) AS count FROM UserPlaylistTrack WHERE playlist_id = " +
              Number(custom.id),
          )
          .get()?.count,
        0,
      );

      logEvent({
        guildId: "managed",
        username: '=HYPERLINK("bad")',
        eventType: "player",
        action: "play",
        trackName: 'Song,"line"\nTwo',
        metadata: { note: "CSV" },
      });
      assert.equal((await request("/api/admin/export/events", "")).status, 401);
      assert.equal((await request("/api/admin/export/events", memberCookie)).status, 403);
      const exported = await request("/api/admin/export/events", ownerCookie);
      assert.equal(exported.status, 200);
      assert.match(exported.headers.get("content-type") ?? "", /text\/csv/);
      assert.match(exported.headers.get("content-disposition") ?? "", /attachment/);
      const csv = await exported.text();
      assert(
        csv.startsWith(
          "Timestamp,Guild ID,User ID,Username,Event Type,Action,Track Name,Metadata\r\n",
        ),
      );
      assert.match(csv, /Archived song/, "Export includes archived rows");
      assert.match(csv, /Song,""line""\nTwo/);
      assert.match(csv, /'=HYPERLINK/);
      const control = (body: unknown, cookie = memberCookie, guild = "managed", header = true) =>
        originalFetch(`${origin}/api/dashboard/guilds/${guild}/control`, {
          method: "POST",
          headers: {
            Cookie: cookie,
            "Content-Type": "application/json",
            ...(header ? { "X-Sashimi-Request": "control" } : {}),
          },
          body: JSON.stringify(body),
        });
      assert.equal((await control({ action: "pause" }, "")).status, 401);
      assert.equal(
        (await control({ action: "pause" }, memberCookie, "managed", false)).status,
        403,
      );
      assert.equal((await control({ action: "stop" }, memberCookie, "member")).status, 403);
      assert.equal((await control({ action: "stop" }, memberCookie, "missing")).status, 403);
      assert.equal(controlCalls, 0, "Unauthorized requests never acquire a player mutex");
      for (const body of [{}, { action: "remove" }, { action: 123 }, null])
        assert.equal((await control(body)).status, 400);
      assert.equal((await control({ action: "pause" })).status, 200);
      assert.equal(remoteSessions.get("managed")?.player.isPaused, true);
      assert.equal((await control({ action: "pause" })).status, 200, "Pause is idempotent");
      assert.equal((await control({ action: "resume" })).status, 200);
      assert.equal(remoteSessions.get("managed")?.player.isPaused, false);
      let skips = 0;
      const managedPlayer = remoteSessions.get("managed")?.player;
      assert(managedPlayer);
      managedPlayer.skip = async (id, _index, username) => {
        assert.equal(id, "ordinary-user");
        assert.equal(username, "Test");
        skips++;
      };
      assert.equal((await control({ action: "skip" })).status, 200);
      assert.equal(skips, 1);
      controlBusy = true;
      assert.equal((await control({ action: "skip" })).status, 409);
      assert.equal(skips, 1);
      controlBusy = false;
      managedPlayer.isLoading = true;
      assert.equal((await control({ action: "skip" })).status, 409);
      managedPlayer.isLoading = false;
      const managedMembership = userGuilds[0];
      managedMembership.permissions = "0";
      assert.equal(
        (await control({ action: "pause" })).status,
        403,
        "Revoked permissions are checked per request",
      );
      managedMembership.permissions = "32";
      permissionsUnavailable = true;
      assert.equal((await control({ action: "pause" })).status, 502);
      permissionsUnavailable = false;
      assert.equal((await control({ action: "pause" }, ownerCookie, "member")).status, 200);
      assert.equal(remoteSessions.get("member")?.player.isPaused, true);
      const stopped = await control({ action: "stop" });
      assert.equal(stopped.status, 200);
      assert.equal((await stopped.json()).player, null);
      assert.equal(managedPlayer.isPlaying, false);
      assert.equal((await control({ action: "skip" })).status, 409);
      remoteSessions.delete("managed");
      assert.equal((await control({ action: "pause" })).status, 409);
    } finally {
      globalThis.fetch = originalFetch;
    }
  } finally {
    server.close();
  }
});
