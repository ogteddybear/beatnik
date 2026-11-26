import { SlashCommandBuilder } from "discord.js";

export const builder = new SlashCommandBuilder()
  .setName("history")
  .setDescription("Show this server's last 10 playback starts.");
