# Installing with Docker Compose

> **New to this?** Use the [beginner's guide](install.md) instead. Its installer sets up exactly what this page describes and gives you a `radio-bot` command for updates, backups and removal. This page is the manual reference.

This guide runs Radio Bot with Docker Engine and the Compose plugin on any Linux machine, on 64-bit x86 or ARM, as long as an image exists for its CPU architecture. To run without containers, see [install-linux.md](install-linux.md); for hosted platforms, see [install-container-platforms.md](install-container-platforms.md). The bot needs **outbound** internet access to Discord and to the radio stream hosts. It needs **no inbound port, domain or reverse proxy**.

You will run your own Discord application, with your own token. Radio Bot is unofficial and is not affiliated with or endorsed by Radio FG / Maison FG or any broadcaster. Before running it for anyone other than yourself, read [rights-and-disclaimer.md](rights-and-disclaimer.md).

## Requirements

- Docker Engine 24 or newer, with Docker Compose **2.24 or newer** (`docker compose version`). `compose.yaml` uses an optional `env_file`, which older Compose releases reject; the `radio-bot` manager checks this.
- Disk space for the image (a Node.js runtime plus FFmpeg) and a few MB for the database and its backups. CPU and memory use haven't been benchmarked yet; see [Resource notes](#resource-notes).
- A Discord account that can create applications, and a server where you have **Manage Server**, which Discord requires to invite a bot. To configure Radio Bot afterwards, you must be the server owner or have the **Administrator** permission.

## 1. Create the Discord application

Follow [install.md → Create your Discord bot](install.md#1-create-your-discord-bot). You need the **Application ID** (for `DISCORD_APPLICATION_ID`) and the **bot token** (for `DISCORD_TOKEN`). Leave every privileged gateway intent off: Radio Bot uses only the non-privileged `Guilds` and `GuildVoiceStates` intents. Only guild install is used, because `/radio` is a server-only command.

### Invite URL

The bot asks for exactly these permissions:

| Permission | Value |
|---|---:|
| View Channels | 1024 |
| Send Messages (only for the control panel and notices) | 2048 |
| Embed Links | 16384 |
| Attach Files (`/radio export`) | 32768 |
| Connect | 1048576 |
| Speak | 2097152 |
| Set Voice Channel Status (optional: the station and song as the channel's status) | 281474976710656 |
| **Total** | **281474979908608** |

Replace `APPLICATION_ID` in this URL with your own:

```text
https://discord.com/oauth2/authorize?client_id=APPLICATION_ID&scope=bot%20applications.commands&permissions=281474979908608
```

Open it, choose your server and authorise. You can do this before or after starting the container. The scopes are `bot` and `applications.commands`. Do **not** grant Administrator. If your voice channels have permission overwrites, make sure the bot's role can View Channel, Connect and Speak in the channel you want it to play in.

## 2. Get the files and create `.env`

```sh
git clone https://github.com/DangerMouseUK/radiobot.git
cd radiobot
cp .env.example .env
chmod 600 .env
```

Edit `.env`. Only two values are required:

```dotenv
DISCORD_TOKEN=paste-your-bot-token-here
DISCORD_APPLICATION_ID=123456789012345678
```

Useful optional values:

```dotenv
# Register /radio only in this guild (handy while testing)
DISCORD_DEV_GUILD_ID=
# Your Discord user ID: allows you to record identity reviews for station-pack sources
OPERATOR_USER_IDS=
# How many servers may stream at once from this installation
MAX_ACTIVE_GUILD_STREAMS=3
# Highest Opus bitrate (32-510); 'maximum' quality matches each station's own bitrate up to it
MAX_OPUS_BITRATE_KBPS=510
# The bot's Discord status while playing: track (station and song), station, or off
PRESENCE_MODE=track
# User-Agent sent to stream hosts; empty = FFmpeg's own Lavf/<version> (recommended)
STREAM_USER_AGENT=
# Station packs: switch packs off/on, or load your own from the data volume
DISABLED_PACKS=
ENABLED_PACKS=
EXTRA_PACKS_DIR=
LOG_LEVEL=info
```

The full list is in the [README configuration table](../README.md#configuration) and in `.env.example`. Inside the container, `DATABASE_PATH` is `/app/data/radio-bot.sqlite`; the image and `compose.yaml` both set it, and `compose.yaml` does so whatever `.env` says. FFmpeg and FFprobe, with `libopus`, come from the image, which sets `FFMPEG_PATH` and `FFPROBE_PATH` itself. Leave them commented out, as they are in `.env.example`. Keep `TELEMETRY_ENABLED=false`: there is no telemetry, and `true` is refused.

Never commit `.env`. It is already listed in `.gitignore` and `.dockerignore`.

## 3. Start it

```sh
docker compose up -d
docker compose logs -f radio-bot
```

The image is published as `ghcr.io/dangermouseuk/radio-bot`, with version tags; `compose.yaml` defaults to `ghcr.io/dangermouseuk/radio-bot:1.0.0`. To use another image or tag, set `RADIO_BOT_IMAGE` in your shell or in the `.env` file next to `compose.yaml`, for example `RADIO_BOT_IMAGE=ghcr.io/dangermouseuk/radio-bot:1.0` (the release workflow also publishes `<major>.<minor>` tags). If the image hasn't been published yet, or you want to build from source, build it locally from the `Dockerfile`:

```sh
docker compose build
docker compose up -d
```

The image is a multi-stage build on a pinned `node:24` Debian slim base. It uses Debian's `ffmpeg` package, which includes `libopus`, runs under `tini`, and runs as the unprivileged `node` user.

On first start, the JSON log should include these messages: `database migrated`, `station packs loaded` (with the loaded and enabled pack IDs), `ffmpeg detected` (with `"libopus":true`), `connected to Discord`, and `slash commands registered`.

If the configuration is invalid, the container exits with code 78 and prints which variable is wrong. Secret values are never printed.

What the shipped `compose.yaml` sets up:

- **One service, `radio-bot`.** Its container is also named `radio-bot`. It runs with `restart: unless-stopped` and loads `.env` through `env_file` with `required: false`, so the stack still starts if the variables come from somewhere else, such as a hosting platform or your shell.
- **No published ports.** The bot only makes outbound connections.
- **A fixed project name, `radio-bot`,** so the names below don't depend on the folder you cloned into.
- **A named volume, `radio-bot-data`,** mounted at `/app/data`. Docker prefixes it with the project name, so it shows up as `radio-bot_radio-bot-data`. It holds `radio-bot.sqlite` (plus its `-wal`/`-shm` files), `health.json` and `backups/`. `DATABASE_PATH` is fixed to `/app/data/radio-bot.sqlite`.
- **Hardening:**
  - a read-only root filesystem (`read_only: true`), with a `tmpfs` at `/tmp`;
  - `cap_drop: [ALL]` and `no-new-privileges`;
  - the image's non-root `node` user.
- **Log rotation:** the `json-file` driver, 10 MB × 5 files.
- **A healthcheck,** defined in the image. See [Healthcheck](#healthcheck).

## 4. First run in Discord

Commands are registered as **guild** commands, so `/radio` appears straight away in every server the bot is in. If you set `DISCORD_DEV_GUILD_ID`, **only that server** gets them, at start-up and when the bot joins servers. Clear it to register everywhere.

As a bot admin (the server owner, or a member with Discord's **Administrator** permission; Manage Server alone is not enough):

1. Run **`/radio config`**. It is ephemeral, so only you see it.
   - **Access page:** command channels, approved voice channels and *DJ roles*. Leaving a list empty means no restriction. There is no admin-role setting.
   - **Playback page:**
     - idle mode (`leave_when_empty` is the default, `pause_when_empty`, or `24x7`);
     - who can play or stop (listeners in the same channel by default, only DJs and admins, or anyone);
     - quality mode (`maximum`, `balanced` or `manual`);
     - the preferred voice channel, plus *Autostart*, *Resume after restart* and *Lock to preferred channel*.
   - **Notifications page:** a channel for recovery and error notices. This is optional, and needs Send Messages in that channel.
   - Set a default station with `/radio config default_station:` and a manual Opus target with `/radio config manual_bitrate:`.
2. Join a voice channel and run **`/radio play station:FG DJ RADIO`**, or use **`/radio browse`**.
3. Run **`/radio quality`** to see the source, the Discord output and the processing report.
4. Optionally, post a persistent control panel with **`/radio panel channel:#radio`**.

The first time a station is played, its sources are probed, which can add a few seconds. Until then, pack stations show as **Unverified** in the browser.

## Data volume

Everything that has to persist is in `/app/data`:

| Path | Contents |
|---|---|
| `radio-bot.sqlite` (+ `-wal`, `-shm`) | Settings, favourites, station queues, source preferences, custom stations, station and source evidence, probe history, sync reports, desired playback state |
| `backups/` | Automatic pre-migration backups (`radio-bot-pre-v<N>-…`, the newest 5 are kept) and manual backups (`radio-bot-manual-…`, the newest 10 are kept). Each kind rotates on its own, so one never evicts the other. Copy any backup you want to keep off the host |
| `health.json` | Heartbeat for the healthcheck, rewritten every 30 s |

Nothing else needs to persist. The bundled station packs (`catalog/packs/`) ship inside the image and are re-seeded into the database on each start. Runtime evidence and guild data are preserved when that happens.

**Your own station packs:** the image's root filesystem is read-only, so put extra packs inside the data volume, for example `/app/data/packs/<pack-id>/`, and set `EXTRA_PACKS_DIR=/app/data/packs`. Restart the container to load changes. A pack that fails validation stops start-up with a message naming the file and field. The authoring guide is [catalog/README.md](../catalog/README.md).

## Logs

The bot writes structured JSON lines to stdout, which the Docker logging driver collects:

```sh
docker compose logs -f --tail=200 radio-bot
```

- `LOG_LEVEL` can be `fatal`, `error`, `warn`, `info` (the default), `debug`, `trace` or `silent`. `debug` adds state transitions and the voice dependency report.
- The Discord token, URL fields and authorisation or cookie headers are redacted, and so are query strings in URLs found in error messages and FFmpeg output.
- **Log retention is controlled by Docker, not by the bot.** The shipped `compose.yaml` keeps at most 5 × 10 MB of logs (`json-file` with `max-size: 10m`, `max-file: 5`). How many days that covers depends on traffic and `LOG_LEVEL`. Adjust the numbers to keep more or less history.

## Healthcheck

The bot writes `/app/data/health.json` every 30 s. The image's `HEALTHCHECK` runs the following every 60 s, with a 10 s timeout, a 120 s start period and 3 retries:

```sh
node dist/scripts/healthcheck.js
```

The container is **unhealthy** when any of these is true:

- the heartbeat file is missing or older than 90 s (for example, the process is hung);
- the database check failed;
- the bot isn't connected to Discord;
- FFmpeg is missing or has no `libopus` encoder, so nothing could play.

It is normal for the container to report unhealthy for a short time after starting, until the bot has logged in.

You can run the check by hand:

```sh
docker compose exec radio-bot node dist/scripts/healthcheck.js
```

### Optional diagnostics endpoint

If you set `DIAGNOSTICS_PORT=9464` (any free port), the bot serves `GET /healthz` and `GET /diagnostics` (JSON: streams, FFmpeg process counts, counters, recent incidents and sessions). It binds to **`127.0.0.1` inside the container**, so publishing the port does not expose it. Query it from inside the container:

```sh
docker compose exec radio-bot node -e "fetch('http://127.0.0.1:9464/diagnostics').then(r=>r.text()).then(console.log)"
```

`/radio stats` in Discord (admins) shows the same information without any port.

## Customising `compose.yaml`

Don't edit `compose.yaml` itself. Put your changes (a bind mount instead of the named volume, resource limits, a different image) in a `compose.override.yaml` next to it. Compose merges that file automatically and Git ignores it. `radio-bot update` refuses to run over edited tracked files, so an override is the only kind of change that survives updates.

## Upgrades

If you installed with the installer, run `radio-bot update`. It backs up the database, switches to the newest release, and restarts. By hand:

```sh
docker compose pull           # or: git pull && docker compose build
docker compose up -d
docker compose logs -f radio-bot
```

On start-up, pending database migrations are applied automatically:

- **A backup is taken first.** If the database already has a schema and a migration is pending, a consistent copy is written to `/app/data/backups/radio-bot-pre-v<N>-<timestamp>.sqlite` (using `VACUUM INTO`) before anything changes. The newest 5 pre-migration backups are kept. Manual backups are rotated separately (newest 10).
- **Each migration runs in a transaction,** and its checksum is recorded.
- **Edited migrations are refused.** If an already-applied migration file has changed, start-up stops with a checksum error rather than letting the schema drift.
- **Downgrades are refused.** If the database is newer than the image (you rolled back), start-up stops with "Database has migrations newer than this build". Restore the matching backup, or run the newer image again.

Read [CHANGELOG.md](../CHANGELOG.md) before upgrading.

## Backups

Take a consistent backup while the bot is running:

```sh
docker compose exec radio-bot node dist/scripts/backup.js
# → Backup written: /app/data/backups/radio-bot-manual-<timestamp>.sqlite
```

Copy backups off the host:

```sh
docker compose cp radio-bot:/app/data/backups ./radio-bot-backups
```

Backups contain Discord server, channel and role IDs, settings, custom station URLs (which may include tokens you added yourself), and the last requester's user ID. Store them as carefully as `.env`. They never contain the Discord token, which lives only in the environment.

**Restore:**

1. Stop the bot with `docker compose down`. This keeps the volume.
2. Copy the backup file over `radio-bot.sqlite` in the volume, and delete any `radio-bot.sqlite-wal` and `radio-bot.sqlite-shm` files.
3. Start the bot again.

For example, using a temporary container:

```sh
docker compose down
docker run --rm -v radio-bot_radio-bot-data:/data -v "$PWD/radio-bot-backups:/b" alpine \
  sh -c 'cp /b/<file>.sqlite /data/radio-bot.sqlite && rm -f /data/radio-bot.sqlite-wal /data/radio-bot.sqlite-shm && chown 1000:1000 /data/radio-bot.sqlite'
docker compose up -d
```

`docker volume ls` lists the volumes if yours is named differently. The `chown` makes the file owned by the image's `node` user (UID 1000).

**Settings only:** `/radio export` in Discord downloads a server's settings as JSON, with no secrets. `/radio import` restores them after showing a preview.

## Registering commands manually

Commands are normally registered automatically (`REGISTER_COMMANDS_ON_START=true`), and the call is skipped when nothing has changed. To force a re-registration, for example after deleting the commands by hand:

```sh
docker compose exec radio-bot node dist/scripts/register-commands.js            # DISCORD_DEV_GUILD_ID if set, else all guilds the bot is in
docker compose exec radio-bot node dist/scripts/register-commands.js 123456789012345678
```

## Resource notes

- **Processes:** each active server runs one FFmpeg encoder. Probes start short-lived `ffprobe` and `ffmpeg` processes; `MAX_CONCURRENT_PROBES` is 2 by default.
- **Bandwidth per active server stream** (PRD §13.2):
  - inbound, a 128 kbps source is about 57.6 MB/hour;
  - outbound, the default `maximum` mode matches the station's bitrate: about 57.6 MB/hour for a 128 kbps station, 144 MB/hour at 320 kbps, and at most 230 MB/hour at the 510 kbps limit. Lower `MAX_OPUS_BITRATE_KBPS` on a metered or slow uplink.

  Both figures are before protocol overhead. Discord fans the audio out to listeners, so the bot's bandwidth does not grow with the number of listeners.
- **CPU and memory:** not yet benchmarked. They depend on the FFmpeg/libopus build, the target bitrate and the number of concurrent servers. Measure on your own hardware: `docker stats`, and the RSS and heap figures in `/radio stats`.

## Uninstalling

```sh
docker compose down        # stop, keep data
docker compose down -v     # stop and delete the data volume (irreversible)
```

Removing the bot from a Discord server stops playback there and deletes that server's settings, favourites, queue, source preferences, playback state and custom stations from the database. A temporary Discord outage does not delete anything. See [rights-and-disclaimer.md](rights-and-disclaimer.md#privacy-policy-for-a-self-hosted-instance).
