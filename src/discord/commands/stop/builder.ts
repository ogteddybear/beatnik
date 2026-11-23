import { SlashCommandBuilder } from "discord.js";

export const builder = new SlashCommandBuilder()
  .setName("stop")
  .setDescription("Stop Sashimi playback and clear the queue.");
