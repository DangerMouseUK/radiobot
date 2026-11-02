# Installing directly on Linux (no containers)

This guide runs Radio Bot as a normal system service on a Linux machine: a dedicated server, a cloud virtual machine, or any always-on Linux computer. It assumes you're comfortable with a terminal and `sudo`. If you'd rather use containers, see [install-docker.md](install-docker.md) or [install-container-platforms.md](install-container-platforms.md); if you're new to this, the [beginner's guide](install.md) is easier.

The bot needs **outbound** internet access to Discord (HTTPS, WebSocket and UDP for voice) and to the radio stream hosts. It needs **no inbound port, domain or reverse proxy**.

You run your own Discord application with your own token. Radio Bot is unofficial and is not affiliated with or endorsed by any broadcaster. Before running it for anyone other than yourself, read [rights-and-disclaimer.md](rights-and-disclaimer.md).

> Status: this path follows standard Node.js and systemd practice, but it has not yet been tested end to end against a live Discord server.

## Requirements

- A 64-bit Linux distribution with systemd (for example Debian 12 or 13, or Ubuntu 24.04 LTS).
- **Node.js 24.17 or newer.** Check with `node --version`. Use your distribution's packages if they are new enough, or the official Node.js binaries. The service expects `node` at `/usr/bin/node`; see [step 3](#3-install-the-service) if yours is elsewhere.
- **FFmpeg and FFprobe with the `libopus` encoder.** On Debian or Ubuntu: `sudo apt install ffmpeg`. Check with `ffmpeg -hide_banner -encoders | grep libopus`, which should print a line containing `libopus`.
- `git`, and `corepack` (it comes with Node.js) for the pnpm package manager.
- A Discord application and bot token. Follow [install.md → Create your Discord bot](install.md#1-create-your-discord-bot); those steps don't depend on how you host the bot.

## 1. Get and build the code

```bash
sudo git clone https://github.com/DangerMouseUK/radiobot.git /opt/radio-bot
cd /opt/radio-bot
sudo git checkout v1.0.5     # the newest release; the default branch may hold unreleased changes
sudo corepack enable
sudo pnpm install --frozen-lockfile --ignore-scripts
sudo pnpm run build
sudo pnpm prune --prod --ignore-scripts
```

- `git tag -l 'v*' --sort=-v:refname | head -n 1` prints the newest release tag.
- If corepack asks whether to download pnpm, answer `Y`.
- `--ignore-scripts` skips downloading a bundled FFmpeg that only the test suite uses; the service uses the FFmpeg you installed.

## 2. Configure

```bash
sudo mkdir -p /etc/radio-bot
sudo cp /opt/radio-bot/.env.example /etc/radio-bot/radio-bot.env
sudo chmod 600 /etc/radio-bot/radio-bot.env
sudo nano /etc/radio-bot/radio-bot.env
```

Set at least `DISCORD_TOKEN` and `DISCORD_APPLICATION_ID`. Every setting is explained in the file and in the [README's configuration table](../README.md#configuration).

- Leave `DATABASE_PATH` commented out, as it is in `.env.example`. The service unit sets it to `/var/lib/radio-bot/radio-bot.sqlite`, and a value in the env file would override the unit's and point the bot at a folder it can't write to.
- Leave `FFMPEG_PATH` and `FFPROBE_PATH` commented out if `ffmpeg` and `ffprobe` are on the system `PATH`.

## 3. Install the service

If `node` is not at `/usr/bin/node` (check with `command -v node`), first edit the `ExecStart=` line in `/opt/radio-bot/deploy/systemd/radio-bot.service` to point at it. Then:

```bash
sudo cp /opt/radio-bot/deploy/systemd/radio-bot.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now radio-bot
systemctl status radio-bot
```

`systemctl status` should say `active (running)`. Within a minute, `journalctl -u radio-bot` should show `connected to Discord`.

If the configuration is invalid, the bot exits with code 78, and the unit doesn't restart it (`RestartPreventExitStatus=78`). `journalctl -u radio-bot` shows which variable is wrong. Fix the env file, then run `sudo systemctl restart radio-bot`. For any other failure, systemd restarts the bot after 5 seconds.

What the unit does:

- It runs the bot as an unprivileged, throwaway user (`DynamicUser=yes`) with a read-only view of the system, and systemd creates the data folder for it.
- It puts the stream first. Voice packets go out every 20 ms, and a busy moment on a small host can make a few leave late, which listeners hear as a small cut. So:
  - `CPUWeight=1000` gives the bot ten times the usual share of the processor whenever other services want it at the same time (the default is 100). It is a share, not a limit: when nothing else is busy, other programs still get the whole processor.
  - `Nice=-5` puts the bot and its FFmpeg encoder slightly ahead of the other processes in the service. On systems that don't share the processor out by service, it also puts them ahead of ordinary programs.
  - `IOWeight=1000` does the same for disk access, on systems whose disk set-up supports it.
  - `OOMScoreAdjust=-500` tells the kernel that if the machine runs out of memory, it should stop other programs before the bot.
  - Stream checks still run their FFmpeg processes at the lowest priority, and mark them as the first to stop if memory runs out, so they never take the processor or memory from the stream.
- Don't add `CPUQuota=` or `MemoryMax=` to the unit: when the bot reaches a limit, the kernel makes it wait, and listeners hear a cut.

Then invite the bot with the link in [install.md, step 3](install.md#3-invite-the-bot-to-your-server), using your own Application ID.

## Where the data lives

Everything the bot stores is under **`/var/lib/radio-bot/`**. This is systemd's `StateDirectory`; with `DynamicUser`, the real path is `/var/lib/private/radio-bot`, and `/var/lib/radio-bot` links to it.

| Path | Contents |
|---|---|
| `radio-bot.sqlite` (+ `-wal`, `-shm`) | Server settings, favourites, station queues, custom stations, source evidence |
| `backups/` | Automatic backups taken before a database migration (`radio-bot-pre-v<N>-…`, newest 5 kept) and manual backups (`radio-bot-manual-…`, newest 10 kept) |
| `health.json` | Heartbeat, rewritten every 30 s |

Nothing is written anywhere else. Back up `/var/lib/radio-bot/` like any other application data, and keep a copy off the machine.

## Day-to-day

- **Logs:** `journalctl -u radio-bot -f` shows JSON lines as they happen. Set `LOG_LEVEL` in the env file for more or less detail.
- **Health:** this prints `healthy: ok` when the heartbeat is fresh, the database works, Discord is connected and FFmpeg has `libopus`. Otherwise it prints `unhealthy:` and the reason.

  ```bash
  cd /opt/radio-bot && sudo DATABASE_PATH=/var/lib/radio-bot/radio-bot.sqlite nice -n 19 node dist/scripts/healthcheck.js
  ```

- **Manual backup:** this writes `backups/radio-bot-manual-<date and time>.sqlite`. It runs at the lowest CPU priority, so it is safe while the bot plays. Run as root, it gives the new files to the database's owner, so the service can still rotate them.

  ```bash
  cd /opt/radio-bot && sudo DATABASE_PATH=/var/lib/radio-bot/radio-bot.sqlite node dist/scripts/backup.js
  ```

- **Settings for each Discord server:** use `/radio config` in that server to set channels, roles and idle mode.

## Upgrading

Read [CHANGELOG.md](../CHANGELOG.md) first, take a manual backup (see [Day-to-day](#day-to-day)), then:

```bash
cd /opt/radio-bot
sudo git fetch --tags && sudo git checkout vX.Y.Z   # the release you want
sudo pnpm install --frozen-lockfile --ignore-scripts
sudo pnpm run build
sudo pnpm prune --prod --ignore-scripts
sudo systemctl restart radio-bot
```

Database migrations run at start-up, and take a backup into `backups/` first. An older build never opens a database that a newer one has migrated: it stops with "Database has migrations newer than this build". To go back to an older release after a migration, check it out and build it as above, then restore the `radio-bot-pre-v<N>-…` backup taken just before the migration.

## Restoring a backup

```bash
sudo systemctl stop radio-bot
sudo cp /var/lib/radio-bot/backups/<file>.sqlite /var/lib/private/radio-bot/radio-bot.sqlite
sudo chown --reference=/var/lib/private/radio-bot /var/lib/private/radio-bot/radio-bot.sqlite
sudo rm -f /var/lib/private/radio-bot/radio-bot.sqlite-wal /var/lib/private/radio-bot/radio-bot.sqlite-shm
sudo systemctl start radio-bot
```

The `chown` keeps the file owned by the service's user. Check that the file is a backup first: `sudo head -c 15 <file>` should print `SQLite format 3`.

## Uninstalling

```bash
sudo systemctl disable --now radio-bot
sudo rm /etc/systemd/system/radio-bot.service
sudo systemctl daemon-reload
sudo rm -rf /opt/radio-bot /etc/radio-bot
sudo rm -rf /var/lib/private/radio-bot /var/lib/radio-bot   # deletes all bot data
```
