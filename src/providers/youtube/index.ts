import type { SabrPlaybackOptions } from "googlevideo/sabr-stream";
import { EnabledTrackTypes } from "googlevideo/utils";
import { spawn } from "node:child_process";
import Stream from "node:stream";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import type { Innertube } from "youtubei.js";

import type { Provider, ProviderTrack } from "../provider";
import type { YoutubeClientConfig } from "./client";
import { createInnertubeClient } from "./client";
import { getPlaylistInfo, getTrackInfo, resolve, search } from "./metadata";
import { createSabrStream } from "./stream";

export const PROVIDER_ID = "youtube";

const DEFAULT_OPTIONS: SabrPlaybackOptions = {
  enabledTrackTypes: EnabledTrackTypes.AUDIO_ONLY,
  stallDetectionMs: 5000,
};

function createYtDlpStream(id: string): Promise<Stream.Readable> {
  return new Promise((resolve, reject) => {
    const process = spawn(
      "yt-dlp",
      [
        `https://www.youtube.com/watch?v=${encodeURIComponent(id)}`,
        "-o",
        "-",
        "-f",
        "bestaudio",
        "--no-warnings",
        "--no-check-certificates",
        "--prefer-free-formats",
        "--extractor-args",
        "youtube:player_client=visionos",
        "--js-runtimes",
        "deno",
      ],
      { stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
    );

    const stream = new Stream.PassThrough();
    let started = false;
    let failed = false;
    let stderr = "";
    process.stderr.on("data", (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(-4_096);
    });
    // Wait for the process exit code before ending the stream, so a late failure
    // cannot turn a truncated download into a successful end-of-stream.
    process.stdout.pipe(stream, { end: false });
    process.stdout.once("data", () => {
      started = true;
      resolve(stream);
    });

    const fail = (error: Error) => {
      if (failed) return;
      failed = true;
      if (started) stream.destroy(error);
      else {
        stream.destroy();
        reject(error);
      }
    };
    process.on("error", (error) => fail(new Error(`Failed to start yt-dlp: ${error.message}`)));
    process.on("close", (code, signal) => {
      if (failed || process.killed) return;
      if (code !== 0) {
        fail(new Error(`yt-dlp exited with code ${code ?? signal}: ${stderr.trim()}`));
      } else if (!started) {
        fail(new Error("yt-dlp exited without producing an audio stream"));
      } else {
        stream.end();
      }
    });
    stream.on("close", () => {
      if (process.exitCode === null && !process.killed) process.kill();
    });
  });
}

export class YoutubeProvider implements Provider {
  readonly id = PROVIDER_ID;
  private constructor(private client: Innertube) {}

  // use this instead of new YoutubeProvider() to init/share client
  static async create(config: YoutubeClientConfig = {}): Promise<YoutubeProvider> {
    const client = await createInnertubeClient(config);
    return new YoutubeProvider(client);
  }

  resolve = (query: string) => resolve(this.client, query);
  getTrack = (id: string) => getTrackInfo(this.client, id);
  getPlaylist = (id: string) => getPlaylistInfo(this.client, id);
  search = (query: string) => search(this.client, query);
  getRelatedTrack = (last: ProviderTrack, excludedIds: string[]) =>
    search(this.client, `${last.title} ${last.channelName} related music`, excludedIds);
  getStream = async (id: string) => {
    try {
      const { audioStream } = await createSabrStream(this.client, id, DEFAULT_OPTIONS);
      return Stream.Readable.fromWeb(audioStream as NodeReadableStream);
    } catch (err) {
      try {
        return await createYtDlpStream(id);
      } catch (fallbackError) {
        throw new Error(
          `No compatible streams found for ${id}. SABR: ${err}; yt-dlp: ${fallbackError}`,
        );
      }
    }
  };
}
