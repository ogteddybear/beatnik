import type { CorePlayer } from "@/core/player";
import { openLiveStream } from "@/providers/live/resolve-url";
import {
  type AudioPlayer,
  AudioPlayerStatus,
  type AudioResource,
  StreamType,
  createAudioResource,
  entersState,
} from "@discordjs/voice";
import type { Readable } from "node:stream";

interface LiveAudio {
  audioPlayer: AudioPlayer;
  ready: () => Promise<unknown>;
  isDestroyed: () => boolean;
  setResource: (resource: AudioResource) => void;
  resetResource: (resource: AudioResource) => void;
  onStage?: (stage: "voice" | "redirect" | "buffering" | "playing") => void;
}

/** Resource factory seam keeps timeout tests independent of FFmpeg and Discord. */
export function createLiveStreamHandler(
  audio: LiveAudio,
  createResource: (
    input: Readable,
    options: { inputType: StreamType; inlineVolume: boolean },
  ) => AudioResource = createAudioResource,
  openStream = openLiveStream,
): NonNullable<CorePlayer["onLiveStream"]> {
  return async (url, isCurrent, disconnected, attempt) => {
    audio.onStage?.("voice");
    await audio.ready();
    if (audio.isDestroyed() || !isCurrent() || attempt.signal.aborted) return;
    audio.onStage?.("redirect");
    const { stream: input } = await openStream(url, { signal: attempt.signal });
    if (audio.isDestroyed() || !isCurrent() || attempt.signal.aborted) {
      input.destroy();
      return;
    }
    let resource: AudioResource | undefined;
    try {
      // Node MP3 bytes -> FFmpeg stdin/PCM -> inline volume -> Opus.
      // Direct FFmpeg HTTP input crashes with SIGSEGV in the Fly image.
      resource = createResource(input, {
        inputType: StreamType.Arbitrary,
        inlineVolume: true,
      });
      audio.setResource(resource);
      resource.playStream.once("error", disconnected);
      resource.playStream.once("end", disconnected);
      attempt.onResourceCreated();
      audio.onStage?.("buffering");
      audio.audioPlayer.play(resource);
      await entersState(audio.audioPlayer, AudioPlayerStatus.Playing, attempt.signal);
    } catch (error) {
      input.destroy();
      if (resource) audio.resetResource(resource);
      throw error;
    }
    if (!isCurrent() || audio.isDestroyed()) audio.resetResource(resource);
    else audio.onStage?.("playing");
  };
}
