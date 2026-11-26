import { PROVIDER_IDS, getBotSettings, saveBotSettings } from "@/core/db/bot-settings";
import { db } from "@/core/db/client";
import { userRecap } from "@/core/db/recap";
import { applyConfiguredPresence } from "@/discord/presence";
import type { Client } from "discord.js";
import express from "express";

const OWNER = "258189484053495809";
interface User {
  id: string;
  username: string;
  avatarUrl: string;
}
export function mountFinalPanel(
  app: express.Express,
  client: Client,
  user: (req: express.Request) => User | null,
) {
  app.get("/recap", (req, res) => {
    res.set("Cache-Control", "private, no-store");
    const actor = user(req);
    if (!actor) return res.redirect("/");
    return res.render("recap", {
      ...actor,
      isAdmin: actor.id === OWNER,
      recap: userRecap(actor.id),
    });
  });
  app.get("/stats", (_req, res) => {
    res.set("Cache-Control", "no-store");
    const plays =
      db
        .prepare<[], { plays: number }>("SELECT coalesce(sum(plays),0) AS plays FROM GuildStats")
        .get()?.plays ?? 0;
    return res.render("stats", {
      servers: client.guilds.cache.size,
      plays,
      uptime: Math.floor(process.uptime()),
    });
  });
  const owner: express.RequestHandler = (req, res, next) => {
    res.set("Cache-Control", "private, no-store");
    const actor = user(req);
    if (!actor) return res.sendStatus(401);
    if (actor.id !== OWNER) return res.sendStatus(403);
    next();
  };
  app.get("/admin/bot", owner, (req, res) => {
    const actor = user(req);
    return res.render("bot-settings", {
      ...actor,
      isAdmin: true,
      settings: getBotSettings(),
      providerIds: PROVIDER_IDS,
      guildCount: client.guilds.cache.size,
    });
  });
  app.post(
    "/api/admin/bot",
    owner,
    (req, res, next) => {
      if (req.get("X-Sashimi-Request") !== "bot" || !req.is("application/json"))
        return res.sendStatus(403);
      next();
    },
    express.json({ limit: "2kb" }),
    (req, res) => {
      let settings;
      try {
        settings = saveBotSettings(req.body);
      } catch {
        return res.status(400).json({ error: "Invalid bot settings." });
      }
      try {
        applyConfiguredPresence(client);
      } catch {
        return res
          .status(503)
          .json({ error: "Settings saved; Discord presence will retry automatically." });
      }
      return res.json({ settings });
    },
  );
  app.get("/manifest.json", (_req, res) =>
    res.sendFile("manifest.json", { root: "src/web/public" }),
  );
  app.get("/sw.js", (_req, res) => {
    res.set({ "Cache-Control": "no-cache", "Service-Worker-Allowed": "/" });
    return res.sendFile("sw.js", { root: "src/web/public" });
  });
}
