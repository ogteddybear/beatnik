import { EmbedBuilder, escapeMarkdown } from "discord.js";
import lyricsFinder from "lyrics-finder";

const cache = new Map<string, { text: string; expires: number }>();
export async function findLyrics(
  artist: string,
  title: string,
  finder = lyricsFinder,
  timeoutMs = 8000,
) {
  const key = `${artist}\0${title}`;
  const saved = cache.get(key);
  if (saved && saved.expires > Date.now()) return saved.text;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const text = await Promise.race([
      finder(artist.slice(0, 250), title.slice(0, 250)),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("Lyrics timeout")), timeoutMs);
      }),
    ]);
    if (text) {
      const oldest = cache.keys().next().value;
      if (cache.size >= 100 && oldest !== undefined) cache.delete(oldest);
      cache.set(key, { text, expires: Date.now() + 10 * 60_000 });
    }
    return text;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function lyricsEmbed(title: string, artist: string, lyrics: string) {
  const safe = escapeMarkdown(lyrics || "No lyrics found for this track.");
  const description = safe.length > 4096 ? `${safe.slice(0, 4000)}\n\n…Lyrics truncated.` : safe;
  return new EmbedBuilder()
    .setColor("#0a203b")
    .setTitle(title.slice(0, 256))
    .setAuthor({ name: (artist || "Unknown artist").slice(0, 256) })
    .setDescription(description);
}
