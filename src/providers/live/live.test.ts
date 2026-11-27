import type { AudioResource } from "@discordjs/voice";
import type { ChatInputCommandInteraction } from "discord.js";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough, type Readable } from "node:stream";
import { test } from "node:test";
import { setImmediate as flush } from "node:timers/promises";

import type { LiveStreamAttempt } from "../../core/player";
import { LIVE_STATIONS } from "./stations";

test("live command and player lifecycle", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "sashimi-live-test-"));
  process.env.TOKEN = "test-token";
  process.env.CLIENT_ID = "123456789012345678";
  process.env.LIBRARY_PATH = directory;
  process.env.DATABASE_URL = path.join(directory, "library.db");
  const { db, archiveDb } = await import("../../core/db/client");
  const { CorePlayer } = await import("../../core/player");
  const { Queue } = await import("../../core/queue");
  try {
    await t.test(
      "live audit history tracks requester, songs, station switches and stops without finite plays",
      async () => {
        const { getLatestEvents, getGuildPlaybackHistory } =
          await import("../../core/db/guild-events");
        const { guildStats } = await import("../../core/db/guild-stats");
        const player = new CorePlayer("live-audit", new Queue(), []);
        let update: LiveStreamAttempt["onMetadata"];
        player.onLiveStream = async (_url, _current, _disconnect, attempt) => {
          attempt.onResolved?.("http://listener1.mp3.tb-group.fm/tb.mp3");
          update = attempt.onMetadata;
        };
        await player.playLive(LIVE_STATIONS.technobase.url, LIVE_STATIONS.technobase.name, {
          userId: "listener",
          username: "Listener",
        });
        assert.ok(update);
        update({ streamTitle: "Artist - First", artist: "Artist", title: "First" });
        update({ streamTitle: "Artist - First", artist: "Artist", title: "First" });
        update({ streamTitle: "Artist - Second", artist: "Artist", title: "Second" });
        await player.playLive(LIVE_STATIONS.housetime.url, LIVE_STATIONS.housetime.name, {
          userId: "other",
          username: "Other",
        });
        await player.stop("admin");
        const events = getLatestEvents(100).filter(
          (event) => event.guild_id === "live-audit" && event.event_type === "live",
        );
        const starts = events.filter((event) => event.action === "start");
        assert.equal(starts.length, 2);
        assert.equal(events.filter((event) => event.action === "stream_resolved").length, 2);
        const songs = events.filter((event) => event.action === "track_change");
        assert.equal(songs.length, 2);
        assert.equal(songs[0].track_name, "Artist - Second");
        assert.equal(songs[0].user_id, "listener");
        const details = JSON.parse(songs[0].metadata ?? "{}");
        assert.equal(details.station, "TechnoBase.FM");
        assert.equal(details.service, "We aRe oNe");
        assert.equal(details.artist, "Artist");
        assert.equal(details.title, "Second");
        assert.equal(details.requestedBy, "listener");
        assert.ok(details.elapsedSeconds >= 0);
        const stops = events
          .filter((event) => event.action === "stop")
          .map((event) => JSON.parse(event.metadata ?? "{}"));
        assert.equal(stops.length, 2);
        assert.equal(stops[0].stoppedBy, "admin");
        assert.equal(stops[1].reason, "station_switch");
        assert.notEqual(
          JSON.parse(starts[0].metadata ?? "{}").sessionId,
          JSON.parse(starts[1].metadata ?? "{}").sessionId,
        );
        assert.equal(getGuildPlaybackHistory("live-audit").length, 0);
        assert.equal(guildStats.get("live-audit").plays, 0);
      },
    );
    await t.test(
      "metadata updates are deduplicated and stale reconnect/stop callbacks are ignored",
      async (ctx) => {
        ctx.mock.timers.enable({ apis: ["setTimeout"] });
        const player = new CorePlayer("live-metadata", new Queue(), []);
        const callbacks: NonNullable<LiveStreamAttempt["onMetadata"]>[] = [];
        let changes = 0;
        player.onStateChange = () => {
          changes++;
        };
        player.onLiveStream = async (_url, _current, _disconnected, attempt) => {
          assert.ok(attempt.onMetadata);
          callbacks.push(attempt.onMetadata);
        };
        await player.playLive(LIVE_STATIONS.technobase.url, LIVE_STATIONS.technobase.name);
        const metadata = { streamTitle: "Artist - Track", artist: "Artist", title: "Track" };
        callbacks[0](metadata);
        assert.deepEqual(player.getState()?.liveMetadata, metadata);
        const afterUpdate = changes;
        callbacks[0](metadata);
        assert.equal(changes, afterUpdate);
        await player.finish(true);
        assert.equal(player.getState()?.liveMetadata, null);
        callbacks[0](metadata);
        assert.equal(player.getState()?.liveMetadata, null);
        ctx.mock.timers.tick(3_000);
        await flush();
        callbacks[1]({ streamTitle: "New title", title: "New title" });
        assert.equal(player.getState()?.liveMetadata?.streamTitle, "New title");
        await player.stop();
        callbacks[1](metadata);
        assert.equal(player.getState(), null);
      },
    );
    await t.test(
      "a silent live resource times out after ten seconds and is torn down",
      async (ctx) => {
        ctx.mock.timers.enable({ apis: ["setTimeout"] });
        const player = new CorePlayer("live-timeout", new Queue(), []);
        let resets = 0;
        let release: () => void = () => assert.fail("No pending resource");
        player.onResetAudio = () => {
          resets++;
        };
        player.onLiveStream = async (_url, _current, _disconnected, attempt) => {
          attempt.onResourceCreated();
          await new Promise<void>((resolve) => {
            release = resolve;
          });
        };
        const pending = player.playLive(
          LIVE_STATIONS.technobase.url,
          LIVE_STATIONS.technobase.name,
        );
        try {
          ctx.mock.timers.tick(10_000);
          await pending;
          assert.equal(resets, 2, "the hung resource must be destroyed at the connection deadline");
        } finally {
          player.suspend();
          release();
          await pending;
        }
      },
    );
    await t.test(
      "mock createAudioResource never plays: short deadline stops and destroys the resource",
      async (ctx) => {
        const { createLiveStreamHandler } = await import("../../discord/live-audio");
        const { createAudioPlayer, createAudioResource, StreamType } =
          await import("@discordjs/voice");
        ctx.mock.timers.enable({ apis: ["setTimeout"] });
        const player = new CorePlayer("live-audio-timeout", new Queue(), [], 20);
        const audioPlayer = createAudioPlayer();
        const resource = createAudioResource(new PassThrough({ objectMode: true }), {
          inputType: StreamType.Opus,
        });
        const input = new PassThrough();
        const createResource = ctx.mock.fn((stream: Readable) => {
          assert.equal(stream, input, "FFmpeg must receive MP3 bytes, never a network URL");
          return resource;
        });
        const stop = ctx.mock.method(audioPlayer, "stop");
        let active: AudioResource | undefined;
        player.onResetAudio = () => {
          audioPlayer.stop(true);
          active?.playStream.destroy();
          active = undefined;
        };
        player.onLiveStream = createLiveStreamHandler(
          {
            audioPlayer,
            ready: async () => undefined,
            isDestroyed: () => false,
            setResource: (value) => {
              active = value;
            },
            resetResource: (value) => {
              if (active === value) player.onResetAudio?.();
            },
          },
          createResource,
          async () => ({ url: "https://listener1.mp3.tb-group.fm/tb.mp3", stream: input }),
        );
        const pending = player.playLive(
          LIVE_STATIONS.technobase.url,
          LIVE_STATIONS.technobase.name,
        );
        try {
          await flush();
          assert.equal(createResource.mock.callCount(), 1);
          assert.equal(player.isPlaying, false);
          assert.equal(player.getState()?.status, "loading");
          ctx.mock.timers.tick(19);
          assert.equal(resource.playStream.destroyed, false);
          ctx.mock.timers.tick(1);
          await pending;
          assert.equal(resource.playStream.destroyed, true);
          assert.equal(input.destroyed, true);
          assert.ok(stop.mock.calls.every((call) => call.arguments[0] === true));
          assert.equal(player.isPlaying, false);
        } finally {
          player.suspend();
        }
      },
    );
    await t.test(
      "two connection timeouts exhaust retries and notify the text channel once",
      async (ctx) => {
        ctx.mock.timers.enable({ apis: ["setTimeout"] });
        const player = new CorePlayer("live-timeout-limit", new Queue(), [], 20);
        let attempts = 0;
        const notices: string[] = [];
        player.onLiveUnavailable = (stationName) => {
          notices.push(stationName);
        };
        player.onLiveStream = async (_url, _current, _disconnected, attempt) => {
          attempts++;
          attempt.onResourceCreated();
          await new Promise<void>((_resolve, reject) => {
            attempt.signal.addEventListener("abort", () => reject(new Error("aborted")), {
              once: true,
            });
          });
        };
        const pending = player.playLive(
          LIVE_STATIONS.technobase.url,
          LIVE_STATIONS.technobase.name,
        );
        ctx.mock.timers.tick(20);
        await pending;
        assert.equal(attempts, 1);
        assert.equal(player.isLive, true);
        assert.equal(player.isPlaying, false);
        ctx.mock.timers.tick(3_000);
        await flush();
        assert.equal(attempts, 2);
        ctx.mock.timers.tick(20);
        await flush();
        assert.equal(player.isLive, false);
        assert.equal(player.isLoading, false);
        assert.equal(player.isPlaying, false);
        assert.deepEqual(notices, ["TechnoBase.FM"]);
        ctx.mock.timers.tick(60_000);
        await flush();
        assert.equal(attempts, 2);
        assert.equal(notices.length, 1);
      },
    );
    await t.test("registry and command expose only the four active stations", async () => {
      const { builder } = await import("../../discord/commands/live/builder");
      const option = builder.toJSON().options?.[0];
      assert.ok(option);
      assert.equal(option?.name, "station");
      assert.deepEqual(Object.keys(LIVE_STATIONS), [
        "technobase",
        "housetime",
        "hardbase",
        "trancebase",
      ]);
      assert.deepEqual(
        "choices" in option ? option.choices?.map((item) => item.value) : [],
        Object.keys(LIVE_STATIONS),
      );
    });

    await t.test(
      "/live technobase rejects users outside voice before creating a session",
      async () => {
        const { execute } = await import("../../discord/commands/live/command");
        const { getSession } = await import("../../core/manager");
        const replies: unknown[] = [];
        const interaction = {
          guildId: "no-voice",
          guild: { members: { cache: new Map([["listener", { voice: { channel: null } }]]) } },
          user: { id: "listener" },
          options: { getString: () => "technobase" },
          deferReply: async () => undefined,
          editReply: async (reply: unknown) => {
            replies.push(reply);
          },
        } as unknown as ChatInputCommandInteraction;
        await execute(interaction);
        assert.deepEqual(replies, ["Please join a voice channel first!"]);
        assert.equal(getSession("no-voice"), undefined);
      },
    );

    await t.test(
      "live clears the queue, disables queue controls, and stop restores normal mode",
      async () => {
        const queue = new Queue();
        queue.tracks = [
          {
            id: "old",
            providerId: "test",
            title: "Old track",
            url: "",
            thumbnailUrl: "",
            channelName: "",
            length: 10,
            loudness: null,
            playlistIdx: null,
            addedBy: "listener",
          },
        ];
        queue.loopMode = "queue";
        const player = new CorePlayer("live-player", queue, []);
        let resets = 0;
        let stops = 0;
        let transportSignal: AbortSignal | undefined;
        player.onResetAudio = () => {
          resets++;
        };
        player.onStop = () => {
          stops++;
        };
        player.onLiveStream = async (url, _current, _disconnected, attempt) => {
          assert.equal(url, LIVE_STATIONS.technobase.url);
          transportSignal = attempt.signal;
        };
        await player.playLive(LIVE_STATIONS.technobase.url, LIVE_STATIONS.technobase.name);
        assert.equal(player.isLive, true);
        assert.equal(player.isPlaying, true);
        assert.equal(player.isLoading, false);
        assert.equal(transportSignal?.aborted, false, "successful startup must keep HTTP alive");
        assert.equal(queue.tracks.length, 0);
        assert.equal(queue.currentIndex, 0);
        assert.equal(player.getState()?.track.title, "TechnoBase.FM");
        assert.equal(player.getState()?.track.thumbnail, LIVE_STATIONS.technobase.artworkUrl);
        assert.equal(player.getState()?.isLive, true);
        assert.equal(stops, 0, "switching to radio must preserve the voice session");
        assert.equal(resets, 1);
        await assert.rejects(player.skip("listener"), /Cannot skip a live stream\./);
        assert.equal(player.toggleLoop(), "off");
        assert.equal(player.pause(), false);
        assert.throws(() => player.enqueueTracks([], "listener"), /Stop the live stream/);
        const { nowPlayingPayload } = await import("../../discord/now-playing");
        const state = player.getState();
        assert.ok(state);
        const payload = nowPlayingPayload(state);
        assert.equal(
          payload.embeds[0].toJSON().thumbnail?.url,
          `https://dis.sashimi.zip/api/image-proxy/${Buffer.from(LIVE_STATIONS.technobase.artworkUrl).toString("base64url")}`,
        );
        assert.equal(payload.components[0].components.length, 1);
        const stopButton = payload.components[0].components[0].data;
        assert.equal("custom_id" in stopButton ? stopButton.custom_id : undefined, "player:stop");
        await player.stop("listener");
        assert.equal(transportSignal?.aborted, true, "stop must cancel the HTTP transport");
        assert.equal(player.isLive, false);
        assert.equal(player.getState(), null);
        assert.equal(stops, 1);
        assert.equal(player.toggleLoop(), "track");
      },
    );

    await t.test(
      "disconnect retries once after three seconds; stale callbacks and stop cannot reconnect",
      async (ctx) => {
        ctx.mock.timers.enable({ apis: ["setTimeout"] });
        const player = new CorePlayer("live-reconnect", new Queue(), []);
        let connections = 0;
        let disconnect: () => void = () => assert.fail("No stream handoff");
        player.onLiveStream = async (_url, _current, onDisconnect) => {
          connections++;
          disconnect = onDisconnect;
        };
        await player.playLive(LIVE_STATIONS.technobase.url, LIVE_STATIONS.technobase.name);
        const oldDisconnect = disconnect;
        disconnect();
        disconnect();
        assert.equal(player.isLoading, true);
        ctx.mock.timers.tick(2_999);
        assert.equal(connections, 1);
        ctx.mock.timers.tick(1);
        await Promise.resolve();
        assert.equal(connections, 2);
        oldDisconnect();
        ctx.mock.timers.tick(3_000);
        assert.equal(connections, 2);
        disconnect();
        await player.stop();
        ctx.mock.timers.tick(3_000);
        assert.equal(connections, 2);
        assert.equal(player.isLive, false);
      },
    );

    await t.test(
      "failed startup retries; suspend cancels reconnect and pending handoffs",
      async (ctx) => {
        ctx.mock.timers.enable({ apis: ["setTimeout"] });
        const player = new CorePlayer("live-failure", new Queue(), []);
        let attempts = 0;
        player.onLiveStream = async () => {
          attempts++;
          throw new Error("offline");
        };
        await player.playLive(LIVE_STATIONS.technobase.url, LIVE_STATIONS.technobase.name);
        assert.equal(player.isLoading, true);
        ctx.mock.timers.tick(3_000);
        await Promise.resolve();
        assert.equal(attempts, 2);
        player.suspend();
        ctx.mock.timers.tick(10_000);
        assert.equal(attempts, 2);
        let release: () => void = () => assert.fail("No pending handoff");
        let current = () => true;
        player.onLiveStream = async (_url, isCurrent) => {
          current = isCurrent;
          await new Promise<void>((resolve) => {
            release = resolve;
          });
        };
        const pending = player.playLive(
          LIVE_STATIONS.technobase.url,
          LIVE_STATIONS.technobase.name,
        );
        await player.stop();
        release();
        await pending;
        assert.equal(current(), false);
        assert.equal(player.isLive, false);
        assert.equal(player.isPlaying, false);
        await assert.rejects(
          player.playLive("http://localhost/private", "Other"),
          /Unknown live station/,
        );
      },
    );
  } finally {
    db.close();
    archiveDb.close();
    await rm(directory, { recursive: true, force: true });
  }
});
