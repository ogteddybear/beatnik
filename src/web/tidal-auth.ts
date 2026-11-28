import { tidalUsers } from "@/core/db/tidal-users";
import { tidalClientConfig } from "@/providers/tidal/tokens";
import express from "express";
import type session from "express-session";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

const SCOPES = ["user.read", "playlists.read"];
type LinkSession = session.Session & {
  tidalLink?: { state: string; discordUserId: string; verifier: string };
  tidalResult?: "success" | "failed" | "cancelled";
};
const digest = (state: string) => createHash("sha256").update(state).digest("hex");
const save = (req: express.Request) =>
  new Promise<void>((resolve, reject) =>
    req.session.save((error) => (error ? reject(error) : resolve())),
  );
export function tidalRedirectUri() {
  return (
    process.env.TIDAL_REDIRECT_URI ||
    new URL(
      "/auth/tidal/callback",
      process.env.DISCORD_REDIRECT_URI || "https://dis.sashimi.zip",
    ).toString()
  );
}

export function mountTidalAuth(
  app: express.Express,
  userId: (req: express.Request) => string | null,
) {
  app.get("/auth/tidal", async (req, res) => {
    res.set({ "Cache-Control": "private, no-store", "Referrer-Policy": "no-referrer" });
    const id = userId(req);
    if (!id) return res.redirect("/auth/discord");
    const config = tidalClientConfig();
    if (!config) return res.status(503).send("Tidal account linking is not configured.");
    const state = randomBytes(32).toString("hex");
    const verifier = randomBytes(32).toString("base64url");
    (req.session as LinkSession).tidalLink = { state, discordUserId: id, verifier };
    tidalUsers.begin(digest(state), id, req.sessionID);
    try {
      await save(req);
    } catch {
      return res.sendStatus(503);
    }
    const url = new URL("https://login.tidal.com/authorize");
    url.search = new URLSearchParams({
      response_type: "code",
      client_id: config.id,
      redirect_uri: tidalRedirectUri(),
      state,
      scope: SCOPES.join(" "),
      code_challenge_method: "S256",
      code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    }).toString();
    return res.redirect(url.toString());
  });
  app.get("/auth/tidal/callback", async (req, res) => {
    res.set({ "Cache-Control": "private, no-store", "Referrer-Policy": "no-referrer" });
    const link = req.session as LinkSession;
    const id = userId(req);
    const received = req.query.state;
    const expected = link.tidalLink;
    link.tidalResult = "failed";
    if (
      !id ||
      !expected ||
      expected.discordUserId !== id ||
      typeof received !== "string" ||
      !/^[a-f0-9]{64}$/.test(received) ||
      !/^[a-f0-9]{64}$/.test(expected.state) ||
      !timingSafeEqual(Buffer.from(received), Buffer.from(expected.state)) ||
      !tidalUsers.claim(digest(received), id, req.sessionID)
    )
      return res.redirect(303, "/auth/tidal/result");
    delete link.tidalLink;
    try {
      await save(req);
      if (req.query.error) {
        link.tidalResult = "cancelled";
      } else {
        const config = tidalClientConfig();
        const code = req.query.code;
        if (!config || typeof code !== "string" || !code || code.length > 4096)
          throw new Error("Invalid callback");
        const response = await fetch("https://auth.tidal.com/v1/oauth2/token", {
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
            redirect_uri: tidalRedirectUri(),
            code_verifier: expected.verifier,
          }),
        });
        if (!response.ok) throw new Error("Exchange unavailable");
        const token = (await response.json()) as {
          access_token?: unknown;
          refresh_token?: unknown;
          expires_in?: unknown;
          scope?: unknown;
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
              !SCOPES.every((scope) => (token.scope as string).split(" ").includes(scope))))
        )
          throw new Error("Incomplete grant");
        const profileResponse = await fetch("https://openapi.tidal.com/v2/users/me", {
          headers: {
            Authorization: `Bearer ${token.access_token}`,
            Accept: "application/vnd.api+json",
          },
          redirect: "error",
          signal: AbortSignal.timeout(8000),
        });
        if (!profileResponse.ok) throw new Error("Profile unavailable");
        const profile = (await profileResponse.json()) as {
          data?: {
            id?: unknown;
            attributes?: { username?: unknown; firstName?: unknown; lastName?: unknown };
          };
        };
        const data = profile.data;
        if (!data || typeof data.id !== "string" || !data.id || data.id.length > 256)
          throw new Error("Invalid profile");
        const attributes = data.attributes;
        const name =
          [attributes?.firstName, attributes?.lastName]
            .filter((v) => typeof v === "string" && v)
            .join(" ") || (typeof attributes?.username === "string" ? attributes.username : "");
        const expiresAt = Date.now() + token.expires_in * 1000;
        if (!Number.isSafeInteger(expiresAt)) throw new Error("Invalid expiration");
        if (
          tidalUsers.complete(digest(received), {
            discord_user_id: id,
            access_token: token.access_token,
            refresh_token: token.refresh_token,
            expires_at: expiresAt,
            tidal_user_id: data.id,
            tidal_display_name: name.slice(0, 256) || null,
            updated_at: Date.now(),
          })
        )
          link.tidalResult = "success";
      }
      await save(req);
    } catch {
      // Never log credentials, codes, token responses or raw network errors.
    }
    return res.redirect(303, "/auth/tidal/result");
  });
  app.get("/auth/tidal/result", (req, res) => {
    res.set({ "Cache-Control": "private, no-store", "Referrer-Policy": "no-referrer" });
    const result = (req.session as LinkSession).tidalResult;
    return res.render("tidal-result", {
      success: result === "success",
      message:
        result === "success"
          ? "✅ Tidal Linked Successfully. Return to Discord and run /tidal playlists."
          : result === "cancelled"
            ? "Tidal linking was cancelled."
            : "Tidal linking could not be confirmed. Sign in and try again.",
    });
  });
  app.post("/auth/tidal/unlink", express.json({ limit: "1kb" }), async (req, res) => {
    res.set("Cache-Control", "private, no-store");
    const id = userId(req);
    if (!id) return res.sendStatus(401);
    if (req.get("X-Sashimi-Request") !== "tidal" || !req.is("application/json"))
      return res.sendStatus(403);
    tidalUsers.unlink(id);
    delete (req.session as LinkSession).tidalLink;
    await save(req);
    return res.json({ linked: false });
  });
}
