import type { CorePlayer, PlayerState } from "@/core/player";
import assert from "node:assert/strict";
import { test } from "node:test";

import { NowPlayingPanel, nowPlayingPayload } from "./now-playing";

test("live panel immediately reflects playback and reconnect transitions, but throttles unchanged refreshes", async () => {
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
  await panel.refresh();
  assert.equal(edits, 1, "Unchanged live refreshes must stay throttled");
  state.status = "loading";
  await panel.refresh();
  assert.equal(edits, 2, "A reconnect must immediately replace Playing");
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
