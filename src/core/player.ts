import type { Provider, ProviderTrack } from "@/providers";
import { type LiveStation, findLiveStation } from "@/providers/live/stations";
import { SpotifyPlaylistUnavailableError } from "@/providers/spotify/errors";
import { log } from "@/shared";
import type { Readable } from "node:stream";

import { findAutoplayTrack } from "./autoplay";
import { isProviderEnabled } from "./db/bot-settings";
import { type EventOptions, logEvent } from "./db/guild-events";
import { getGuildPlayerSettings, updateGuildPlayerSettings } from "./db/guild-settings";
import { guildStats } from "./db/guild-stats";
import { publishGuildUpdate } from "./live-updates";
import type { LoopMode, Queue, QueuedTrack } from "./queue";
import { shuffleArray } from "./queue";
import {
  isUnplayableStreamError,
  resolveQuery,
  resolveStream,
  resolveTrackLoudness,
} from "./resolvers";

export interface PlayerState {
  isLive?: boolean;
  status: "loading" | "paused" | "playing";
  track: { id: string; title: string; artist: string; thumbnail: string; durationSeconds: number };
  progressSeconds: number;
  progressPercent: number;
  loopMode: LoopMode;
  nextTracks: PlayerState["track"][];
}

export interface LiveStreamAttempt {
  signal: AbortSignal;
  onResourceCreated: () => void;
}

export class CorePlayer {
  constructor(
    public readonly guildId: string,
    public readonly queue: Queue,
    private providers: Provider[],
    private readonly liveConnectionTimeoutMs = 10_000,
  ) {
    this.volume = getGuildPlayerSettings(guildId).volume;
  }

