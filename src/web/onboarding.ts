import { db } from "@/core/db/client";
import { logEvent } from "@/core/db/guild-events";
import {
  getDefaultTextChannel,
  getGuildPlayerSettings,
  setDefaultTextChannel,
  updateGuildPlayerSettings,
} from "@/core/db/guild-settings";
import { getSession } from "@/core/manager";
import { ChannelType, type Client, PermissionFlagsBits } from "discord.js";
import express from "express";

export function mountOnboarding(
  app: express.Express,
  client: Client,
  authorize: (req: express.Request) => Promise<{ id: string; username: string } | null>,
) {
  const actors = new WeakMap<express.Request, { id: string; username: string }>();
  const auth: express.RequestHandler = async (req, res, next) => {
    res.set("Cache-Control", "private, no-store");
    if (!req.isAuthenticated())
      return req.path.startsWith("/api/") ? res.sendStatus(401) : res.redirect("/auth/discord");
    try {
      const actor = await authorize(req);
      if (!actor) return res.sendStatus(403);
      actors.set(req, actor);
      next();
    } catch {
      return res.status(502).send("Discord permissions are temporarily unavailable.");
    }
  };
  app.get("/onboard/:guildId", auth, async (req, res) => {
    const guild = client.guilds.cache.get(String(req.params.guildId));
    const actor = actors.get(req);
    if (!guild || !actor) return res.sendStatus(404);
    try {
      const [roles, channels, me] = await Promise.all([
        guild.roles.fetch(),
        guild.channels.fetch(),
        guild.members.fetchMe(),
      ]);
      return res.render("onboard", {
        username: actor.username,
        avatarUrl: "",
        isAdmin: actor.id === "258189484053495809",
        guildId: guild.id,
        guildName: guild.name,
        settings: {
          ...getGuildPlayerSettings(guild.id),
          default_text_channel_id: getDefaultTextChannel(guild.id),
        },
        roles: [...roles.values()]
          .filter((role) => role.id !== guild.id && !role.managed)
          .map((role) => ({ id: role.id, name: role.name })),
        channels: [...channels.values()]
          .filter(
            (channel) =>
              channel?.type === ChannelType.GuildText &&
              channel
                .permissionsFor(me)
                ?.has([
                  PermissionFlagsBits.ViewChannel,
                  PermissionFlagsBits.SendMessages,
                  PermissionFlagsBits.EmbedLinks,
                ]),
          )
          .map((channel) => ({ id: channel?.id, name: channel?.name })),
      });
    } catch {
      return res.status(502).send("Server roles or channels could not be loaded.");
    }
  });
  app.post(
    "/api/onboard/:guildId",
    auth,
    (req, res, next) => {
      if (req.get("X-Sashimi-Request") !== "onboard" || !req.is("application/json"))
        return res.sendStatus(403);
      next();
    },
    express.json({ limit: "2kb" }),
    async (req, res) => {
      const input = req.body;
      if (
        !input ||
        typeof input !== "object" ||
        Array.isArray(input) ||
        Object.keys(input).some(
          (key) =>
            !["volume", "dj_role_id", "default_text_channel_id", "autoplay_enabled"].includes(key),
        ) ||
        !Number.isInteger(input.volume) ||
        input.volume < 0 ||
        input.volume > 200 ||
        typeof input.autoplay_enabled !== "boolean" ||
        ![input.dj_role_id, input.default_text_channel_id].every(
          (value) => value === null || (typeof value === "string" && /^\d{17,20}$/.test(value)),
        )
      )
        return res.sendStatus(400);
      const guild = client.guilds.cache.get(String(req.params.guildId));
      const actor = actors.get(req);
      if (!guild || !actor) return res.sendStatus(404);
      try {
        if (input.dj_role_id) {
          const role = await guild.roles.fetch(input.dj_role_id);
          if (!role || role.managed || role.id === guild.id)
            return res.status(400).json({ error: "Choose a normal role from this server." });
        }
        if (input.default_text_channel_id) {
          const [channel, me] = await Promise.all([
            guild.channels.fetch(input.default_text_channel_id),
            guild.members.fetchMe(),
          ]);
          if (
            !channel ||
            channel.type !== ChannelType.GuildText ||
            !channel
              .permissionsFor(me)
              ?.has([
                PermissionFlagsBits.ViewChannel,
                PermissionFlagsBits.SendMessages,
                PermissionFlagsBits.EmbedLinks,
              ])
          )
            return res
              .status(400)
              .json({
                error:
                  "Choose a text channel where Sashimi can view, send messages and embed links.",
              });
        }
        const settings = db.transaction(() => {
          const result = updateGuildPlayerSettings(guild.id, {
            volume: input.volume,
            dj_role_id: input.dj_role_id,
            autoplay_enabled: input.autoplay_enabled,
          });
          setDefaultTextChannel(guild.id, input.default_text_channel_id);
          return { ...result, default_text_channel_id: input.default_text_channel_id };
        })();
        getSession(guild.id)?.player.setVolume(input.volume, actor.id, actor.username);
        logEvent({
          guildId: guild.id,
          userId: actor.id,
          username: actor.username,
          eventType: "player",
          action: "onboard",
          metadata: settings,
        });
        return res.json({ settings });
      } catch {
        return res
          .status(502)
          .json({ error: "Setup could not be completed. Refresh and try again." });
      }
    },
  );
}
