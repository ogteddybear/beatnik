import type { Provider, ProviderTrack } from "@/providers";
import { SpotifyPlaylistUnavailableError } from "@/providers/spotify/errors";
import { log } from "@/shared";
import type { Readable } from "node:stream";

import { type EventOptions, logEvent } from "./db/guild-events";
import { guildStats } from "./db/guild-stats";
import type { LoopMode, Queue, QueuedTrack } from "./queue";
import { shuffleArray } from "./queue";
import {
  isUnplayableStreamError,
  resolveQuery,
  resolveStream,
  resolveTrackLoudness,
} from "./resolvers";

export interface PlayerState {
  status: "loading" | "paused" | "playing";
  track: { id: string; title: string; artist: string; thumbnail: string; durationSeconds: number };
  progressSeconds: number;
  progressPercent: number;
  loopMode: LoopMode;
  nextTracks: PlayerState["track"][];
}

export class CorePlayer {
  constructor(
    public readonly guildId: string,
    public readonly queue: Queue,
    private providers: Provider[],
  ) {}

  isPlaying = false;
  isPaused = false;
  isLoading = false;
  private generation = 0;
  private startedAt = 0;
  private elapsed = 0;
  private failedTracks = new Set<number>();
  fromCache: boolean | null = null;
  volume = 100;
  onVolume?: (percent: number) => void;
  onPause?: (paused: boolean) => boolean;
  onPosition?: () => number;
  onStateChange?: () => void;
  onPersist?: () => void;
  restorePaused = false;

  private notifyStateChange() {
    this.onPersist?.();
    this.onStateChange?.();
  }

