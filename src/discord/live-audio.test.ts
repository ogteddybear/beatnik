import {
  type AudioResource,
  NoSubscriberBehavior,
  createAudioPlayer,
  createAudioResource,
} from "@discordjs/voice";
import ffmpeg from "ffmpeg-static";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { Readable } from "node:stream";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import { LIVE_STATIONS } from "../providers/live/stations";
import { createLiveStreamHandler } from "./live-audio";

test("real FFmpeg sustains playback from Node-owned MP3 bytes and tears down the source", async () => {
  assert.ok(ffmpeg);
  const args = [
    "-hide_banner",
    "-loglevel",
    "error",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=440:sample_rate=48000",
    "-t",
    "0.25",
    "-f",
    "mp3",
    "pipe:1",
  ];
  // Match prism's fallback when ffmpeg-static's binary is absent locally.
  let fixture = spawnSync(ffmpeg, args, { timeout: 10_000 });
  if (fixture.error) fixture = spawnSync("ffmpeg", args, { timeout: 10_000 });
  assert.equal(
    fixture.status,
    0,
    fixture.error?.message ?? fixture.stderr?.toString() ?? "FFmpeg failed",
  );
  assert.ok(fixture.stdout.length);
  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(), 10_000);
  const input = Readable.from(
    (async function* () {
      while (!controller.signal.aborted) {
        yield fixture.stdout;
        await delay(50, undefined, { signal: controller.signal });
      }
    })(),
  );
  const audioPlayer = createAudioPlayer({
    behaviors: { noSubscriber: NoSubscriberBehavior.Play },
  });
  let resource: AudioResource | undefined;
  let disconnects = 0;
  const handler = createLiveStreamHandler(
    {
      audioPlayer,
      ready: async () => undefined,
      isDestroyed: () => false,
      setResource: (value) => {
        resource = value;
      },
      resetResource: () => {
        audioPlayer.stop(true);
      },
    },
    createAudioResource,
    async () => ({
      url: "http://listener1.mp3.tb-group.fm/tb.mp3",
      stream: input,
    }),
  );
  try {
    await handler(
      LIVE_STATIONS.technobase.url,
      () => !controller.signal.aborted,
      () => {
        disconnects++;
      },
      {
        signal: controller.signal,
        onResourceCreated: () => undefined,
      },
    );
    await delay(500);
    assert.equal(audioPlayer.state.status, "playing");
    assert.ok(resource && resource.playbackDuration >= 200);
    assert.equal(disconnects, 0);
  } finally {
    clearTimeout(deadline);
    audioPlayer.stop(true);
    controller.abort();
    input.destroy();
    resource?.playStream.destroy();
  }
  assert.equal(input.destroyed, true);
});
