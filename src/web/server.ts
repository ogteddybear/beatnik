import { config } from "@/core/config";
import { getLatestEvents } from "@/core/db/guild-events";
import { guildStats } from "@/core/db/guild-stats";
import SQLiteStore from "connect-sqlite3";
import { DiscordScope, Strategy as DiscordStrategy } from "discord-strategy";
import type { Client } from "discord.js";
import express from "express";
import session from "express-session";
import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import passport from "passport";

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

function botInviteUrl(clientID: string): string {
  return `https://discord.com/oauth2/authorize?client_id=${encodeURIComponent(clientID)}&permissions=3146752&scope=bot%20applications.commands`;
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
    return `https://cdn.discordapp.com/avatars/${encodeURIComponent(user.id)}/${encodeURIComponent(user.avatar)}.png`;
  }
  const defaultAvatarIndex = user.id ? (BigInt(user.id) >> 22n) % 6n : 0n;
  return `https://cdn.discordapp.com/embed/avatars/${defaultAvatarIndex}.png`;
}

async function fileSize(file: string): Promise<number> {
  try {
    const info = await stat(file);
    return info.isFile() ? info.size : 0;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw error;
  }
}

export async function guildStorageBytes(guildId: string): Promise<number> {
  if (!guildId || guildId === "." || guildId === ".." || /[\\/:]/.test(guildId)) {
    throw new Error("Invalid guild ID for cache");
  }
  const directory = path.join(config.libraryPath, guildId);
  let files;
  try {
    files = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw error;
  }
  let bytes = 0;
  const cachedFiles = files.filter((file) => file.isFile() && file.name.endsWith(".cache"));
  for (let offset = 0; offset < cachedFiles.length; offset += 32) {
    const sizes = await Promise.all(
      cachedFiles
        .slice(offset, offset + 32)
        .map((file) => fileSize(path.join(directory, file.name))),
    );
    bytes += sizes.reduce((total, size) => total + size, 0);
  }
  return bytes;
}

function formatBytes(bytes: number): string {
  if (bytes < 1_024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1_024)), units.length);
  return `${(bytes / 1_024 ** exponent).toFixed(1)} ${units[exponent - 1]}`;
}

export function createWebServer(client: Client) {
  const clientID = process.env.DISCORD_CLIENT_ID || config.discord.clientId;
  const clientSecret = requiredEnv("DISCORD_CLIENT_SECRET");
  const callbackURL = requiredEnv("DISCORD_REDIRECT_URI");
  const secret = requiredEnv("SESSION_SECRET");
  const inviteUrl = botInviteUrl(clientID);
  const production = process.env.NODE_ENV === "production";
  const auth = new passport.Passport();
  const SQLiteStoreFactory = SQLiteStore(session);

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
  if (production) app.set("trust proxy", 1);
  app.disable("x-powered-by");
  app.set("view engine", "ejs");
  app.set("views", path.join(process.cwd(), "src", "web", "views"));
  app.use("/static", express.static(path.join(process.cwd(), "src", "web", "public")));
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

  app.get("/", (req, res) => {
    if (req.isAuthenticated()) return res.redirect("/dashboard");
    return res.render("login", { inviteUrl });
  });
  app.get("/auth/discord", auth.authenticate("discord"));
  app.get("/auth/callback", auth.authenticate("discord", { failureRedirect: "/" }), (_req, res) =>
    res.redirect("/dashboard"),
  );
  app.get("/dashboard", async (req, res) => {
    if (!req.isAuthenticated() || !isDashboardUser(req.user)) return res.redirect("/");

    res.set("Cache-Control", "private, no-store");
    let userGuilds: DiscordGuild[] = [];
    if (req.user.id !== ADMIN_USER_ID) {
      const response = await fetch("https://discord.com/api/users/@me/guilds", {
        headers: { Authorization: `Bearer ${req.user.accessToken}` },
      });
      if (response.status === 401 || response.status === 403) return res.redirect("/logout");
      if (!response.ok) return res.status(502).send("Discord is temporarily unavailable.");

      userGuilds = (await response.json()) as DiscordGuild[];
    }
    const visibleGuilds = authorizedGuilds(client, req.user.id, userGuilds);
    const guilds = await Promise.all(
      visibleGuilds.map(async (guild) => {
        const { requests, plays, skips, stops, commands_used } = guildStats.get(guild.id);
        return {
          name: guild.name,
          iconUrl: guild.icon
            ? `https://cdn.discordapp.com/icons/${encodeURIComponent(guild.id)}/${encodeURIComponent(guild.icon)}.png`
            : null,
          requests,
          plays,
          skips,
          stops,
          commands: commands_used,
          storageUsed: formatBytes(await guildStorageBytes(guild.id)),
        };
      }),
    );
    return res.render("dashboard", {
      username: req.user.username,
      avatarUrl: avatarUrlFor(req.user),
      guilds,
      inviteUrl,
      isAdmin: req.user.id === ADMIN_USER_ID,
    });
  });
  app.get("/admin", (req, res) => {
    if (!req.isAuthenticated() || !isDashboardUser(req.user)) return res.redirect("/");
    if (req.user.id !== ADMIN_USER_ID) return res.redirect("/dashboard");
    res.set("Cache-Control", "private, no-store");

    const events = getLatestEvents(100).map((event) => ({
      time: new Date(event.created_at).toISOString(),
      guild: event.guild_id
        ? (client.guilds.cache.get(event.guild_id)?.name ?? event.guild_id)
        : "Unknown",
      user: event.user_id
        ? (client.users.cache.get(event.user_id)?.username ?? event.user_id)
        : "System",
      eventType: event.event_type,
      action: event.action,
      metadata: event.metadata ?? "—",
    }));
    return res.render("admin", {
      username: req.user.username,
      avatarUrl: avatarUrlFor(req.user),
      events,
      isAdmin: true,
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
