import type { Provider, ProviderTrack } from "@/providers";
import { log } from "@/shared";
import type { Readable } from "node:stream";

import { type EventOptions, logEvent } from "./db/guild-events";
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
  volume = 100;
  onVolume?: (percent: number) => void;

  onStream?: (track: ProviderTrack, stream: Readable) => void | Promise<void>;
  onQueueEnd?: () => void;
  onStop?: () => void;
  onError?: (track: ProviderTrack, err: Error) => void;

  private logPlayerEvent(options: Omit<EventOptions, "guildId">) {
    try {
      logEvent({ guildId: this.guildId, ...options });
    } catch (error) {
      console.error("Unable to record player event:", error);
    }
  }

  async enqueue(
    query: string,
    userId: string,
    willShuffle = false,
    playNext = false,
    username?: string,
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
    const queuedTracks = tracks.map((track) => ({
      ...track,
      addedBy: userId,
      addedByUsername: username,
    }));
    guildStats.recordRequests(this.guildId, userId, queuedTracks, username);
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
        streamResult = await resolveStream(this.guildId, track.id, provider);
      } catch (err) {
        if (!isUnplayableYouTubeStreamError(err, provider)) throw err;
        log({
          level: "WARN",
          component: "CORE",
          name: "PLAYER",
          message: `Skipping unplayable track ${track.providerId}:${track.id}: ${err}`,
        });
        this.logPlayerEvent({
          userId: track.addedBy,
          username: track.addedByUsername,
          eventType: "player_error",
          action: "unplayable",
          trackId: track.id,
          trackName: track.title,
          metadata: {
            providerId: track.providerId,
          },
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
        this.logPlayerEvent({
          userId: track.addedBy,
          username: track.addedByUsername,
          eventType: "player",
          action: "play",
          trackId: track.id,
          trackName: track.title,
          metadata: { providerId: track.providerId },
        });
      }
      log({
        component: "CORE",
        name: "PLAYER",
        message: `Playing ${track.providerId}:${track.id} from ${fromCache ? "cache" : "provider"}`,
      });
    } catch (err) {
      this.isPlaying = false;
      this.logPlayerEvent({
        userId: track.addedBy,
        username: track.addedByUsername,
        eventType: "player_error",
        action: "play",
        trackId: track.id,
        trackName: track.title,
        metadata: {
          providerId: track.providerId,
          errorName: err instanceof Error ? err.name : "UnknownError",
        },
      });
      this.onError?.(track, err instanceof Error ? err : new Error(String(err)));
      await this.next();
    }
  }

  async next() {
    this.queue.currentIndex++;
    await this.play();
  }

  async skip(userId: string, idx?: number, username?: string) {
    const track = this.queue.nowPlaying;
    if (!track) return;
    this.logPlayerEvent({
      userId,
      username,
      eventType: "player",
      action: "skip",
      trackId: track.id,
      trackName: track.title,
    });
    if (idx === undefined) await this.next();
    else await this.jump(idx);
  }

  async jump(idx: number) {
    this.queue.currentIndex = idx;
    await this.play();
  }

  async stop(userId: string | null = null, username?: string) {
    if (this.queue.tracks.length || this.isPlaying) {
      this.logPlayerEvent({
        userId,
        username,
        eventType: "player",
        action: "stop",
        metadata: {
          reason: userId ? "command" : "automatic",
        },
      });
    }
    this.isPlaying = false;
    this.fromCache = null;
    this.queue.currentIndex = 0;
    this.queue.tracks = [];
    this.onStop?.();
  }

  setVolume(percent: number, userId: string, username?: string) {
    if (!Number.isFinite(percent) || percent < 0 || percent > 200)
      throw new Error("Volume must be between 0 and 200.");
    const previous = this.volume;
    this.volume = percent;
    this.onVolume?.(percent);
    this.logPlayerEvent({
      userId,
      username,
      eventType: "volume",
      action: "set",
      metadata: { previous, percent },
    });
  }

  clear(userId: string, username?: string) {
    const removed = this.queue.tracks.splice(this.queue.currentIndex + 1).length;
    this.logPlayerEvent({
      userId,
      username,
      eventType: "player",
      action: "clear",
      metadata: { removedCount: removed },
    });
    return removed;
  }
}
