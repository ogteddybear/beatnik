import { log } from "@/shared";
import type { Readable } from "node:stream";

import type { Provider, ProviderPlaylist, ProviderTrack, ResolvedQuery } from "../provider";
import type { YoutubeProvider } from "../youtube";

const API_BASE = "https://api.spotify.com/v1/";
const API_ORIGIN = "https://api.spotify.com";
const ACCOUNTS_TOKEN_URL = "https://accounts.spotify.com/api/token";
const PROVIDER_ID = "spotify-link-resolver";
const DEFAULT_MARKET = "US";
const MAX_RATE_LIMIT_RETRIES = 3;
const TRACK_MAPPING_CONCURRENCY = 4;

type AccessTokenProvider = () => Promise<string>;

interface SpotifyArtist {
  name: string;
}

interface SpotifyTrack {
  id: string | null;
  name: string;
  duration_ms: number;
  type: string;
  artists: SpotifyArtist[];
}

interface SpotifyPage<T> {
  items: T[];
  next: string | null;
}

interface SpotifyAlbum {
  id: string;
  name: string;
  external_urls: { spotify: string };
  artists: SpotifyArtist[];
  tracks: SpotifyPage<SpotifyTrack>;
}

interface SpotifyPlaylist {
  id: string;
  name: string;
  external_urls: { spotify: string };
  owner: { display_name: string | null };
}

interface SpotifyPlaylistItem {
  item: SpotifyTrack | null;
}

interface SpotifyTokenResponse {
  access_token: string;
  expires_in: number;
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function createClientCredentialsTokenProvider(
  clientId: string,
  clientSecret: string,
): AccessTokenProvider {
  let cachedToken: { value: string; expiresAt: number } | null = null;
  let pendingToken: Promise<string> | null = null;

  const requestToken = async () => {
    const response = await fetch(ACCOUNTS_TOKEN_URL, {
      method: "POST",
      headers: {
        Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ grant_type: "client_credentials" }),
    });

    if (!response.ok) {
      throw new Error(`Spotify token request failed with status ${response.status}`);
    }

    const token = (await response.json()) as SpotifyTokenResponse;
    if (!token.access_token || !Number.isFinite(token.expires_in)) {
      throw new Error("Spotify token response was missing access_token or expires_in");
    }

    cachedToken = {
      value: token.access_token,
      expiresAt: Date.now() + Math.max(0, token.expires_in * 1_000 - 30_000),
    };
    return cachedToken.value;
  };

  return async () => {
    if (cachedToken && Date.now() < cachedToken.expiresAt) return cachedToken.value;
    if (pendingToken) return pendingToken;

    pendingToken = requestToken();
    try {
      return await pendingToken;
    } finally {
      pendingToken = null;
    }
  };
}

export class SpotifyLinkResolver implements Provider {
  readonly id = PROVIDER_ID;

  private constructor(
    private readonly youtubeProvider: YoutubeProvider,
    private readonly accessTokenProvider: AccessTokenProvider,
    private readonly market: string,
  ) {}

  static createIfConfigured(
    youtubeProvider: YoutubeProvider,
    userAccessTokenProvider?: AccessTokenProvider,
  ): SpotifyLinkResolver | null {
    const clientId = process.env.SPOTIFY_CLIENT_ID;
    const clientSecret = process.env.SPOTIFY_CLIENT_SECRET;
    const market = process.env.SPOTIFY_MARKET ?? DEFAULT_MARKET;

    if (!/^[A-Z]{2}$/.test(market)) {
      throw new Error("SPOTIFY_MARKET must be a two-letter uppercase country code");
    }
    if (Boolean(clientId) !== Boolean(clientSecret)) {
      throw new Error("SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET must be set together");
    }
    if (userAccessTokenProvider) {
      return new SpotifyLinkResolver(youtubeProvider, userAccessTokenProvider, market);
    }
    if (!clientId || !clientSecret) return null;

    return new SpotifyLinkResolver(
      youtubeProvider,
      createClientCredentialsTokenProvider(clientId, clientSecret),
      market,
    );
  }

  async resolve(input: string): Promise<ResolvedQuery | null> {
    let url: URL;
    try {
      url = new URL(input);
    } catch {
      return null;
    }

    if (
      url.protocol !== "https:" ||
      (url.hostname !== "open.spotify.com" && url.hostname !== "www.open.spotify.com")
    ) {
      return null;
    }

    const match = url.pathname.match(
      /^\/(?:intl-[a-z]{2}\/)?(track|album|playlist)\/([A-Za-z0-9]+)\/?$/i,
    );
    if (!match) return null;

    const [, kind, id] = match;
    if (kind.toLowerCase() === "track") {
      return { type: "search", resolvedQuery: `spotify:track:${id}` };
    }
    return {
      type: "playlist",
      resolvedQuery: `spotify:${kind.toLowerCase()}:${id}`,
    };
  }

  async search(resolvedQuery: string): Promise<ProviderTrack | null> {
    const id = this.parseResolvedQuery(resolvedQuery, "track");
    if (!id) return null;

    try {
      const track = await this.spotifyRequest<SpotifyTrack>(
        `tracks/${id}?market=${encodeURIComponent(this.market)}`,
      );
      return await this.mapTrackToYouTube(track);
    } catch (error) {
      this.logError(`Could not resolve Spotify track ${id}`, error);
      return null;
    }
  }

  async getTrack(resolvedQuery: string): Promise<ProviderTrack | null> {
    return this.search(resolvedQuery);
  }

