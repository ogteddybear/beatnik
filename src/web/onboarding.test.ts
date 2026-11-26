import { ChannelType, type Client, type Guild } from "discord.js";
import express from "express";
import { JSDOM } from "jsdom";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

test("onboarding validates permissions and server resources, saves settings and drives the four-step wizard", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "sashimi-onboard-"));
  Object.assign(process.env, {
    TOKEN: "test",
    CLIENT_ID: "123",
    LIBRARY_PATH: directory,
    DATABASE_URL: path.join(directory, "library.db"),
  });
  const { db, archiveDb } = await import("../core/db/client");
  const { mountOnboarding } = await import("./onboarding");
  const { getDefaultTextChannel, getGuildPlayerSettings } =
    await import("../core/db/guild-settings");
  const { configuredTextChannel, welcomeGuild } = await import("../discord/onboarding");
  const guildId = "123456789012345678",
    roleId = "223456789012345678",
    channelId = "323456789012345678";
  let canSend = true;
  const messages: unknown[] = [];
  const channel = {
    id: channelId,
    name: "<b>music</b>",
    type: ChannelType.GuildText,
    permissionsFor: () => ({ has: () => canSend }),
    send: async (message: unknown) => {
      messages.push(message);
    },
  };
  const role = { id: roleId, name: "<script>DJ</script>", managed: false };
  const guild = {
    id: guildId,
    name: "<script>Server</script>",
    systemChannel: channel,
    members: { me: {}, fetchMe: async () => ({}) },
    roles: {
      fetch: async (id?: string) =>
        id ? (id === roleId ? role : null) : new Map([[roleId, role]]),
    },
    channels: {
      cache: new Map([[channelId, channel]]),
      fetch: async (id?: string) =>
        id ? (id === channelId ? channel : null) : new Map([[channelId, channel]]),
    },
  } as unknown as Guild;
  const app = express();
  app.set("view engine", "ejs");
  app.set("views", path.join(process.cwd(), "src/web/views"));
  app.use((req, _res, next) => {
    req.isAuthenticated = (() => !!req.get("X-User")) as typeof req.isAuthenticated;
    next();
  });
  mountOnboarding(
    app,
    { guilds: { cache: new Map([[guildId, guild]]) } } as unknown as Client,
    async (req) =>
      req.get("X-User") === "manager" && req.params.guildId === guildId
        ? { id: "manager", username: "Manager" }
        : null,
  );
  const server = app.listen(0, "127.0.0.1");
  let dom: JSDOM | undefined;
  try {
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const address = server.address();
    assert(address && typeof address !== "string");
    const origin = `http://127.0.0.1:${address.port}`;
    const body = {
      volume: 65,
      autoplay_enabled: true,
      dj_role_id: roleId,
      default_text_channel_id: channelId,
    };
    const save = (input: object = body, user = "manager", header = "onboard") =>
      fetch(`${origin}/api/onboard/${guildId}`, {
        method: "POST",
        headers: {
          "X-User": user,
          "X-Sashimi-Request": header,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(input),
      });
    assert.equal((await save(body, "")).status, 401);
    assert.equal((await save(body, "member")).status, 403);
    assert.equal((await save(body, "manager", "")).status, 403);
    assert.equal((await save({ ...body, volume: 201 })).status, 400);
    assert.equal((await save({ ...body, dj_role_id: channelId })).status, 400);
    assert.equal((await save({ ...body, default_text_channel_id: roleId })).status, 400);
    canSend = false;
    assert.equal((await save()).status, 400);
    assert.equal(
      getGuildPlayerSettings(guildId).volume,
      100,
      "Invalid selections cannot partially save",
    );
    canSend = true;
    assert.equal((await save()).status, 200);
    assert.equal(getDefaultTextChannel(guildId), channelId);
    assert.equal(getGuildPlayerSettings(guildId).volume, 65);
    assert.equal(configuredTextChannel(guild), channel);
    await welcomeGuild(guild);
    assert.match(JSON.stringify(messages), new RegExp(`/onboard/${guildId}`));
    canSend = false;
    await welcomeGuild(guild);
    assert.equal(messages.length, 1);
    assert.equal(configuredTextChannel(guild), null);
    canSend = true;
    const page = await (
      await fetch(`${origin}/onboard/${guildId}`, { headers: { "X-User": "manager" } })
    ).text();
    assert.match(page, /&lt;script&gt;Server/);
    dom = new JSDOM(page, { runScripts: "outside-only", url: "https://sashimi.example" });
    let sent: unknown;
    dom.window.fetch = async (_url, options) => {
      sent = JSON.parse(String(options?.body));
      return Response.json({ settings: body });
    };
    dom.window.eval(await readFile("src/web/public/onboard.js", "utf8"));
    const next = dom.window.document.querySelector<HTMLButtonElement>("#wizard-next");
    assert(next);
    next.click();
    next.click();
    next.click();
    assert.equal(dom.window.document.querySelector("#wizard-progress")?.textContent, "Step 4 of 4");
    dom.window.document
      .querySelector("#onboard-form")
      ?.dispatchEvent(new dom.window.Event("submit", { cancelable: true }));
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(sent, body);
    assert.match(
      dom.window.document.querySelector("#wizard-status")?.textContent ?? "",
      /successfully/,
    );
  } finally {
    dom?.window.close();
    server.close();
    db.close();
    archiveDb.close();
    await rm(directory, { recursive: true, force: true });
  }
});
