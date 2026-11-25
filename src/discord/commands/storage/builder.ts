import { SlashCommandBuilder } from "discord.js";

export const builder = new SlashCommandBuilder()
  .setName("storage")
  .setDescription("Show this server's cache usage and storage quota.");
