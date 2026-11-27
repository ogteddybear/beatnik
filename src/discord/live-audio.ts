import type { CorePlayer } from "@/core/player";
import {
  type AudioPlayer,
  AudioPlayerStatus,
  type AudioResource,
  StreamType,
  createAudioResource,
  entersState,
} from "@discordjs/voice";

interface LiveAudio {
  audioPlayer: AudioPlayer;
  ready: () => Promise<unknown>;
  isDestroyed: () => boolean;
  setResource: (resource: AudioResource) => void;
  resetResource: (resource: AudioResource) => void;
}

/** Resource factory seam keeps timeout tests independent of FFmpeg and Discord. */
export function createLiveStreamHandler(
  audio: LiveAudio,
  createResource: (
    url: string,
    options: { inputType: StreamType; inlineVolume: boolean },
  ) => AudioResource = createAudioResource,
): NonNullable<CorePlayer["onLiveStream"]> {
  return async (url, isCurrent, disconnected, attempt) => {
    await audio.ready();
    if (audio.isDestroyed() || !isCurrent() || attempt.signal.aborted) return;
    // Arbitrary MP3 URL -> prism FFmpeg PCM -> inline volume -> Opus.
    const resource = createResource(url, {
      inputType: StreamType.Arbitrary,
      inlineVolume: true,
    });
    audio.setResource(resource);
    resource.playStream.once("error", disconnected);
    resource.playStream.once("end", disconnected);
    attempt.onResourceCreated();
    try {
      audio.audioPlayer.play(resource);
      await entersState(audio.audioPlayer, AudioPlayerStatus.Playing, attempt.signal);
    } catch (error) {
      audio.resetResource(resource);
      throw error;
    }
    if (!isCurrent() || audio.isDestroyed()) audio.resetResource(resource);
  };
}
