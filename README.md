# Sashimi - a music bot for Discord

[![GitHub release (latest by semver)](https://img.shields.io/github/v/release/vphoebe/beatnik)](https://github.com/vphoebe/beatnik/releases)
[![Node.js v22](https://img.shields.io/badge/node-v22.x-brightgreen)](https://nodejs.org/en/blog/release/v22.0.0)
[![License](https://img.shields.io/github/license/vphoebe/beatnik)](https://github.com/vphoebe/beatnik/blob/main/LICENSE)
[![Docker Latest](https://img.shields.io/docker/image-size/nickseman/beatnik/latest?label=docker%20size)](https://hub.docker.com/r/nickseman/beatnik/tags?name=latest)
[![Docker Pulls](https://img.shields.io/docker/pulls/nickseman/beatnik)](https://hub.docker.com/r/nickseman/beatnik)
[![Last Commit](https://img.shields.io/github/last-commit/vphoebe/beatnik)](https://github.com/vphoebe/beatnik/commits)

A modern music bot for your Discord server that you can host yourself! No subscription fees, service API keys, or advanced knowledge required.

## 🥁 Features
- Use easy to understand slash commands to play audio from YouTube videos in your server's voice channels
- Save YouTube playlists and videos to your library for fast, local playback
  - Adding to your library downloads the audio and metadata locally, so future plays don't require the API
- Get up and running using Docker in minutes
- No fees, service tokens, or privacy concerns - everything is operated by you locally

## 🚀 Get started

### Discord application setup
1. Sign into the [Discord developer portal](https://discord.com/developers/applications "Discord developer portal") and create a new application. You can call it whatever you'd like and set a profile picture for it. You'll return here later to grab your token and client ID.
2. Once created, navigate to **OAuth2** on the left sidebar. Scroll down to **OAuth2 URL Generator** and make the following changes:
	- Under *Scopes*, check `applications.commands` and `bot`.
	- Under *Bot Permissions*, check `Send Messages`, `Connect`, and `Speak`.
3. Copy the generated URL, paste into your web browser, and select a Discord server to add Sashimi to.

### Docker

You can use this example Docker compose file to get Sashimi up and running.

```yaml
services:
  sashimi:
    container_name: "sashimi"
    image: "nickseman/beatnik:latest"
    ports:
      - "8080:8080"
    volumes:
      - "/path/on/your/computer/library.db:/app/library.db"
      - "/path/on/your/computer/library:/app/library"
    environment:
      - TOKEN=xxxxxxxxxx
      - CLIENT_ID=00000000
      - DISCORD_CLIENT_ID=00000000
      - DISCORD_CLIENT_SECRET=your-discord-oauth-client-secret
      - DISCORD_REDIRECT_URI=http://localhost:8080/auth/callback
      - SESSION_SECRET=replace-with-a-long-random-secret
    restart: always
```

Change `/path/on/your/computer` to a directory where Sashimi's files can live, such as `/Users/me/Documents/Sashimi`. Create a new folder called `library` inside there, as well as an empty file called `library.db`. Then, set the environment variables in your Docker compose file:

| Variable  |  Where to find |
| ------------ | ------------ |
| `TOKEN`  | Discord developer portal > Applications > [your app] > Bot > Token  |
| `CLIENT_ID` | Discord developer portal > Applications > [your app] > OAuth2 > Client ID  |
| `PLAYER_ID` | (Optional) Player ID override. Can be used to work around temporary issues when YouTube introduces breaking changes by forcing an older player. |
| `DISCORD_CLIENT_ID` | (Optional) Discord OAuth2 application Client ID; defaults to the bot's `CLIENT_ID`. |
| `DISCORD_CLIENT_SECRET` | Discord OAuth2 application Client Secret. Keep private. |
| `DISCORD_REDIRECT_URI` | Discord OAuth2 redirect URL; for Fly, `https://dis.sashimi.zip/auth/callback`. Register this URL in the Discord developer portal. |
| `SESSION_SECRET` | A long, random secret used to sign dashboard session cookies. Keep private. |
| `FLY_API_TOKEN` | Required for Fly platform metrics in the owner Infrastructure Health panel. Supply a read-scoped token with access to the organization's Prometheus endpoint. Keep this server-only, preferably as a Fly secret; never put it in client JavaScript or HTML. |
| `FLY_ORG_SLUG` | Required for Fly platform metrics. Organization slug used by `https://api.fly.io/prometheus/<org-slug>/api/v1/query`; configure as a Fly secret alongside the token. |

Generate the read-only dashboard metrics token with:

```sh
fly tokens create readonly --name "sashimi-dashboard-metrics" --expiry 8760h
```

Store the output securely as `FLY_API_TOKEN`; do not commit or share it.
Raw Macaroon tokens beginning with `fm2_` are sent with the `FlyV1` authorization
scheme. Values already beginning with `FlyV1 ` are used unchanged. Other token
formats retain legacy `Bearer` authentication.

Infrastructure Health is visible only to owner `258189484053495809` on `/admin`.
It displays process RSS and uptime, 1/5/15-minute OS load averages, and a rough
CPU load percentage (1-minute load divided by CPU core count, not actual CPU
utilization). CPU load is unavailable on Windows, where Node reports zero load averages.
Fly queries retrieve machine memory and the `beatnik_data` volume's total/free
space. Requests run concurrently with three-second timeouts; platform results
are cached for 15 seconds, and the visible admin page refreshes every 15 seconds.
Missing credentials, failed queries, empty results, or ambiguous machine series
do not prevent startup or dashboard loading. Individual metrics show
“Unavailable”; process RAM still shows RSS when its platform limit is unavailable.
Where available, Node's `fs.statfs('/data')` provides a clearly labeled local
filesystem fallback for volume capacity (which can differ from provisioned size).
The token, organization slug, request headers, and raw API responses are never
sent to the browser.

For bot installation to return to Sashimi, register
`https://dis.sashimi.zip/invite/callback` under **Discord Developer Portal →
Application → OAuth2 → Redirects** (in addition to the existing login redirect
`https://dis.sashimi.zip/auth/callback`). The installation callback URL is built
from the origin of `DISCORD_REDIRECT_URI`, so register `<same origin>/invite/callback`
when using a different host. Configure the application for **Guild Install**;
the invite explicitly requests `bot`, `applications.commands`, and `identify`
with the authorization code flow. The callback exchanges the one-time code,
does not display tokens, and validates a session-bound state. Registration is a
manual portal step; changing application settings is not done by this repo.
Installation confirmation uses a guild in Discord's token response, the bot's
gateway cache, or a bot-authenticated guild lookup. It does not infer membership
from the OAuth scope string (Discord can return an empty scope for a successful
bot install). The callback's `guild_id` is only a hint until membership is checked.
Missing cache entries, temporary API failures, and interrupted code exchanges
remain pending rather than prompting another invite. The result page rechecks
the session-bound receipt for up to two minutes, pauses while hidden, and offers
a manual confirmation check. REST checks are throttled and receipts expire after
ten minutes without converting an unknown installation into a failure. Explicit
Discord denial, invalid/expired callbacks, and authorization errors have distinct
messages. No codes or tokens are stored in the receipt or logged. The bot's
default standalone invite links are not changed by this flow.

The dashboard listens on `PORT` (default `8080`). On Fly, set the OAuth credentials and
`SESSION_SECRET` as secrets. Users see servers they can manage where the bot is present;
the configured admin sees all bot servers. Requests, plays, skips, stops, commands,
and raw events are tracked from this version onward (existing usage is not backfilled).
The owner-only server detail view groups recorded events into 24-hour, 7-day,
and 30-day ranges and provides a paginated, filterable activity feed. Library
add/update/remove events are recorded from this version onward; an add counts
a library operation, not the number of tracks. Historical library additions
are not inferred from queued requests.
New events snapshot the actor's username and track title when available; older
events retain null fields rather than inventing historical names. Successful new
cache writes log a separate `library/download` event. Voice joins/leaves, explicit
volume changes (`/volume percent:0..200`), and clearing upcoming tracks (`/clear`,
which leaves the current track playing) are also recorded.
While a voice session is active, one Now Playing message is edited as tracks
change and every 15 seconds. Its buttons pause/resume, skip, and cycle loop mode
Off → Track → Queue → Off. Users must be in the bot's voice channel; expired
panels cannot control a new session. Ending playback removes the buttons.
Track repeat applies only to natural completion, not explicit skips or errors.
Queue repeat wraps to the first track; an entirely failed queue stops rather
than retrying forever.

The regular and owner dashboards show Now Playing widgets for only the
guilds already visible to that user, including artist, thumbnail, progress,
loop/paused state, and up to five upcoming tracks. State refreshes every 15 seconds
while the page is visible. Queues, voice/text channel IDs, playback index, loop
mode and pause state are saved to SQLite on mutations and restored after Discord
is ready on restart. The current track restarts from its beginning; volume and
exact playback position are not persisted. `/stop`, queue completion and voice
departure clear the saved row. Graceful deployment shutdown preserves it.
Seeking is not offered: the current provider
contract returns non-seekable streams without a start-offset API.
Pause/resume, skip and stop buttons send authenticated remote actions. Unlike
Discord buttons, web controls do not require presence in the voice channel:
access requires the same bot-membership and MANAGE_GUILD/ADMINISTRATOR checks as
the dashboard (or the configured owner). Every request rechecks permissions,
requires JSON with `X-Sashimi-Request: control`, and uses the same voice-session
mutex as Discord controls. Buttons show pending state and errors; failed network
requests are never automatically retried, to avoid double-skipping.

`/remove position:<1-based index>` removes a queue entry while preserving the
current playback cursor. Removing the current track starts the next available
track, or wraps in queue-loop mode. Users must be in the bot's voice channel.
The previous saved-library removal subcommands are preserved under
`/library-remove playlist` and `/library-remove saved-track` (the legacy `queue`
subcommand is also available there). `/history` lists the last ten recorded
playback starts for this guild, including the current track, repeats, and
archived events. History survives restarts; older events without recorded titles
show “Unknown track”. Command definitions use version `1.8.0`.

### Personal Spotify accounts

Users can link Spotify from the dashboard's **Spotify Account** card or
`/spotify link`. Set `SPOTIFY_CLIENT_ID` and `SPOTIFY_CLIENT_SECRET`, and register
`https://dis.sashimi.zip/auth/spotify/callback` as an exact redirect URI in the
Spotify developer dashboard. `SPOTIFY_REDIRECT_URI` can override the callback;
otherwise its origin is derived from `DISCORD_REDIRECT_URI` (production defaults
to `https://dis.sashimi.zip`).

The authorization requests `playlist-read-private`, `playlist-read-collaborative`,
and `user-read-private`. Sign into the Sashimi dashboard first, then click the
Spotify link again if you were redirected through Discord login. Spotify
development-mode account eligibility and app allowlisting still apply.

All `/spotify` replies are ephemeral:

- `/spotify playlists page:1` lists the user's playlists privately.
- `/spotify load playlist:...` accepts autocomplete, a playlist ID, or a Spotify
  playlist URL and queues playable matches in the user's voice channel.
- `/spotify unlink` removes stored authorization; the dashboard also supports unlink.

`/play` automatically uses the requesting user's authorization for Spotify
playlists, falling back to public spotdl resolution when unlinked or denied
access. Private playlist metadata is not reused through the shared metadata cache.
Playlist discovery is private, but queued tracks appear in the normal shared
guild queue and playback controls.

Tokens are stored in SQLite and refreshed automatically, with refresh-token
rotation supported. Protect the database and its backups as credentials.
Unlinking deletes local tokens and cancels pending linking attempts; it does not
revoke Spotify-side consent (users can remove the app in Spotify account settings).

### Personal web playlists, lyrics and exports

`/playlists` lets signed-in users create private playlists, add supported HTTPS
YouTube/SoundCloud/Spotify track links, view tracks and delete playlists. All
queries are scoped to the signed-in owner, including autocomplete in Discord.
The dashboard's “Save Current Queue to Playlist” button copies the current track
and upcoming tracks (not the already-played prefix). Load one with
`/load custom name:"Chill Vibes"`; existing `/load playlist`, `/load track` and
`/load all` remain available. Creating playlists does not download audio.
Names are unique per owner (case-insensitive), with limits of 100 playlists per
owner and 1000 tracks per playlist. Mutation APIs require the
`X-Sashimi-Request: playlists` header and JSON for POSTs.

`/lyrics` searches `lyrics-finder` using the current track's artist and title.
Requests have an eight-second response timeout and a bounded ten-minute cache;
overlong lyrics are escaped and truncated to fit Discord's embed limit.
Lyrics lookup depends on an external search service and can be unavailable.

The owner-only `/api/admin/export/events` endpoint downloads all live and archived
events as CSV. The admin page links to it. Exports quote commas/newlines/quotes,
neutralize spreadsheet formulas, exclude events inserted after export starts,
and use bounded pages with network backpressure rather than holding a database
read lock for the whole download. New tables are installed by migration
`006_sessions_and_user_playlists`; back up the main and archive SQLite files.

Raw events older than 30 days are moved on startup and every 24 hours to
`LIBRARY_PATH/library-archive.db`. Each bounded batch copies and deletes events
atomically using an attached SQLite database with DELETE journals; IDs and
aggregate counters are preserved. Back up **both** the main and archive databases
together. Historical admin queries merge both stores in timestamp/ID order, with
cursor pagination; even short date ranges entirely before the retention boundary
include archived events. Existing 90-day maximum query windows still apply.
Cache files downloaded from guild library commands are stored in
`LIBRARY_PATH/<guildId>/<trackId>.cache`. On startup, flat `.cache` and `.opus`
files are moved to `LIBRARY_PATH/global/` and remain playable as a fallback.
Storage usage sums regular files directly in each guild's own directory (including
in-flight downloads); shared legacy files in `global/` are not attributed to any guild.
Each guild defaults to a 100 MB cache quota (1 MB = 1,048,576 bytes).
`/storage` shows usage, a ten-block progress bar, and the configured limit.
The owner can change quotas on the guild analytics page. A zero quota disables
new cache writes; lowering a quota never deletes existing files. Unknown-size
streams are checked chunk by chunk, and rejected or failed downloads leave no
partial audio cache. Concurrent cache writes are serialized per guild.
Quota rejections log `library/quota_exceeded`; uncached playback continues through
the normal provider streaming path. The owner settings API requires JSON and
`X-Sashimi-Request: quota` for cross-site request protection.
Dashboard sessions are stored in `LIBRARY_PATH/sessions.db` (on Fly's `/data` volume),
so sessions persist across deploys. `connect-sqlite3` requires the separate `sqlite3`
runtime driver; it does not use Sashimi's `better-sqlite3` database connection.


## 🎵 Usage
Sashimi uses Discord slash commands. You can type `/` in any text channel, and then click the Sashimi icon to see all the commands with descriptions.

|Command| Description | Options |
|--|--|--|
| `/play [query]` | Plays a video or playlist URL, or searches for a text query and plays the first result. | `end`: Adds to end of the queue, instead of next.<br> `shuffle`: Shuffles a playlist. |
| `/load (playlist \| track) [item]` | Loads a playlist or track from your library. | `end`: Adds to end of the queue, instead of next.<br> `shuffle`: Shuffles a playlist. |
| `/load all` | Loads all playlists into the queue and shuffles. | |
| `/load custom name:"Chill Vibes"` | Queues one of your personal web playlists. | `next`, `shuffle` |
| `/lyrics` | Finds lyrics for the currently playing track. | |
| `/add [query]` | Adds a YouTube URL to your library (playlist or track) and downloads the tracks locally. |
| `/update playlist [playlist]` | Updates a playlist in your library (eg. when new tracks are added.) | |
| `/update all` | Updates all saved playlists in your library. | |
| `/stop`  | Stops music, clears the queue, and removes Sashimi from the voice channel.  |  |
| `/skip`  | Skips the current playing track in the queue. | `track`: Skip to a specific track in queue. |
| `/shuffle` | Shuffles tracks in the queue after the currently playing song. | |
| `/queue` | Lists the current queue and currently playing track. | `page`: View another page of the queue, if necessary. |
| `/remove [position]` | Removes a track at its 1-based queue position. | |
| `/history` | Shows the last ten recorded playback starts for this server. | |
| `/library-remove (playlist \| saved-track) [item]` | Removes an item from your library. | |
