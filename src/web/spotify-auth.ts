import { spotifyUsers } from "@/core/db/spotify-users";
import { spotifyClientConfig } from "@/providers/spotify/tokens";
import express from "express";
import type session from "express-session";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

const SCOPES = ["playlist-read-private", "playlist-read-collaborative", "user-read-private"];
type LinkSession = session.Session & {
  spotifyLink?: { state: string; discordUserId: string };
  spotifyResult?: "success" | "failed" | "cancelled";
};
const digest = (state: string) => createHash("sha256").update(state).digest("hex");
const save = (req: express.Request) =>
  new Promise<void>((resolve, reject) =>
    req.session.save((error) => (error ? reject(error) : resolve())),
  );
export function spotifyRedirectUri() {
  return (
    process.env.SPOTIFY_REDIRECT_URI ||
    new URL(
      "/auth/spotify/callback",
      process.env.DISCORD_REDIRECT_URI || "https://dis.sashimi.zip",
    ).toString()
  );
}
export function mountSpotifyAuth(
  app: express.Express,
  userId: (req: express.Request) => string | null,
) {
  app.get("/auth/spotify", async (req, res) => {
    res.set({ "Cache-Control": "private, no-store", "Referrer-Policy": "no-referrer" });
    const id = userId(req);
    if (!id) return res.redirect("/auth/discord");
    const config = spotifyClientConfig();
    if (!config) return res.status(503).send("Spotify account linking is not configured.");
    const state = randomBytes(32).toString("hex");
    const link = req.session as LinkSession;
    link.spotifyLink = { state, discordUserId: id };
    spotifyUsers.begin(digest(state), id, req.sessionID);
    try {
      await save(req);
    } catch {
      return res.sendStatus(503);
    }
    const url = new URL("https://accounts.spotify.com/authorize");
    url.search = new URLSearchParams({
      response_type: "code",
      client_id: config.id,
      redirect_uri: spotifyRedirectUri(),
      state,
      scope: SCOPES.join(" "),
      show_dialog: "true",
    }).toString();
    return res.redirect(url.toString());
  });
  app.get("/auth/spotify/callback", async (req, res) => {
    res.set({ "Cache-Control": "private, no-store", "Referrer-Policy": "no-referrer" });
    const link = req.session as LinkSession;
    const id = userId(req);
    const received = req.query.state;
    const expected = link.spotifyLink;
    link.spotifyResult = "failed";
    if (
      !id ||
      !expected ||
      expected.discordUserId !== id ||
      typeof received !== "string" ||
      !/^[a-f0-9]{64}$/.test(received) ||
      !/^[a-f0-9]{64}$/.test(expected.state) ||
      !timingSafeEqual(Buffer.from(received), Buffer.from(expected.state)) ||
      !spotifyUsers.claim(digest(received), id, req.sessionID)
    ) {
      return res.redirect(303, "/auth/spotify/result");
    }
    delete link.spotifyLink; // Persist the consumed nonce before contacting Spotify.
    try {
      await save(req);
      if (req.query.error) {
        link.spotifyResult = "cancelled";
      } else {
        const config = spotifyClientConfig();
        const code = req.query.code;
        if (!config || typeof code !== "string" || !code || code.length > 4096)
          throw new Error("Invalid callback");
        const response = await fetch("https://accounts.spotify.com/api/token", {
          method: "POST",
          redirect: "error",
          signal: AbortSignal.timeout(8000),
          headers: {
            Authorization: `Basic ${Buffer.from(`${config.id}:${config.secret}`).toString("base64")}`,
            "Content-Type": "application/x-www-form-urlencoded",
          },
          body: new URLSearchParams({
            grant_type: "authorization_code",
            code,
            redirect_uri: spotifyRedirectUri(),
          }),
        });
        if (!response.ok) throw new Error("Exchange unavailable");
        const token = (await response.json()) as {
          access_token?: unknown;
          refresh_token?: unknown;
          expires_in?: unknown;
          scope?: string;
        };
        if (
          typeof token.access_token !== "string" ||
          !token.access_token ||
          typeof token.refresh_token !== "string" ||
          !token.refresh_token ||
          typeof token.expires_in !== "number" ||
          !Number.isFinite(token.expires_in) ||
          token.expires_in <= 0 ||
          (token.scope !== undefined &&
            (typeof token.scope !== "string" ||
              !SCOPES.every((scope) => token.scope?.split(" ").includes(scope))))
        )
          throw new Error("Incomplete grant");
        const profileResponse = await fetch("https://api.spotify.com/v1/me", {
          headers: { Authorization: `Bearer ${token.access_token}` },
          redirect: "error",
          signal: AbortSignal.timeout(8000),
        });
        if (!profileResponse.ok) throw new Error("Profile unavailable");
        const profile = (await profileResponse.json()) as { id?: unknown; display_name?: unknown };
        if (typeof profile.id !== "string" || !profile.id || profile.id.length > 256)
          throw new Error("Invalid profile");
        const expiresAt = Date.now() + token.expires_in * 1000;
        if (!Number.isSafeInteger(expiresAt)) throw new Error("Invalid expiration");
        const completed = spotifyUsers.complete(digest(received), {
          discord_user_id: id,
          access_token: token.access_token,
          refresh_token: token.refresh_token,
          expires_at: expiresAt,
          spotify_user_id: profile.id,
          spotify_display_name:
            typeof profile.display_name === "string" ? profile.display_name.slice(0, 256) : null,
          updated_at: Date.now(),
        });
        if (completed) link.spotifyResult = "success";
      }
      await save(req);
    } catch {
      /* Do not log OAuth codes, token bodies, headers or raw network errors. */
    }
    return res.redirect(303, "/auth/spotify/result");
  });
  app.get("/auth/spotify/result", (req, res) => {
    res.set({ "Cache-Control": "private, no-store", "Referrer-Policy": "no-referrer" });
    const result = (req.session as LinkSession).spotifyResult;
    return res.render("spotify-result", {
      success: result === "success",
      message:
        result === "success"
          ? "✅ Spotify Linked Successfully. Return to Discord and run /spotify playlists."
          : result === "cancelled"
            ? "Spotify linking was cancelled."
            : "Spotify linking could not be confirmed. Sign in and try again.",
    });
  });
  app.post("/auth/spotify/unlink", express.json({ limit: "1kb" }), async (req, res) => {
    res.set("Cache-Control", "private, no-store");
    const id = userId(req);
    if (!id) return res.sendStatus(401);
    if (req.get("X-Sashimi-Request") !== "spotify" || !req.is("application/json"))
      return res.sendStatus(403);
    spotifyUsers.unlink(id);
    delete (req.session as LinkSession).spotifyLink;
    await save(req);
    return res.json({ linked: false });
  });
}
