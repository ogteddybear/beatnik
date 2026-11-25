import { getSession } from "@/core/manager";
import { requireVoiceChannel } from "@/discord/messaging";

import type { CommandExecuter } from "..";

export const execute: CommandExecuter = async (interaction) => {
  if (!interaction.guildId) return;
  await interaction.deferReply();
  const channel = await requireVoiceChannel(interaction);
  if (!channel) return;
  const botChannel = interaction.guild?.members.me?.voice.channelId;
  if (botChannel && botChannel !== channel.id) {
    await interaction.editReply("Join Sashimi’s voice channel to change the volume.");
    return;
  }
  const session = getSession(interaction.guildId);
  if (!session) {
    await interaction.editReply("There is no active queue.");
    return;
  }
  const percent = interaction.options.getInteger("percent", true);
  session.player.setVolume(percent, interaction.user.id, interaction.user.username);
  await interaction.editReply(`Volume set to ${percent}%.`);
};
