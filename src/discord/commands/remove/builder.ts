import { SlashCommandBuilder } from "discord.js";

export const builder = new SlashCommandBuilder()
  .setName("remove")
  .setDescription("Remove a track from this server's queue.")
  .addIntegerOption((option) =>
    option
      .setName("position")
      .setDescription("1-based position shown by /queue.")
      .setMinValue(1)
      .setRequired(true),
  );
