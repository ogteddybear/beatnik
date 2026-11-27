import { LIVE_STATIONS } from "@/providers/live/stations";
import { SlashCommandBuilder } from "discord.js";

export const builder = new SlashCommandBuilder()
  .setName("live")
  .setDescription("Listen to live We aRe oNe internet radio.")
  .setDMPermission(false)
  .addStringOption((option) =>
    option
      .setName("station")
      .setDescription("Radio station")
      .setRequired(true)
      .addChoices(
        ...Object.entries(LIVE_STATIONS).map(([value, station]) => ({
          name: station.name,
          value,
        })),
      ),
  );
