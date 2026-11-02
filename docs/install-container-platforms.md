# Running on a container platform

Radio Bot ships a standard `Dockerfile`, so any platform that can build or run a container image *and* keep it running can host it. This page lists what such a platform must provide and how the common options compare. For your own machine, use [install-docker.md](install-docker.md) (Docker Compose) or [install-linux.md](install-linux.md) (no containers).

> Status: none of the platforms named here have been tested with Radio Bot. The requirements below come from how the bot works, and the platform notes describe each platform's documented model. Check the current documentation of the platform you choose.

## What the platform must provide

| Requirement | Why |
|---|---|
| **A long-running process ("worker" / "background service")** | The bot holds a permanent WebSocket connection to Discord and streams audio continuously. It cannot run as a request-driven or serverless function. |
| **Outbound TCP and UDP** | Discord voice audio is sent over **UDP**. Outbound HTTPS is needed for Discord's API and the radio streams. |
| **No inbound port** | The bot serves nothing. Choose a worker/background type that does not require an HTTP port or health-check URL. |
| **A persistent volume mounted at `/app/data`** | SQLite holds server settings, favourites and custom stations. Without a persistent volume, all of that resets on every redeploy or restart. |
| **Secret environment variables** | At least `DISCORD_TOKEN` and `DISCORD_APPLICATION_ID`. See `.env.example` for the rest. |
| **Enough CPU for FFmpeg** | One FFmpeg encode per active voice channel. Benchmark on your plan before relying on it. |

The image runs as a non-root user and writes only to `/app/data` and `/tmp`.

## Platform notes

### Platforms with persistent volumes

Any platform that runs a long-lived container **and** attaches a persistent volume meets every requirement. Deploy from the repository's `Dockerfile` (or the published image), mount a volume at `/app/data`, set the environment variables, and don't configure an HTTP port or HTTP health check.

### DigitalOcean App Platform

Deploy the repository as a **Worker** component built from the `Dockerfile`; a worker does not need an HTTP port. Two limits to know:

- **No persistent volumes.** App Platform's filesystem is ephemeral, so the SQLite database is lost whenever the app redeploys or restarts. Per-server settings made with `/radio config`, favourites and custom stations would all reset. That is fine for evaluation but not for a server people rely on. For lasting settings, run the container on a Droplet with Docker ([install-docker.md](install-docker.md)) or directly on Linux ([install-linux.md](install-linux.md)).
- **Confirm outbound UDP** for Discord voice on your plan before committing.

### Vercel and other serverless/function platforms

**Not supported.** Vercel runs request-driven serverless functions with execution time limits. It cannot keep a Discord gateway connection open, keep a voice connection, or run FFmpeg continuously, and it has no persistent disk. The same applies to other function-as-a-service platforms (for example AWS Lambda or Cloudflare Workers).

## Generic deployment steps

1. Create your Discord application and bot token ([install.md → Create your Discord bot](install.md#1-create-your-discord-bot)).
2. Create a **worker/background** service from this repository's `Dockerfile`, or from a published image (`ghcr.io/dangermouseuk/radio-bot:<version>`).
3. Attach a **persistent volume at `/app/data`** (if the platform has them).
4. Set `DISCORD_TOKEN` (as a secret) and `DISCORD_APPLICATION_ID`. Leave `DATABASE_PATH`, `FFMPEG_PATH` and `FFPROBE_PATH` unset; the image's defaults are correct.
5. Do **not** expose a port or configure an HTTP health check. The image has its own `HEALTHCHECK` (`nice -n 19 node dist/scripts/healthcheck.js`, at the lowest CPU priority) for platforms that honour Docker health checks.
6. Deploy, then run `/radio config` in your Discord server.

Logs are JSON lines on stdout; read them in the platform's log viewer.