  onStream?: (
    track: ProviderTrack,
    stream: Readable,
    isCurrent: () => boolean,
    startPaused: boolean,
  ) => void | Promise<void>;
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
    const { metadata, type, provider } = await resolveQuery(query, true, {
      requestingUserId: userId,
    });
    let tracks: ProviderTrack[] = [];
    if (type === "playlist") {
      if (!metadata && provider.id === "spotify-link-resolver")
        throw new SpotifyPlaylistUnavailableError();
      tracks = metadata?.tracks || [];
    } else if (metadata) {
      tracks = [metadata];
    }
    return this.enqueueTracks(tracks, userId, willShuffle, playNext, username);
  }

  enqueueTracks(
    tracks: ProviderTrack[],
    userId: string,
    willShuffle = false,
    playNext = false,
    username?: string,
  ): QueuedTrack[] {
    if (willShuffle) tracks = shuffleArray(tracks);
    // Explicit playNext inserts after the current track; otherwise preserve FIFO by appending.
    const basis = playNext ? this.queue.currentIndex + 1 : this.queue.tracks.length;
    const queuedTracks = tracks.map((track) => ({
      ...track,
      addedBy: userId,
      addedByUsername: username,
    }));
    guildStats.recordRequests(this.guildId, userId, queuedTracks, username);
    this.queue.insertMany(queuedTracks, basis);
    return queuedTracks;
  }

  getState(): PlayerState | null {
    const track = this.queue.nowPlaying;
    if (!track || !this.isPlaying) return null;
    const view = (item: ProviderTrack) => ({
      id: item.id,
      title: item.title,
      artist: item.channelName,
      thumbnail: item.thumbnailUrl,
      durationSeconds: Math.max(0, item.length),
    });
    const progress = this.isLoading
      ? 0
      : (this.onPosition?.() ??
        this.elapsed + (this.isPaused ? 0 : (Date.now() - this.startedAt) / 1000));
    const duration = Math.max(0, track.length);
    const progressSeconds = Math.max(0, duration ? Math.min(duration, progress) : progress);
    return {
      status: this.isLoading ? "loading" : this.isPaused ? "paused" : "playing",
      track: view(track),
      progressSeconds,
      progressPercent: duration ? (progressSeconds / duration) * 100 : 0,
      loopMode: this.queue.loopMode,
      nextTracks: this.queue.upcoming().map(view),
    };
  }

  pause(userId?: string, username?: string): boolean {
    if (!this.isPlaying || this.isLoading || this.isPaused || !this.onPause?.(true)) return false;
    this.elapsed += (Date.now() - this.startedAt) / 1000;
    this.isPaused = true;
    this.logPlayerEvent({ userId, username, eventType: "player", action: "pause" });
    this.notifyStateChange();
    return true;
  }

  resume(userId?: string, username?: string): boolean {
    if (!this.isPlaying || this.isLoading || !this.isPaused || !this.onPause?.(false)) return false;
    this.startedAt = Date.now();
    this.isPaused = false;
    this.logPlayerEvent({ userId, username, eventType: "player", action: "resume" });
    this.notifyStateChange();
    return true;
  }

  toggleLoop(userId?: string, username?: string): LoopMode {
    const loopMode = this.queue.toggleLoop();
    this.logPlayerEvent({
      userId,
      username,
      eventType: "player",
      action: "loop",
      metadata: { loopMode },
    });
    this.notifyStateChange();
    return loopMode;
  }

  async play(attempted = new Set<number>()) {
    const generation = ++this.generation;
    const track = this.queue.nowPlaying;
    if (!track || attempted.has(this.queue.currentIndex)) {
      // nothing left to play in the queue
      this.isPlaying = false;
      this.isPaused = false;
      this.isLoading = false;
      this.onQueueEnd?.();
      return;
    }
    attempted.add(this.queue.currentIndex);
    this.isPlaying = true;
    this.isLoading = true;
    this.isPaused = false;
    this.elapsed = 0;
    this.notifyStateChange();
    let activeStream: Readable | undefined;
    try {
      const provider = this.providers.find((p) => p.id === track.providerId);
      if (!provider) throw new Error(`No provider found for ${track.providerId}`);

      const loudness = await resolveTrackLoudness(track, provider);
      if (generation !== this.generation) return;
      const trackWithLoudness = { ...track, loudness };

      let streamResult: Awaited<ReturnType<typeof resolveStream>>;
      try {
        streamResult = await resolveStream(this.guildId, track.id, provider);
      } catch (err) {
        if (generation !== this.generation) return;
        if (!isUnplayableStreamError(err, provider)) throw err;
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
        await this.next(false, attempted);
        return;
      }
      const { stream, fromCache } = streamResult;
      activeStream = stream;
      if (generation !== this.generation) {
        stream.destroy();
        return;
      }
      this.isPlaying = true;
      this.fromCache = fromCache;
      const onStream = this.onStream;
      if (onStream) {
        await onStream(
          trackWithLoudness,
          stream,
          () => generation === this.generation,
          this.restorePaused,
        );
        if (generation !== this.generation) {
          stream.destroy();
          return;
        }
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
      this.startedAt = Date.now();
      this.isLoading = false;
      this.isPaused = this.restorePaused;
      this.restorePaused = false;
      this.notifyStateChange();
      log({
        component: "CORE",
        name: "PLAYER",
        message: `Playing ${track.providerId}:${track.id} from ${fromCache ? "cache" : "provider"}`,
      });
    } catch (err) {
      activeStream?.destroy();
      if (generation !== this.generation) return;
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
      await this.next(false, attempted);
    }
  }

  async next(naturalFinish = false, attempted = new Set<number>()) {
    this.queue.advance(naturalFinish);
    await this.play(attempted);
  }

  async finish(failed = false) {
    if (failed) this.failedTracks.add(this.queue.currentIndex);
    else this.failedTracks.clear();
    await this.next(!failed, new Set(this.failedTracks));
  }

  async skip(userId: string, idx?: number, username?: string) {
    if (this.isLoading) return;
    const track = this.queue.nowPlaying;
    if (!track) return;
    this.failedTracks.clear();
    this.logPlayerEvent({
      userId,
      username,
      eventType: "player",
      action: "skip",
      trackId: track.id,
      trackName: track.title,
    });
    if (idx === undefined) await this.next(false);
    else await this.jump(idx);
  }

  async jump(idx: number) {
    this.failedTracks.clear();
    this.queue.currentIndex = idx;
    await this.play();
  }

  async remove(
    position: number,
    userId: string,
    username?: string,
  ): Promise<QueuedTrack | undefined> {
    if (!Number.isInteger(position) || position < 1 || position > this.queue.tracks.length) return;
    if (this.isLoading) throw new Error("The player is changing tracks. Please try again.");
    const index = position - 1;
    const currentIndex = this.queue.currentIndex;
    const [removed] = this.queue.remove(index, false);
    this.failedTracks.clear();
    this.logPlayerEvent({
      userId,
      username,
      eventType: "player",
      action: "remove",
      trackId: removed.id,
      trackName: removed.title,
      metadata: { position },
    });
    if (index < currentIndex) this.queue.currentIndex--;
    else if (index === currentIndex) {
      // Splicing already shifted the next track into this slot. Do not advance
      // again (or repeat the removed track when track-loop is enabled).
      if (this.queue.loopMode === "queue" && this.queue.currentIndex >= this.queue.tracks.length)
        this.queue.currentIndex = 0;
      await this.play();
      return removed;
    }
    this.notifyStateChange();
    return removed;
  }

  async stop(userId: string | null = null, username?: string) {
    this.generation++;
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
    this.isLoading = false;
    this.isPaused = false;
    this.fromCache = null;
    this.queue.currentIndex = 0;
    this.queue.tracks = [];
    this.queue.loopMode = "off";
    this.failedTracks.clear();
    this.restorePaused = false;
    this.onPersist?.();
    this.onStop?.();
  }

  suspend() {
    this.generation++;
    this.isPlaying = false;
    this.isLoading = false;
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
    this.notifyStateChange();
    return removed;
  }
}
