import type { CorePlayer, PlayerState } from "@/core/player";
import assert from "node:assert/strict";
import { test } from "node:test";

import { NowPlayingPanel, NowPlayingPanels, nowPlayingPayload } from "./now-playing";

test("/live uses only its command reply when the automatic panel channel is the same", async () => {
  const state: PlayerState = {
    isLive: true,
    status: "playing",
    track: {
      id: "tb",
      title: "TechnoBase.FM",
      artist: "HandsUp",
      thumbnail: "",
      durationSeconds: 0,
    },
    progressSeconds: 0,
    progressPercent: 0,
    loopMode: "off",
    nextTracks: [],
  };
  let sends = 0;
  let edits = 0;
  const panels = new NowPlayingPanels(
    {
      id: "commands",
      async send() {
        sends++;
        return {
          id: "automatic",
          async edit() {
            return undefined;
          },
        };
      },
    },
    { getState: () => state } as CorePlayer,
  );
  await panels.prepareLiveReply("commands");
  await panels.refresh();
  panels.watchLiveReply({
    id: "reply",
    async edit() {
      edits++;
    },
  });
  await panels.refresh();
  assert.equal(
    sends,
    0,
    "a slash reply must not be duplicated by an automatic panel in the same channel",
  );
  assert.ok(edits);
  assert.equal(panels.isCurrentMessage("reply"), true);
  await panels.prepareLiveReply("other-channel");
  panels.watchLiveReply({
    id: "other-reply",
    async edit() {
      return undefined;
    },
  });
  await panels.refresh();
  assert.equal(sends, 1, "a separately configured Now Playing channel still receives its panel");
  assert.equal(panels.isCurrentMessage("reply"), false);
  assert.equal(panels.isCurrentMessage("automatic"), true);
  assert.equal(panels.isCurrentMessage("other-reply"), true);
  await panels.close();
  assert.equal(panels.isCurrentMessage("automatic"), false);
});

test("a seeded /live reply keeps service and songs updated and retains its final snapshot", async (ctx) => {
  ctx.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  const state: PlayerState = {
    isLive: true,
    liveService: "We aRe oNe",
    status: "playing",
    track: {
      id: "tb",
      title: "TechnoBase.FM",
      artist: "HandsUp",
      thumbnail: "",
      durationSeconds: 0,
    },
    progressSeconds: 0,
    progressPercent: 0,
    loopMode: "off",
    nextTracks: [],
    liveMetadata: { streamTitle: "First song", title: "First song" },
  };
  const edits: string[] = [];
  const panel = new NowPlayingPanel(null, { getState: () => state } as CorePlayer, {
    id: "command-reply",
    async edit(payload) {
      edits.push(JSON.stringify(payload));
    },
  });
  await panel.refresh();
  assert.equal(panel.isCurrentMessage("command-reply"), true);
  assert.match(edits[0], /We aRe oNe/);
  assert.match(edits[0], /TechnoBase.FM/);
  assert.match(edits[0], /First song/);
  state.liveMetadata = { streamTitle: "Second song", title: "Second song" };
  await panel.refresh();
  assert.equal(edits.length, 1);
  ctx.mock.timers.tick(60_000);
  await panel.refresh();
  assert.match(edits[1], /Second song/);
  await panel.close();
  assert.match(edits[2], /Broadcast ended/);
  assert.match(edits[2], /TechnoBase.FM/);
  assert.match(edits[2], /Second song/);
  assert.match(edits[2], /"components":\[\]/);
});

test("live panel immediately reflects playback and reconnect transitions, but throttles unchanged refreshes", async (ctx) => {
  ctx.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  const state: PlayerState = {
    isLive: true,
    status: "loading",
    track: {
      id: "technobase",
      title: "TechnoBase.FM",
      artist: "HandsUp",
      thumbnail: "",
      durationSeconds: 0,
    },
    progressSeconds: 0,
    progressPercent: 0,
    loopMode: "off",
    nextTracks: [],
  };
  let edits = 0;
  const panel = new NowPlayingPanel(
    {
      async send() {
        return {
          id: "live-panel",
          async edit() {
            edits++;
          },
        };
      },
    },
    { getState: () => state } as CorePlayer,
  );
  await panel.refresh();
  state.status = "playing";
  await panel.refresh();
  assert.equal(edits, 1, "Playing must immediately replace Connecting");
  state.liveMetadata = { streamTitle: "Artist - Track", title: "Track", artist: "Artist" };
  assert.match(nowPlayingPayload(state).embeds[0].toJSON().description ?? "", /Artist - Track/);
  await panel.refresh();
  assert.equal(edits, 1, "Metadata updates must not bypass the one-minute throttle");
  ctx.mock.timers.tick(59_999);
  await panel.refresh();
  assert.equal(edits, 1);
  ctx.mock.timers.tick(1);
  await panel.refresh();
  assert.equal(edits, 2, "Latest metadata can be displayed after one minute");
  state.status = "loading";
  await panel.refresh();
  assert.equal(edits, 3, "A reconnect must immediately replace Playing");
  await panel.close();
});

test("persistent player panel edits across tracks, replaces deleted messages and disables on close", async () => {
  const state: PlayerState = {
    status: "playing",
    track: {
      id: "one",
      title: "First",
      artist: "Artist",
      thumbnail: "https://example.com/image.jpg",
      durationSeconds: 60,
    },
    progressSeconds: 30,
    progressPercent: 50,
    loopMode: "off",
    nextTracks: [],
  };
  let sends = 0;
  let edits = 0;
  let deleted = false;
  const payloads: unknown[] = [];
  const channel = {
    async send(payload: unknown) {
      sends++;
      payloads.push(payload);
      return {
        id: `message-${sends}`,
        async edit(payload: unknown) {
          edits++;
          if (deleted) {
            deleted = false;
            throw { code: 10008 };
          }
          payloads.push(payload);
        },
      };
    },
  };
  const panel = new NowPlayingPanel(channel, { getState: () => state } as CorePlayer);
  await Promise.all([panel.refresh(), panel.refresh()]);
  assert.equal(sends, 1, "Concurrent refreshes must not send duplicate messages");
  assert.equal(edits, 1);
  assert.equal(panel.isCurrentMessage("message-1"), true);
  state.track.title = "Second";
  state.status = "paused";
  await panel.refresh();
  assert.equal(sends, 1, "New tracks edit the existing panel");
  const payload = nowPlayingPayload(state);
  assert.match(payload.embeds[0].toJSON().description ?? "", /0:30 \/ 1:00/);
  const [pause, skip] = payload.components[0].toJSON().components;
  assert("label" in pause);
  assert("custom_id" in skip);
  assert.equal(pause.label, "Resume");
  assert.equal(skip.custom_id, "player:skip");
  deleted = true;
  await panel.refresh();
  assert.equal(sends, 2);
  assert.equal(panel.isCurrentMessage("message-1"), false);
  await panel.close();
  assert.equal(panel.isCurrentMessage("message-2"), false);
  const last = payloads.at(-1) as { components: unknown[] };
  assert.deepEqual(last.components, []);
  await panel.refresh();
  assert.equal(sends, 2);
});
