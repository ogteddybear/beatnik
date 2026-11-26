import { SoundCloudProvider } from "@/providers";
import { spotifyClientConfig } from "@/providers/spotify/tokens";
import { EmbedBuilder } from "discord.js";
import { stat } from "node:fs/promises";
import os from "node:os";

import { archivePath, db } from "./db/client";
import { providers } from "./manager";

export const OWNER_ID = "258189484053495809";
async function fileSize(file: string) {
  try {
    return `${((await stat(file)).size / 1024 / 1024).toFixed(2)} MiB`;
  } catch {
    return "Unavailable";
  }
}
export async function spotifyConnectivity(fetcher: typeof fetch = fetch) {
  const config = spotifyClientConfig();
  if (!config) return "Not configured";
  try {
    const response = await fetcher("https://accounts.spotify.com/api/token", {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(4000),
      headers: {
        Authorization: `Basic ${Buffer.from(`${config.id}:${config.secret}`).toString("base64")}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ grant_type: "client_credentials" }),
    });
    if (!response.ok) return `Token endpoint HTTP ${response.status}`;
    const token = (await response.json()) as { access_token?: unknown };
    if (typeof token.access_token !== "string" || !token.access_token)
      return "Invalid token response";
    const api = await fetcher("https://api.spotify.com/v1/search?q=music&type=track&limit=1", {
      redirect: "error",
      signal: AbortSignal.timeout(4000),
      headers: { Authorization: `Bearer ${token.access_token}` },
    });
    return api.ok ? "API reachable" : `API reachable, HTTP ${api.status}`;
  } catch {
    return "Unavailable / timed out";
  }
}
export async function diagnosticsEmbed() {
  const [mainSize, archiveSize, spotify] = await Promise.all([
    fileSize(db.name),
    fileSize(archivePath),
    spotifyConnectivity(),
  ]);
  const counts = db
    .prepare<[], { main: number; archive: number }>(
      `SELECT
    (SELECT count(*) FROM main.GuildEvents) AS main,
    (SELECT count(*) FROM event_archive.GuildEvents) AS archive`,
    )
    .get();
  if (!counts) throw new Error("Database event counts unavailable.");
  const soundcloud = providers.find((provider) => provider instanceof SoundCloudProvider);
  return new EmbedBuilder()
    .setTitle("Sashimi diagnostics")
    .setColor("#0a203b")
    .setTimestamp()
    .addFields(
      {
        name: "System",
        value: `Uptime: ${Math.floor(process.uptime())}s\nRAM (RSS): ${(process.memoryUsage().rss / 1024 / 1024).toFixed(1)} MiB\nCPU load (1/5/15m): ${
          process.platform === "win32"
            ? "Unavailable on Windows"
            : os
                .loadavg()
                .map((value) => value.toFixed(2))
                .join(" / ")
        }`,
      },
      {
        name: "Database",
        value: `Main: ${mainSize}\nArchive: ${archiveSize}\nGuildEvents: ${counts.main + counts.archive} (${counts.main} live / ${counts.archive} archived)`,
      },
      {
        name: "Providers",
        value: `SoundCloud: ${soundcloud instanceof SoundCloudProvider ? soundcloud.getClientIdStatus() : "Not initialized"}\nYouTube: ${providers.some((provider) => provider.id === "youtube") ? "SABR + yt-dlp fallback enabled (configured, not probed)" : "Not initialized"}\nSpotify: ${spotify}`,
      },
    );
}
