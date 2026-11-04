# Installing with Docker Compose

> **New to this?** Use the [beginner's guide](install.md) instead. Its installer sets up exactly what this page describes and gives you a `radio-bot` command for updates, backups and removal. This page is the manual reference.

This guide runs Radio Bot with Docker Engine and the Compose plugin on any Linux machine with a 64-bit x86 or ARM processor; published images cover both (`linux/amd64` and `linux/arm64`). To run without containers, see [install-linux.md](install-linux.md); for hosted platforms, see [install-container-platforms.md](install-container-platforms.md). The bot needs **outbound** internet access to Discord and to the radio stream hosts. It needs **no inbound port, domain or reverse proxy**.

You will run your own Discord application, with your own token. Radio Bot is unofficial and is not affiliated with or endorsed by any broadcaster. Before running it for anyone other than yourself, read [rights-and-disclaimer.md](rights-and-disclaimer.md).

## Requirements

- Docker Engine 24 or newer, with Docker Compose **2.24 or newer** (`docker compose version`). `compose.yaml` uses an optional `env_file`, which older Compose releases reject; the `radio-bot` manager checks this.
- About 3 GB of free disk space: the image (a Node.js runtime plus FFmpeg) is about 1 GB and is briefly there twice during an upgrade, and the database and its backups take a few MB. For CPU and memory, see the [README's requirements](../README.md#requirements) and [Resource notes](#resource-notes).
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
git checkout v1.2.3          # the newest release; the default branch may hold unreleased changes
cp .env.example .env
chmod 600 .env
```

Each release's `compose.yaml` names the published image of that same release, so the checkout and the image match. `git tag -l 'v*' --sort=-v:refname | head -n 1` prints the newest release tag.

Edit `.env`. Only two values are required:

```dotenv
DISCORD_TOKEN=paste-your-bot-token-here
DISCORD_APPLICATION_ID=123456789012345678
```

Useful optional values:

```dotenv
# Register /radio only in this server (handy while testing)
DISCORD_DEV_GUILD_ID=
# Your Discord user ID: allows you to install, update and remove station packs from Discord, and to
# record identity reviews for station-pack sources (the application's owner always can)
OPERATOR_USER_IDS=
# How many servers may stream at once from this installation
MAX_ACTIVE_GUILD_STREAMS=3
# Highest Opus bitrate (32-510); 'maximum' quality matches each station's own bitrate up to it
MAX_OPUS_BITRATE_KBPS=510
# The bot's Discord status while playing: track (station and song), station, or off
PRESENCE_MODE=track
# User-Agent sent to stream hosts; empty = FFmpeg's own Lavf/<version> (recommended)
STREAM_USER_AGENT=
# Station packs: switch packs off/on, or load your own from the data volume (e.g. /app/data/my-packs)
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

The image is published as `ghcr.io/dangermouseuk/radio-bot`, with version tags; `compose.yaml` defaults to `ghcr.io/dangermouseuk/radio-bot:1.2.3`. To use another image or tag, set `RADIO_BOT_IMAGE` in your shell or in the `.env` file next to `compose.yaml`, for example `RADIO_BOT_IMAGE=ghcr.io/dangermouseuk/radio-bot:1.2` (the release workflow also publishes `<major>.<minor>` tags). If the image hasn't been published yet, or you want to build from source, build it locally from the `Dockerfile`:

```sh
docker compose build
docker compose up -d
```

The image is a multi-stage build on a pinned `node:24` Debian slim base. It uses Debian's `ffmpeg` package, which includes `libopus`, runs under `tini`, and runs as the unprivileged `node` user.

On first start, the JSON log should include these messages: `database migrated`, `station packs loaded` (with the loaded and enabled pack IDs, and how many installed packs were skipped; a new install has none loaded until you add some, see [Station packs](#station-packs)), `ffmpeg detected` (with `"libopus":true`) and `connected to Discord`. `slash commands registered` follows once the bot is in at least one server and the command needed registering there; it is not logged when nothing changed.

If the configuration is invalid, the container exits with code 78 and prints which variable is wrong. Secret values are never printed. Because of `restart: unless-stopped`, Docker keeps restarting it until you fix `.env` and run `docker compose up -d` again.

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

Commands are registered as **server** (guild) commands, so `/radio` appears straight away in every server the bot is in. If you set `DISCORD_DEV_GUILD_ID`, **only that server** gets them, at start-up and when the bot joins servers. Clear it to register everywhere.

The bot starts with no stations. Add station packs first, either with `packs.js` in the container (see [Station packs](#station-packs)) or in Discord: as the owner of the bot's Discord application (or a user listed in `OPERATOR_USER_IDS`), run **`/radio packs library`**, pick a pack from the menu and press **Install**.

As a bot admin (the server owner, or a member with Discord's **Administrator** permission; Manage Server alone is not enough):

1. Run **`/radio config`**. Only you see its replies.
   - **Access page:** command channels, approved voice channels, *DJ roles*, and who else can play or stop (listeners in the same channel by default, only DJs and admins, or anyone). Leaving a list empty means no restriction. There is no admin-role setting.
   - **Playback page:**
     - idle mode (*Leave* is the default, *Pause*, or *Keep playing (24/7)*);
     - quality mode (*Maximum*, *Balanced* or *Manual*);
     - the preferred voice channel, and one menu for the *Autostart*, *Resume after restart* and *Channel lock* switches (a ticked switch is on).
   - **Notices page:** a channel for recovery and error notices (optional; needs Send Messages in that channel), and the *Voice channel status* switch, which shows what's playing as the voice channel's status (on by default; needs the optional Set Voice Channel Status permission).
   - Set a default station with `/radio config default_station:` and a manual Opus target with `/radio config manual_bitrate:`.
2. Join a voice channel and run **`/radio play`**, then start typing a station's name and pick it from the list, or use **`/radio browse`**.
3. Run **`/radio quality`** to see the source, the Discord output and the processing report.
4. Optionally, post a persistent control panel with **`/radio panel channel:#radio`**.

The first time a station is played, the bot checks (probes) its sources, which can add a few seconds. Until then, pack stations show as **Unverified** in the browser.

## Data volume

Everything the bot keeps is in `/app/data`:

| Path | Contents |
|---|---|
| `radio-bot.sqlite` (+ `-wal`, `-shm`) | Settings, favourites, station queues, source preferences, custom stations, station and source evidence, probe history, sync reports, desired playback state |
| `backups/` | Automatic pre-migration backups (`radio-bot-pre-v<N>-…`, the newest 5 are kept) and manual backups (`radio-bot-manual-…`, the newest 10 are kept). Each kind rotates on its own, so one never evicts the other. Copy any backup you want to keep off the host |
| `health.json` | Heartbeat for the healthcheck, rewritten every 30 s |
| `installed-packs/` | Station packs installed from the pack library (one folder per pack), and `installed.json`, which records where each came from and which packs were removed on purpose |

Nothing else needs keeping. Installed packs are read into the database again on each start. Reloading them loses nothing the bot has learnt about each source, and no server's data. The image itself ships no station packs. If the volume is lost but you restore a database backup, the bot reinstalls the packs that database uses from the official library when it starts.

## Station packs

The bot ships with no stations: they come in station packs from the official pack library. The library's address is fixed in the bot. Downloads go through the bot's own safe HTTP client, and each pack is checked (its SHA-256 against the library's index, then the same rules as any pack) before it is written to `/app/data/installed-packs/`.

With the installer, `radio-bot packs …` does all of this for you. By hand, run `dist/scripts/packs.js` in the container, then send the running bot `SIGHUP` so it loads the change without a restart and without interrupting what is playing:

```sh
docker compose exec radio-bot nice -n 19 node dist/scripts/packs.js browse                # the library's packs (add words, --country GB or --language fr to narrow it)
docker compose exec radio-bot nice -n 19 node dist/scripts/packs.js info mypack           # one pack's details
docker compose exec radio-bot nice -n 19 node dist/scripts/packs.js add mypack            # install (or --collection <id> for a whole collection)
docker compose exec radio-bot nice -n 19 node dist/scripts/packs.js list                  # installed packs, and updates available
docker compose exec radio-bot nice -n 19 node dist/scripts/packs.js update                # update every installed pack (or name some)
docker compose exec radio-bot nice -n 19 node dist/scripts/packs.js remove mypack         # remove; it isn't reinstalled automatically
docker compose kill -s HUP radio-bot                                                      # after add, update or remove: load the change now
```

If the container is stopped, use `docker compose run --rm --no-deps radio-bot node dist/scripts/packs.js …` instead; the bot loads the change when it starts. `--from <address>` uses another pack library (the address of its `index.json`, or a path to one inside the container). Installing from Discord (`/radio packs library` and `/radio packs installed`) uses the official library only, and needs the bot's operator.

The bot checks the official library once a day: it notes updates (it never updates a pack by itself), removes packs installed from the official library that the library has withdrawn, and retries reinstalling missing packs. All of this needs outbound HTTPS to `github.com`.

**Your own station packs:** the image's root filesystem is read-only, so put your own packs inside the data volume, for example `/app/data/my-packs/<pack-id>/`, and set `EXTRA_PACKS_DIR=/app/data/my-packs`. Don't use the `installed-packs` folder for them. Restart the container to load changes. A pack that fails validation stops start-up with a message naming the file and field. The authoring guide is [catalog/README.md](../catalog/README.md).

## Logs

The bot writes structured JSON lines to stdout, which the Docker logging driver collects:

```sh
docker compose logs -f --tail=200 radio-bot
```

- `LOG_LEVEL` can be `fatal`, `error`, `warn`, `info` (the default), `debug`, `trace` or `silent`. `debug` adds state transitions and the voice dependency report.
- The Discord token, URL fields and authorisation or cookie headers are redacted, and so are query strings in URLs found in error messages and FFmpeg output.
- **Log retention is controlled by Docker, not by the bot.** The shipped `compose.yaml` keeps at most 5 × 10 MB of logs (`json-file` with `max-size: 10m`, `max-file: 5`). How many days that covers depends on traffic and `LOG_LEVEL`. Adjust the numbers to keep more or less history. `radio-bot update` also keeps the last 500 lines of each replaced container in `logs/` (the newest 5 files).

## Healthcheck

The bot writes `/app/data/health.json` every 30 s. The image's `HEALTHCHECK` runs the following every 60 s, with a 10 s timeout, a 120 s start period and 3 retries. It runs at the lowest CPU priority (`nice -n 19`), so on a one-core host it can't delay the stream:

```sh
nice -n 19 node dist/scripts/healthcheck.js
```

The container is **unhealthy** when any of these is true:

- the heartbeat file is missing or older than 90 s (for example, the process is hung);
- the database check failed;
- the bot isn't connected to Discord;
- FFmpeg is missing or has no `libopus` encoder, so nothing could play.

It is normal for the container to report unhealthy for a short time after starting, until the bot has logged in.

You can run the check by hand:

```sh
docker compose exec radio-bot nice -n 19 node dist/scripts/healthcheck.js
```

### Optional diagnostics endpoint

If you set `DIAGNOSTICS_PORT=9464` (any free port), the bot serves `GET /healthz` and `GET /diagnostics` (JSON: streams, FFmpeg process counts, counters, recent incidents and sessions). It binds to **`127.0.0.1` inside the container**, so publishing the port does not expose it. If the port is already in use, the bot logs a warning and carries on without the endpoint. Query it from inside the container:

```sh
docker compose exec radio-bot node -e "fetch('http://127.0.0.1:9464/diagnostics').then(r=>r.text()).then(console.log)"
```

`/radio stats` in Discord (admins) shows the same information without any port.

## Customising `compose.yaml`

Don't edit `compose.yaml` itself. Put your changes (a bind mount instead of the named volume, a different image) in a `compose.override.yaml` next to it. Compose merges that file automatically and Git ignores it. `radio-bot update` refuses to run over edited tracked files, so an override is the only kind of change that survives updates.

Don't add CPU or memory limits (`cpus:`, `mem_limit:` or `deploy.resources.limits`). When the bot reaches a limit, the kernel makes it wait, and listeners hear a cut.

## How the stream gets priority

The bot sends a small piece of audio to Discord every 20 milliseconds, so on a busy machine it has to come first. `compose.yaml` sets two things for that:

- **`cpu_shares: 26214`** gives the bot's container a much bigger share of the processor than other containers and services whenever they all want it at once: ten times the usual share or more. Docker turns the number into a "CPU weight" of about 1,000 to 1,400, depending on its version, against a default of 100. It is a share, not a limit: when nothing else is busy, other programs still get the whole processor, and the bot is never held back.
- **`oom_score_adj: -500`** tells the kernel that if the machine ever runs out of memory, it should stop other programs before the bot. The bot's stream checks mark themselves as the first to stop, so a check always goes before the stream does.

Inside the container, stream checks, backups and health checks run at the lowest CPU priority, and `radio-bot` runs backups at the lowest disk priority as well.

**Rootless Docker:** the container still starts, but the two settings do less. Docker can't give the container a lower memory score than Docker's own, so it uses its own score instead, and the CPU share only counts if your system lets rootless Docker manage the processor (cgroup v2 with CPU delegation); otherwise Docker ignores it.

If your Docker refuses to start the container with an error that mentions `oom_score_adj` (this can happen with user-namespace remapping), turn that setting off in `compose.override.yaml` and run `radio-bot restart`:

```yaml
services:
  radio-bot:
    oom_score_adj: 0
```

## Upgrades

If you installed with the installer, run `radio-bot update`. It:

1. warns you if the bot is playing anywhere, and asks whether to go ahead (playback only resumes by itself where **Resume after restart** is on, and the download in step 4 happens while the station still plays, which can cause small cuts on a small server);
2. if the bot is running, backs up the database and copies the backups to `backups/` (if the backup fails, it stops and changes nothing);
3. switches to the newest release (or the one you name, as in `radio-bot update v1.0.4`);
4. downloads that release's image, or builds it if none is published;
5. saves the last 500 log lines of the old container to `logs/` (the newest 5 files are kept);
6. restarts the bot and waits until it is healthy;
7. removes the older `radio-bot` images.

If an update stops after switching versions but before the bot is running on the new one (a failed download, Ctrl+C), `radio-bot status` says that the last update didn't finish, and running `radio-bot update` again finishes it. It tells an unfinished update apart by a marker the update leaves until the new version is healthy, and by the running container's image differing from the one `compose.yaml` names.

By hand, in the folder you cloned into:

```sh
docker compose logs --tail=500 radio-bot > radio-bot-before-update.log   # replacing the container deletes its logs
docker compose exec radio-bot nice -n 19 node dist/scripts/backup.js     # see Backups
git fetch --tags
git checkout vX.Y.Z           # the release you want; its compose.yaml names its image
docker compose pull           # or, if no image is published for it: docker compose build
docker compose up -d
docker compose logs -f radio-bot
docker image ls ghcr.io/dangermouseuk/radio-bot   # remove old versions with: docker image rm <name:tag>
```

`docker compose pull` on its own doesn't upgrade anything: the image tag is fixed in `compose.yaml`, so you need the new release's `compose.yaml` (or a new `RADIO_BOT_IMAGE`). Each image is about 1 GB, so remove old ones, or a small disk fills up over a few updates.

On start-up, pending database migrations are applied automatically:

- **A backup is taken first.** If the database already has a schema and a migration is pending, a consistent copy is written to `/app/data/backups/radio-bot-pre-v<N>-<timestamp>.sqlite` (using `VACUUM INTO`) before anything changes. The newest 5 pre-migration backups are kept. Manual backups are rotated separately (newest 10).
- **Each migration runs in a transaction,** and its checksum is recorded.
- **Edited migrations are refused.** If an already-applied migration file has changed, start-up stops with a checksum error rather than letting the schema drift.
- **Downgrades are refused.** If the database is newer than the image (you rolled back), start-up stops with "Database has migrations newer than this build". Restore the `radio-bot-pre-v<N>-…` backup the newer version took just before it migrated (see [Backups](#backups)), or run the newer image again.

**From 1.1.0 or earlier:** those versions included a station pack in the image. Newer images include none, so on its first start the new version reinstalls, from the official pack library and before anything plays, every pack its database has stations from but no longer has. Favourites, queues and preferences keep working. This needs outbound HTTPS to `github.com`; if the library can't be reached, the bot logs a warning and tries again at its daily check. `packs.js list` (or `radio-bot packs`) shows what is installed.

Read [CHANGELOG.md](../CHANGELOG.md) before upgrading.

## Backups

Take a consistent backup while the bot is running:

```sh
docker compose exec radio-bot nice -n 19 node dist/scripts/backup.js
# → Backup written: /app/data/backups/radio-bot-manual-<timestamp>.sqlite
```

`nice -n 19` runs it at the lowest CPU priority, so it can't hold up the stream. Copy backups off the host (this also works while the container is stopped or restarting, for example to fetch the pre-migration backup from a version that won't start):

```sh
docker cp radio-bot:/app/data/backups ./radio-bot-backups
```

With the installer, `radio-bot backup` does both (if the bot isn't running, it only copies the backups already there), and `radio-bot restore FILE` puts a backup back. `restore` checks that the file is a SQLite database before stopping anything, backs up the current database first if the bot is running, and starts the bot again on its current data if copying the file in fails or is interrupted.

`radio-bot` runs the backup and the health check at the lowest CPU priority, as the image's own healthcheck does, and at the lowest disk priority (`ionice -c 3`) where the disk supports it. `backup.js` also lowers its own CPU priority, so a backup is safe to run while the bot plays.

Backups contain Discord server, channel and role IDs, settings, custom station URLs (which may include tokens you added yourself), and the last requester's user ID. Store them as carefully as `.env`. They never contain the Discord token, which lives only in the environment.

**Restore:**

1. Check that the file is a SQLite database: `head -c 15 <file>.sqlite` should print `SQLite format 3`.
2. Stop the bot with `docker compose down`. This keeps the volume.
3. Copy the backup file over `radio-bot.sqlite` in the volume, and delete any `radio-bot.sqlite-wal` and `radio-bot.sqlite-shm` files.
4. Start the bot again.

For example, using a temporary container:

```sh
docker compose down
docker run --rm -v radio-bot_radio-bot-data:/data -v "$PWD/radio-bot-backups:/b" alpine \
  sh -c 'cp /b/<file>.sqlite /data/radio-bot.sqlite && rm -f /data/radio-bot.sqlite-wal /data/radio-bot.sqlite-shm && chown 1000:1000 /data/radio-bot.sqlite'
docker compose up -d
```

`docker volume ls` lists the volumes if yours is named differently. The `chown` makes the file owned by the image's `node` user (UID 1000).

**Settings only:** `/radio export` in Discord downloads one server's settings as JSON, with no secrets. `/radio import` shows a preview and applies it only when you press **Apply import** (the preview lasts 10 minutes, and a new import replaces it). The file holds the settings, favourites, source preferences and custom stations. A custom station whose URL has a query string or a user name is exported with its URL redacted and has to be added again with `/radio add`; the others are added again on import, each after a probe. Favourites and a default station that point at custom stations aren't exported, because a re-added custom station gets a new ID; an import keeps the ones the server already has.

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
- **CPU and memory:** one stream at 128 kbps used about 8% of one CPU core and about 200 MB of memory in total (the bot plus its FFmpeg process); each extra stream adds roughly the same CPU and about 60 MB. The Opus encode itself costs little even at the 510 kbps maximum (under 3% of a core in that test). Figures depend on your hardware and FFmpeg build, so check your own with `docker stats` and the memory and event-loop figures in `/radio stats`.

## Uninstalling

```sh
docker compose down        # stop, keep data
docker compose down -v     # stop and delete the data volume (irreversible)
```

Removing the bot from a Discord server stops playback there and deletes that server's settings, favourites, queue, source preferences, playback state and custom stations from the database. A temporary Discord outage does not delete anything. See [rights-and-disclaimer.md](rights-and-disclaimer.md#privacy-policy-for-a-self-hosted-instance).
