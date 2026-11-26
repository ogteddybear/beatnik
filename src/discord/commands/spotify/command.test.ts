import type { Provider } from "@/providers";
import {
  type AutocompleteInteraction,
  type ChatInputCommandInteraction,
  MessageFlags,
} from "discord.js";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

test("Spotify command replies stay ephemeral and playlists belong to the invoking user", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "sashimi-spotify-command-"));
  Object.assign(process.env, {
    TOKEN: "test",
    CLIENT_ID: "123",
    LIBRARY_PATH: directory,
    DATABASE_URL: path.join(directory, "library.db"),
    SPOTIFY_CLIENT_ID: "client",
    SPOTIFY_CLIENT_SECRET: "secret",
  });
  const { db, archiveDb } = await import("../../../core/db/client");
  const original = globalThis.fetch;
  try {
    const { spotifyUsers } = await import("../../../core/db/spotify-users");
    const { handleSpotifyCommand, autocomplete } = await import("./command");
    const { providers } = await import("../../../core/manager");
    const replies: unknown[] = [];
    const flags: unknown[] = [];
    const interaction = (action: string, id = "A") =>
      ({
        user: { id },
        guildId: null,
        options: { getSubcommand: () => action, getInteger: () => 2 },
        deferReply: async (options: { flags: number }) => {
          flags.push(options.flags);
        },
        editReply: async (reply: unknown) => {
          replies.push(reply);
        },
      }) as unknown as ChatInputCommandInteraction;
    await handleSpotifyCommand(interaction("link"));
    assert.equal(
      replies.pop(),
      "🔗 Link your Spotify account: https://dis.sashimi.zip/auth/spotify",
    );
    await handleSpotifyCommand(interaction("load"));
    assert.equal(
      replies.pop(),
      "🔗 Link your Spotify account: https://dis.sashimi.zip/auth/spotify",
    );
    spotifyUsers.save({
      discord_user_id: "A",
      access_token: "A-token",
      refresh_token: "A-refresh",
      expires_at: Date.now() + 3600000,
      spotify_user_id: "spotify-A",
      spotify_display_name: "A",
      updated_at: Date.now(),
    });
    globalThis.fetch = async (url, options) => {
      assert.equal(new Headers(options?.headers).get("Authorization"), "Bearer A-token");
      assert.match(String(url), /offset=10/);
      return Response.json({
        items: [{ id: "PrivateA", name: "Private A", tracks: { total: 3 } }],
        total: 11,
        next: null,
      });
    };
    await handleSpotifyCommand(interaction("playlists"));
    const reply = replies.pop() as { embeds: { toJSON(): { description?: string } }[] };
    assert.match(reply.embeds[0].toJSON().description ?? "", /Private A/);
    await handleSpotifyCommand(interaction("playlists", "B"));
    assert.equal(
      replies.pop(),
      "🔗 Link your Spotify account: https://dis.sashimi.zip/auth/spotify",
    );
    let choices: { name: string; value: string }[] = [];
    globalThis.fetch = async (_url, options) => {
      assert.equal(new Headers(options?.headers).get("Authorization"), "Bearer A-token");
      return Response.json({ items: [{ id: "PrivateA", name: "Private A" }], next: null });
    };
    await autocomplete({
      user: { id: "A" },
      options: { getFocused: () => "private" },
      respond: async (items: typeof choices) => {
        choices = items;
      },
    } as unknown as AutocompleteInteraction);
    assert.deepEqual(choices, [{ name: "Private A", value: "PrivateA" }]);
    let resolvedFor: string | undefined;
    const fake = {
      id: "spotify-link-resolver",
      getPlaylist: async (_query: string, context?: { requestingUserId?: string }) => {
        resolvedFor = context?.requestingUserId;
        return { tracks: [{ id: "mapped" }] };
      },
    } as unknown as Provider;
    providers.unshift(fake);
    try {
      const load = interaction("load");
      Object.assign(load, {
        guildId: "guild",
        guild: { members: { cache: new Map([["A", { voice: { channel: {} } }]]) } },
        options: { getSubcommand: () => "load", getString: () => "PrivateA" },
      });
      let queued = false;
      await handleSpotifyCommand(load, async (_interaction, tracks) => {
        queued = true;
        assert.equal(tracks[0].id, "mapped");
      });
      assert.equal(queued, true);
      assert.equal(resolvedFor, "A");
    } finally {
      providers.splice(providers.indexOf(fake), 1);
    }
    globalThis.fetch = async () => {
      throw new Error("sensitive network detail");
    };
    await handleSpotifyCommand(interaction("playlists"));
    assert.doesNotMatch(String(replies.pop()), /sensitive/);
    await handleSpotifyCommand(interaction("unlink"));
    assert.equal(spotifyUsers.get("A"), undefined);
    assert(flags.length >= 6 && flags.every((flag) => flag === MessageFlags.Ephemeral));
  } finally {
    globalThis.fetch = original;
    db.close();
    archiveDb.close();
    await rm(directory, { recursive: true, force: true });
  }
});
