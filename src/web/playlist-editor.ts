import { isProviderEnabled } from "@/core/db/bot-settings";
import { userPlaylists } from "@/core/db/user-playlists";
import { providers } from "@/core/manager";
import { getValidSpotifyAccessToken } from "@/providers/spotify/tokens";
import express from "express";

export function mountPlaylistEditor(
  app: express.Express,
  auth: express.RequestHandler,
  owner: (req: express.Request) => string | null,
) {
  app.get("/playlists/:id", auth, (req, res) => {
    const userId = owner(req);
    const playlist = userId ? userPlaylists.get(userId, Number(req.params.id)) : undefined;
    if (!playlist) return res.sendStatus(404);
    return res.render("playlist-editor", {
      playlist,
      username: "Your playlists",
      avatarUrl: "",
      isAdmin: userId === "258189484053495809",
    });
  });
  app.get("/api/playlists/:id", auth, (req, res) => {
    const playlist = userPlaylists.get(owner(req) ?? "", Number(req.params.id));
    return playlist ? res.json({ playlist }) : res.sendStatus(404);
  });
  app.put("/api/playlists/:id", auth, express.json({ limit: "2kb" }), (req, res) => {
    const id = Number(req.params.id),
      userId = owner(req) ?? "";
    if (!userPlaylists.get(userId, id)) return res.sendStatus(404);
    if (
      typeof req.body?.name !== "string" ||
      !req.body.name.trim() ||
      req.body.name.trim().length > 100
    )
      return res.sendStatus(400);
    try {
      userPlaylists.rename(userId, id, req.body.name);
      return res.json({ playlist: userPlaylists.get(userId, id) });
    } catch {
      return res.status(409).json({ error: "Playlist name already exists." });
    }
  });
  app.delete("/api/playlists/:id/tracks/:trackId", auth, (req, res) => {
    const userId = owner(req) ?? "",
      id = Number(req.params.id),
      entryId = Number(req.params.trackId);
    if (!Number.isSafeInteger(entryId) || !userPlaylists.removeTrack(userId, id, entryId))
      return res.sendStatus(404);
    return res.json({ playlist: userPlaylists.get(userId, id) });
  });
  app.post("/api/playlists/:id/reorder", auth, express.json({ limit: "16kb" }), (req, res) => {
    const id = Number(req.params.id),
      userId = owner(req) ?? "";
    if (!userPlaylists.get(userId, id)) return res.sendStatus(404);
    const ids: unknown = req.body?.trackIds;
    if (
      !Array.isArray(ids) ||
      ids.length > 1000 ||
      !ids.every((value) => Number.isSafeInteger(value) && value > 0)
    )
      return res.sendStatus(400);
    try {
      userPlaylists.reorder(userId, id, ids);
      return res.json({ playlist: userPlaylists.get(userId, id) });
    } catch {
      return res.status(409).json({ error: "Playlist changed. Refresh before reordering." });
    }
  });
  app.get("/api/search/youtube", auth, async (req, res) => {
    const q = req.query.q;
    if (typeof q !== "string" || !q.trim() || q.length > 200) return res.sendStatus(400);
    const youtube = providers.find(
      (provider) => provider.id === "youtube" && isProviderEnabled(provider.id),
    );
    if (!youtube?.search) return res.status(503).json({ error: "YouTube search is unavailable." });
    try {
      const track = await youtube.search(q.trim());
      return res.json({ tracks: track ? [track] : [] });
    } catch {
      return res.status(502).json({ error: "No results or search temporarily unavailable." });
    }
  });
  app.post(
    "/api/playlists/:id/import/spotify",
    auth,
    express.json({ limit: "2kb" }),
    async (req, res) => {
      const userId = owner(req) ?? "",
        id = Number(req.params.id);
      if (!userPlaylists.get(userId, id)) return res.sendStatus(404);
      if (!(await getValidSpotifyAccessToken(userId)))
        return res.status(409).json({ error: "Link Spotify first at /auth/spotify." });
      const input = req.body?.playlist;
      let spotifyId = typeof input === "string" && /^[A-Za-z0-9]{1,64}$/.test(input) ? input : null;
      if (!spotifyId && typeof input === "string") {
        try {
          const url = new URL(input);
          if (url.protocol === "https:" && url.hostname === "open.spotify.com")
            spotifyId =
              url.pathname.match(/^\/(?:intl-[a-z]{2}\/)?playlist\/([A-Za-z0-9]{1,64})\/?$/)?.[1] ??
              null;
        } catch {
          /* Invalid URL is rejected below. */
        }
      }
      if (!spotifyId) return res.sendStatus(400);
      try {
        const resolver = providers.find(
          (provider) => provider.id === "spotify-link-resolver" && isProviderEnabled(provider.id),
        );
        const playlist = await resolver?.getPlaylist(`spotify:playlist:${spotifyId}`, {
          requestingUserId: userId,
        });
        if (!playlist?.tracks.length)
          return res.status(422).json({ error: "No playable tracks found." });
        if (!userPlaylists.append(userId, id, playlist.tracks)) return res.sendStatus(404);
        return res.json({ playlist: userPlaylists.get(userId, id) });
      } catch {
        return res
          .status(409)
          .json({ error: "Import failed or the 1000-track limit was exceeded." });
      }
    },
  );
}
