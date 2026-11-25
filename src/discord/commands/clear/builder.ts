import { SlashCommandBuilder } from "discord.js";

export const builder = new SlashCommandBuilder()
  .setName("clear")
  .setDescription("Remove upcoming tracks without stopping the current track.");
