import { setSessionChannels } from "@/core/manager";
import type { CorePlayer } from "@/core/player";
import type { TextBasedChannel, VoiceBasedChannel } from "discord.js";

import { configuredTextChannel } from "./onboarding";
import { VoiceSession } from "./voice";

const voiceSessions = new Map<string, VoiceSession>();
export function getVoiceSession(guildId: string) {
  return voiceSessions.get(guildId);
}

export function getOrCreateVoiceSession(
  voiceChannel: VoiceBasedChannel,
  textChannel: TextBasedChannel | null,
  corePlayer: CorePlayer,
  actor?: { userId: string; username: string },
): VoiceSession {
  const { guildId } = voiceChannel;
  let session = voiceSessions.get(guildId);
  if (!session) {
    textChannel = configuredTextChannel(voiceChannel.guild) ?? textChannel;
    setSessionChannels(guildId, voiceChannel.id, textChannel?.id ?? null);
    session = new VoiceSession(voiceChannel, textChannel, corePlayer, actor);
    voiceSessions.set(guildId, session);
  }
  return session;
}

export function destroyAllVoiceSessions() {
  for (const guildId of [...voiceSessions.keys()]) deleteVoiceSession(guildId);
}

export function deleteVoiceSession(guildId: string) {
  voiceSessions.get(guildId)?.destroy();
  voiceSessions.delete(guildId);
}
