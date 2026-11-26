import { SlashCommandBuilder } from "discord.js";

export const builder = new SlashCommandBuilder()
  .setName("lyrics")
  .setDescription("Find lyrics for the currently playing track.");
