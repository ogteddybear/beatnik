import { log } from "@/shared";
import type { Readable } from "node:stream";
import { SpotDl } from "spotdl-api";

import type {
  Provider,
  ProviderContext,
  ProviderPlaylist,
  ProviderTrack,
  ResolvedQuery,
} from "../provider";
import { SpotifyApiError } from "../spotify/errors";
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
  private readonly spotdl = new SpotDl(undefined, {
    clientId: process.env.SPOTIFY_CLIENT_ID,
    clientSecret: process.env.SPOTIFY_CLIENT_SECRET,
  });

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

  async getPlaylist(
    resolvedQuery: string,
    context?: ProviderContext,
  ): Promise<ProviderPlaylist | null> {
    const match = resolvedQuery.match(/^spotify:(album|playlist):([A-Za-z0-9]+)$/);
    if (!match) return null;

    const [, kind, id] = match;
    if (kind === "playlist" && context?.requestingUserId) {
      const { getValidSpotifyAccessToken } = await import("../spotify/tokens");
      const userId = context.requestingUserId;
      const token = await getValidSpotifyAccessToken(userId);
      if (token) {
        try {
          const playlist = await this.getUserPlaylist(id, userId);
          return {
            providerId: this.id,
            id,
            url: `https://open.spotify.com/playlist/${id}`,
            title: playlist.name,
            authorName: playlist.owner,
            tracks: await this.mapSpotifyTracks(playlist.tracks),
          };
        } catch (error) {
          if (!(error instanceof SpotifyApiError) || ![401, 403, 404].includes(error.status)) {
            this.logError(
              "Spotify user playlist is temporarily unavailable",
              new Error("Spotify API unavailable"),
            );
            return null;
          }
        }
      }
    }
    return this.getPublicPlaylist(kind, id);
  }

  private async getUserPlaylist(id: string, userId: string) {
    const { spotifyUserRequest } = await import("../spotify/user-api");
    interface Page {
      items?: { track?: SpotifyTrack | null; item?: SpotifyTrack | null; is_local?: boolean }[];
      next?: string | null;
    }
    const info = await spotifyUserRequest<{
      name?: string;
      owner?: { display_name?: string };
      tracks?: Page;
      items?: Page;
    }>(userId, `playlists/${id}`);
    let page = info.items ?? info.tracks;
    if (!page) throw new SpotifyApiError(403);
    const tracks: SpotifyTrack[] = [];
    const visited = new Set<string>();
    for (let count = 0; count < 200; count++) {
      for (const entry of page.items ?? []) {
        const track = entry.item ?? entry.track;
        if (
          !entry.is_local &&
          track?.id &&
          track.type === "track" &&
          typeof track.name === "string" &&
          Array.isArray(track.artists) &&
          track.artists.every((artist) => typeof artist.name === "string") &&
          Number.isFinite(track.duration_ms)
        )
          tracks.push(track);
      }
      if (!page.next)
        return {
          name: info.name ?? "Spotify playlist",
          owner: info.owner?.display_name ?? "Unknown",
          tracks,
        };
      const next: URL = new URL(page.next, "https://api.spotify.com/v1/");
      if (
        next.origin !== "https://api.spotify.com" ||
        !next.pathname.startsWith(`/v1/playlists/${id}/`) ||
        visited.has(next.toString())
      )
        throw new SpotifyApiError(502);
      visited.add(next.toString());
      page = await spotifyUserRequest<Page>(userId, next.toString());
    }
    throw new SpotifyApiError(413);
  }

  private async getPublicPlaylist(kind: string, id: string): Promise<ProviderPlaylist | null> {
    const controller = new AbortController();
    const timeoutError = new Error("Spotify playlist resolution timed out after 15s");
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const url = `https://open.spotify.com/${kind}/${id}`;
      const timeoutPromise = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(timeoutError);
        }, 15_000);
      });
      const songs = await Promise.race([
        this.spotdl.save(url, { args: ["--use-official-api"], signal: controller.signal }),
        timeoutPromise,
      ]);
      const spotifyTracks: SpotifyTrack[] = songs.map((song) => ({
        id: song.song_id,
        name: song.name,
        artists: song.artists.map((name) => ({ name })),
        duration_ms: song.duration * 1_000,
        type: "track",
      }));

      return {
        providerId: this.id,
        id,
        url,
        title:
          (kind === "album" ? songs[0]?.album_name : songs[0]?.list_name) ??
          `Spotify ${kind} ${id}`,
        authorName: kind === "album" ? (songs[0]?.album_artist ?? "Unknown") : "Unknown",
        tracks: await this.mapSpotifyTracks(spotifyTracks),
      };
    } catch (error) {
      if (error === timeoutError) {
        log({ component: "PROVIDER", name: this.id, level: "WARN", message: timeoutError.message });
        return null;
      }
      this.logError(`Could not resolve Spotify ${kind} ${id}`, error);
      return null;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async getStream(_uniqueId: string): Promise<Readable> {
    throw new Error(
      "SpotifyLinkResolver does not stream audio; resolved tracks must use the YouTube provider",
    );
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
