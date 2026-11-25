import type { Provider, ProviderTrack } from "@/providers";
import { log } from "@/shared";
import type { Readable } from "node:stream";

import { logEvent } from "./db/guild-events";
import { guildStats } from "./db/guild-stats";
import type { Queue, QueuedTrack } from "./queue";
import { shuffleArray } from "./queue";
import {
  isUnplayableYouTubeStreamError,
  resolveQuery,
  resolveStream,
  resolveTrackLoudness,
} from "./resolvers";

export class CorePlayer {
  constructor(
    public readonly guildId: string,
    public readonly queue: Queue,
    private providers: Provider[],
  ) {}

  isPlaying = false;
  fromCache: boolean | null = null;

  onStream?: (track: ProviderTrack, stream: Readable) => void | Promise<void>;
  onQueueEnd?: () => void;
  onStop?: () => void;
  onError?: (track: ProviderTrack, err: Error) => void;

  private logPlayerEvent(
    userId: string | null,
    eventType: string,
    action: string,
    metadata?: Record<string, unknown>,
  ) {
    try {
      logEvent(this.guildId, userId, eventType, action, metadata);
    } catch (error) {
      console.error("Unable to record player event:", error);
    }
  }

  async enqueue(
    query: string,
    userId: string,
    willShuffle = false,
    playNext = false,
  ): Promise<QueuedTrack[]> {
    const { metadata, type } = await resolveQuery(query);
    let tracks: ProviderTrack[] = [];
    if (type === "playlist") {
      tracks = metadata?.tracks || [];
    } else if (metadata) {
      tracks = [metadata];
    }
    if (willShuffle) tracks = shuffleArray(tracks);
    // Explicit playNext inserts after the current track; otherwise preserve FIFO by appending.
    const basis = playNext ? this.queue.currentIndex + 1 : this.queue.tracks.length;
    const queuedTracks = tracks.map((track) => ({ ...track, addedBy: userId }));
    guildStats.recordRequests(
      this.guildId,
      userId,
      queuedTracks.map((track) => track.id),
    );
    return queuedTracks.map((queuedTrack, idx) => {
      this.queue.insert(queuedTrack, basis + idx);
      return queuedTrack;
    });
  }

  async play() {
    const track = this.queue.nowPlaying;
    if (!track) {
      // nothing left to play in the queue
      this.isPlaying = false;
      this.onQueueEnd?.();
      return;
    }
    try {
      const provider = this.providers.find((p) => p.id === track.providerId);
      if (!provider) throw new Error(`No provider found for ${track.providerId}`);

      const loudness = await resolveTrackLoudness(track, provider);
      const trackWithLoudness = { ...track, loudness };

      let streamResult: Awaited<ReturnType<typeof resolveStream>>;
      try {
        streamResult = await resolveStream(track.id, provider);
      } catch (err) {
        if (!isUnplayableYouTubeStreamError(err, provider)) throw err;
        log({
          level: "WARN",
          component: "CORE",
          name: "PLAYER",
          message: `Skipping unplayable track ${track.providerId}:${track.id}: ${err}`,
        });
        this.logPlayerEvent(track.addedBy, "player_error", "unplayable", {
          trackId: track.id,
          providerId: track.providerId,
        });
        this.isPlaying = false;
        await this.next();
        return;
      }
      const { stream, fromCache } = streamResult;
      this.isPlaying = true;
      this.fromCache = fromCache;
      const onStream = this.onStream;
      if (onStream) {
        await onStream(trackWithLoudness, stream);
        this.logPlayerEvent(track.addedBy, "player", "play", { trackId: track.id });
      }
      log({
        component: "CORE",
        name: "PLAYER",
        message: `Playing ${track.providerId}:${track.id} from ${fromCache ? "cache" : "provider"}`,
      });
    } catch (err) {
      this.isPlaying = false;
      this.logPlayerEvent(track.addedBy, "player_error", "play", {
        trackId: track.id,
        providerId: track.providerId,
        errorName: err instanceof Error ? err.name : "UnknownError",
      });
      this.onError?.(track, err instanceof Error ? err : new Error(String(err)));
      await this.next();
    }
  }

  async next() {
    this.queue.currentIndex++;
    await this.play();
  }

  async skip(userId: string, idx?: number) {
    const track = this.queue.nowPlaying;
    if (!track) return;
    this.logPlayerEvent(userId, "player", "skip", { trackId: track.id });
    if (idx === undefined) await this.next();
    else await this.jump(idx);
  }

  async jump(idx: number) {
    this.queue.currentIndex = idx;
    await this.play();
  }

  async stop(userId: string | null = null) {
    if (this.queue.tracks.length || this.isPlaying) {
      this.logPlayerEvent(userId, "player", "stop", {
        reason: userId ? "command" : "automatic",
      });
    }
    this.isPlaying = false;
    this.fromCache = null;
    this.queue.currentIndex = 0;
    this.queue.tracks = [];
    this.onStop?.();
  }
}
