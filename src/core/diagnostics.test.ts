import type { ChatInputCommandInteraction } from "discord.js";
import { MessageFlags } from "discord.js";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

test("diagnostics is owner-only, private, measures both databases and never reveals provider credentials", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "sashimi-diagnostics-"));
  Object.assign(process.env, {
    TOKEN: "test",
    CLIENT_ID: "123",
    LIBRARY_PATH: directory,
    DATABASE_URL: path.join(directory, "library.db"),
    SPOTIFY_CLIENT_ID: "private-client",
    SPOTIFY_CLIENT_SECRET: "private-secret",
  });
  const { db, archiveDb } = await import("./db/client");
  const original = globalThis.fetch;
  try {
    let calls = 0;
    globalThis.fetch = async (url) => {
      calls++;
      return String(url).includes("accounts.spotify.com")
        ? Response.json({ access_token: "private-token" })
        : Response.json({});
    };
    const { diagnosticsEmbed, OWNER_ID, spotifyConnectivity } = await import("./diagnostics");
    const { execute } = await import("../discord/commands/diagnostics/command");
    const replies: unknown[] = [];
    const interaction = (id: string) =>
      ({
        user: { id },
        deferReply: async (options: { flags: number }) => {
          assert.equal(options.flags, MessageFlags.Ephemeral);
        },
        editReply: async (reply: unknown) => {
          replies.push(reply);
        },
      }) as unknown as ChatInputCommandInteraction;
    await execute(interaction("not-owner"));
    assert.equal(calls, 0);
    assert.match(String(replies.pop()), /restricted/);
    db.prepare("INSERT INTO GuildEvents (event_type, action) VALUES ('player','play')").run();
    archiveDb
      .prepare("INSERT INTO GuildEvents (id,event_type,action) VALUES (2,'player','play')")
      .run();
    const embed = (await diagnosticsEmbed()).toJSON();
    assert.match(JSON.stringify(embed), /GuildEvents: 2 \(1 live \/ 1 archived\)/);
    assert.match(JSON.stringify(embed), /RAM \(RSS\)/);
    assert.match(JSON.stringify(embed), /API reachable/);
    assert.doesNotMatch(JSON.stringify(embed), /private-client|private-secret|private-token/);
    await execute(interaction(OWNER_ID));
    assert.equal(typeof replies.pop(), "object");
    assert.equal(
      await spotifyConnectivity(async () => new Response("", { status: 401 })),
      "Token endpoint HTTP 401",
    );
  } finally {
    globalThis.fetch = original;
    db.close();
    archiveDb.close();
    await rm(directory, { recursive: true, force: true });
  }
});
