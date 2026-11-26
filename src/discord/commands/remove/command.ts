import type { CommandExecuter } from "@/discord/commands";
import { requireVoiceChannel } from "@/discord/messaging";
import { getPlayerControlSession } from "@/discord/player-buttons";
import { type ChatInputCommandInteraction, MessageFlags, inlineCode } from "discord.js";

export async function removeQueueWithInteraction(
  interaction: ChatInputCommandInteraction,
  position: number,
  lookup = getPlayerControlSession,
) {
  if (!interaction.guildId) {
    await interaction.reply({ content: "Use /remove in a server.", flags: MessageFlags.Ephemeral });
    return;
  }
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const channel = await requireVoiceChannel(interaction);
  if (!channel) return;
  const session = lookup(interaction.guildId);
  const voice = session?.voice;
  if (!session || !voice) {
    await interaction.editReply("There is no active queue.");
    return;
  }
  const botChannel = interaction.guild?.members.me?.voice.channelId;
  if (channel.id !== voice.channelId || (botChannel && channel.id !== botChannel)) {
    await interaction.editReply("Join Sashimi’s voice channel to remove tracks.");
    return;
  }
  const accepted = await voice.runControl(async () => {
    if (session.player.isLoading) {
      await interaction.editReply("The player is changing tracks. Please try again.");
      return;
    }
    const removed = await session.player.remove(
      position,
      interaction.user.id,
      interaction.user.username,
    );
    await interaction.editReply(
      removed
        ? `Removed ${inlineCode(removed.title.slice(0, 200))} from position ${position}.`
        : `Choose a queue position between 1 and ${session.player.queue.tracks.length}.`,
    );
  });
  if (!accepted)
    await interaction.editReply("Another player action is in progress. Please try again.");
}

export const execute: CommandExecuter = async (interaction) => {
  await removeQueueWithInteraction(interaction, interaction.options.getInteger("position", true));
};