  isPlaying = false;
  isPaused = false;
  isLoading = false;
  isLive = false;
  private liveStation?: LiveStation;
  private liveReconnectTimer?: ReturnType<typeof setTimeout>;
  private liveAttempt?: AbortController;
  private liveAttempts = 0;
  onResetAudio?: () => void;
  onLiveUnavailable?: (stationName: string) => void;
  onLiveStream?: (
    url: string,
    isCurrent: () => boolean,
    disconnected: () => void,
    attempt: LiveStreamAttempt,
  ) => Promise<void>;
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
    publishGuildUpdate(this.guildId);
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
    if (this.isLive) throw new Error("Stop the live stream with /stop before adding tracks.");
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
    if (this.isLive && this.liveStation) {
      return {
        isLive: true,
        status: this.isLoading ? "loading" : "playing",
        track: {
          id: this.liveStation.url,
          title: this.liveStation.name,
          artist: this.liveStation.genre,
          thumbnail: "",
          durationSeconds: 0,
        },
        progressSeconds: 0,
        progressPercent: 0,
        loopMode: "off",
        nextTracks: [],
      };
    }
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
    if (this.isLive) return false;
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
    if (this.isLive) return this.queue.loopMode;
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
    if (this.isLive) throw new Error("Stop the live stream with /stop before playing tracks.");
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
      if (!isProviderEnabled(provider.id))
        throw new Error("This provider is disabled by the bot owner.");

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
          metadata: {
            providerId: track.providerId,
            artist: track.channelName,
            durationSeconds: track.length,
          },
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
    await this.advance(naturalFinish, attempted);
  }

  async advance(naturalFinish = false, attempted = new Set<number>()) {
    if (this.isLive) throw new Error("Cannot skip a live stream.");
    const last = this.queue.nowPlaying;
    this.queue.advance(naturalFinish);
    // Only successful natural completion starts radio; failures/removals/stops
    // never recursively generate more tracks.
    if (
      !this.queue.nowPlaying &&
      last &&
      naturalFinish &&
      getGuildPlayerSettings(this.guildId).autoplay_enabled
    ) {
      const generation = ++this.generation;
      this.isLoading = true;
      const candidate = await findAutoplayTrack(last, this.providers, this.queue.tracks.slice(-50));
      if (generation !== this.generation) return;
      this.isLoading = false;
      if (
        !this.queue.nowPlaying &&
        candidate &&
        getGuildPlayerSettings(this.guildId).autoplay_enabled &&
        !this.queue.tracks
          .slice(-50)
          .some((track) => track.providerId === candidate.providerId && track.id === candidate.id)
      ) {
        this.queue.insertMany(
          [{ ...candidate, addedBy: last.addedBy, addedByUsername: last.addedByUsername }],
          this.queue.tracks.length,
        );
        this.logPlayerEvent({
          eventType: "player",
          action: "autoplay",
          trackId: candidate.id,
          trackName: candidate.title,
          metadata: { providerId: candidate.providerId, seedTrackId: last.id },
        });
      }
    }
    await this.play(attempted);
  }

  async finish(failed = false) {
    if (this.isLive) {
      this.reconnectLive();
      return;
    }
    if (failed) this.failedTracks.add(this.queue.currentIndex);
    else this.failedTracks.clear();
    await this.next(!failed, new Set(this.failedTracks));
  }

  async skip(userId: string, idx?: number, username?: string) {
    if (this.isLive) throw new Error("Cannot skip a live stream.");
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
    if (this.isLive) throw new Error("Cannot skip a live stream.");
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

  /** Switch audio without invoking onStop, which tears down the voice session. */
  async playLive(url: string, stationName: string) {
    const station = findLiveStation(url);
    if (!station || station.name !== stationName) throw new Error("Unknown live station.");
    if (!this.onLiveStream) throw new Error("No voice session available for live playback.");
    this.generation++;
    this.clearLive();
    this.isPlaying = false;
    this.isLoading = true;
    this.onResetAudio?.();
    this.queue.tracks = [];
    this.queue.currentIndex = 0;
    this.queue.loopMode = "off";
    this.failedTracks.clear();
    this.restorePaused = false;
    this.isPaused = false;
    this.fromCache = null;
    this.liveStation = station;
    this.isLive = true;
    this.notifyStateChange();
    await this.connectLive();
  }

  private async connectLive() {
    const station = this.liveStation;
    if (!this.isLive || !station) return;
    const generation = ++this.generation;
    const isCurrent = () => this.isLive && generation === this.generation;
    const controller = new AbortController();
    this.liveAttempt = controller;
    this.liveAttempts++;
    this.isPlaying = false;
    this.isLoading = true;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let onAbort: () => void = () => undefined;
    const cancelled = new Promise<never>((_resolve, reject) => {
      onAbort = () => {
        if (timeout) clearTimeout(timeout);
        reject(new Error("Live connection timed out or was cancelled."));
      };
      controller.signal.addEventListener("abort", onAbort, { once: true });
    });
    try {
      const onLiveStream = this.onLiveStream;
      if (!onLiveStream) throw new Error("No voice session available for live playback.");
      await Promise.race([
        cancelled,
        onLiveStream(
          station.url,
          isCurrent,
          () => {
            if (isCurrent()) this.reconnectLive();
          },
          {
            signal: controller.signal,
            onResourceCreated: () => {
              if (!isCurrent() || controller.signal.aborted || timeout) return;
              timeout = setTimeout(() => controller.abort(), this.liveConnectionTimeoutMs);
              timeout.unref();
            },
          },
        ),
      ]);
      if (!isCurrent()) return;
      this.liveAttempts = 0;
      this.isPlaying = true;
      this.isLoading = false;
      this.notifyStateChange();
    } catch (error) {
      if (isCurrent()) {
        log({
          level: "WARN",
          component: "CORE",
          name: "PLAYER",
          message: `Guild ${this.guildId}: ${station.name} connection attempt ${this.liveAttempts}/2 failed: ${error instanceof Error ? error.message : "Unknown error"}`,
        });
        this.reconnectLive();
      }
    } finally {
      if (timeout) clearTimeout(timeout);
      controller.signal.removeEventListener("abort", onAbort);
      controller.abort();
      if (this.liveAttempt === controller) this.liveAttempt = undefined;
    }
  }

  private reconnectLive() {
    if (!this.isLive || this.liveReconnectTimer) return;
    if (this.liveAttempts >= 2) {
      const stationName = this.liveStation?.name;
      void this.stop();
      if (stationName) this.onLiveUnavailable?.(stationName);
      return;
    }
    // Invalidate callbacks from the failed resource before stopping it.
    this.generation++;
    this.liveAttempt?.abort();
    this.isPlaying = false;
    this.isLoading = true;
    this.onResetAudio?.();
    this.liveReconnectTimer = setTimeout(() => {
      this.liveReconnectTimer = undefined;
      void this.connectLive();
    }, 3_000);
    this.liveReconnectTimer.unref();
    this.notifyStateChange();
  }

  private clearLive() {
    this.liveAttempt?.abort();
    this.liveAttempt = undefined;
    this.liveAttempts = 0;
    if (this.liveReconnectTimer) clearTimeout(this.liveReconnectTimer);
    this.liveReconnectTimer = undefined;
    this.isLive = false;
    this.liveStation = undefined;
  }

  async stop(userId: string | null = null, username?: string) {
    this.generation++;
    this.clearLive();
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
    this.onResetAudio?.();
    this.onPersist?.();
    this.onStop?.();
    publishGuildUpdate(this.guildId);
  }

  suspend() {
    this.generation++;
    this.clearLive();
    this.isPlaying = false;
    this.isLoading = false;
    this.onResetAudio?.();
  }

  setVolume(percent: number, userId: string, username?: string) {
    if (!Number.isInteger(percent) || percent < 0 || percent > 200)
      throw new Error("Volume must be between 0 and 200.");
    updateGuildPlayerSettings(this.guildId, { volume: percent });
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
    this.notifyStateChange();
  }

  reorder(from: number, to: number, userId: string, username?: string) {
    if (
      !Number.isInteger(from) ||
      !Number.isInteger(to) ||
      from < 1 ||
      to < 1 ||
      from > this.queue.tracks.length ||
      to > this.queue.tracks.length
    )
      throw new Error("Invalid queue position.");
    if (this.isLoading) throw new Error("The player is changing tracks. Please try again.");
    const current = this.queue.nowPlaying;
    const [track] = this.queue.tracks.splice(from - 1, 1);
    this.queue.tracks.splice(to - 1, 0, track);
    if (current) this.queue.currentIndex = this.queue.tracks.indexOf(current);
    this.failedTracks.clear();
    this.logPlayerEvent({
      userId,
      username,
      eventType: "player",
      action: "reorder",
      trackId: track.id,
      trackName: track.title,
      metadata: { from, to },
    });
    this.notifyStateChange();
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
