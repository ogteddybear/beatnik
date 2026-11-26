import { SlashCommandBuilder } from "discord.js";

export const builder = new SlashCommandBuilder()
  .setName("diagnostics")
  .setDescription("Bot-owner system diagnostics.");
