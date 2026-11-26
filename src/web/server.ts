import { calculateGuildStorage, guildStorageSummary } from "@/core/cache/storage";
import { config } from "@/core/config";
import { resolveCustomPlaylistTrack, supportedTrackUrl } from "@/core/custom-playlists";
import { searchEvents, serverOverview } from "@/core/db/dashboard-search";
import { eventCharts } from "@/core/db/event-charts";
import {
  type EventFilters,
  eventExportBoundary,
  eventExportPage,
  guildEventCounts,
  guildEventPage,
  recentGuildCounts,
} from "@/core/db/guild-events";
import { MB, setGuildStorageLimit } from "@/core/db/guild-settings";
import { guildStats } from "@/core/db/guild-stats";
import { spotifyUsers } from "@/core/db/spotify-users";
import { userPlaylists } from "@/core/db/user-playlists";
import { getGuildPlayerState, getSession } from "@/core/manager";
import { getPlayerControlSession } from "@/discord/player-buttons";
import type { ProviderTrack } from "@/providers";
import SQLiteStore from "connect-sqlite3";
import { DiscordScope, Strategy as DiscordStrategy } from "discord-strategy";
import type { Client } from "discord.js";
import express from "express";
import session from "express-session";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { once } from "node:events";
import path from "node:path";
import { setImmediate } from "node:timers/promises";
import passport from "passport";

import { proxyImageUrl } from "../utils/image-proxy";
import { EVENTS_CSV_HEADER, eventCsvRow } from "./events-csv";
import { mountEventsStream } from "./events-stream";
import { mountFinalPanel } from "./final-panel";
import { mountGuildManagement } from "./guild-management";
import { mountImageProxy } from "./image-proxy";
import {
  INVITE_CONFIRMATION_TTL,
  type InviteResult,
  createInviteVerifier,
  discordGuildId,
  invitePresentation,
} from "./invite";
import { getInfrastructureMetrics } from "./metrics";
import { mountOnboarding } from "./onboarding";
import { mountPlaylistEditor } from "./playlist-editor";
import { mountSpotifyAuth } from "./spotify-auth";

interface DashboardUser {
  id: string;
  username: string;
  avatar: string | null;
  accessToken: string;
}

interface DiscordGuild {
  id: string;
  permissions: string;
}

const MANAGE_GUILD = 0x20n;
const ADMINISTRATOR = 0x8n;
const ADMIN_USER_ID = "258189484053495809";
const DAY = 86_400_000;
const EVENT_TYPES = new Set([
  "command",
  "command_error",
  "player",
  "player_error",
  "library",
  "voice",
  "volume",
]);

type InviteSession = session.Session & {
  inviteState?: string;
  inviteIssuedAt?: number;
  inviteResult?: InviteResult;
};

export function canManageGuild(permissions: string): boolean {
  try {
    const flags = BigInt(permissions);
    return (flags & (MANAGE_GUILD | ADMINISTRATOR)) !== 0n;
  } catch {
    return false;
  }
}

export function authorizedGuilds(client: Client, userId: string, userGuilds: DiscordGuild[]) {
  if (userId === ADMIN_USER_ID) return Array.from(client.guilds.cache.values());
  return userGuilds.flatMap((guild) => {
    const botGuild = client.guilds.cache.get(guild.id);
    return botGuild && canManageGuild(guild.permissions) ? [botGuild] : [];
  });
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing environment variable: ${name}`);
  return value;
}

function isDashboardUser(user: Express.User | undefined): user is DashboardUser {
  return Boolean(user && "accessToken" in user && typeof user.accessToken === "string");
}

function avatarUrlFor(user: DashboardUser): string {
  if (user.avatar) {
    return proxyImageUrl(
      `https://cdn.discordapp.com/avatars/${encodeURIComponent(user.id)}/${encodeURIComponent(user.avatar)}.png`,
    );
  }
  const defaultAvatarIndex = user.id ? (BigInt(user.id) >> 22n) % 6n : 0n;
  return proxyImageUrl(`https://cdn.discordapp.com/embed/avatars/${defaultAvatarIndex}.png`);
}

export const guildStorageBytes = calculateGuildStorage;

async function storageView(guildId: string) {
  const storage = await guildStorageSummary(guildId);
  return {
    ...storage,
    storageUsed: formatBytes(storage.storageBytes),
    storageLimit: formatBytes(storage.maxStorageBytes),
  };
}

