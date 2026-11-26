import { getSession } from "@/core/manager";
import type { CorePlayer } from "@/core/player";
import { type ButtonInteraction, MessageFlags } from "discord.js";

import { getVoiceSession } from "./manager";

interface ButtonSession {
  player: CorePlayer;
  voice: {
    channelId: string;
    isCurrentMessage(id: string): boolean;
    runControl(action: () => Promise<void>): Promise<boolean>;
  };
}
function currentSession(guildId: string): ButtonSession | undefined {
  const session = getSession(guildId);
  const voice = getVoiceSession(guildId);
  return session && voice ? { player: session.player, voice } : undefined;
}

export async function handlePlayerButton(
  interaction: ButtonInteraction,
  lookup = currentSession,
): Promise<void> {
  if (!/^player:(pause|skip|loop)$/.test(interaction.customId)) return;
  const session = interaction.guildId ? lookup(interaction.guildId) : undefined;
  if (
    !interaction.guild ||
    !session ||
    interaction.message.author.id !== interaction.client.user.id ||
    !session.voice.isCurrentMessage(interaction.message.id)
  ) {
    await interaction.reply({
      content: "This player control is no longer active.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  try {
    const member = await interaction.guild.members.fetch(interaction.user.id);
    const botChannel = interaction.guild.members.me?.voice.channelId;
    if (
      member.voice.channelId !== session.voice.channelId ||
      (botChannel && member.voice.channelId !== botChannel)
    ) {
      await interaction.editReply("Join Sashimi’s voice channel to use these controls.");
      return;
    }
    const accepted = await session.voice.runControl(async () => {
      const { player, voice } = session;
      if (
        !voice.isCurrentMessage(interaction.message.id) ||
        !player.isPlaying ||
        player.isLoading
      ) {
        await interaction.editReply("The player is changing tracks. Please try again.");
        return;
      }
      const { id, username } = interaction.user;
      switch (interaction.customId) {
        case "player:pause": {
          const changed = player.isPaused
            ? player.resume(id, username)
            : player.pause(id, username);
          await interaction.editReply(
            changed
              ? player.isPaused
                ? "Paused."
                : "Resumed."
              : "Playback could not be paused or resumed.",
          );
          break;
        }
        case "player:skip":
          await player.skip(id, undefined, username);
          await interaction.editReply("Skipped.");
          break;
        case "player:loop":
          await interaction.editReply(`Loop: ${player.toggleLoop(id, username)}.`);
          break;
      }
    });
    if (!accepted)
      await interaction.editReply("Another player action is in progress. Please try again.");
  } catch {
    await interaction.editReply("The player control could not be applied. Please try again.");
  }
}
