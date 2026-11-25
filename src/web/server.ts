import { config } from "@/core/config";
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
  name: string;
  icon: string | null;
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing environment variable: ${name}`);
  return value;
}

function isDashboardUser(user: Express.User | undefined): user is DashboardUser {
  return Boolean(user && "accessToken" in user && typeof user.accessToken === "string");
}

async function fileSize(file: string): Promise<number> {
  try {
    return (await stat(file)).size;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw error;
  }
}

async function globalStorageBytes(): Promise<number> {
  const files = await readdir(config.libraryPath, { withFileTypes: true });
  let bytes = 0;
  const cacheFiles = files.filter((file) => file.isFile() && file.name.endsWith(".cache"));
  for (let offset = 0; offset < cacheFiles.length; offset += 32) {
    const sizes = await Promise.all(
      cacheFiles
        .slice(offset, offset + 32)
        .map((file) => fileSize(path.join(config.libraryPath, file.name))),
    );
    bytes += sizes.reduce((total, size) => total + size, 0);
  }
  bytes += await fileSize(config.databaseUrl);
  bytes += await fileSize(`${config.databaseUrl}-wal`);
  bytes += await fileSize(`${config.databaseUrl}-shm`);
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
    return res.render("login");
  });
  app.get("/auth/discord", auth.authenticate("discord"));
  app.get("/auth/callback", auth.authenticate("discord", { failureRedirect: "/" }), (_req, res) =>
    res.redirect("/dashboard"),
  );
  app.get("/dashboard", async (req, res) => {
    if (!req.isAuthenticated() || !isDashboardUser(req.user)) return res.redirect("/");

    res.set("Cache-Control", "private, no-store");
    const response = await fetch("https://discord.com/api/users/@me/guilds", {
      headers: { Authorization: `Bearer ${req.user.accessToken}` },
    });
    if (response.status === 401 || response.status === 403) return res.redirect("/logout");
    if (!response.ok) return res.status(502).send("Discord is temporarily unavailable.");

    const guilds = (await response.json()) as DiscordGuild[];
    const mutualGuilds = guilds.filter((guild) => client.guilds.cache.has(guild.id));
    const defaultAvatarIndex = req.user.id ? (BigInt(req.user.id) >> 22n) % 6n : 0n;
    const avatarUrl = req.user.avatar
      ? `https://cdn.discordapp.com/avatars/${encodeURIComponent(req.user.id)}/${encodeURIComponent(req.user.avatar)}.png`
      : `https://cdn.discordapp.com/embed/avatars/${defaultAvatarIndex}.png`;

    return res.render("dashboard", {
      username: req.user.username,
      avatarUrl,
      guilds: mutualGuilds.map((guild) => ({
        name: guild.name,
        iconUrl: guild.icon
          ? `https://cdn.discordapp.com/icons/${encodeURIComponent(guild.id)}/${encodeURIComponent(guild.icon)}.png`
          : null,
      })),
      storageUsed: formatBytes(await globalStorageBytes()),
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