function formatBytes(bytes: number): string {
  if (bytes < 1_024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1_024)), units.length);
  return `${(bytes / 1_024 ** exponent).toFixed(1)} ${units[exponent - 1]}`;
}

function queryString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export function parseEventFilters(
  query: Record<string, unknown>,
  now = Date.now(),
): EventFilters | null {
  const fromString = queryString(query.from);
  const toString = queryString(query.to);
  const from = fromString === undefined ? now - 7 * DAY : Number(fromString);
  const to = toString === undefined ? now + 1 : Number(toString);
  if (
    !Number.isSafeInteger(from) ||
    !Number.isSafeInteger(to) ||
    from < 0 ||
    to <= from ||
    to > now + DAY ||
    to - from > 90 * DAY
  )
    return null;
  const eventType = queryString(query.type);
  if (query.type !== undefined && (!eventType || !EVENT_TYPES.has(eventType))) return null;
  const action = queryString(query.action);
  if (query.action !== undefined && (!action || !/^[\w-]{1,64}$/.test(action))) return null;
  const userId = queryString(query.user);
  if (query.user !== undefined && (!userId || !/^\d{1,20}$/.test(userId))) return null;
  return { from, to, eventType, action, userId };
}

function cursor(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !/^[1-9]\d*$/.test(value)) return NaN;
  const id = Number(value);
  return Number.isSafeInteger(id) ? id : NaN;
}

async function guildSummaries(guilds: ReturnType<typeof authorizedGuilds>) {
  const now = Date.now();
  const recent = recentGuildCounts(now - 7 * DAY, now + 1);
  return Promise.all(
    guilds.map(async (guild) => {
      const { requests, plays, skips, stops, commands_used } = guildStats.get(guild.id);
      return {
        id: guild.id,
        name: guild.name,
        iconUrl: guild.icon
          ? proxyImageUrl(
              `https://cdn.discordapp.com/icons/${encodeURIComponent(guild.id)}/${encodeURIComponent(guild.icon)}.png`,
            )
          : null,
        requests,
        plays,
        skips,
        stops,
        commands: commands_used,
        recent: recent.get(guild.id) ?? {
          adds: 0,
          requests: 0,
          plays: 0,
          skips: 0,
          stops: 0,
          commands: 0,
          errors: 0,
        },
        ...(await storageView(guild.id)),
        player: getGuildPlayerState(guild.id),
      };
    }),
  );
}

function safeEventDetails(metadata: string | null): string {
  if (!metadata) return "—";
  try {
    const value: unknown = JSON.parse(metadata);
    if (!value || typeof value !== "object" || Array.isArray(value)) return "—";
    const fields = [
      "trackId",
      "playlistId",
      "providerId",
      "command",
      "count",
      "libraryRecordId",
      "reason",
      "errorName",
      "channelName",
      "channelId",
      "percent",
      "previous",
      "removedCount",
      "loopMode",
    ] as const;
    const details = fields.flatMap((field) => {
      const entry = (value as Record<string, unknown>)[field];
      return (typeof entry === "string" && entry.length <= 128) ||
        (["count", "libraryRecordId", "percent", "previous", "removedCount"].includes(field) &&
          typeof entry === "number" &&
          Number.isSafeInteger(entry))
        ? [`${field}: ${entry}`]
        : [];
    });
    return details.join(" · ") || "—";
  } catch {
    return "—";
  }
}

