import SoundCloud, { type Track } from "@zibot/scdl";
import { Readable } from "node:stream";

import type { Provider, ProviderPlaylist, ProviderTrack, ResolvedQuery } from "../provider";
import { SoundCloudStreamUnavailableError } from "./errors";

const PROVIDER_ID = "soundcloud";

export class SoundCloudProvider implements Provider {
  readonly id = PROVIDER_ID;
  private readonly sc = new SoundCloud();
  getClientIdStatus() {
    return this.sc.clientId ? "Client ID loaded (validity not probed)" : "No Client ID loaded";
  }

  async resolve(query: string): Promise<ResolvedQuery | null> {
    let url: URL;
    try {
      url = new URL(query);
    } catch {
      return null;
    }

    if (
      url.protocol !== "https:" ||
      (url.hostname !== "soundcloud.com" && !url.hostname.endsWith(".soundcloud.com"))
    ) {
      return null;
    }

    const pathSegments = url.pathname.split("/").filter(Boolean);
    const isPlaylist = pathSegments.length === 3 && pathSegments[1] === "sets";
    const isTrack = pathSegments.length === 2;
    if (!isPlaylist && !isTrack) return null;

    const id = Buffer.from(url.toString()).toString("base64url");
    return {
      type: isPlaylist ? "playlist" : "track",
      resolvedQuery: id,
    };
  }

  async search(query: string): Promise<ProviderTrack | null> {
    try {
      const results = await this.sc.search({ query, type: "tracks", limit: 1 });
      const track = results.find((result): result is Track => result.kind === "track");
      return track ? this.mapTrack(track) : null;
    } catch {
      return null;
    }
  }

  async getTrack(resolvedQuery: string): Promise<ProviderTrack | null> {
    try {
      const url = Buffer.from(resolvedQuery, "base64url").toString("utf-8");
      const track = await this.sc.getTrackDetails(url);
      return this.mapTrack(track);
    } catch {
      return null;
    }
  }

  async getPlaylist(resolvedQuery: string): Promise<ProviderPlaylist | null> {
    try {
      const url = Buffer.from(resolvedQuery, "base64url").toString("utf-8");
      const playlist = await this.sc.getPlaylistDetails(url);
      return {
        providerId: this.id,
        id: Buffer.from(playlist.permalink_url).toString("base64url"),
        url: playlist.permalink_url,
        title: playlist.title,
        authorName: playlist.user.username,
        tracks: playlist.tracks.map((track, index) => this.mapTrack(track, index)),
      };
    } catch {
      return null;
    }
  }

  async getStream(id: string): Promise<Readable> {
    const url = Buffer.from(id, "base64url").toString("utf-8");
    try {
      const stream = await this.sc.downloadTrack(url);
      // scdl can return null after swallowing a download failure.
      if (!(stream instanceof Readable)) throw new SoundCloudStreamUnavailableError();
      return stream;
    } catch {
      throw new SoundCloudStreamUnavailableError();
    }
  }

  private mapTrack(track: Track, playlistIdx: number | null = null): ProviderTrack {
    return {
      providerId: this.id,
      id: Buffer.from(track.permalink_url).toString("base64url"),
      url: track.permalink_url,
      title: track.title,
      thumbnailUrl: track.artwork_url ?? track.user.avatar_url,
      channelName: track.user.username,
      length: Math.round(track.duration / 1_000),
      loudness: null,
      playlistIdx,
    };
  }
}
