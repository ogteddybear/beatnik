import type { Provider, ProviderTrack } from "@/providers";
import { log } from "@/shared";
import type { Readable } from "node:stream";

import type { Queue, QueuedTrack } from "./queue";
import { shuffleArray } from "./queue";
import { resolveQuery, resolveStream, resolveTrackLoudness } from "./resolvers";

export class CorePlayer {
  constructor(
    public readonly queue: Queue,
    private providers: Provider[],
  ) {}

  isPlaying = false;
  fromCache: boolean | null = null;

  onStream?: (track: ProviderTrack, stream: Readable) => void;
  onQueueEnd?: () => void;
  onStop?: () => void;
  onError?: (track: ProviderTrack, err: Error) => void;

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
    return tracks.map((t, idx) => {
      const queuedTrack = { ...t, addedBy: userId };
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

      const { stream, fromCache } = await resolveStream(track.id, provider);
      this.isPlaying = true;
      this.fromCache = fromCache;
      this.onStream?.(trackWithLoudness, stream);
      log({
        component: "CORE",
        name: "PLAYER",
        message: `Playing ${track.providerId}:${track.id} from ${fromCache ? "cache" : "provider"}`,
      });
    } catch (err) {
      this.isPlaying = false;
      this.onError?.(track, err instanceof Error ? err : new Error(String(err)));
      await this.next();
    }
  }

  async next() {
    this.queue.currentIndex++;
    await this.play();
  }

  async jump(idx: number) {
    this.queue.currentIndex = idx;
    await this.play();
  }

  async stop() {
    this.isPlaying = false;
    this.fromCache = null;
    this.queue.currentIndex = 0;
    this.queue.tracks = [];
    this.onStop?.();
  }
}
