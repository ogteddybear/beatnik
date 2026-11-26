export const SPOTIFY_LINK_MESSAGE =
  "🔗 Link your Spotify account: https://dis.sashimi.zip/auth/spotify";
export class SpotifyApiError extends Error {
  constructor(public readonly status: number) {
    super(`Spotify request unavailable (${status})`);
  }
}
export class SpotifyPlaylistUnavailableError extends Error {
  constructor() {
    super(
      "Spotify playlist unavailable. It may be private; run /spotify link to authorize your account.",
    );
  }
}
