import { getOrCreateSession } from "@/core/manager";
import { getOrCreateVoiceSession, getVoiceSession } from "@/discord/manager";
import { requireVoiceChannel } from "@/discord/messaging";
import { LIVE_STATIONS } from "@/providers/live/stations";
import { EmbedBuilder } from "discord.js";

import type { CommandExecuter } from "..";

export const execute: CommandExecuter = async (interaction) => {
  await interaction.deferReply();
  if (!interaction.guildId) {
    await interaction.editReply("Use /live in a server voice channel.");
    return;
  }
  const voiceChannel = await requireVoiceChannel(interaction);
  if (!voiceChannel) return;
  const key = interaction.options.getString("station", true);
  if (!Object.hasOwn(LIVE_STATIONS, key)) {
    await interaction.editReply("Unknown radio station.");
    return;
  }
  const existing = getVoiceSession(interaction.guildId);
  if (existing && existing.channelId !== voiceChannel.id) {
    await interaction.editReply("Join Sashimi’s voice channel to change the station.");
    return;
  }
  const station = LIVE_STATIONS[key as keyof typeof LIVE_STATIONS];
  const { player } = getOrCreateSession(interaction.guildId);
  const voice = getOrCreateVoiceSession(voiceChannel, interaction.channel, player, {
    userId: interaction.user.id,
    username: interaction.user.username,
  });
  const accepted = await voice.runControl(async () => {
    await player.playLive(station.url, station.name);
    await interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setColor("#0a203b")
          .setDescription(
            `📻 ${player.isLoading ? "Connecting to" : "Streaming"} **${station.name}** — ${station.genre}. Use \`/stop\` to end the broadcast.`,
          ),
      ],
      allowedMentions: { parse: [] },
    });
  });
  if (!accepted)
    await interaction.editReply("Another player action is in progress. Please try again.");
};
