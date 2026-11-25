import { SlashCommandBuilder } from "discord.js";

export const builder = new SlashCommandBuilder()
  .setName("volume")
  .setDescription("Set playback volume.")
  .addIntegerOption((option) =>
    option
      .setName("percent")
      .setDescription("Volume from 0 to 200 percent.")
      .setMinValue(0)
      .setMaxValue(200)
      .setRequired(true),
  );
