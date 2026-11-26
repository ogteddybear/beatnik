import { logEvent } from "@/core/db/guild-events";
import {
  type GuildPlayerSettings,
  getGuildPlayerSettings,
  updateGuildPlayerSettings,
} from "@/core/db/guild-settings";
import { getSession } from "@/core/manager";
import type { CorePlayer } from "@/core/player";
import type { Client } from "discord.js";
import express from "express";
import { createHash } from "node:crypto";

interface Actor {
  id: string;
  username: string;
}
const guildIdOf = (req: express.Request) => String(req.params.guildId);
type Controls = (
  id: string,
) =>
  | { player: CorePlayer; voice: { runControl(action: () => Promise<void>): Promise<boolean> } }
  | undefined;
export function guildQueueSnapshot(guildId: string) {
  const session = getSession(guildId);
  const currentIndex = session?.queue.currentIndex ?? 0;
  const tracks = (session?.queue.tracks ?? []).map((track, index) => ({
    position: index + 1,
    id: track.id,
    providerId: track.providerId,
    title: track.title,
    artist: track.channelName,
    durationSeconds: track.length,
    current: index === currentIndex,
    played: index < currentIndex,
  }));
  const revision = createHash("sha256")
    .update(JSON.stringify({ currentIndex, tracks }))
    .digest("hex");
  return { tracks, currentIndex, revision, loading: session?.player.isLoading ?? false };
}

export function mountGuildManagement(
  app: express.Express,
  client: Client,
  authorize: (req: express.Request) => Promise<Actor | null>,
  controls: Controls,
) {
  const router = express.Router({ mergeParams: true });
  // Leave the existing /control endpoint and unrelated guild routes untouched.
  router.use((req, _res, next) =>
    /^\/(?:settings|queue(?:\/[^/]+)?)\/?$/.test(req.path) ? next() : next("router"),
  );
  const actors = new WeakMap<express.Request, Actor>();
  const auth: express.RequestHandler = async (req, res, next) => {
    res.set("Cache-Control", "private, no-store");
    if (!req.isAuthenticated()) return res.sendStatus(401);
    try {
      const actor = await authorize(req);
      if (!actor) return res.sendStatus(403);
      actors.set(req, actor);
      next();
    } catch {
      return res.status(502).json({ error: "Discord permissions are temporarily unavailable." });
    }
  };
  router.use(auth);
  router.use((req, res, next) => {
    if (req.method === "GET") return next();
    if (
      req.get("X-Sashimi-Request") !== "guild" ||
      (req.method === "POST" && !req.is("application/json"))
    )
      return res.sendStatus(403);
    next();
  });
  router.use(express.json({ limit: "2kb" }));
  router.get("/settings", (req, res) => res.json(getGuildPlayerSettings(guildIdOf(req))));
  router.post("/settings", async (req, res) => {
    const body: unknown = req.body;
    if (!body || typeof body !== "object" || Array.isArray(body)) return res.sendStatus(400);
    const input = body as Record<string, unknown>;
    if (
      !Object.keys(input).length ||
      Object.keys(input).some((key) => !["volume", "autoplay_enabled", "dj_role_id"].includes(key))
    )
      return res.sendStatus(400);
    if (
      ("volume" in input &&
        (typeof input.volume !== "number" ||
          !Number.isInteger(input.volume) ||
          input.volume < 0 ||
          input.volume > 200)) ||
      ("autoplay_enabled" in input && typeof input.autoplay_enabled !== "boolean") ||
      ("dj_role_id" in input &&
        input.dj_role_id !== null &&
        (typeof input.dj_role_id !== "string" || !/^\d{17,20}$/.test(input.dj_role_id)))
    )
      return res.sendStatus(400);
    const guildId = guildIdOf(req);
    if (typeof input.dj_role_id === "string") {
      try {
        const role = await client.guilds.cache.get(guildId)?.roles.fetch(input.dj_role_id);
        if (!role || role.managed || role.id === guildId)
          return res.status(400).json({ error: "Choose a normal role from this server." });
      } catch {
        return res.status(400).json({ error: "DJ role could not be verified." });
      }
    }
    const actor = actors.get(req);
    if (!actor) return res.sendStatus(401);
    const settings = updateGuildPlayerSettings(guildId, input as Partial<GuildPlayerSettings>);
    if (typeof input.volume === "number")
      getSession(guildId)?.player.setVolume(input.volume, actor.id, actor.username);
    logEvent({
      guildId,
      userId: actor.id,
      username: actor.username,
      eventType: "player",
      action: "settings",
      metadata: settings,
    });
    return res.json(settings);
  });
  router.get("/queue", (req, res) => res.json(guildQueueSnapshot(guildIdOf(req))));

  const mutateQueue: express.RequestHandler = async (req, res) => {
    const guildId = String(req.params.guildId);
    const session = controls(guildId);
    if (!session) return res.status(409).json({ error: "There is no active voice player." });
    const actor = actors.get(req);
    if (!actor) return res.sendStatus(401);
    let error: string | undefined;
    let status = 409;
    try {
      const accepted = await session.voice.runControl(async () => {
        if (
          controls(guildId)?.player !== session.player ||
          getSession(guildId)?.player !== session.player
        ) {
          error = "The player changed. Refresh the queue.";
          return;
        }
        const snapshot = guildQueueSnapshot(guildId);
        const revision: unknown = req.get("X-Queue-Revision") ?? req.body?.revision;
        if (revision !== undefined && revision !== snapshot.revision) {
          error = "The queue changed. Refresh and try again.";
          return;
        }
        if (session.player.isLoading) {
          error = "The player is changing tracks. Please try again.";
          return;
        }
        const from: unknown =
          req.method === "DELETE" ? Number(req.params.position) : req.body?.from;
        const to: unknown = req.body?.to;
        const valid = (value: unknown): value is number =>
          typeof value === "number" &&
          Number.isInteger(value) &&
          value >= 1 &&
          value <= snapshot.tracks.length;
        if (!valid(from) || (req.method !== "DELETE" && !valid(to))) {
          status = 400;
          error = "Invalid queue position.";
          return;
        }
        if (req.method === "DELETE") await session.player.remove(from, actor.id, actor.username);
        else session.player.reorder(from, to as number, actor.id, actor.username);
      });
      if (!accepted || error)
        return res.status(status).json({ error: error ?? "The player is busy. Try again." });
      return res.json(guildQueueSnapshot(guildId));
    } catch {
      return res.status(503).json({ error: "Queue update failed. Refresh and try again." });
    }
  };
  router.delete("/queue/:position", mutateQueue);
  router.post("/queue/reorder", mutateQueue);
  app.use("/api/dashboard/guilds/:guildId", router);
  app.get("/dashboard/guilds/:guildId", auth, (req, res) => {
    const guild = client.guilds.cache.get(String(req.params.guildId));
    if (!guild) return res.sendStatus(404);
    const actor = actors.get(req);
    if (!actor) return res.sendStatus(401);
    return res.render("guild-manage", {
      username: actor.username,
      avatarUrl: "",
      isAdmin: actor.id === "258189484053495809",
      guildId: guild.id,
      guildName: guild.name,
    });
  });
}
