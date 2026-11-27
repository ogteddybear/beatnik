import { IcecastMetadataReader } from "icecast-metadata-js";
import { Readable } from "node:stream";

export interface LiveMetadata {
  streamTitle: string;
  title: string;
  artist?: string;
}

export function parseLiveMetadata(value: string): LiveMetadata | null {
  const streamTitle = Array.from(value.slice(0, 1024), (character) => {
    const code = character.charCodeAt(0);
    return code < 32 || code === 127 ? " " : character;
  })
    .join("")
    .trim()
    .slice(0, 512);
  if (!streamTitle) return null;
  const split = streamTitle.indexOf(" - ");
  const artist = split > 0 ? streamTitle.slice(0, split).trim() : "";
  const title = split > 0 ? streamTitle.slice(split + 3).trim() : "";
  return artist && title ? { streamTitle, artist, title } : { streamTitle, title: streamTitle };
}

/** Pull-based parsing preserves backpressure; only audio bytes reach FFmpeg. */
export function stripIcyMetadata(
  source: Readable,
  intervalHeader: string | null,
  onMetadata?: (metadata: LiveMetadata | null) => void,
): Readable {
  const interval = Number(intervalHeader);
  if (!Number.isSafeInteger(interval) || interval <= 0 || interval > 16 * 1024 * 1024)
    return source;
  const reader = new IcecastMetadataReader({
    icyMetaInt: interval,
    icyDetectionTimeout: 0,
    metadataTypes: ["icy"],
  });
  const audio = Readable.from(
    (async function* () {
      for await (const chunk of source) {
        for (const result of reader.iterator(chunk)) {
          if (result.metadata && Object.hasOwn(result.metadata, "StreamTitle")) {
            onMetadata?.(parseLiveMetadata(result.metadata.StreamTitle));
          }
          if (result.stream?.length) yield result.stream;
        }
      }
    })(),
    { objectMode: false },
  );
  const onError = (error: Error) => audio.destroy(error);
  source.on("error", onError);
  audio.on("error", () => undefined);
  audio.once("close", () => {
    source.off("error", onError);
    source.destroy();
  });
  return audio;
}