  async getPlaylist(resolvedQuery: string): Promise<ProviderPlaylist | null> {
    const match = resolvedQuery.match(/^spotify:(album|playlist):([A-Za-z0-9]+)$/);
    if (!match) return null;

    const [, kind, id] = match;
    try {
      if (kind === "album") return await this.getAlbum(id);
      return await this.getSpotifyPlaylist(id);
    } catch (error) {
      this.logError(`Could not resolve Spotify ${kind} ${id}`, error);
      return null;
    }
  }

  async getStream(_uniqueId: string): Promise<Readable> {
    throw new Error(
      "SpotifyLinkResolver does not stream audio; resolved tracks must use the YouTube provider",
    );
  }

  private async getAlbum(id: string): Promise<ProviderPlaylist> {
    const album = await this.spotifyRequest<SpotifyAlbum>(
      `albums/${id}?market=${encodeURIComponent(this.market)}`,
    );
    const spotifyTracks = await this.collectPages(album.tracks);

    return {
      providerId: this.id,
      id: album.id,
      url: album.external_urls.spotify,
      title: album.name,
      authorName: album.artists.map((artist) => artist.name).join(", ") || "Unknown",
      tracks: await this.mapSpotifyTracks(spotifyTracks),
    };
  }

  private async getSpotifyPlaylist(id: string): Promise<ProviderPlaylist> {
    const market = encodeURIComponent(this.market);
    const playlist = await this.spotifyRequest<SpotifyPlaylist>(`playlists/${id}?market=${market}`);
    const firstPage = await this.spotifyRequest<SpotifyPage<SpotifyPlaylistItem>>(
      `playlists/${id}/items?market=${market}`,
    );
    const playlistItems = await this.collectPages(firstPage);
    const spotifyTracks = playlistItems
      .map(({ item }) => item)
      .filter((item): item is SpotifyTrack => item?.type === "track" && Boolean(item.id));

    return {
      providerId: this.id,
      id: playlist.id,
      url: playlist.external_urls.spotify,
      title: playlist.name,
      authorName: playlist.owner.display_name ?? "Unknown",
      tracks: await this.mapSpotifyTracks(spotifyTracks),
    };
  }

  private async collectPages<T>(firstPage: SpotifyPage<T>): Promise<T[]> {
    const items = [...firstPage.items];
    let next = firstPage.next;

    while (next) {
      const page: SpotifyPage<T> = await this.spotifyRequest<SpotifyPage<T>>(next);
      items.push(...page.items);
      next = page.next;
    }
    return items;
  }

  private async mapSpotifyTracks(tracks: SpotifyTrack[]): Promise<ProviderTrack[]> {
    const mapped: (ProviderTrack | null)[] = Array.from({ length: tracks.length }, () => null);
    let nextIndex = 0;

    const worker = async () => {
      while (nextIndex < tracks.length) {
        const index = nextIndex++;
        const track = tracks[index];
        try {
          const youtubeTrack = await this.mapTrackToYouTube(track);
          if (youtubeTrack) mapped[index] = { ...youtubeTrack, playlistIdx: index };
        } catch (error) {
          this.logError(`Skipping Spotify track ${track.id ?? track.name}`, error);
        }
      }
    };

    const workerCount = Math.min(TRACK_MAPPING_CONCURRENCY, tracks.length);
    await Promise.all(Array.from({ length: workerCount }, () => worker()));
    return mapped.filter((track): track is ProviderTrack => track !== null);
  }

  private async mapTrackToYouTube(track: SpotifyTrack): Promise<ProviderTrack | null> {
    const artistNames = track.artists.map((artist) => artist.name).join(" ");
    const youtubeTrack = await this.youtubeProvider.search(`${track.name} ${artistNames} audio`);
    if (!youtubeTrack) return null;

    const spotifySeconds = track.duration_ms / 1_000;
    const tolerance = Math.max(12, spotifySeconds * 0.08);
    // This avoids many wrong matches, but rejects some legitimate live, radio, and extended mixes.
    if (Math.abs(youtubeTrack.length - spotifySeconds) > tolerance) return null;

    return {
      ...youtubeTrack,
      providerId: this.youtubeProvider.id,
      playlistIdx: null,
    };
  }

  private parseResolvedQuery(resolvedQuery: string, kind: "track"): string | null {
    const match = resolvedQuery.match(new RegExp(`^spotify:${kind}:([A-Za-z0-9]+)$`));
    return match?.[1] ?? null;
  }

  private async spotifyRequest<T>(pathOrUrl: string): Promise<T> {
    const url = /^https?:\/\//i.test(pathOrUrl)
      ? new URL(pathOrUrl)
      : new URL(pathOrUrl.replace(/^\/+/, ""), API_BASE);
    if (url.origin !== API_ORIGIN) {
      throw new Error(`Refusing unexpected Spotify API origin: ${url.origin}`);
    }

    let rateLimitRetries = 0;
    while (true) {
      const accessToken = await this.accessTokenProvider();
      const response = await fetch(url, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });

      if (response.status === 429 && rateLimitRetries < MAX_RATE_LIMIT_RETRIES) {
        const retryAfterSeconds = Number(response.headers.get("Retry-After"));
        const baseDelay =
          Number.isFinite(retryAfterSeconds) && retryAfterSeconds >= 0
            ? retryAfterSeconds * 1_000
            : 1_000;
        await sleep(baseDelay * 2 ** rateLimitRetries);
        rateLimitRetries += 1;
        continue;
      }

      if (!response.ok) {
        throw new Error(`Spotify API request failed with status ${response.status}`);
      }
      return (await response.json()) as T;
    }
  }

  private logError(message: string, error: unknown): void {
    log({
      level: "ERROR",
      component: "PROVIDER",
      name: this.id,
      message: `${message}: ${error}`,
    });
  }
}
