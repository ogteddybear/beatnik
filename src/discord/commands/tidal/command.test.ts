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

test("Tidal commands are private, paginate ten at a time and load only the invoking user's playlists", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "sashimi-tidal-command-"));
  Object.assign(process.env, {
    TOKEN: "test",
    CLIENT_ID: "123",
    LIBRARY_PATH: directory,
    DATABASE_URL: path.join(directory, "library.db"),
    TIDAL_CLIENT_ID: "client",
    TIDAL_CLIENT_SECRET: "secret",
  });
  const { db, archiveDb } = await import("../../../core/db/client");
  const original = globalThis.fetch;
  try {
    const { tidalUsers } = await import("../../../core/db/tidal-users");
    const { handleTidalCommand, autocomplete } = await import("./command");
    const { TIDAL_LINK_MESSAGE } = await import("../../../providers/tidal/errors");
    const { providers } = await import("../../../core/manager");
    const { builder } = await import("./builder");
    assert.equal(builder.toJSON().name, "tidal");
    const replies: unknown[] = [];
    const flags: number[] = [];
    const interaction = (action: string, id = "A") =>
      ({
        user: { id },
        guildId: null,
        options: { getSubcommand: () => action, getInteger: () => 2, getString: () => "p10" },
        deferReply: async (options: { flags: number }) => {
          flags.push(options.flags);
        },
        editReply: async (reply: unknown) => {
          replies.push(reply);
        },
      }) as unknown as ChatInputCommandInteraction;
    await handleTidalCommand(interaction("link"));
    assert.equal(replies.pop(), TIDAL_LINK_MESSAGE);
    await handleTidalCommand(interaction("load"));
    assert.equal(replies.pop(), TIDAL_LINK_MESSAGE);
    tidalUsers.save({
      discord_user_id: "A",
      access_token: "A-token",
      refresh_token: "A-refresh",
      expires_at: Date.now() + 3600_000,
      tidal_user_id: "tidal-A",
      tidal_display_name: "A",
      updated_at: Date.now(),
    });
    const searches: string[] = [];
    globalThis.fetch = async (input, options) => {
      const url = new URL(String(input));
      assert.equal(new Headers(options?.headers).get("Authorization"), "Bearer A-token");
      if (url.pathname.endsWith("/relationships/items"))
        return Response.json({
          data: [
            { type: "tracks", id: "t1" },
            { type: "tracks", id: "t2" },
          ],
          included: [
            {
              type: "tracks",
              id: "t1",
              attributes: { title: "Song", duration: "PT3M" },
              relationships: { artists: { data: [{ type: "artists", id: "a1" }] } },
            },
            { type: "tracks", id: "t2", attributes: { title: "Unmatched", duration: "PT2M" } },
            { type: "artists", id: "a1", attributes: { name: "Artist" } },
          ],
        });
      assert.equal(url.searchParams.get("filter[owners.id]"), "me");
      return Response.json({
        data: Array.from({ length: 21 }, (_, index) => ({
          type: "playlists",
          id: `p${index}`,
          attributes: { name: `Private ${index}`, numberOfTrackItems: 2 },
        })),
      });
    };
    await handleTidalCommand(interaction("playlists"));
    const reply = replies.pop() as {
      embeds: { toJSON(): { description?: string; footer?: { text: string } } }[];
    };
    const embed = reply.embeds[0].toJSON();
    assert.equal(embed.description?.split("\n").length, 10);
    assert.match(embed.description || "", /Private 10/);
    assert.doesNotMatch(embed.description || "", /Private 20/);
    assert.match(embed.footer?.text || "", /page:3/);
    await handleTidalCommand(interaction("playlists", "B"));
    assert.equal(replies.pop(), TIDAL_LINK_MESSAGE);
    let choices: { name: string; value: string }[] = [];
    await autocomplete({
      user: { id: "A" },
      options: { getFocused: () => "private 10" },
      respond: async (items: typeof choices) => {
        choices = items;
      },
    } as unknown as AutocompleteInteraction);
    assert.deepEqual(choices, [{ name: "Private 10", value: "p10" }]);
    await autocomplete({
      user: { id: "B" },
      options: { getFocused: () => "" },
      respond: async (items: typeof choices) => {
        choices = items;
      },
    } as unknown as AutocompleteInteraction);
    assert.deepEqual(choices, []);
    const fake = {
      id: "youtube",
      search: async (query: string) => {
        searches.push(query);
        if (query.includes("Unmatched")) throw new Error("No YouTube search results found.");
        return { id: "mapped", providerId: "youtube" };
      },
    } as unknown as Provider;
    providers.unshift(fake);
    try {
      const load = interaction("load");
      Object.assign(load, {
        guildId: "guild",
        guild: { members: { cache: new Map([["A", { voice: { channel: {} } }]]) } },
      });
      let queued = 0;
      await handleTidalCommand(load, async (_interaction, tracks) => {
        queued++;
        assert.deepEqual(
          tracks.map((track) => track.id),
          ["mapped"],
        );
      });
      assert.equal(queued, 1);
      assert.deepEqual(searches, ["Artist Song", "Unmatched"]);
      const apiFetch = globalThis.fetch;
      globalThis.fetch = async (input, options) => {
        if (!new URL(String(input)).pathname.endsWith("/relationships/items"))
          return apiFetch(input, options);
        return Response.json({
          data: Array.from({ length: 8 }, (_, index) => ({
            type: "tracks",
            id: `t${index}`,
            attributes: { title: `Song ${index}`, duration: "PT3M" },
          })),
        });
      };
      let active = 0;
      let peak = 0;
      let releaseFirst!: () => void;
      const firstReady = new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      const completions: number[] = [];
      fake.search = async (query) => {
        const index = Number(query.split(" ").at(-1));
        active++;
        peak = Math.max(peak, active);
        try {
          if (index === 0) await firstReady;
          else await Promise.resolve();
          if (index === 4) releaseFirst();
          completions.push(index);
          if (index === 2) return null;
          if (index === 3) throw new Error("No YouTube search results found.");
          return { id: `mapped-${index}`, providerId: "youtube" } as Awaited<
            ReturnType<NonNullable<Provider["search"]>>
          >;
        } finally {
          active--;
        }
      };
      await handleTidalCommand(load, async (_interaction, tracks) => {
        queued++;
        assert.deepEqual(
          tracks.map((track) => track.id),
          ["mapped-0", "mapped-1", "mapped-4", "mapped-5", "mapped-6", "mapped-7"],
        );
      });
      assert.equal(peak, 4, "At most four searches run concurrently");
      assert.notEqual(
        completions[0],
        0,
        "Results are queued in playlist order, not completion order",
      );
      assert.equal(queued, 2);
      fake.search = async () => {
        throw new Error("systemic YouTube failure");
      };
      await handleTidalCommand(load, async () => {
        queued++;
      });
      assert.equal(queued, 2, "Systemic search failures must not queue partial results");
      assert.doesNotMatch(String(replies.pop()), /systemic YouTube failure/);
      globalThis.fetch = apiFetch;
      Object.assign(load, {
        options: { getSubcommand: () => "load", getString: () => "someone-elses-playlist" },
      });
      await handleTidalCommand(load, async () => {
        queued++;
      });
      assert.equal(queued, 2);
      assert.match(String(replies.pop()), /Choose one of your Tidal playlists/);
    } finally {
      providers.splice(providers.indexOf(fake), 1);
    }
    globalThis.fetch = async () => {
      throw new Error("private-token-response");
    };
    await handleTidalCommand(interaction("playlists"));
    assert.doesNotMatch(String(replies.pop()), /private-token-response/);
    db.prepare("UPDATE TidalUserTokens SET expires_at = 0").run();
    globalThis.fetch = async () => Response.json({ error: "invalid_grant" }, { status: 400 });
    await handleTidalCommand(interaction("playlists"));
    assert.equal(replies.pop(), TIDAL_LINK_MESSAGE);
    assert.equal(tidalUsers.get("A"), undefined);
    await handleTidalCommand(interaction("unlink"));
    assert.match(String(replies.pop()), /unlinked/);
    assert(flags.length >= 8 && flags.every((flag) => flag === MessageFlags.Ephemeral));
  } finally {
    globalThis.fetch = original;
    db.close();
    archiveDb.close();
    await rm(directory, { recursive: true, force: true });
  }
});
