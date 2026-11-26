import { SlashCommandBuilder } from "discord.js";

export const builder = new SlashCommandBuilder()
  .setName("autoplay")
  .setDescription("Toggle server radio mode.")
  .addBooleanOption((option) =>
    option.setName("enabled").setDescription("Enable or disable instead of toggling."),
  );
