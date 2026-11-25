import { getOrCreateSession } from "@/core/manager";
import { getOrCreateVoiceSession } from "@/discord/manager";
import { drawProgressBar, getAddedToQueueMessage, requireVoiceChannel } from "@/discord/messaging";
import type { ProviderTrack } from "@/providers";
import type { ChatInputCommandInteraction } from "discord.js";

export async function enqueueAndPlay(
  interaction: ChatInputCommandInteraction,
  queries: string[],
  options: { shuffle?: boolean; playNext?: boolean } = {},
) {
  const guildId = interaction.guildId;
  if (!guildId) return;

  const voiceChannel = await requireVoiceChannel(interaction);
  if (!voiceChannel) return;

  const { shuffle = false, playNext = false } = options;
  const { player } = getOrCreateSession(guildId);
  getOrCreateVoiceSession(voiceChannel, interaction.channel, player, {
    userId: interaction.user.id,
    username: interaction.user.username,
  });

  const allTracksQueued = [];

  for (const query of queries) {
    const tracks = await player.enqueue(
      query,
      interaction.user.id,
      shuffle,
      playNext,
      interaction.user.username,
    );
    allTracksQueued.push(...tracks);
  }

  if (options.shuffle) {
    player.queue.shuffle();
  }

  // interaction is already deferred
  await interaction.editReply({
    content: getAddedToQueueMessage(allTracksQueued, player.isPlaying, playNext, shuffle),
  });

  if (!player.isPlaying) {
    await player.play();
  }
}

export function createDownloadProgressHandler(interaction: ChatInputCommandInteraction) {
  return async function (track: ProviderTrack, index: number, total: number) {
    await interaction.editReply(
      `Downloading \`${track.title}\`...\n${drawProgressBar(total, index)}`,
    );
  };
}