export function createWebServer(
  client: Client,
  controlSession = getPlayerControlSession,
  resolveTrack = resolveCustomPlaylistTrack,
) {
  const clientID = process.env.DISCORD_CLIENT_ID || config.discord.clientId;
  const clientSecret = requiredEnv("DISCORD_CLIENT_SECRET");
  const callbackURL = requiredEnv("DISCORD_REDIRECT_URI");
  const secret = requiredEnv("SESSION_SECRET");
  const inviteCallback = new URL("/invite/callback", callbackURL).toString();
  const production = process.env.NODE_ENV === "production";
  const auth = new passport.Passport();
  const SQLiteStoreFactory = SQLiteStore(session);
  const verifyInvite = createInviteVerifier(client, config.discord.token);

  auth.use(
    new DiscordStrategy(
      {
        clientID,
        clientSecret,
        callbackURL,
        scope: [DiscordScope.Identify, DiscordScope.Guilds],
        state: true,
        // discord-strategy's published options type omits OAuth2's client fields.
      } as ConstructorParameters<typeof DiscordStrategy>[0],
      (accessToken, _refreshToken, profile, done, _consume) => {
        done(null, {
          id: profile.id,
          username: profile.username,
          avatar: profile.avatar ?? null,
          accessToken,
        } satisfies DashboardUser);
      },
    ),
  );
  auth.serializeUser((user, done) => done(null, user));
  auth.deserializeUser((user, done) => done(null, user as DashboardUser));

  const app = express();
  app.locals.proxyImageUrl = proxyImageUrl;
  mountImageProxy(app);
  if (production) app.set("trust proxy", 1);
  app.disable("x-powered-by");
  app.set("view engine", "ejs");
  app.set("views", path.join(process.cwd(), "src", "web", "views"));
  app.get("/favicon.ico", (_req, res) => res.redirect(302, "/static/icon.svg"));
  app.use(
    "/static",
    express.static(path.join(process.cwd(), "src", "web", "public"), {
      setHeaders(res, filePath) {
        if (["icon.svg", "favicon.svg"].includes(path.basename(filePath)))
          res.setHeader("Cache-Control", "public, max-age=86400");
      },
    }),
  );
  app.use(
    session({
      store: new SQLiteStoreFactory({
        db: "sessions.db",
        dir: config.libraryPath,
      }) as session.Store,
      secret,
      resave: false,
      saveUninitialized: false,
      cookie: {
        secure: production,
        httpOnly: true,
        sameSite: "lax",
        maxAge: 7 * 24 * 60 * 60 * 1_000,
      },
    }),
  );
  app.use(auth.initialize());
  app.use(auth.session());
  mountSpotifyAuth(app, (req) =>
    req.isAuthenticated() && isDashboardUser(req.user) ? req.user.id : null,
  );

  app.get("/", (req, res) => {
    if (req.isAuthenticated()) return res.redirect("/dashboard");
    return res.render("login", { inviteUrl: "/invite" });
  });
  app.get("/auth/discord", auth.authenticate("discord"));
  app.get("/auth/callback", auth.authenticate("discord", { failureRedirect: "/" }), (_req, res) =>
    res.redirect("/dashboard"),
  );
  app.get("/invite", (req, res, next) => {
    const state = randomBytes(32).toString("hex");
    const inviteSession = req.session as InviteSession;
    inviteSession.inviteState = state;
    inviteSession.inviteIssuedAt = Date.now();
    delete inviteSession.inviteResult;
    const authorize = new URL("https://discord.com/oauth2/authorize");
    authorize.search = new URLSearchParams({
      response_type: "code",
      client_id: clientID,
      permissions: "3146752",
      scope: "bot applications.commands identify",
      integration_type: "0",
      redirect_uri: inviteCallback,
      state,
    }).toString();
    req.session.save((error) => {
      if (error) return next(error);
      res.redirect(authorize.toString());
    });
  });
  app.get("/invite/callback", async (req, res) => {
    res.set("Cache-Control", "private, no-store");
    res.set("Referrer-Policy", "no-referrer");
    const inviteSession = req.session as InviteSession;
    const expected = inviteSession.inviteState;
    const issuedAt = inviteSession.inviteIssuedAt;
    delete inviteSession.inviteState;
    delete inviteSession.inviteIssuedAt;
    const received = queryString(req.query.state);
    if (
      !expected ||
      !received ||
      !issuedAt ||
      Date.now() - issuedAt < 0 ||
      Date.now() - issuedAt > 10 * 60_000 ||
      !/^[a-f0-9]{64}$/.test(received) ||
      received.length !== expected.length ||
      !timingSafeEqual(Buffer.from(received), Buffer.from(expected)) ||
      req.query.iss !== "https://discord.com"
    ) {
      if (!["confirmed", "pending"].includes(inviteSession.inviteResult?.status ?? "")) {
        inviteSession.inviteResult = { status: "invalid", createdAt: Date.now() };
      }
      return res.redirect("/invite/result");
    }
    // Persist nonce consumption before making any external request.
    await new Promise<void>((resolve, reject) =>
      req.session.save((error) => (error ? reject(error) : resolve())),
    );
    const result: InviteResult = { status: "pending", createdAt: Date.now() };
    inviteSession.inviteResult = result;
    if (req.query.error === "access_denied") {
      result.status = "cancelled";
    } else if (req.query.error !== undefined) {
      result.status = "failed";
    } else {
      const code = queryString(req.query.code);
      if (!code || code.length > 2048) {
        result.status = "failed";
      } else {
        // Discord documents this parameter as a hint, not membership proof.
        result.guildId = discordGuildId(req.query.guild_id);
        try {
          const response = await fetch("https://discord.com/api/oauth2/token", {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({
              client_id: clientID,
              client_secret: clientSecret,
              grant_type: "authorization_code",
              code,
              redirect_uri: inviteCallback,
            }),
            signal: AbortSignal.timeout(5_000),
          });
          // Never put the exchange response, code, or credentials in logs or templates.
          const token: unknown = response.ok ? await response.json() : null;
          if (
            token &&
            typeof token === "object" &&
            "access_token" in token &&
            typeof token.access_token === "string" &&
            token.access_token
          ) {
            result.authorizationComplete = true;
            if (
              "guild" in token &&
              token.guild &&
              typeof token.guild === "object" &&
              "id" in token.guild
            ) {
              const confirmedGuild = discordGuildId(token.guild.id);
              if (confirmedGuild) {
                // A guild in Discord's server-to-server token response is proof,
                // unlike the editable guild_id callback query parameter.
                result.guildId = confirmedGuild;
                result.status = "confirmed";
              }
            }
          }
        } catch {
          // The code exchange can fail after the bot was added. Stay pending.
        }
        await verifyInvite(result);
      }
    }
    return res.redirect("/invite/result");
  });
  app.get("/invite/result", async (req, res) => {
    res.set("Cache-Control", "private, no-store");
    res.set("Referrer-Policy", "no-referrer");
    const inviteSession = req.session as InviteSession;
    await verifyInviteResult(inviteSession);
    return res.render("invite-result", {
      ...invitePresentation(inviteSession.inviteResult),
      canCheck: canCheckInvite(inviteSession.inviteResult),
      isAuthenticated: req.isAuthenticated(),
    });
  });
  function canCheckInvite(result?: InviteResult) {
    return Boolean(
      result?.status === "pending" &&
      result.guildId &&
      Date.now() >= result.createdAt &&
      Date.now() - result.createdAt < INVITE_CONFIRMATION_TTL,
    );
  }
  async function verifyInviteResult(inviteSession: InviteSession) {
    // Older deployed sessions stored a string result instead of a receipt.
    if (inviteSession.inviteResult && typeof inviteSession.inviteResult !== "object") {
      delete inviteSession.inviteResult;
    }
    if (inviteSession.inviteResult) await verifyInvite(inviteSession.inviteResult);
  }
  app.get("/api/invite/status", async (req, res) => {
    res.set("Cache-Control", "private, no-store");
    res.set("Referrer-Policy", "no-referrer");
    const inviteSession = req.session as InviteSession;
    await verifyInviteResult(inviteSession);
    // No guild ID query accepted; this endpoint can only check the receipt in
    // this browser's session. It grants no dashboard or event-log access.
    return res.json({
      ...invitePresentation(inviteSession.inviteResult),
      status: inviteSession.inviteResult?.status ?? "none",
      canCheck: canCheckInvite(inviteSession.inviteResult),
    });
  });

  async function visibleGuilds(req: express.Request) {
    if (!req.isAuthenticated() || !isDashboardUser(req.user)) return null;
    if (req.user.id === ADMIN_USER_ID) return authorizedGuilds(client, req.user.id, []);
    const response = await fetch("https://discord.com/api/users/@me/guilds", {
      headers: { Authorization: `Bearer ${req.user.accessToken}` },
      signal: AbortSignal.timeout(5000),
    });
    if (response.status === 401 || response.status === 403) return null;
    if (!response.ok) throw new Error("Discord guild permissions unavailable");
    return authorizedGuilds(client, req.user.id, (await response.json()) as DiscordGuild[]);
  }

  mountFinalPanel(app, client, (req) =>
    req.isAuthenticated() && isDashboardUser(req.user)
      ? { id: req.user.id, username: req.user.username, avatarUrl: avatarUrlFor(req.user) }
      : null,
  );
  app.get("/servers", async (req, res) => {
    res.set("Cache-Control", "private, no-store");
    if (!req.isAuthenticated() || !isDashboardUser(req.user)) return res.redirect("/");
    try {
      const guilds = await visibleGuilds(req);
      if (!guilds) return res.redirect("/logout");
      const overview = serverOverview(guilds.map((guild) => guild.id));
      const byId = new Map(overview.guilds.map((guild) => [guild.id, guild]));
      return res.render("servers", {
        username: req.user.username,
        avatarUrl: avatarUrlFor(req.user),
        isAdmin: req.user.id === ADMIN_USER_ID,
        overview,
        guilds: guilds.map((guild) => ({ ...byId.get(guild.id), id: guild.id, name: guild.name })),
      });
    } catch {
      return res.status(502).send("Server statistics are temporarily unavailable.");
    }
  });
  app.get("/api/admin/search", (req, res) => {
    res.set("Cache-Control", "private, no-store");
    if (!req.isAuthenticated() || !isDashboardUser(req.user)) return res.sendStatus(401);
    if (req.user.id !== ADMIN_USER_ID) return res.sendStatus(403);
    const q = req.query.q;
    const before =
      req.query.before === undefined ? Number.MAX_SAFE_INTEGER : Number(req.query.before);
    if (
      typeof q !== "string" ||
      !q.trim() ||
      q.length > 200 ||
      !Number.isSafeInteger(before) ||
      before <= 0 ||
      (req.query.before !== undefined &&
        (typeof req.query.before !== "string" || !/^\d+$/.test(req.query.before)))
    )
      return res.sendStatus(400);
    return res.json(searchEvents(q.trim(), before));
  });
  app.get("/dashboard", async (req, res) => {
    if (!req.isAuthenticated() || !isDashboardUser(req.user)) return res.redirect("/");
    res.set("Cache-Control", "private, no-store");
    let visible;
    try {
      visible = await visibleGuilds(req);
    } catch {
      return res.status(502).send("Discord is temporarily unavailable.");
    }
    if (!visible) return res.redirect("/logout");
    const guilds = await guildSummaries(visible);
    return res.render("dashboard", {
      username: req.user.username,
      avatarUrl: avatarUrlFor(req.user),
      guilds,
      inviteUrl: "/invite",
      isAdmin: req.user.id === ADMIN_USER_ID,
      spotifyAccount: spotifyUsers.summary(req.user.id),
    });
  });
  app.get("/playlists", (req, res) => {
    if (!req.isAuthenticated() || !isDashboardUser(req.user)) return res.redirect("/");
    res.set("Cache-Control", "private, no-store");
    return res.render("playlists", {
      username: req.user.username,
      avatarUrl: avatarUrlFor(req.user),
      isAdmin: req.user.id === ADMIN_USER_ID,
    });
  });
  const playlistAuth: express.RequestHandler = (req, res, next) => {
    res.set("Cache-Control", "private, no-store");
    if (!req.isAuthenticated() || !isDashboardUser(req.user)) {
      res.sendStatus(401);
      return;
    }
    if (
      req.method !== "GET" &&
      (req.get("X-Sashimi-Request") !== "playlists" ||
        (req.method !== "DELETE" && !req.is("application/json")))
    ) {
      res.sendStatus(403);
      return;
    }
    next();
  };
  app.get("/api/playlists", playlistAuth, (req, res) => {
    if (!isDashboardUser(req.user)) return res.sendStatus(401);
    return res.json({ playlists: userPlaylists.list(req.user.id) });
  });
  mountPlaylistEditor(app, playlistAuth, (req) => (isDashboardUser(req.user) ? req.user.id : null));
  app.post("/api/playlists", playlistAuth, express.json({ limit: "16kb" }), async (req, res) => {
    if (!isDashboardUser(req.user)) return res.sendStatus(401);
    const name: unknown = req.body?.name;
    if (typeof name !== "string" || !name.trim() || name.trim().length > 100)
      return res.status(400).json({ error: "Use a playlist name of 1–100 characters." });
    let tracks: ProviderTrack[] = [];
    if (req.body.guildId !== undefined) {
      if (typeof req.body.guildId !== "string") return res.sendStatus(400);
      try {
        const guilds = await visibleGuilds(req);
        if (!guilds) return res.sendStatus(401);
        if (!guilds.some((guild) => guild.id === req.body.guildId)) return res.sendStatus(403);
      } catch {
        return res.sendStatus(502);
      }
      const queue = getSession(req.body.guildId)?.queue;
      if (!queue?.nowPlaying)
        return res.status(409).json({ error: "There is no current queue to save." });
      tracks = queue.tracks.slice(queue.currentIndex);
      if (tracks.length > 1000)
        return res.status(400).json({ error: "Playlists support at most 1000 tracks." });
    }
    try {
      const id = userPlaylists.create(req.user.id, name, tracks);
      return res.status(201).json({ playlist: userPlaylists.get(req.user.id, id) });
    } catch {
      return res
        .status(409)
        .json({ error: "Playlist name already exists or your playlist limit was reached." });
    }
  });
  app.post(
    "/api/playlists/:id/tracks",
    playlistAuth,
    express.json({ limit: "16kb" }),
    async (req, res) => {
      if (!isDashboardUser(req.user)) return res.sendStatus(401);
      const id = Number(req.params.id);
      if (!Number.isSafeInteger(id) || id < 1 || !userPlaylists.get(req.user.id, id))
        return res.sendStatus(404);
      const url: unknown = req.body?.url;
      if (!supportedTrackUrl(url))
        return res
          .status(400)
          .json({ error: "Use a supported HTTPS YouTube, SoundCloud or Spotify track URL." });
      try {
        const track = await resolveTrack(url);
        if (!track)
          return res
            .status(400)
            .json({ error: "No track found. Playlist URLs are not supported here." });
        if (!userPlaylists.add(req.user.id, id, track)) return res.sendStatus(404);
        return res.json({ playlist: userPlaylists.get(req.user.id, id) });
      } catch {
        return res
          .status(502)
          .json({ error: "Track metadata is unavailable or the track limit was reached." });
      }
    },
  );
  app.delete("/api/playlists/:id", playlistAuth, (req, res) => {
    if (!isDashboardUser(req.user)) return res.sendStatus(401);
    const id = Number(req.params.id);
    if (!Number.isSafeInteger(id) || id < 1 || !userPlaylists.delete(req.user.id, id))
      return res.sendStatus(404);
    return res.sendStatus(204);
  });
  app.get("/api/admin/export/events", async (req, res) => {
    res.set("Cache-Control", "private, no-store");
    if (!req.isAuthenticated() || !isDashboardUser(req.user)) return res.sendStatus(401);
    if (req.user.id !== ADMIN_USER_ID) return res.sendStatus(403);
    const through = eventExportBoundary();
    const abort = new AbortController();
    res.once("close", () => abort.abort());
    res.type("text/csv").attachment("sashimi-events.csv");
    res.write(EVENTS_CSV_HEADER);
    try {
      let after = 0;
      while (!res.destroyed) {
        // Bounded pages release SQLite read locks before waiting on the network.
        // Preserved event IDs keep pagination stable while the archiver moves rows.
        const events = eventExportPage(after, through);
        if (!events.length) break;
        for (const event of events) {
          if (res.destroyed) return;
          if (!res.write(eventCsvRow(event))) await once(res, "drain", { signal: abort.signal });
        }
        after = events[events.length - 1].id;
        await setImmediate();
      }
      res.end();
    } catch {
      if (!res.destroyed) res.destroy();
    }
  });
  mountEventsStream(app, async (req) => {
    if (!req.isAuthenticated() || !isDashboardUser(req.user)) return null;
    // An open SSE request must not outlive logout/session expiry.
    const alive = await new Promise<boolean>((resolve) =>
      req.session.reload((error) => resolve(!error)),
    );
    if (!alive) return null;
    const stored = (req.session as session.Session & { passport?: { user?: { id?: string } } })
      .passport?.user;
    if (stored?.id !== req.user.id) return null;
    const guilds = await visibleGuilds(req);
    return guilds ? { userId: req.user.id, guildIds: guilds.map((guild) => guild.id) } : null;
  });
  mountOnboarding(app, client, async (req) => {
    if (!isDashboardUser(req.user)) return null;
    const guilds = await visibleGuilds(req);
    return guilds?.some((guild) => guild.id === req.params.guildId)
      ? { id: req.user.id, username: req.user.username }
      : null;
  });
  mountGuildManagement(
    app,
    client,
    async (req) => {
      if (!isDashboardUser(req.user)) return null;
      const guilds = await visibleGuilds(req);
      return guilds?.some((guild) => guild.id === req.params.guildId)
        ? { id: req.user.id, username: req.user.username }
        : null;
    },
    controlSession,
  );
  app.get("/api/dashboard/statistics", async (req, res) => {
    res.set("Cache-Control", "private, no-store");
    if (!req.isAuthenticated() || !isDashboardUser(req.user)) return res.sendStatus(401);
    try {
      const guilds = await visibleGuilds(req);
      if (!guilds) return res.sendStatus(401);
      return res.json(eventCharts(guilds.map((guild) => guild.id)));
    } catch {
      return res.status(502).json({ error: "Statistics are temporarily unavailable." });
    }
  });
  app.get("/api/admin/guilds/:guildId/statistics", (req, res) => {
    res.set("Cache-Control", "private, no-store");
    if (!req.isAuthenticated() || !isDashboardUser(req.user)) return res.sendStatus(401);
    if (req.user.id !== ADMIN_USER_ID) return res.sendStatus(403);
    if (!client.guilds.cache.has(req.params.guildId)) return res.sendStatus(404);
    return res.json(eventCharts([req.params.guildId]));
  });
  app.get("/api/dashboard/guilds", async (req, res) => {
    res.set("Cache-Control", "private, no-store");
    if (!req.isAuthenticated() || !isDashboardUser(req.user)) return res.sendStatus(401);
    try {
      const visible = await visibleGuilds(req);
      if (!visible) return res.sendStatus(401);
      return res.json({ guilds: await guildSummaries(visible) });
    } catch {
      return res.sendStatus(502);
    }
  });
  app.post(
    "/api/dashboard/guilds/:guildId/control",
    async (req, res, next) => {
      res.set("Cache-Control", "private, no-store");
      if (!req.isAuthenticated() || !isDashboardUser(req.user)) return res.sendStatus(401);
      // JSON + custom header block cross-site forms; no cross-origin access is granted.
      if (req.get("X-Sashimi-Request") !== "control" || !req.is("application/json"))
        return res.sendStatus(403);
      try {
        const guilds = await visibleGuilds(req);
        if (!guilds) return res.sendStatus(401);
        if (!guilds.some((guild) => guild.id === req.params.guildId)) return res.sendStatus(403);
      } catch {
        return res.status(502).json({ error: "Discord permissions are temporarily unavailable." });
      }
      next();
    },
    express.json({ limit: "1kb" }),
    async (req, res) => {
      const action: unknown = req.body?.action;
      if (action !== "pause" && action !== "resume" && action !== "skip" && action !== "stop")
        return res.status(400).json({ error: "Invalid player action." });
      if (!isDashboardUser(req.user)) return res.sendStatus(401);
      const session = controlSession(req.params.guildId);
      if (!session) return res.status(409).json({ error: "There is no active player." });
      const { id, username } = req.user;
      let applied = false;
      try {
        const accepted = await session.voice.runControl(async () => {
          const current = controlSession(req.params.guildId);
          if (current?.player !== session.player || current?.voice !== session.voice) return;
          const { player } = session;
          if (!player.isPlaying || (player.isLoading && action !== "stop")) return;
          switch (action) {
            case "pause":
              applied = player.isPaused || player.pause(id, username);
              break;
            case "resume":
              applied = !player.isPaused || player.resume(id, username);
              break;
            case "skip":
              await player.skip(id, undefined, username);
              applied = true;
              break;
            case "stop":
              await player.stop(id, username);
              applied = true;
              break;
          }
        });
        if (!accepted || !applied)
          return res
            .status(409)
            .json({ error: "The player is busy or changing tracks. Please try again." });
        return res.json({ player: getGuildPlayerState(req.params.guildId) });
      } catch {
        return res.status(503).json({ error: "The player action could not be applied." });
      }
    },
  );
  app.get("/api/admin/guilds", async (req, res) => {
    res.set("Cache-Control", "private, no-store");
    if (!req.isAuthenticated() || !isDashboardUser(req.user)) return res.sendStatus(401);
    if (req.user.id !== ADMIN_USER_ID) return res.sendStatus(403);
    return res.json({ guilds: await guildSummaries(authorizedGuilds(client, req.user.id, [])) });
  });
  app.get("/api/admin/infrastructure", async (req, res) => {
    res.set("Cache-Control", "private, no-store");
    if (!req.isAuthenticated() || !isDashboardUser(req.user)) return res.sendStatus(401);
    if (req.user.id !== ADMIN_USER_ID) return res.sendStatus(403);
    return res.json(await getInfrastructureMetrics());
  });
  app.get("/admin", async (req, res) => {
    if (!req.isAuthenticated() || !isDashboardUser(req.user)) return res.redirect("/");
    if (req.user.id !== ADMIN_USER_ID) return res.redirect("/dashboard");
    res.set("Cache-Control", "private, no-store");
    return res.render("admin", {
      username: req.user.username,
      avatarUrl: avatarUrlFor(req.user),
      isAdmin: true,
      guilds: await guildSummaries(authorizedGuilds(client, req.user.id, [])),
      infrastructure: await getInfrastructureMetrics(),
    });
  });
  app.get("/admin/guild/:guildId", (req, res) => {
    if (!req.isAuthenticated() || !isDashboardUser(req.user)) return res.redirect("/");
    if (req.user.id !== ADMIN_USER_ID) return res.redirect("/dashboard");
    const guild = client.guilds.cache.get(req.params.guildId);
    if (!guild) return res.sendStatus(404);
    res.set("Cache-Control", "private, no-store");
    return res.render("guild-detail", {
      username: req.user.username,
      avatarUrl: avatarUrlFor(req.user),
      isAdmin: true,
      guildId: guild.id,
      guildName: guild.name,
    });
  });
  app.get("/api/admin/guilds/:guildId/summary", async (req, res) => {
    res.set("Cache-Control", "private, no-store");
    if (!req.isAuthenticated() || !isDashboardUser(req.user)) return res.sendStatus(401);
    if (req.user.id !== ADMIN_USER_ID) return res.sendStatus(403);
    if (!client.guilds.cache.has(req.params.guildId)) return res.sendStatus(404);
    const now = Date.now();
    return res.json({
      allTime: guildStats.get(req.params.guildId),
      ranges: {
        day: guildEventCounts(req.params.guildId, now - DAY, now + 1),
        week: guildEventCounts(req.params.guildId, now - 7 * DAY, now + 1),
        month: guildEventCounts(req.params.guildId, now - 30 * DAY, now + 1),
      },
      ...(await storageView(req.params.guildId)),
      player: getGuildPlayerState(req.params.guildId),
    });
  });
  app.post(
    "/api/admin/guilds/:guildId/settings",
    (req, res, next) => {
      res.set("Cache-Control", "private, no-store");
      if (!req.isAuthenticated() || !isDashboardUser(req.user)) return res.sendStatus(401);
      if (req.user.id !== ADMIN_USER_ID) return res.sendStatus(403);
      if (!client.guilds.cache.has(req.params.guildId)) return res.sendStatus(404);
      // A custom header plus JSON prevents cross-site form submission. No CORS
      // access is granted, so another origin cannot send this authenticated request.
      if (req.get("X-Sashimi-Request") !== "quota" || !req.is("application/json"))
        return res.status(403).json({ error: "Use the same-origin quota form." });
      next();
    },
    express.json({ limit: "1kb" }),
    async (req, res) => {
      const mb: unknown = req.body?.max_storage_mb;
      if (
        typeof mb !== "number" ||
        !Number.isFinite(mb) ||
        mb < 0 ||
        !Number.isSafeInteger(Math.round(mb * MB))
      )
        return res
          .status(400)
          .json({ error: "Quota must be a non-negative MB number within the safe byte range." });
      setGuildStorageLimit(req.params.guildId, Math.round(mb * MB));
      return res.json(await storageView(req.params.guildId));
    },
  );
  app.get("/api/admin/guilds/:guildId/events", (req, res) => {
    res.set("Cache-Control", "private, no-store");
    if (!req.isAuthenticated() || !isDashboardUser(req.user)) return res.sendStatus(401);
    if (req.user.id !== ADMIN_USER_ID) return res.sendStatus(403);
    if (!client.guilds.cache.has(req.params.guildId)) return res.sendStatus(404);
    const filters = parseEventFilters(req.query);
    const before = cursor(req.query.before);
    const since = cursor(req.query.since);
    if (!filters || Number.isNaN(before) || Number.isNaN(since) || (before && since))
      return res.sendStatus(400);
    const page = guildEventPage(req.params.guildId, filters, { before, since });
    return res.json({
      events: page.events.map((event) => ({
        id: event.id,
        time: new Date(event.created_at).toISOString(),
        user:
          event.username ??
          (event.user_id
            ? (client.users.cache.get(event.user_id)?.username ?? event.user_id)
            : "System"),
        username: event.username,
        trackName: event.track_name,
        userId: event.user_id,
        eventType: event.event_type,
        action: event.action,
        // Only these structured fields are recorded; never expose arbitrary legacy metadata.
        details: safeEventDetails(event.metadata),
      })),
      hasMore: page.hasMore,
    });
  });
  app.get("/logout", (req, res, next) => {
    req.logout((error) => {
      if (error) return next(error);
      req.session.destroy((sessionError) => {
        if (sessionError) return next(sessionError);
        res.clearCookie("connect.sid");
        res.redirect("/");
      });
    });
  });

  return app;
}
