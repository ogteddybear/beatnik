import type { ProviderTrack } from "@/providers";

export function shuffleArray<T>(array: T[]) {
  const newArray = [...array];
  for (let i = newArray.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const temp = newArray[i];
    newArray[i] = newArray[j];
    newArray[j] = temp;
  }
  return newArray;
}

export interface QueuedTrack extends ProviderTrack {
  addedBy: string;
  addedByUsername?: string;
}

export type LoopMode = "off" | "track" | "queue";

export class Queue {
  tracks: QueuedTrack[] = [];
  currentIndex = 0;
  loopMode: LoopMode = "off";
  onChange?: () => void;

  toggleLoop(): LoopMode {
    this.loopMode = this.loopMode === "off" ? "track" : this.loopMode === "track" ? "queue" : "off";
    this.onChange?.();
    return this.loopMode;
  }

  advance(naturalFinish = true): boolean {
    if (naturalFinish && this.loopMode === "track" && this.nowPlaying) return true;
    this.currentIndex++;
    if (this.loopMode === "queue" && this.tracks.length && this.currentIndex >= this.tracks.length)
      this.currentIndex = 0;
    this.onChange?.();
    return !!this.nowPlaying;
  }

  upcoming(limit = 5): QueuedTrack[] {
    const after = this.tracks.slice(this.currentIndex + 1);
    return (
      this.loopMode === "queue" ? [...after, ...this.tracks.slice(0, this.currentIndex + 1)] : after
    ).slice(0, limit);
  }

  insert(track: QueuedTrack, start: number) {
    this.tracks.splice(start, 0, track);
    this.onChange?.();
  }

  insertMany(tracks: QueuedTrack[], start: number) {
    this.tracks.splice(start, 0, ...tracks);
    this.onChange?.();
  }

  remove(idx: number, notify = true) {
    const removed = this.tracks.splice(idx, 1);
    if (notify) this.onChange?.();
    return removed;
  }

  shuffle() {
    const before = this.tracks.slice(0, this.currentIndex + 1);
    const after = this.tracks.slice(this.currentIndex + 1);
    const shuffled = shuffleArray(after);
    this.tracks = [...before, ...shuffled];
    this.onChange?.();
  }

  getPage(pageNumber: number) {
    // return 10 tracks corresponding to the page number
    const zeroIndexPageNumber = pageNumber - 1;
    if (zeroIndexPageNumber > this.pages - 1) {
      return null;
    }
    const pagedTracks = [...this.tracks].slice(
      zeroIndexPageNumber * 10,
      zeroIndexPageNumber * 10 + 10,
    );
    return pagedTracks;
  }

  get pages() {
    return Math.ceil(this.tracks.length / 10);
  }

  get nowPlaying(): QueuedTrack | undefined {
    return this.tracks[this.currentIndex];
  }
}
