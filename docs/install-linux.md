# Installing directly on Linux (no containers)

This guide runs Radio Bot as a normal service on a Linux machine: a dedicated server, a cloud virtual machine, or any always-on Linux computer. If you would rather use containers, see [install-docker.md](install-docker.md) or [install-container-platforms.md](install-container-platforms.md).

The bot needs **outbound** internet access to Discord (HTTPS, WebSocket and UDP for voice) and to the radio stream hosts. It needs **no inbound port, domain or reverse proxy**.

You run your own Discord application with your own token. Radio Bot is unofficial and is not affiliated with or endorsed by Radio FG / Maison FG or any broadcaster. Before running it for anyone other than yourself, read [rights-and-disclaimer.md](rights-and-disclaimer.md).

> Status: this path follows standard Node.js and systemd practice. Like the other deployment paths, it has not yet been smoke-tested end to end against a live Discord server for v1.0.0.

## Requirements

- A 64-bit Linux distribution with systemd (for example Debian 12/13 or Ubuntu 24.04 LTS).
- **Node.js 24.17 or newer.** Check with `node --version`. Use your distribution's packages if they are new enough, or the official Node.js binaries.
- **FFmpeg and FFprobe with the `libopus` encoder.** On Debian/Ubuntu: `sudo apt install ffmpeg`. Check with `ffmpeg -hide_banner -encoders | grep libopus`.
- `git`, and `corepack` (shipped with Node.js) for pnpm.
- A Discord application and bot token. Follow [install.md → Create your Discord bot](install.md#1-create-your-discord-bot); those steps don't depend on how you host the bot.

## 1. Get and build the code

```bash
sudo git clone https://github.com/DangerMouseUK/radiobot.git /opt/radio-bot
cd /opt/radio-bot
sudo corepack enable
sudo pnpm install --frozen-lockfile --ignore-scripts
sudo pnpm run build
sudo pnpm prune --prod --ignore-scripts
```

`--ignore-scripts` skips the download of a bundled FFmpeg that is only used by the test suite; the service uses the FFmpeg you installed above.

## 2. Configure

```bash
sudo mkdir -p /etc/radio-bot
sudo cp /opt/radio-bot/.env.example /etc/radio-bot/radio-bot.env
sudo chmod 600 /etc/radio-bot/radio-bot.env
sudo nano /etc/radio-bot/radio-bot.env
```

Set at least `DISCORD_TOKEN` and `DISCORD_APPLICATION_ID`. Leave `DATABASE_PATH` commented out, as it is in `.env.example`: the service unit sets it to `/var/lib/radio-bot/radio-bot.sqlite`, and systemd lets a value in the env file override the unit's, which would point the bot at a directory it cannot write to. Leave `FFMPEG_PATH`/`FFPROBE_PATH` commented out if `ffmpeg` and `ffprobe` are on the system `PATH`.

## 3. Install the service

```bash
sudo cp /opt/radio-bot/deploy/systemd/radio-bot.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now radio-bot
```

If `node` is not at `/usr/bin/node` (check with `command -v node`), edit `ExecStart=` in the unit first.

If the configuration is invalid the bot exits with code 78, and the unit doesn't restart it (`RestartPreventExitStatus=78`): fix the env file, then `sudo systemctl restart radio-bot`. `journalctl -u radio-bot` shows which variable is wrong.

The unit runs the bot as an unprivileged, throwaway user (`DynamicUser=yes`) with a read-only view of the system. systemd creates the data directory for it.

## Where the data lives

Everything the bot stores is under **`/var/lib/radio-bot/`** (systemd's `StateDirectory`; with `DynamicUser` the real path is `/var/lib/private/radio-bot`, symlinked from `/var/lib/radio-bot`):

| Path | Contents |
|---|---|
| `radio-bot.sqlite` (+ `-wal`, `-shm`) | Server settings, favourites, station queues, custom stations, source evidence |
| `backups/` | Automatic pre-migration backups (newest 5 kept) and manual backups (newest 10 kept) |
| `health.json` | Heartbeat written every 30 s |

Back up `/var/lib/radio-bot/` like any other application data. Nothing is written anywhere else.

## Day-to-day

- **Logs:** `journalctl -u radio-bot -f` (JSON lines; set `LOG_LEVEL` in the env file).
- **Health:** `cd /opt/radio-bot && sudo DATABASE_PATH=/var/lib/radio-bot/radio-bot.sqlite node dist/scripts/healthcheck.js` prints `healthy: ok` when the heartbeat is fresh and Discord is connected.
- **Manual backup:** `cd /opt/radio-bot && sudo DATABASE_PATH=/var/lib/radio-bot/radio-bot.sqlite node dist/scripts/backup.js`. Run as root, the backup gives the new files to the database's owner, so the service can still rotate them.
- **First run in Discord:** use `/radio config` in your server to set channels, roles and idle mode.

## Upgrading

```bash
cd /opt/radio-bot
sudo git fetch --tags && sudo git checkout v1.0.1   # the release you want
sudo pnpm install --frozen-lockfile --ignore-scripts
sudo pnpm run build
sudo pnpm prune --prod --ignore-scripts
sudo systemctl restart radio-bot
```

Database migrations run on start-up and take a backup into `backups/` first. A newer database is never opened by an older build.

## Uninstalling

```bash
sudo systemctl disable --now radio-bot
sudo rm /etc/systemd/system/radio-bot.service
sudo systemctl daemon-reload
sudo rm -rf /opt/radio-bot /etc/radio-bot
sudo rm -rf /var/lib/private/radio-bot /var/lib/radio-bot   # deletes all bot data
```
