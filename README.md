# Radio Bot

[![CI](https://github.com/DangerMouseUK/radiobot/actions/workflows/ci.yml/badge.svg)](https://github.com/DangerMouseUK/radiobot/actions/workflows/ci.yml)
[![Licence: MIT](https://img.shields.io/badge/licence-MIT-blue.svg)](LICENSE)
![Node.js 24.17+](https://img.shields.io/badge/node-%3E%3D24.17-339933?logo=nodedotjs&logoColor=white)
![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178C6?logo=typescript&logoColor=white)

**A self-hosted Discord bot that plays live internet radio in your voice channels, and is honest about what it plays.**

Stations come from **station packs**: plain JSON files, one pack per radio company, that you install from the official pack library (or write yourself) and can read, update or remove without touching the code. Before the bot plays a stream, it tests it, checks that it really is the station it claims to be, and can tell you why it chose it. The sound is converted **once** into Opus (the audio format Discord uses), at the station's own bitrate, with no other processing.

> [!IMPORTANT]
> **Unofficial.** Radio Bot is an independent open-source project. It is **not affiliated with, endorsed by or sponsored by any broadcaster**. Station packs refer to stations by name only, so that people can find them; those names, the audio and any artwork belong to their owners. The MIT licence covers this project's original code only. Read [docs/rights-and-disclaimer.md](docs/rights-and-disclaimer.md) before running an instance for anyone other than yourself.

## Highlights

- **Station packs.** Install packs from the official, reviewed pack library with `/radio packs library` in Discord or `radio-bot packs add` on the server, and they play straight away, with no restart and no break in the music. You can also drop your own pack folders into `EXTRA_PACKS_DIR`. One environment variable switches whole packs on or off.
- **The right station first, then the best sound.** A station can have several stream addresses, called *sources*. The bot tests (probes) each one with `ffprobe` and a short decode check, and checks that it is the right station: where the address came from (its provenance), the station name the stream sends and, optionally, a comparison of the audio. It picks the *correct* station first and the best-sounding source second, and `/radio sources` tells you why it chose what it did.
- **One encode, at the station's own quality.** FFmpeg decodes the stream once and encodes it once with `libopus`, at the source's bitrate, up to 510 kbps (48 kHz stereo, music mode). A 320 kbps station goes out at 320 kbps, and a 128 kbps one isn't padded out to waste bandwidth. `@discordjs/voice` only unpacks the result (demuxes it) and sends it on. There is no loudness normalisation, EQ or limiting, and the voice channel's bitrate setting does not limit the output.
- **Automatic recovery.** If the audio stalls, the bot notices and tries again, waiting a little longer each time. If that fails, it switches to another verified source, and rests sources that keep failing (a cooldown) before trying them again. It also reconnects to the voice channel when the connection drops, and catches up with the live broadcast when it falls behind.
- **Now playing.** The current song or show title, when the stream sends one, appears in `/radio now` and on the control panel. The bot's own Discord status shows it too ("Listening to Station Name · Artist - Title"), and so does the status of the voice channel it's playing in ("📻 Station Name · Artist - Title").
- **Queue and skip.** Line up stations with `/radio queue` and move on with `/radio skip` or the **Skip** button.
- **Private live stats.** `/radio stats` shows administrators the input and output bitrate, the server the stream really comes from and its region, and the ping and jitter (how much the ping varies) to both the stream server and Discord's voice server. Only the admin who asked can see the message, and they can close it.
- **Secure by default.** The bot asks for as few Discord permissions as it can, and for none of Discord's privileged intents (access to member lists, presence or message content). All stream traffic goes through an HTTP client that refuses private and internal network addresses (SSRF protection), and FFmpeg reads only from its standard input, never from a URL. The bot checks the user's permission every time a button or command is used. There is no telemetry.
- **Simple to run.** One process and one SQLite database file. It only needs to connect out to the internet: no open port, domain name, reverse proxy, Redis or PostgreSQL.

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
| Bandwidth | Each Discord server the bot is playing in uses the station's bitrate coming in (download) and about the same going out (upload): roughly 60–70 MB per hour each way at 128 kbps, and up to about 230 MB per hour out at the 510 kbps maximum | |

Measured on a small cloud server, one stream at 128 kbps used about 8% of one CPU core and about 200 MB of memory in total (the bot plus its FFmpeg process). Each extra stream adds roughly the same CPU and about 60 MB, so the default limit of 3 streams (`MAX_ACTIVE_GUILD_STREAMS`) fits comfortably within the minimum. These figures haven't been measured on a Raspberry Pi or over long periods yet. A one-core machine is enough, but other scheduled jobs on the same machine (system stats collectors, `docker stats` loggers, backups) can cause brief audio hiccups: the bot sends a small packet of audio every 20 ms, and a burst of other work can make a few leave late.

## Quick start

You need a computer that stays on (Linux, a Raspberry Pi 4/5, a cloud server, or a Mac or Windows PC for trying it out), and a Discord bot token. **New to this? Follow the [beginner's install guide](docs/install.md)**: it walks through every click.

1. **Create a Discord application and bot.** Copy the **Application ID** and the **bot token**; see [docs/install.md, step 1](docs/install.md#1-create-your-discord-bot).
2. **Run the installer** on Linux or macOS. On Windows, if you don't have a Linux machine to hand, it can run inside WSL (see the guide):

   ```bash
   curl -fsSL https://raw.githubusercontent.com/DangerMouseUK/radiobot/main/install.sh | bash
   ```

   It downloads the newest release into `~/radio-bot`, sets up Docker if needed (on Linux, with your permission), asks for your Application ID and token, starts the bot, and waits until it is online. If you'd rather read the script before running it, this does the same thing: `git clone https://github.com/DangerMouseUK/radiobot.git ~/radio-bot && bash ~/radio-bot/scripts/radio-bot.sh install`.
3. **Add some stations.** The bot comes with no stations. On a first install, the installer offers to show the station packs in the official pack library and to add the ones you choose. You can add more at any time with `radio-bot packs browse` and `radio-bot packs add <pack>`, or in Discord with `/radio packs library` (as the bot's owner).
4. **Invite the bot** with the link the installer prints (or `radio-bot invite`).
5. **In your server,** join a voice channel, run `/radio play` and pick a station from the list. Admins can run `/radio config` to choose channels and DJ roles.

From then on, the `radio-bot` command looks after it:

| Command | Does |
|---|---|
| `radio-bot status` · `radio-bot logs` | Version, health and available updates · the live log |
| `radio-bot update` | Updates to the newest release: warns you first if the bot is playing, backs up the database to `backups/`, keeps the old version's last 500 log lines and removes old images. Run it again to finish an update that stopped halfway |
| `radio-bot backup` · `radio-bot restore <file>` | Copy the database out (or, if the bot won't start, the backups it already made) · put a copy back |
| `radio-bot packs` | Station packs: `packs browse [words]` shows the library, `packs add <pack>` installs one, `packs update` updates them, `packs remove <pack>` removes one, and `packs` on its own lists what's installed. A running bot loads the change at once, without interrupting the music |
| `radio-bot config` | Edit installation settings, then restart to apply them |
| `radio-bot start` · `stop` · `restart` · `invite` | Control the bot · print the invite link again |
| `radio-bot uninstall` | Remove it, optionally keeping a copy of your data |

`radio-bot help` lists every command. If you'd rather run Docker Compose yourself: `git clone`, `git checkout` the newest release tag, `cp .env.example .env`, set `DISCORD_TOKEN` and `DISCORD_APPLICATION_ID`, then `docker compose up -d`. [docs/install-docker.md](docs/install-docker.md) covers this in full. The database lives in the `radio-bot_radio-bot-data` volume, and a backup is taken automatically before a database upgrade (a migration) changes it.

## Other ways to deploy

Radio Bot is one program that runs all the time. It needs to connect out to the internet (including UDP, for Discord voice), FFmpeg with `libopus`, and somewhere to keep a small SQLite database file that survives restarts and updates.

| Option | Use when | Guide |
|---|---|---|
| **The installer** (recommended) | Linux, Raspberry Pi, macOS or Windows (WSL). It uses Docker underneath and adds the `radio-bot` command for updates, backups and removal. | [docs/install.md](docs/install.md) |
| **Docker / Docker Compose by hand** | You already run Docker and want full control. The image bundles Node.js and FFmpeg. | [docs/install-docker.md](docs/install-docker.md) |
| **Directly on Linux (systemd)** | You'd rather not use containers. Needs Node.js 24.17+ and FFmpeg installed on the machine. A locked-down systemd service file is included. | [docs/install-linux.md](docs/install-linux.md) |
| **A container platform** | A hosted platform runs the image as an always-on background worker with a persistent volume. Serverless platforms such as Vercel are **not** suitable. | [docs/install-container-platforms.md](docs/install-container-platforms.md) |

## Discord application setup

Step-by-step instructions are in [docs/install.md](docs/install.md#1-create-your-discord-bot). In summary:

- **Developer Portal:** create an application. Under **Bot**, reset and copy the token, which goes in `DISCORD_TOKEN`. Under **General Information**, copy the Application ID, which goes in `DISCORD_APPLICATION_ID`.
- **Gateway intents** (which kinds of events Discord sends the bot): the bot uses only `Guilds` and `GuildVoiceStates`. Leave every privileged intent switched off: Presence, Server Members and Message Content.
- **Scopes:** `bot` and `applications.commands`.
- **Bot permissions** (the minimal set, integer `281474979908608`):

  | Permission | Why |
  |---|---|
  | View Channels | See the voice channel and the panel/notice channels |
  | Send Messages | Only for the optional control panel (`/radio panel`) and the recovery/error notice channel |
  | Embed Links | The control panel, which is an embed |
  | Attach Files | `/radio export` returns a JSON file |
  | Connect | Join the voice channel |
  | Speak | Play audio |
  | Set Voice Channel Status | Optional: show the station and song as the voice channel's status (`/radio config` → Notices). Without it, everything else works |

  Administrator, Manage Channels, Manage Roles, Manage Messages, Read Message History and Message Content are not needed.

- **Invite URL:** replace `APPLICATION_ID` with your own:

  ```text
  https://discord.com/oauth2/authorize?client_id=APPLICATION_ID&scope=bot%20applications.commands&permissions=281474979908608
  ```

`/radio` is registered as a **guild** (server) command in each server the bot is in, so it appears immediately. Registration happens at start-up and whenever the bot joins a new server, and it is skipped when nothing has changed. The command works only in servers, not in DMs.

## Commands

Everything is under `/radio`. There are three access levels:

- **Read:** anyone, in a channel where radio commands are allowed.
- **Control:** admins and members with a DJ role. Other listeners depend on the server's listener-control setting: `same_channel` (the default: listeners who are in a voice channel, and only in the bot's channel while it is playing there), `none` (nobody else) or `any` (everyone). See [docs/permissions.md](docs/permissions.md).
- **Admin:** the server owner, or members with Discord's **Administrator** permission. Nothing else grants admin: not Manage Server, and there is no admin-role setting.

**What everyone sees and what only you see.** Replies that only concern you are ephemeral (only you see them): the now-playing card, lists, settings, errors and refusals. What changes the radio for everyone is announced in the channel in one short line, with no pings:
- changing the station, whether by `/radio play`, Skip, Previous, Next, Browse or a favourite: "@name switched to **My Station**";
- `queue add`, `queue remove` and `queue clear`;
- Stop and Leave.

If the bot can't post that line, the private reply still says what happened. **Refresh** on the control panel redraws the panel itself; on any other card it redraws that card.

### Listening

| Command | Level | What it does |
|---|---|---|
| `/radio play <station> [channel]` | Control | Plays a station in your voice channel (or `channel`), or switches to it. DJs and admins can name any channel; with the default listener control, listeners can only name the one they are in. An ambiguous name shows a picker; the bot never guesses. |
| `/radio browse [pack] [category] [search]` | Read | Paged station picker, grouped by pack, with this server's custom stations last. **Search** opens a box to search by name, alias or genre, or to change or clear the search. Picking a station plays it (needs Control). |
| `/radio list [scope] [pack] [page]` | Read | Station list with status and IDs. By default it lists every station: the packs, then this server's custom stations. `scope` narrows it to `packs` only, this server's `custom` stations, or `favourites`, and `pack` to one pack. A button hides or shows the custom stations, and a menu plays a station from the page (needs Control). |
| `/radio now` | Read | What's playing, at a glance: the song or show title (when the stream sends one), the voice channel, the station's stream next to what is sent to Discord, and one line on why this source was chosen and which one is the fallback. Below that are control buttons and what's queued next. The full figures are under Sources, Inspect and `/radio quality`. |
| `/radio stop` | Control | Stops the audio. The bot stays in the channel for 5 minutes (or indefinitely in 24/7 mode), and won't start playing again by itself after a restart. |
| `/radio join [channel]` | Control | Joins a voice channel, and starts the default station if one is set. After `/radio stop`, with the bot still in the channel, it starts the default station again. |
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
| `/radio quality` | Read | The audio from the station to Discord. Coming in: the source's codec, its bitrate and how that is known, sample rate and channels. Going out: the Opus target, the channel's bitrate setting (shown as "not a cap"), the bitrate actually being sent, encryption and resampling. |
| `/radio sources <station>` | Read | The station's sources, best first: which one plays now, the fallback, and why each one can or can't be used. While the station plays, anyone with Control can switch it to another usable source, until the station changes. Admins also get *Check sources again*, *Use this source first* (try the source playing now first on this server) and *Choose automatically* buttons. |
| `/radio inspect <station>` | Read | Everything in `sources`, plus each stream address (with any secret parts hidden), every bitrate figure, when each source was last checked, last worked and last failed, its health, how long it takes to start, and where the address came from. Admins also get a *Check sources again* button. |
| `/radio status` | Read | Whether the bot is connected, the station it is set to play, and the last problem. |
| `/radio stats` | Admin | A private live panel with **Refresh** and **Close** buttons, described below. |
| `/radio help` | Read | Short help. Admins also see the admin commands. |

`/radio stats` shows:

- **Stream input:** the requested host, the host it redirected to (with a region hint such as "Europe"), the connected IP and port, codec, input bitrate over 10 s and 60 s, HLS segment counts, and TCP round-trip time and jitter to the stream server. The round trip is measured from connection handshakes only; no extra stream request is made.
- **Output to Discord:** the Opus target, the channel's bitrate setting for reference, the Ogg Opus rate actually being sent over 10 s and 60 s, packets per second (normally about 50), and late packets: how many, since the bot joined, went out more than 40 ms after the one before, and the longest gap. Listeners start to hear a gap of about 55 ms or more as a small cut with a slow-down and speed-up, and the panel says so.
- **Discord voice connection:** the voice server's host name and IP with a region hint, the channel's region setting (RTC region), voice WebSocket ping with jitter, gateway ping, encryption and DAVE (Discord's end-to-end encryption for voice), and how many times the bot has reconnected or switched source.
- **Bot health:** the process, FFmpeg, the User-Agent in use, per-pack coverage (how many stations in each pack have a known, working and verified stream), recent incidents, and the event-loop delay over the last minute (how long the bot's main thread was too busy to react). Voice packets go out every 20 ms from that thread, so a delay of 20 ms or more means packets left late, which listeners hear as a short drop and a catch-up.

### Administration

| Command | Level | What it does |
|---|---|---|
| `/radio config [default_station] [manual_bitrate]` | Admin | Opens the server's settings: which text and voice channels the bot may be used in, DJ roles, idle mode (what the bot does when the channel empties), listener control, quality mode, preferred voice channel, channel lock, autostart, resume after restart, the notice channel, and whether the voice channel status shows what's playing. |
| `/radio add <name> <url> [website] [description] [category] [language]` | Admin | Adds a custom station for this server. The URL must be a public address (private and local network addresses are refused) and must pass a live probe before it is accepted. The reply has a **Play now** button. |
| `/radio edit <station> [name] [url] [website] [description] [category] [language]` | Admin | Edits a custom station. A new URL is probed first, and the old one is kept if the probe fails. |
| `/radio remove <station>` | Admin | Removes a custom station for good, with its favourites and queue entries; the reply says what went with it. Pack stations can't be removed. |
| `/radio rescan <station> [compare]` | Admin | Probes a station's sources again now (rate-limited). `compare:true` also compares about 40 s of the audio with the verified source. |
| `/radio export` | Admin | Downloads this server's settings as a JSON file. No secrets are included: a custom station URL that could hold one (it has a query string after `?`, or a user name or password) is left out, and that station has to be added again with `/radio add` after an import. |
| `/radio import <file>` | Admin | Checks an export file and shows what would change. The file's favourites replace this server's. Nothing is applied until you press **Apply import** within 10 minutes. Each server has one preview at a time (a new import replaces it), and five imports per 10 minutes. This server's custom-station favourites and custom default station are kept. |
| `/radio panel [channel]` | Admin | Posts a control panel that stays in the channel and keeps working after restarts. Its buttons still check permissions on every click. |
| `/radio source pin <station> <source>` | Admin | Always uses this source. While it can't be used, playback is marked Degraded and a fallback plays. |
| `/radio source prefer <station> <source>` | Admin | Uses this source whenever it can be used, and lets the bot choose otherwise. |
| `/radio source auto <station>` | Admin | Lets the bot choose the station's source again, from its own checks. |
| `/radio source verify <station> <source> <verdict>` | Admin (+ Operator for pack sources) | Records whether a source really plays this station (`verified`, `mismatch` or `clear`). Admins can review their own server's custom stations. A review of a pack source affects every server, so the admin must also be an operator: listed in `OPERATOR_USER_IDS`, or the application owner (or a member of its team). |

### Station packs

Any admin can look at the station packs. A pack is shared by every server the bot is in, so installing, updating or removing one also needs the admin to be the bot's **operator**: listed in `OPERATOR_USER_IDS`, or the owner of the bot's Discord application (or a member of its team). Pack changes are limited to 10 an hour for the whole installation.

| Command | Level | What it does |
|---|---|---|
| `/radio packs installed` | Admin | Every station pack the bot has: its version, its station count, where it came from (the library, your own `EXTRA_PACKS_DIR`, or the bot itself), whether an update is available, packs that couldn't be loaded and why, and notices such as a pack withdrawn from the library. A menu opens an installed pack's card, with **Update** (when there is one) and **Remove**, which asks first (Operator). |
| `/radio packs library [search] [country]` | Admin | The packs in the official pack library, filtered by words (company, brand, city or pack name) and by country (a name or a two-letter code such as `GB`). A menu opens a pack's card: its company, stations, countries, languages and when its streams were last checked, with an **Install** button (Operator). An install runs in the background without interrupting what is playing, and the card says when it's done. Discord only ever installs from the official library. |
| `/radio packs sync [pack]` | Admin | Checks station names against each pack's official station list (or just the one `pack`). Reports stations that were added, renamed or are missing from the list, and stations whose sources all failed their last check. (This was `/radio sync` before.) |

**Buttons** on now-playing messages and the control panel, in rows of two or three, so each row fits a phone screen: Previous and Next (the next station in the pack, or in your favourites); Browse and Favourite (or Unfavourite, when the station already is one); Sources and Inspect; then Refresh, Stop and Leave. **Skip** joins the first row when the queue isn't empty (blurple then, with the queue under "Up next"), and is always on the panel. The station list from Browse has a **Show favourites** button (**Show all stations** to go back) that switches between all stations and only this server's favourites.

**Favourites and the default station** do different jobs:

- **Favourites** are this server's shortlist. Anyone who can control the radio adds one with the **Favourite** button under a playing station, and removes it with **Unfavourite**. They come first in the `/radio play` suggestions, have their own list (**Show favourites** in Browse, or `/radio list scope:favourites`), and when there are two or more, Next and Previous step through them while one is playing.
- **The default station** is the one station the bot starts by itself, set by an admin with `/radio config default_station` (choose **No default station** to clear it). `/radio join` plays it, and autostart plays it in the preferred voice channel when the bot starts. It also comes first in the `/radio play` suggestions.

> `/radio` uses all 25 top-level options that Discord allows, which is why `queue`, `source` and `packs` are subcommand groups.

## Station packs

A station pack lists one radio company's stations and the public stream addresses that carry them. It is a folder containing:

| File | Contents |
|---|---|
| `pack.json` | Pack ID, name, version, owner, countries, languages, categories, brand labels, and an optional official-list sync |
| `stations.json` | The stations: names, aliases, tags and category |
| `sources.json` | Candidate stream URLs for each station, each with its provenance |

Station IDs look like `<pack-id>:<slug>`, for example `mypack:my-station`, and they are permanent.

Radio Bot ships with no station packs; they come from the official pack library, [DangerMouseUK/radiobot-packs](https://github.com/DangerMouseUK/radiobot-packs), where every pack is reviewed and records where each stream address came from, and you can install, update or remove any of them.

- **Installing packs.** Use `radio-bot packs browse` and `radio-bot packs add <pack>` on the machine that runs the bot, or `/radio packs library` in Discord. Installed packs are kept in the `installed-packs` folder next to the database, and a running bot loads them without a restart. The bot checks the library once a day, shows admins when a pack has an update (it never updates a pack by itself), and removes a pack the library has withdrawn.
- **Updating from an earlier version.** Earlier versions included a pack. When an updated bot starts, it installs any pack its database still uses from the official library before anything plays, so favourites and queues keep working. This needs the bot to reach `github.com`; if it can't, it tries again later.
- **Your own packs.** Put pack folders in a directory and set `EXTRA_PACKS_DIR`. If one of them has a mistake in it, the bot won't start, and the error message names the file and field. (A broken installed pack is skipped instead, and listed in `/radio packs installed`.)
- **Switching packs on and off.** A pack is switched on unless its `enabledByDefault` is `false`. `ENABLED_PACKS` switches on packs that are off by default, and `DISABLED_PACKS` switches any pack off.

To write a pack, follow [catalog/README.md](catalog/README.md) and the library's playbook, start from the example in [`catalog/packs/_template/`](catalog/packs/_template/), then check it:

```sh
node scripts/validate-catalogue.ts --pack path/to/your-pack --strict
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
| `MAX_CONCURRENT_PROBES` | `2` | How many source probes can run at once on this installation (1–16). Probes of the same host always run one at a time. |
| `MAX_CUSTOM_STATIONS_PER_GUILD` | `25` | Custom stations per server (0–500). `0` turns `/radio add` off. |
| `ALLOW_INSECURE_HTTP_STREAMS` | `true` | Whether plain `http://` stream URLs are allowed, for custom stations and pack sources alike. |
| `STREAM_USER_AGENT` | empty | User-Agent sent to stream hosts (up to 300 characters). Empty means FFmpeg's own, `Lavf/<version>`, taken from the installed FFmpeg (fallback `Lavf/61.7.100`). |
| `CATALOG_SYNC_ENABLED` | `true` | Regularly check station names against the official list of each pack that has one. Names and IDs only, never stream URLs. |
| `CATALOG_SYNC_INTERVAL_HOURS` | `24` | Time between these checks, 6–720 hours, plus a random delay of up to 15 minutes. |
| `EXTRA_PACKS_DIR` | empty | A directory of your own pack folders to load, for example `/app/data/my-packs` in Docker. Packs installed from the library don't go here: they live in the `installed-packs` folder next to the database. |
| `ENABLED_PACKS` | empty | Pack IDs to switch on when their `enabledByDefault` is `false`. |
| `DISABLED_PACKS` | empty | Pack IDs to switch off, such as `mypack`. Their stations are hidden and not synced. |
| `DISABLED_STATION_IDS` | empty | Station IDs to take down, such as `mypack:my-station`. They show as Temporarily unavailable. |
| `DISABLED_SOURCE_IDS` | empty | Source IDs to take down, for takedown requests or broken feeds. |
| `OPERATOR_USER_IDS` | empty | Discord user IDs, separated by commas or spaces, allowed to record identity reviews for pack sources and to install, update or remove station packs from Discord (they must also be an admin of the server they use the command in). The application owner (or its team) is always allowed. |
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

- **Choosing a source.** Every source is probed within a time limit. A few seconds of audio are held in memory, `ffprobe` reads the codec, sample rate, channels and packet sizes, a decode check confirms the audio is valid, and the sample is thrown away. A source can be used only if it is verified as the right station, it is healthy and it isn't resting after repeated failures (in cooldown). Direct streams always come first. HLS (a stream delivered as a series of short files) is a **last resort**, used only when no direct stream can be used, because it starts more slowly and recovers less smoothly. Among sources of the same kind, the one with the best evidence wins, and bitrates of different codecs are never compared, with one narrow exception: measured AAC-LC at twice the rate, and at least 96 kbps, beats HE-AAC. See [docs/station-verification.md](docs/station-verification.md).
- **Talking to stream hosts.** The bot identifies itself as FFmpeg's network library (`Lavf/<version>`), which is what decodes the audio. It does not imitate a web browser and sends no `Referer`. A host that still refuses (HTTP 401, 403 or 451) is reported as `ACCESS_DENIED`.
- **Recovery.** If no audio arrives for 15 s, the bot treats the stream as stalled. It tries the same source again, waiting about 1, 3 and then 8 s between tries (with a little randomness), then switches to another verified source. A short blip, such as a station's encoder reconnecting, doesn't put a source on hold: only failures that keep coming for more than a minute do (for 10 minutes, doubling each time up to 2 hours), and even then the bot checks it again every 2 minutes if nothing else can play. Once a better source works again, the bot moves back to it, at most once every 10 minutes. A lost voice connection is rebuilt, waiting longer between attempts each time, then retried every 2 minutes for as long as the radio should be playing. Playback that falls more than 45 s behind the live broadcast jumps forward to live. After a restart, playback resumes only if the server has turned that on, and a `/radio stop` or `/radio leave` is always respected.
- **Permissions.** Every slash command, button, select menu and form checks the user's permission at the moment it is used. Buttons and forms carry signed IDs that work only in their own server and usually expire. Rate limits apply to play and switch, probes, custom-station adds, syncs, imports, station pack changes and button clicks. See [docs/permissions.md](docs/permissions.md).

The module map and data flow are in [docs/architecture.md](docs/architecture.md), and the audio path in detail is in [docs/audio-quality.md](docs/audio-quality.md).

## What it cannot do

- **Make a stream sound better than it is.** Many internet radio streams are 128 kbps MP3 or AAC. Encoding at the source's bitrate keeps the one extra lossy step small, and no higher bitrate could restore what the station's own encoder removed. The bot never claims "HD" or "lossless" audio.
- **Promise what listeners hear.** A voice channel's bitrate setting is 96 kbps on an unboosted server and up to 384 kbps with boosts. The bot encodes above that setting, but what each listener's client receives hasn't been measured; see [Project status](#project-status).
- **Record.** Nothing is saved to disk. Audio exists only in a short playback buffer and, during a probe, a few seconds in memory. The bot is self-deafened and never receives voice audio.
- **Play anything that isn't live radio.** There's no music search, YouTube or Spotify. Song and show titles appear only when the stream sends them (ICY `StreamTitle`, so not for HLS sources), and they are labelled as stream metadata.
- **Play more than one station per server at a time.** Each server gets one voice connection.
- **Bypass anything.** It cannot get past DRM, encrypted HLS, authentication, geo-blocking or private APIs, and it isn't designed to.

## Project status

Version **1.1.0** is the current release; 1.0.0 was the first public release. Lint, the strict typecheck and the full unit and integration suite pass, and CI runs them on every push and pull request. The integration tests run against a local fixture radio server with synthetic audio, never real stations or Discord. The following have **not** been verified yet, and are listed here so you can judge for yourself:

- **Only one live Discord test so far.** On 1 November 2026, the bot was invited to a private test server with the minimum permissions and played a station from the pack that then shipped with the bot in a voice channel, where it was heard in the Discord client. It used the direct MP3 source at 128 kbps and one Opus encode at 128 kbps, and DAVE end-to-end encryption was negotiated. The Discord-side figures in `/radio stats` (voice server, WebSocket ping, packets per second, encryption) were shown live. Not yet tested on a live call: the owner, DJ and member permission scenarios, station switching, and kick, move and channel-delete handling.
- **No 72-hour soak test** (a long, unattended run) has been run, so long-run memory growth and FFmpeg process clean-up over days are unmeasured.
- **Pack stations are only partly probed.** On 31 October 2026, live probes confirmed 3 of the 63 stations of the pack that used to ship with the bot (it is now in the pack library): direct MP3 and AAC-LC, and HLS AAC-LC, all at 128 kbps, 44.1 kHz stereo. The other 60 use the same host and URL pattern but haven't been probed. One HLS address timed out, and one station's direct stream refuses access and is disabled. The probe evidence is kept in the pack's `evidence/` folder in the library.
- **The pack library's own GitHub workflows** (the checks on each change, and publishing `index.json` and the bundles as release assets) haven't been verified on GitHub yet. Downloading, checking and installing packs are covered by the tests against a local stand-in library only.
- **Installing, updating and removing packs from Discord** (`/radio packs installed` and `/radio packs library`) hasn't been tried on a live Discord server yet, and nor has the automatic reinstall of the formerly included pack when an existing install updates.
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
| [catalog/README.md](catalog/README.md) | Station pack format, where packs are loaded from, pack libraries and the authoring tools |
| [CHANGELOG.md](CHANGELOG.md) · [CONTRIBUTING.md](CONTRIBUTING.md) · [SECURITY.md](SECURITY.md) · [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) | Project policies |

## Licence

[MIT](LICENSE) for this project's original code. Third-party audio, station names, trademarks, artwork and the FFmpeg binaries in the Docker image are not covered by it, and belong to their respective owners.
