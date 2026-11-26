import { resolveQuery } from "./resolvers";

export function supportedTrackUrl(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 2048) return false;
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      !url.port &&
      [
        "youtube.com",
        "www.youtube.com",
        "m.youtube.com",
        "music.youtube.com",
        "youtu.be",
        "soundcloud.com",
        "www.soundcloud.com",
        "open.spotify.com",
      ].includes(url.hostname)
    );
  } catch {
    return false;
  }
}
export async function resolveCustomPlaylistTrack(url: string) {
  if (!supportedTrackUrl(url)) return null;
  const result = await resolveQuery(url, false);
  if (result.type !== "track") return null;
  return result.provider.getTrack(result.resolvedQuery);
}
