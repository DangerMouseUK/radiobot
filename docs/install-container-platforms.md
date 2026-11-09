# Running on a container platform

Radio Bot ships a standard `Dockerfile`, and every release publishes a ready-made image. Any hosting platform that can run a container *and* keep it running all the time can host it. This page lists what such a platform must provide, and how the common kinds of platform compare. For your own machine, use [install.md](install.md) (the beginner's installer), [install-docker.md](install-docker.md) (Docker Compose by hand) or [install-linux.md](install-linux.md) (no containers).

> Status: none of the platforms named here have been tested with Radio Bot. The requirements below come from how the bot works, and the platform notes describe each platform's documented model. Check the current documentation of the platform you choose.

## What the platform must provide

| Requirement | Why |
|---|---|
| **A long-running process** (often called a "worker" or "background service") | The bot keeps a permanent connection to Discord and streams audio continuously. It can't run as a function that starts per request. |
| **Outbound TCP and UDP** | Discord voice audio is sent over **UDP**. Outbound HTTPS is needed for Discord's API, the radio streams and the station pack library on `github.com`. |
| **No inbound port** | The bot serves nothing. Choose a worker or background type that doesn't require an HTTP port or a health-check URL. |
| **A persistent volume mounted at `/app/data`** | The bot's SQLite database there holds server settings, favourites and custom stations, and its `installed-packs` folder holds the station packs you installed. Without a persistent volume, all of that resets on every redeploy or restart. The image runs as the `node` user (UID 1000), so the volume must be writable by that user. |
| **Secret environment variables** | At least `DISCORD_TOKEN` and `DISCORD_APPLICATION_ID`. See `.env.example` and the [README's configuration table](../README.md#configuration) for the rest. |
| **Enough CPU and memory** | One FFmpeg encoder runs per Discord server that is playing. One stream used about 8% of one CPU core and about 200 MB of memory in total; plan for 1 GB of memory. Check on your plan before relying on it. |
| **A 64-bit x86 or ARM machine** | Images are published for `linux/amd64` and `linux/arm64`. |

The image runs as a non-root user and writes only to `/app/data` and `/tmp`.

## Platform notes

### Platforms with persistent volumes

Any platform that runs a long-lived container **and** attaches a persistent volume meets every requirement. Deploy from the published image (or the repository's `Dockerfile`), mount a volume at `/app/data`, set the environment variables, and don't configure an HTTP port or HTTP health check.

### DigitalOcean App Platform

Deploy the repository as a **Worker** component built from the `Dockerfile`; a worker doesn't need an HTTP port. Two limits to know:

- **No persistent volumes.** App Platform's filesystem is temporary, so the SQLite database is lost whenever the app redeploys or restarts. Per-server settings made with `/radio config`, favourites, custom stations and installed station packs would all reset. That is fine for trying it out, but not for a server people rely on. For lasting settings, run the container on a Droplet with Docker ([install-docker.md](install-docker.md)) or directly on Linux ([install-linux.md](install-linux.md)).
- **Confirm outbound UDP** for Discord voice on your plan before committing.

### Vercel and other serverless or function platforms

**Not supported.** Vercel runs serverless functions that start per request and have time limits. They can't keep a Discord connection or a voice connection open, or run FFmpeg continuously, and they have no persistent disk. The same applies to other function-as-a-service platforms, for example AWS Lambda or Cloudflare Workers.

## Generic deployment steps

1. Create your Discord application and bot token ([install.md → Create your Discord bot](install.md#1-create-your-discord-bot)).
2. Create a **worker** or **background** service from the published image, `ghcr.io/dangermouseuk/radio-bot:<version>` (for example `1.5.0`), or from this repository's `Dockerfile`.
3. Attach a **persistent volume at `/app/data`**, if the platform has them.
4. Set `DISCORD_TOKEN` (as a secret) and `DISCORD_APPLICATION_ID`. Leave `DATABASE_PATH`, `FFMPEG_PATH` and `FFPROBE_PATH` unset; the image's defaults are correct.
5. Do **not** expose a port or configure an HTTP health check. The image has its own `HEALTHCHECK` for platforms that use Docker health checks: a small shell script (`sh /app/scripts/healthcheck.sh`) that reads the bot's heartbeat file every 2 minutes, at the lowest CPU priority so it can't delay the audio. If your platform asks for a command health check, use that one, and keep it as infrequent.
6. Deploy. In the platform's log viewer you should see `connected to Discord` within a minute. If the settings are invalid, the bot exits with code 78 and the log names the variable that is wrong.
7. Invite the bot with the link in [install.md, step 3](install.md#3-invite-the-bot-to-your-server), using your own Application ID, then run `/radio config` in your Discord server.
8. Add stations. The bot ships with none: they come in station packs from the official pack library. As the owner of the bot's Discord application (or a user listed in `OPERATOR_USER_IDS`), run `/radio packs library` in a server where you are an admin, pick a pack from the menu and press **Install**. It runs in the background and needs no restart.

Logs are JSON lines on standard output; read them in the platform's log viewer.

## Station packs on a platform

Platforms rarely give you a shell in the running container, so install, update and remove packs from Discord: `/radio packs library` to install, `/radio packs installed` to update or remove. Discord installs only from the official library. If your platform does let you run a command in the container, `node dist/scripts/packs.js` works there too (see [install-docker.md → Station packs](install-docker.md#station-packs)); the bot then needs `SIGHUP` or a restart to load the change.

- Installed packs live in `/app/data/installed-packs/`, in the persistent volume. On a platform without persistent volumes they are lost on every redeploy, like the settings.
- At start-up, before anything plays, the bot reinstalls from the official library any pack its database uses but doesn't have, for example after updating from a version that included a pack. Once a day it checks the library for updates (which the bot's operator installs from `/radio packs installed`) and for withdrawn packs (which it removes). Both need outbound HTTPS to `github.com`; if that fails, the bot logs a warning and tries again later.
