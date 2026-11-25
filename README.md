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

The dashboard listens on `PORT` (default `8080`). On Fly, set the OAuth credentials and
`SESSION_SECRET` as secrets. Users see servers they can manage where the bot is present;
the configured admin sees all bot servers. Requests, plays, skips, stops, commands,
and raw events are tracked from this version onward (existing usage is not backfilled).
Per-server storage is an estimate
of cached tracks requested by that server, not exclusive disk usage: cached files can
be shared by multiple servers, and files downloaded but never queued are not included.
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
| `/add [query]` | Adds a YouTube URL to your library (playlist or track) and downloads the tracks locally. |
| `/update playlist [playlist]` | Updates a playlist in your library (eg. when new tracks are added.) | |
| `/update all` | Updates all saved playlists in your library. | |
| `/stop`  | Stops music, clears the queue, and removes Sashimi from the voice channel.  |  |
| `/skip`  | Skips the current playing track in the queue. | `track`: Skip to a specific track in queue. |
| `/shuffle` | Shuffles tracks in the queue after the currently playing song. | |
| `/queue` | Lists the current queue and currently playing track. | `page`: View another page of the queue, if necessary. |
| `/remove queue [track]` | Removes a track from the queue. | | |
| `/remove (playlist \| saved-track) [item]` | Removes an item from your library. | |
