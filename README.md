# Radio Bot

[![CI](https://github.com/DangerMouseUK/radiobot/actions/workflows/ci.yml/badge.svg)](https://github.com/DangerMouseUK/radiobot/actions/workflows/ci.yml)
[![Licence: MIT](https://img.shields.io/badge/licence-MIT-blue.svg)](LICENSE)
![Node.js 24.17+](https://img.shields.io/badge/node-%3E%3D24.17-339933?logo=nodedotjs&logoColor=white)
![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178C6?logo=typescript&logoColor=white)

**A self-hosted Discord bot that plays live internet radio in your voice channels, and is honest about what it plays.**

Stations come from **station packs**: folders of plain JSON you can review, add to or switch off without touching the code. Before the bot trusts a stream, it probes it, checks that it really is the station it claims to be, and explains its choice. Audio reaches Discord through **one** Opus encode at the station's own bitrate, with no second encode and no processing.

> [!IMPORTANT]
> **Unofficial.** Radio Bot is an independent open-source project. It is **not affiliated with, endorsed by or sponsored by any broadcaster**. Station packs refer to stations by name only, so that people can find them; those names, the audio and any artwork belong to their owners. The MIT licence covers this project's original code only. Read [docs/rights-and-disclaimer.md](docs/rights-and-disclaimer.md) before running an instance for anyone other than yourself.

## Highlights

- **Station packs.** Drop a folder of three JSON files into `catalog/packs/` or your own `EXTRA_PACKS_DIR` and its stations appear. One environment variable switches whole packs on or off.
- **Evidence before bitrate.** Every candidate stream is probed with `ffprobe` and a decode check, and its identity is checked against its provenance, its stream metadata and, optionally, an audio comparison. The bot plays the *correct* station first and the best-sounding source second, and `/radio sources` tells you why it chose what it did.
- **One encode, at the station's own quality.** FFmpeg decodes once and encodes once with `libopus` at the source's bitrate, up to 510 kbps (48 kHz stereo, music mode). A 320 kbps station goes out at 320 kbps, and a 128 kbps one isn't padded out to waste bandwidth. `@discordjs/voice` only demuxes the result. There is no normalisation, EQ or limiting, and the voice channel's bitrate setting is not used as a cap.
- **Automatic recovery.** A watchdog spots stalls and retries with backoff. If that fails, the bot switches to another verified source and puts sources that keep failing into a cooldown. It also rebuilds lost voice connections and catches up with the live stream when it falls behind.
- **Now playing.** The current song or show title, when the stream sends one, appears in `/radio now` and on the control panel. The bot's own Discord status shows it too ("Listening to Station Name · Artist - Title"), and so does the status of the voice channel it's playing in ("📻 Station Name · Artist - Title").
- **Queue and skip.** Line up stations with `/radio queue` and move on with `/radio skip` or the **Skip** button.
- **Private live stats.** `/radio stats` shows administrators the input and output bitrate, the redirect host and region, and ping and jitter to both the stream server and Discord's voice server. Only they can see the message, and they can dismiss it.
- **Secure by default.** The bot asks for the minimum Discord permissions and no privileged intents. All stream traffic goes through an SSRF-safe HTTP client, and FFmpeg reads only from stdin. Every button and command is authorised on the server side each time it is used. There is no telemetry.
- **Simple to run.** One process and one SQLite file. It needs outbound internet access only: no inbound port, domain, reverse proxy, Redis or PostgreSQL.

## Contents

- [Requirements](#requirements)
- [Quick start](#quick-start)
- [Other ways to deploy](#other-ways-to-deploy)
- [Discord application setup](#discord-application-setup)
- [Commands](#commands)
- [Station packs](#station-packs)
- [Configuration](#configuration)
- [How it works](#how-it-works)
- [What it cannot do](#what-it-cannot-do)
- [Project status](#project-status)
- [Development](#development)
- [Documentation](#documentation)
- [Licence](#licence)

## Requirements

| | Minimum | Recommended |
|---|---|---|
| CPU | 1 core, 64-bit (x86-64 or ARM64, such as a Raspberry Pi 4 or 5) | 1–2 cores |
| Memory | 512 MB | 1 GB |
| Disk | 3 GB free (the Docker image, about 1 GB, is briefly there twice during an update; plus the database and backups) | 5 GB |
| Network | Outbound only, including UDP for Discord voice; no open ports | |
| Bandwidth | Each playing server uses the station's bitrate in and about the same out: roughly 60–70 MB per hour each way at 128 kbps, and up to about 230 MB per hour out at the 510 kbps maximum | |

Measured on a small cloud server, one stream at 128 kbps used about 8% of one CPU core and about 200 MB of memory in total (the bot plus its FFmpeg process). Each extra stream adds roughly the same CPU and about 60 MB, so the default limit of 3 streams (`MAX_ACTIVE_GUILD_STREAMS`) fits comfortably within the minimum. These figures haven't been measured on a Raspberry Pi or over long periods yet. A one-core host is enough, but other scheduled jobs on the same machine (system stats collectors, `docker stats` loggers, backups) can cause brief audio hiccups: voice packets go out every 20 ms, and a burst of other work can make a few leave late.

## Quick start

You need a computer that stays on (Linux, a Raspberry Pi 4/5, a cloud server, or a Mac or Windows PC for trying it out), and a Discord bot token. **New to this? Follow the [beginner's install guide](docs/install.md)**: it walks through every click.

1. **Create a Discord application and bot.** Copy the **Application ID** and the **bot token**; see [docs/install.md, step 1](docs/install.md#1-create-your-discord-bot).
2. **Run the installer** on Linux or macOS. On Windows, if you don't have a Linux machine to hand, it can run inside WSL (see the guide):

   ```bash
   curl -fsSL https://raw.githubusercontent.com/DangerMouseUK/radiobot/main/install.sh | bash
   ```

   It downloads the newest release into `~/radio-bot`, sets up Docker if needed (on Linux, with your permission), asks for your Application ID and token, starts the bot, and waits until it is online. If you'd rather read the script before running it, this does the same thing: `git clone https://github.com/DangerMouseUK/radiobot.git ~/radio-bot && bash ~/radio-bot/scripts/radio-bot.sh install`.
3. **Invite the bot** with the link the installer prints (or `radio-bot invite`).
4. **In your server,** join a voice channel and run `/radio play` and pick a station from the list. Admins can run `/radio config` to choose channels and DJ roles.

From then on, the `radio-bot` command looks after it:

| Command | Does |
|---|---|
| `radio-bot status` · `radio-bot logs` | Version, health and available updates · the live log |
| `radio-bot update` | Updates to the newest release: warns you first if the bot is playing, backs up the database, keeps the old version's last 500 log lines and removes old images |
| `radio-bot backup` · `radio-bot restore <file>` | Copy the database out · put a copy back |
| `radio-bot config` | Edit installation settings, then restart to apply them |
| `radio-bot uninstall` | Remove it, optionally keeping a copy of your data |

If you'd rather run Docker Compose yourself: `git clone`, `cp .env.example .env`, set `DISCORD_TOKEN` and `DISCORD_APPLICATION_ID`, then `docker compose up -d --build`. [docs/install-docker.md](docs/install-docker.md) covers this in full. The database lives in the `radio-bot_radio-bot-data` volume, and a backup is taken automatically before any migration changes it.

## Other ways to deploy

Radio Bot is one long-running process. It needs outbound internet access (including UDP, for Discord voice), FFmpeg with `libopus`, and somewhere persistent for a small SQLite file.

| Option | Use when | Guide |
|---|---|---|
| **The installer** (recommended) | Linux, Raspberry Pi, macOS or Windows (WSL). It uses Docker underneath and adds the `radio-bot` command for updates, backups and removal. | [docs/install.md](docs/install.md) |
| **Docker / Docker Compose by hand** | You already run Docker and want full control. The image bundles Node.js and FFmpeg. | [docs/install-docker.md](docs/install-docker.md) |
| **Directly on Linux (systemd)** | You'd rather not use containers. Needs Node.js 24.17+ and FFmpeg installed on the host. A hardened unit file is included. | [docs/install-linux.md](docs/install-linux.md) |
| **A container platform** | A hosted platform runs the image as an always-on background worker with a persistent volume. Serverless platforms such as Vercel are **not** suitable. | [docs/install-container-platforms.md](docs/install-container-platforms.md) |

## Discord application setup

Step-by-step instructions are in [docs/install.md](docs/install.md#1-create-your-discord-bot). In summary:

- **Developer Portal:** create an application. Under **Bot**, reset and copy the token, which goes in `DISCORD_TOKEN`. Under **General Information**, copy the Application ID, which goes in `DISCORD_APPLICATION_ID`.
- **Gateway intents:** the bot uses only `Guilds` and `GuildVoiceStates`. Leave every privileged intent switched off: Presence, Server Members and Message Content.
- **Scopes:** `bot` and `applications.commands`.
- **Bot permissions** (the minimal set, integer `281474979908608`):

  | Permission | Why |
  |---|---|
  | View Channels | See the voice channel and the panel/notice channels |
  | Send Messages | Only for the optional control panel (`/radio panel`) and the recovery/error notice channel |
  | Embed Links | Embeds in the control panel and notices |
  | Attach Files | `/radio export` returns a JSON file |
  | Connect | Join the voice channel |
  | Speak | Play audio |
  | Set Voice Channel Status | Optional: show the station and song as the voice channel's status (`/radio config` → Notifications). Without it, everything else works |

  Administrator, Manage Channels, Manage Roles, Manage Messages, Read Message History and Message Content are not needed.

- **Invite URL:** replace `APPLICATION_ID` with your own:

  ```text
  https://discord.com/oauth2/authorize?client_id=APPLICATION_ID&scope=bot%20applications.commands&permissions=281474979908608
  ```

`/radio` is registered as a **guild** command in each server the bot is in, so it appears immediately. Registration happens at start-up and whenever the bot joins a new server, and it is skipped when nothing has changed. The command works only in servers, not in DMs.

## Commands

Everything is under `/radio`. There are three access levels:

- **Read:** anyone, in an allowed command channel.
- **Control:** admins and DJ roles, plus listeners if the server's listener-control mode allows it (`none`, `same_channel` or `any`).
- **Admin:** the server owner, or members with Discord's **Administrator** permission. Nothing else grants admin: not Manage Server, and there is no admin-role setting.

Replies that only concern you are ephemeral (only you see them).

### Listening

| Command | Level | What it does |
|---|---|---|
| `/radio play <station> [channel]` | Control | Plays a station in your voice channel (or `channel`), or switches to it. DJs and admins can name any channel; with the default listener control, listeners can only name the one they are in. An ambiguous name shows a picker; the bot never guesses. |
| `/radio browse [pack] [category] [search]` | Read | Paged station picker, grouped by pack, with this server's custom stations last. Picking a station plays it (needs Control). |
| `/radio list [scope] [pack] [page]` | Read | Station list with status and IDs: pack stations (`scope:packs`, optionally one `pack`), this server's `custom` stations, or `favourites`. |
| `/radio now` | Read | What's playing, at a glance: the song or show title from the stream, then the channel, the station's stream and what goes to Discord side by side, and one line on why this source plays (and the fallback), with control buttons and what's up next. The full figures are under Sources, Inspect and `/radio quality`. |
| `/radio stop` | Control | Stops the audio. The bot stays in the channel for 5 minutes (or indefinitely in 24/7 mode) and cancels auto-resume. |
| `/radio join [channel]` | Control | Joins a voice channel, and starts the default station if one is set. |
| `/radio leave` | Control | Disconnects. The bot won't rejoin until someone plays something. |

### Queue

Radio never ends, so the queue moves only when you skip.

| Command | Level | What it does |
|---|---|---|
| `/radio queue add <station>` | Control | Adds a station to the queue (up to 25). If nothing is playing, it starts the station straight away instead. |
| `/radio queue list` | Read | Shows the queue. |
| `/radio queue remove <position>` | Control | Removes one queued station. |
| `/radio queue clear` | Control | Empties the queue. |
| `/radio skip` | Control | Plays the next queued station, passing over any that can no longer be played. A station leaves the queue only once it has actually started. |

### Information

| Command | Level | What it does |
|---|---|---|
| `/radio quality` | Read | Input and output report: source codec, bitrate evidence, sample rate and channels; Opus target, the channel's bitrate setting (shown as "not a cap"), observed output, encryption and resampling. |
| `/radio sources <station>` | Read | The station's sources, best first, with what plays now, the fallback, and why each one can or can't be used. While it plays, anyone with Control can switch to another usable source until the station changes. Admins also get re-probe, *Prefer the playing source on this server* and *Back to automatic choice* buttons. |
| `/radio inspect <station>` | Read | Everything in `sources`, plus the redacted endpoint, every bitrate figure, probe and failure times, health, start-up time and provenance. Admins also get a re-probe button. |
| `/radio status` | Read | Connection state, the desired station and the last problem. |
| `/radio stats` | Admin | A private live panel with **Refresh** and **Close** buttons, described below. |
| `/radio help` | Read | Short help. Admins also see the admin commands. |

`/radio stats` shows:

- **Stream input:** the requested host, the host it redirected to (with a region hint such as "Europe"), the connected IP and port, codec, input bitrate over 10 s and 60 s, HLS segment counts, and TCP round-trip time and jitter to the stream server. The round trip is measured from connection handshakes only; no extra stream request is made.
- **Output to Discord:** the Opus target, the channel's bitrate setting for reference, the Ogg Opus rate actually being sent over 10 s and 60 s, packets per second (normally about 50), and late packets: how many went out more than 40 ms after the one before since the bot joined, and the longest gap. Listeners start to hear a gap of about 55 ms or more as a small cut with a slow-down and speed-up, and the panel says so.
- **Discord voice connection:** the voice server's host name and IP with a region hint, the channel's RTC region, voice WebSocket ping with jitter, gateway ping, encryption and DAVE, and reconnect and failover counts.
- **Bot health:** the process, FFmpeg, the User-Agent in use, per-pack coverage, recent incidents, and the event-loop delay over the last minute. Voice packets go out every 20 ms from that loop, so a delay of 20 ms or more means packets left late, which listeners hear as a short drop and a catch-up.

### Administration

| Command | Level | What it does |
|---|---|---|
| `/radio config [default_station] [manual_bitrate]` | Admin | Interactive settings: command and voice channel allowlists, DJ roles, idle mode, listener control, quality mode, preferred channel, channel lock, autostart, resume after restart, the notice channel, and whether the voice channel status shows what's playing. |
| `/radio add <name> <url> …` | Admin | Adds a custom station for this server. The URL must pass the SSRF policy and a live probe before it is accepted. |
| `/radio edit <station> …` | Admin | Edits a custom station. A new URL is probed first, and the old one is kept if the probe fails. |
| `/radio remove <station>` | Admin | Removes a custom station. Pack stations can't be removed. |
| `/radio rescan <station> [compare]` | Admin | Re-probes a station's sources (rate-limited). `compare:true` also runs an audio comparison of about 40 s against the verified source. |
| `/radio sync [pack]` | Admin | Reconciles station names with each pack's official list (or just `pack`). Reports added, renamed, missing and unreachable stations. |
| `/radio export` | Admin | Downloads this server's settings as JSON. No secrets are included, and custom URLs with query strings are redacted. |
| `/radio import <file>` | Admin | Validates an export and previews the changes. Nothing is applied until you confirm. This server's custom-station favourites and custom default station are kept. |
| `/radio panel [channel]` | Admin | Posts a persistent control panel that survives restarts. Its buttons still check permissions on every click. |
| `/radio source pin <station> <source>` | Admin | Always uses this source. If it becomes ineligible, playback is marked Degraded and uses a fallback. |
| `/radio source prefer <station> <source>` | Admin | Uses this source whenever it is eligible, and automatic selection otherwise. |
| `/radio source auto <station>` | Admin | Returns the station to evidence-based selection. |
| `/radio source verify <station> <source> <verdict>` | Admin (+ Operator for pack sources) | Records an identity review (`verified`, `mismatch` or `clear`). Admins can review their own server's custom stations. A review of a pack source affects every server, so the admin must also be an operator: listed in `OPERATOR_USER_IDS`, or the application owner (or a member of its team). |

**Buttons** on now-playing messages and the control panel: Previous station, Next station, Stop, Leave, Browse stations, Refresh, Favourite, Sources and Inspect. **Skip (n queued)** appears when the queue isn't empty, and is always on the panel. The station list from Browse has a **Favourites** button that shows only this server's favourites, and back.

**Favourites and the default station** do different jobs:

- **Favourites** are this server's shortlist. Anyone who can control the radio adds one with the **Favourite** button under a playing station, and removes it with **Unfavourite**. They come first in the `/radio play` suggestions, have their own list (the Favourites button in Browse, or `/radio list scope:favourites`), and when there are two or more, Next and Previous step through them while one is playing.
- **The default station** is the one station the bot starts by itself, set by an admin with `/radio config default_station` (choose **No default station** to clear it). `/radio join` plays it, and autostart plays it in the preferred voice channel when the bot starts. It also comes first in the `/radio play` suggestions.

> `/radio` uses all 25 top-level options that Discord allows, which is why `queue` and `source` are subcommand groups.

## Station packs

A station pack is a folder containing:

| File | Contents |
|---|---|
| `pack.json` | Pack ID, name, disclaimer, categories, brand labels, and an optional official-list sync |
| `stations.json` | The stations: names, aliases, tags and category |
| `sources.json` | Candidate stream URLs for each station, each with its provenance |

Station IDs look like `<pack-id>:<slug>`, for example `mypack:my-station`, and they are permanent.

The bot loads every pack in `catalog/packs/` and in `EXTRA_PACKS_DIR`. A pack is switched on unless its `enabledByDefault` is `false`. `ENABLED_PACKS` switches on packs that are off by default, and `DISABLED_PACKS` switches any pack off. A pack that fails validation stops start-up with a message naming the file and field.

Radio Bot ships with a starter pack of Radio FG webradio stations, which you can switch off, delete or replace with your own packs.

Each bundled pack's folder includes a `SOURCE_PROVENANCE.md` recording where every stream address came from.

To write a pack, follow [catalog/README.md](catalog/README.md), then check it:

```sh
pnpm build
node dist/scripts/validate-catalogue.js --pack path/to/your-pack
```

Server admins can also add their own public Icecast, SHOUTcast, HLS, PLS or M3U streams with `/radio add`. These are kept in a separate catalogue for that server only.

## Configuration

Settings come from environment variables, usually through `.env`; [`.env.example`](.env.example) lists them all. They are validated at start-up. If one is invalid, the bot exits with code 78 and names the variable, without printing secret values. Per-server settings are made in Discord with `/radio config` and stored in SQLite.

| Variable | Default | Meaning |
|---|---|---|
| `DISCORD_TOKEN` | **required** | Bot token. It is never logged, and it is redacted from errors. |
| `DISCORD_APPLICATION_ID` | **required** | Application (client) ID. |
| `DISCORD_DEV_GUILD_ID` | empty | If set, `/radio` is registered only in this one server. Useful for development. |
| `REGISTER_COMMANDS_ON_START` | `true` | Register `/radio` at start-up and when the bot joins a server. |
| `DATABASE_PATH` | `./data/radio-bot.sqlite` | The SQLite file. Backups and `health.json` are written next to it. Docker sets `/app/data/radio-bot.sqlite`. |
| `LOG_LEVEL` | `info` | `fatal`, `error`, `warn`, `info`, `debug`, `trace` or `silent`. Logs are JSON lines on stdout. |
| `FFMPEG_PATH` / `FFPROBE_PATH` | `ffmpeg` / `ffprobe` | Paths to the binaries. FFmpeg must include the `libopus` encoder. Leave these unset in Docker. |
| `DEFAULT_QUALITY_MODE` | `maximum` | Starting quality for new servers: `maximum` (the source's own bitrate, up to `MAX_OPUS_BITRATE_KBPS`), `balanced` (128 kbps or the source's rate, whichever is lower) or `manual` (an admin-set value, capped at `MAX_OPUS_BITRATE_KBPS`). |
| `MAX_OPUS_BITRATE_KBPS` | `510` | Highest Opus bitrate, 32–510. `maximum` matches each source's own bitrate up to it (and uses it when the source's bitrate is unknown). Lower it to save CPU and upload bandwidth. |
| `DEFAULT_IDLE_MODE` | `leave_when_empty` | Starting idle mode for new servers: `24x7`, `pause_when_empty` or `leave_when_empty`. |
| `AUTO_RESUME_DEFAULT` | `false` | Starting "resume after restart" setting for new servers. |
| `PRESENCE_MODE` | `track` | The bot's own Discord status while it plays: `track` ("Listening to Station Name · Artist - Title"), `station` (station name only) or `off`. A bot has one status for every server, so when several servers play different stations it shows "Listening to radio in 3 servers". Custom stations are private to their server and are never named. |
| `MAX_ACTIVE_GUILD_STREAMS` | `3` | How many servers can stream at once on this installation (1–1000). |
| `MAX_CONCURRENT_PROBES` | `2` | Concurrent source probes across the installation (1–16). Probes to the same host always run one at a time. |
| `MAX_CUSTOM_STATIONS_PER_GUILD` | `25` | Custom stations per server (0–500). `0` turns `/radio add` off. |
| `ALLOW_INSECURE_HTTP_STREAMS` | `true` | Whether plain `http://` stream URLs are allowed, for custom stations and pack sources alike. |
| `STREAM_USER_AGENT` | empty | User-Agent sent to stream hosts (up to 300 characters). Empty means FFmpeg's own, `Lavf/<version>`, taken from the installed FFmpeg (fallback `Lavf/61.7.100`). |
| `CATALOG_SYNC_ENABLED` | `true` | Scheduled sync of station names for each pack that declares an official list. Names and IDs only, never stream URLs. |
| `CATALOG_SYNC_INTERVAL_HOURS` | `24` | Time between syncs, 6–720 hours, with up to 15 minutes of jitter. |
| `EXTRA_PACKS_DIR` | empty | A directory of extra pack folders to load, for example `/app/data/packs` in Docker. |
| `ENABLED_PACKS` | empty | Pack IDs to switch on when their `enabledByDefault` is `false`. |
| `DISABLED_PACKS` | empty | Pack IDs to switch off, such as `mypack`. Their stations are hidden and not synced. |
| `DISABLED_STATION_IDS` | empty | Station IDs to take down, such as `mypack:my-station`. They show as Temporarily unavailable. |
| `DISABLED_SOURCE_IDS` | empty | Source IDs to take down, for takedown requests or broken feeds. |
| `OPERATOR_USER_IDS` | empty | Discord user IDs, separated by commas or spaces, allowed to record identity reviews for pack sources. The application owner (or its team) is always allowed. |
| `PROBE_HISTORY_LIMIT` | `30` | Probe results kept per source (1–1000). |
| `PROBE_HISTORY_DAYS` | `30` | Maximum age of stored probe results, in days (1–365). |
| `DIAGNOSTICS_PORT` | empty (off) | Optional JSON endpoint (`/healthz`, `/diagnostics`), bound to `127.0.0.1` only. If the port is in use, the bot logs a warning and runs without it. |
| `TELEMETRY_ENABLED` | `false` | Must stay `false`. Radio Bot has no telemetry, and `true` is refused at start-up. |

## How it works

```text
 stream host ──HTTPS──▶ SafeHttpClient ──bytes──▶ FFmpeg (stdin) ──Ogg Opus──▶ @discordjs/voice ──DAVE──▶ Discord
   (Icecast/HLS)        SSRF policy, pinned DNS,   decode once,     48 kHz,       demux only,
                        redirects re-checked,       encode once     20 ms frames  no re-encode
                        ICY metadata stripped       with libopus
```

- **Choosing a source.** Every source is probed within a time budget. A few seconds are captured in memory, `ffprobe` reads codec, sample rate, channels and packet sizes, a decode check confirms the audio is valid, and the sample is discarded. A source is eligible only if its identity is verified, it is healthy and it isn't in cooldown. Direct streams are always preferred: HLS is a **last-resort tier**, used only when no direct stream is eligible, because segmented delivery starts more slowly and recovers less smoothly. Within a tier, sources are ranked by evidence, and never across codecs by bitrate alone. See [docs/station-verification.md](docs/station-verification.md).
- **Talking to stream hosts.** The bot identifies itself as FFmpeg's network library (`Lavf/<version>`), which is what decodes the audio. It does not imitate a web browser and sends no `Referer`. A host that still refuses (HTTP 401, 403 or 451) is reported as `ACCESS_DENIED`.
- **Recovery.** The watchdog declares a stall after 15 s without audio. The bot retries the same source with jittered backoff (about 1, 3 and 8 s), then fails over to another verified source. After four consecutive failures (the first plus all three retries) a source goes into a cooldown of 10 minutes, doubling up to 2 hours. Lost voice connections are rebuilt with backoff, and playback that falls more than 45 s behind live re-syncs to the live edge. After a restart, playback resumes only if the server opted in, and an explicit `/radio stop` or `/radio leave` is always respected.
- **Permissions.** Every slash command, button and select menu is authorised on the server side at the moment it is used. Buttons carry signed, server-bound and usually expiring IDs. Rate limits apply to play and switch, probes, custom-station adds, syncs and button clicks. See [docs/permissions.md](docs/permissions.md).

The module map and data flow are in [docs/architecture.md](docs/architecture.md), and the audio path in detail is in [docs/audio-quality.md](docs/audio-quality.md).

## What it cannot do

- **Add fidelity the source doesn't have.** Many internet radio streams are 128 kbps MP3 or AAC. Encoding at the source's bitrate keeps the one extra lossy step small, and no higher target could restore what the station's own encoder removed. The bot never claims "HD" or "lossless" audio.
- **Promise what listeners hear.** A voice channel's bitrate setting is 96 kbps on an unboosted server and up to 384 kbps with boosts. The bot encodes above that setting, but what each listener's client receives hasn't been measured; see [Project status](#project-status).
- **Record.** Nothing is saved to disk. Audio exists only in a short playback buffer and, during a probe, a few seconds in memory. The bot is self-deafened and never receives voice audio.
- **Play anything that isn't live radio.** There's no music search, YouTube or Spotify. Song and show titles appear only when the stream sends them (ICY `StreamTitle`, so not for HLS sources), and they are labelled as stream metadata.
- **Play more than one station per server at a time.** Each server gets one voice connection.
- **Bypass anything.** It cannot get past DRM, encrypted HLS, authentication, geo-blocking or private APIs, and it isn't designed to.

## Project status

Version **1.0.5** is the current release; 1.0.0 was the first public release. Lint, the strict typecheck and the full unit and integration suite pass, and CI runs them on every push and pull request. The integration tests run against a local fixture radio server with synthetic audio, never real stations or Discord. The following have **not** been verified yet, and are listed here so you can judge for yourself:

- **Only one live Discord test so far.** On 1 November 2026, the bot was invited to a private test server with the minimum permissions and played a bundled station in a voice channel, where it was heard in the Discord client. It used the direct MP3 source at 128 kbps and one Opus encode at 128 kbps, and DAVE end-to-end encryption was negotiated. The Discord-side figures in `/radio stats` (voice server, WebSocket ping, packets per second, encryption) were shown live. Not yet tested on a live call: the owner, DJ and member permission scenarios, station switching, and kick, move and channel-delete handling.
- **No 72-hour soak test** has been run, so long-run memory growth and FFmpeg process clean-up over days are unmeasured.
- **Bundled stations are only partly probed.** On 31 October 2026, live probes confirmed 3 of the 63 bundled stations: direct MP3 and AAC-LC, and HLS AAC-LC, all at 128 kbps, 44.1 kHz stereo. The other 60 use the same host and URL pattern but haven't been probed. One HLS address timed out, and one station's direct stream refuses access and is disabled. The probe evidence is kept in the pack's `evidence/` folder.
- **"Identity verified" mostly rests on provenance** (the official player maps the stream to the station) plus a successful probe. Audio comparison has confirmed two stations; the others haven't been compared or checked by listening. `/radio rescan compare:true` and `/radio source verify` exist to strengthen this.
- **Encoding above the channel's bitrate setting:** the bitrate a listener's client actually receives, when the bot sends more than the channel's setting, hasn't been measured.
- **Resource use is measured for one stream only** (see [Requirements](#requirements)): about 8% of one CPU core and about 200 MB of memory at 128 kbps. Several streams at once, long runs, and a Raspberry Pi haven't been measured yet.
- **The licence review of the FFmpeg build in the Docker image hasn't been done.** The image, published to GHCR by the release workflow, uses Debian's FFmpeg packages. The installer downloads it for release versions, and builds the image on your machine if the download fails.
- **The installer and `radio-bot` command** are tested end to end in CI against a stand-in for Docker. `radio-bot update` has also taken a real Docker install from 1.0.1 to 1.0.3 (backup first, healthy straight away, settings kept); that run found the old-image clean-up bug fixed in 1.0.4. A fresh install hasn't yet been run against real Docker on a Linux server, a Raspberry Pi, macOS or Windows.
- **Rights:** no permission has been requested from or granted by any broadcaster. If you operate an instance, that is your responsibility; see [docs/rights-and-disclaimer.md](docs/rights-and-disclaimer.md).

## Development

You need Node.js 24.17+, pnpm (via `corepack enable`) and FFmpeg with `libopus`. The dev dependencies include `ffmpeg-static` and `ffprobe-static` for the tests; on Linux, run the tests against the system FFmpeg instead (`FFMPEG_PATH=/usr/bin/ffmpeg FFPROBE_PATH=/usr/bin/ffprobe pnpm test`), as CI does.

```sh
corepack enable
pnpm install
pnpm typecheck   # strict TypeScript, no emit
pnpm lint        # Biome
pnpm test        # Vitest: unit + integration
pnpm build       # compile to dist/
```

Use a separate Discord application and a private test server for development, never a production token. Read [CONTRIBUTING.md](CONTRIBUTING.md) before opening a pull request. Changes to audio, streams, voice or station packs need a second reviewer, and there are firm rules about fixtures (no copyrighted audio), catalogue provenance and Discord permissions. AI coding agents should read [AGENTS.md](AGENTS.md).

## Documentation

| Document | What it covers |
|---|---|
| [docs/architecture.md](docs/architecture.md) | Modules, data flow and the source-validation boundary |
| [docs/audio-quality.md](docs/audio-quality.md) | The audio path, choosing the Opus target, and honest limits |
| [docs/station-verification.md](docs/station-verification.md) | Candidate states, identity rules, ranking and pack coverage |
| [docs/permissions.md](docs/permissions.md) | Discord permissions, the capability matrix and rate limits |
| [docs/troubleshooting.md](docs/troubleshooting.md) | Problems mapped to reason codes |
| [docs/install.md](docs/install.md) | **Start here:** the beginner's install guide and the `radio-bot` command |
| [docs/install-docker.md](docs/install-docker.md) | Docker Compose by hand: settings, volume, upgrades, backups and restores |
| [docs/install-linux.md](docs/install-linux.md) | Running directly on Linux with systemd |
| [docs/install-container-platforms.md](docs/install-container-platforms.md) | Hosted container platforms: requirements and limits |
| [docs/rights-and-disclaimer.md](docs/rights-and-disclaimer.md) | Unofficial status, rights, takedown and privacy |
| [docs/PRD.md](docs/PRD.md) | Product requirements, as built |
| [catalog/README.md](catalog/README.md) | Station pack authoring guide |
| [CHANGELOG.md](CHANGELOG.md) · [CONTRIBUTING.md](CONTRIBUTING.md) · [SECURITY.md](SECURITY.md) · [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) | Project policies |

## Licence

[MIT](LICENSE) for this project's original code. Third-party audio, station names, trademarks, artwork and the FFmpeg binaries in the Docker image are not covered by it, and belong to their respective owners.
