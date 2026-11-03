<p align="center">
  <img src="docs/assets/radio-bot-banner.png" alt="Radio Bot: live radio in your voice channels" width="100%">
</p>

<h1 align="center">
  <img src="docs/assets/radio-bot-icon-rounded.png" alt="" width="56" height="56" align="absmiddle">&nbsp;Radio Bot
</h1>

<p align="center">
  <strong>A self-hosted Discord bot that plays live internet radio in your voice channels,<br>and is honest about what it plays.</strong>
</p>

<p align="center">
  <a href="https://github.com/DangerMouseUK/radiobot/actions/workflows/ci.yml"><img src="https://github.com/DangerMouseUK/radiobot/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/licence-MIT-blue.svg" alt="Licence: MIT"></a>
  <img src="https://img.shields.io/badge/node-%3E%3D24.17-339933?logo=nodedotjs&amp;logoColor=white" alt="Node.js 24.17+">
  <img src="https://img.shields.io/badge/TypeScript-strict-3178C6?logo=typescript&amp;logoColor=white" alt="TypeScript">
</p>

<p align="center">
  <a href="#quick-start"><strong>Quick start</strong></a>
  &nbsp;·&nbsp;
  <a href="docs/install.md">Beginner's install guide</a>
  &nbsp;·&nbsp;
  <a href="#commands">Commands</a>
  &nbsp;·&nbsp;
  <a href="#station-packs">Station packs</a>
  &nbsp;·&nbsp;
  <a href="docs/troubleshooting.md">Troubleshooting</a>
</p>

<br>

You choose the stations by installing **station packs**: small sets of JSON files, one pack per radio company, from the reviewed [pack library](https://github.com/DangerMouseUK/radiobot-packs) or written by you. Before the bot plays a stream, it tests it, checks that it really is the station it claims to be, and can tell you why it picked it. The sound is converted **once** into Opus, Discord's audio format, at the station's own bitrate, with nothing else done to it.

> [!IMPORTANT]
> **Unofficial.** Radio Bot is an independent open-source project. It is **not affiliated with, endorsed by or sponsored by any broadcaster**. Station packs name stations only so that people can find them; those names, the audio and any artwork belong to their owners. The MIT licence covers this project's original code only. Read [docs/rights-and-disclaimer.md](docs/rights-and-disclaimer.md) before running an instance for anyone other than yourself.

## Highlights

- **Stations you choose.** Add packs from the pack library with `/radio packs library` in Discord or `radio-bot packs add` on your server. They're ready to play straight away: no restart, and no break in whatever is playing.
- **The right station first, then the best sound.** A station can have several stream addresses (*sources*). The bot tests each one and checks it is the right station before anything else, then picks the best-sounding of those. `/radio sources` shows its reasoning.
- **One encode, at the station's own quality.** The stream is decoded once and encoded once with `libopus`, at the source's own bitrate (up to 510 kbps, 48 kHz stereo). A 320 kbps station goes out at 320 kbps, and a 128 kbps one isn't padded out. There is no loudness normalisation, EQ or limiting.
- **It recovers by itself.** When audio stalls, the bot retries, then switches to another verified source, and rests sources that keep failing. It rebuilds a dropped voice connection and catches up with the live broadcast if it falls behind.
- **Now playing everywhere.** The song or show title, when the stream sends one, appears in `/radio now`, on the control panel, in the bot's Discord status and in the voice channel's status.
- **Queue, favourites and a control panel.** Line stations up with `/radio queue`, keep a shortlist of favourites, and post a panel of buttons that keeps working after restarts.
- **Private live stats for admins.** `/radio stats` shows the bitrate coming in and going out, where the stream really comes from, and the ping and jitter to the stream server and to Discord.
- **Secure by default.** Minimal Discord permissions and no privileged intents. All stream traffic goes through a client that refuses private and internal addresses, and FFmpeg never touches a URL. Every command and button is permission-checked when it is used. No telemetry.
- **Light and simple to run.** One process and one SQLite file, happy on a single CPU core. It only connects out: no open port, domain, reverse proxy or database server.

## Contents

- [Requirements](#requirements)
- [Quick start](#quick-start)
- [Other ways to install](#other-ways-to-install)
- [Station packs](#station-packs)
- [Commands](#commands)
- [Discord application setup](#discord-application-setup)
- [Configuration](#configuration)
- [How it works](#how-it-works)
- [What it can't do](#what-it-cant-do)
- [Project status](#project-status)
- [Development](#development)
- [Documentation](#documentation)
- [Licence](#licence)

## Requirements

| | Minimum | Recommended |
|---|---|---|
| CPU | 1 core, 64-bit (x86-64 or ARM64, such as a Raspberry Pi 4 or 5) | 1–2 cores |
| Memory | 512 MB | 1 GB |
| Disk | 3 GB free: the Docker image (about 1 GB) is briefly there twice during an update, plus the database and backups | 5 GB |
| Network | Outbound only, including UDP for Discord voice. No open ports | |
| Bandwidth | Per server playing: the station's bitrate coming in and about the same going out. Roughly 60–70 MB an hour each way at 128 kbps, and up to about 230 MB an hour out at 510 kbps | |

On a small cloud server, one 128 kbps stream used about 8% of one CPU core and about 200 MB of memory in total (the bot and its FFmpeg process). Each extra stream adds roughly the same CPU and about 60 MB, so the default limit of 3 streams (`MAX_ACTIVE_GUILD_STREAMS`) fits comfortably within the minimum. These figures haven't yet been measured on a Raspberry Pi or over long periods.

A one-core machine is enough, but other heavy scheduled jobs on it (stats collectors, `docker stats` loggers, backups) can cause brief hiccups: the bot sends a small packet of audio every 20 ms, and a burst of other work can make a few leave late.

## Quick start

You need a computer that stays on (Linux, a Raspberry Pi 4 or 5, a cloud server, or a Mac or Windows PC to try it out) and a Discord bot token. **New to this? Follow the [beginner's install guide](docs/install.md)**, which walks through every click.

1. **Create a Discord application and bot,** and copy its **Application ID** and **bot token** ([how](docs/install.md#1-create-your-discord-bot)).
2. **Run the installer** on Linux or macOS (on Windows, inside WSL; the guide explains):

   ```bash
   curl -fsSL https://raw.githubusercontent.com/DangerMouseUK/radiobot/main/install.sh | bash
   ```

   It downloads the newest release into `~/radio-bot`, sets up Docker if needed (on Linux, with your permission), asks for your Application ID and token, starts the bot and waits until it is online. To read the script before running it, this does the same: `git clone https://github.com/DangerMouseUK/radiobot.git ~/radio-bot && bash ~/radio-bot/scripts/radio-bot.sh install`.
3. **Add some stations.** The bot comes with none. On a first install, the installer offers to show the pack library and add the packs you pick. You can add more at any time (see [Station packs](#station-packs)).
4. **Invite the bot** with the link the installer prints (or `radio-bot invite`).
5. **In your server,** join a voice channel, run `/radio play` and pick a station. Admins can run `/radio config` to choose channels and DJ roles.

From then on, the `radio-bot` command looks after it:

| Command | What it does |
|---|---|
| `radio-bot status` · `radio-bot logs` | Version, health and available updates · the live log |
| `radio-bot packs` | Station packs: `packs browse [words]` shows the library, `packs add <pack>` installs one, `packs update` updates them, `packs remove <pack>` removes one, and `packs` on its own lists what's installed. A running bot picks up the change at once, without interrupting the music |
| `radio-bot update` | Updates to the newest release. It warns you first if the bot is playing, backs up the database to `backups/`, keeps the old version's last 500 log lines and removes old images. Run it again to finish an update that stopped halfway |
| `radio-bot backup` · `radio-bot restore <file>` | Copy the database out (or, if the bot won't start, the backups it already made) · put a copy back |
| `radio-bot config` | Edit the installation's settings, then restart to apply them |
| `radio-bot start` · `stop` · `restart` · `invite` | Control the bot · print the invite link again |
| `radio-bot uninstall` | Remove it, optionally keeping a copy of your data |

`radio-bot help` lists every command.

## Other ways to install

Radio Bot is one program that runs all the time. It needs outbound internet access (including UDP for Discord voice), FFmpeg with `libopus`, and somewhere to keep a small SQLite database that survives restarts and updates.

| Option | Use it when | Guide |
|---|---|---|
| **The installer** (recommended) | Linux, Raspberry Pi, macOS or Windows (WSL). Docker underneath, plus the `radio-bot` command for updates, backups and packs | [docs/install.md](docs/install.md) |
| **Docker Compose by hand** | You already run Docker and want full control. The image includes Node.js and FFmpeg | [docs/install-docker.md](docs/install-docker.md) |
| **Directly on Linux (systemd)** | You'd rather not use containers. Needs Node.js 24.17+ and FFmpeg; a locked-down systemd service file is included | [docs/install-linux.md](docs/install-linux.md) |
| **A container platform** | A hosted platform runs the image as an always-on worker with a persistent volume. Serverless platforms such as Vercel are **not** suitable | [docs/install-container-platforms.md](docs/install-container-platforms.md) |

With Docker Compose by hand: clone the repository, `git checkout` the newest release tag, `cp .env.example .env`, set `DISCORD_TOKEN` and `DISCORD_APPLICATION_ID`, then `docker compose up -d`. The database lives in the `radio-bot_radio-bot-data` volume, and a backup is taken automatically before a database upgrade changes it.

## Station packs

A station pack lists one radio company's stations and the public stream addresses that carry them. Radio Bot ships with none: they come from the [official pack library](https://github.com/DangerMouseUK/radiobot-packs), where every pack is reviewed and records where each stream address came from, and you install, update or remove them as you like.

### Installing and removing packs

- **On the server:** `radio-bot packs browse` (add words, `--country GB` or `--language fr` to narrow it down), then `radio-bot packs add <pack>`, or `--collection <name>` for a whole collection. `radio-bot packs update` and `radio-bot packs remove <pack>` do what they say. Anyone with shell access can also install from another library with `--from <address>`.
- **In Discord:** `/radio packs library` to find and install, `/radio packs installed` to update or remove. Discord installs only ever come from the official library, and changing packs needs the bot's [operator](#who-can-do-what).
- **Either way,** the running bot loads the change straight away, without a restart or a break in the music. A removed pack's stations are hidden, and come back with their favourites if the pack is installed again.

### Updates, withdrawals and older installs

- Once a day the bot checks the library. It tells admins when a pack has an update (it never updates a pack by itself), and removes any pack the library has withdrawn.
- Earlier versions of Radio Bot included a pack. When an updated bot starts, it reinstalls from the library any pack its database still uses, before anything plays, so favourites and queues keep working. This needs the bot to reach `github.com`; if it can't, it tries again later.

### Your own packs

Put pack folders in a directory and point `EXTRA_PACKS_DIR` at it. A pack with a mistake in it stops the bot from starting, with a message naming the file and field, so you see it at once. (A broken pack installed from a library is skipped instead, and listed in `/radio packs installed`.)

Each pack is a folder:

| File | Contents |
|---|---|
| `pack.json` | ID, name, version, owner, countries, languages, categories, brand labels and an optional official-list sync |
| `stations.json` | The stations: names, aliases, tags and categories |
| `sources.json` | Each station's stream addresses, and where each one came from (its provenance) |

Station IDs look like `<pack-id>:<slug>`, for example `mypack:my-station`, and never change. To write a pack, follow [catalog/README.md](catalog/README.md) and the library's playbook, start from [`catalog/packs/_template/`](catalog/packs/_template/), and check it with:

```sh
node scripts/validate-catalogue.ts --pack path/to/your-pack --strict
```

Packs are switched on unless their `enabledByDefault` is `false`. `ENABLED_PACKS` switches on packs that are off by default, and `DISABLED_PACKS` switches any pack off.

Server admins can also add their own public Icecast, SHOUTcast, HLS, PLS or M3U streams with `/radio add`. These custom stations belong to that server only.

## Commands

Everything is under `/radio`, and it only works in servers, not in DMs.

### Who can do what

- **Read:** anyone, in a channel where radio commands are allowed.
- **Control:** admins and members with a DJ role. Other listeners depend on the server's listener-control setting: `same_channel` (the default: listeners in a voice channel, and only in the bot's channel while it plays there), `none` or `any`.
- **Admin:** the server owner, or members with Discord's **Administrator** permission. Nothing else grants admin: not Manage Server, and there is no admin-role setting.
- **Operator:** an admin who may also make changes that affect every server the bot is in (installing, updating or removing packs, and reviewing pack sources). That means a user listed in `OPERATOR_USER_IDS`, or the owner of the bot's Discord application (or a member of its team).

Replies that only concern you are private (ephemeral): the now-playing card, lists, settings, errors and refusals. Anything that changes the radio for everyone (changing station, the queue, Stop and Leave) is announced in the channel in one short line, with no pings. The full capability matrix is in [docs/permissions.md](docs/permissions.md).

### Listening

| Command | Level | What it does |
|---|---|---|
| `/radio play <station> [channel]` | Control | Plays a station in your voice channel (or `channel`), or switches to it. An ambiguous name shows a picker: the bot never guesses |
| `/radio browse [pack] [category] [search]` | Read | A paged station picker, grouped by pack, with this server's custom stations last. **Search** opens a box to search by name, alias or genre. Picking a station plays it (needs Control) |
| `/radio list [scope] [pack] [page]` | Read | Every station with its status and ID. `scope` narrows it to `packs`, this server's `custom` stations or `favourites`. A menu plays a station from the page (needs Control) |
| `/radio now` | Read | What's playing: the title (when the stream sends one), the channel, the station's stream next to what goes to Discord, why this source was chosen, control buttons and what's queued next |
| `/radio stop` | Control | Stops the audio. The bot stays in the channel for 5 minutes (or indefinitely in 24/7 mode) and won't start again by itself after a restart |
| `/radio join [channel]` | Control | Joins a voice channel and starts the default station, if one is set |
| `/radio leave` | Control | Disconnects. The bot won't rejoin until someone plays something |

### Queue

Radio never ends, so the queue moves only when you skip.

| Command | Level | What it does |
|---|---|---|
| `/radio queue add <station>` | Control | Adds a station to the queue (up to 25), or starts it straight away if nothing is playing |
| `/radio queue list` | Read | Shows the queue |
| `/radio queue remove <position>` | Control | Removes one queued station |
| `/radio queue clear` | Control | Empties the queue |
| `/radio skip` | Control | Plays the next queued station, passing over any that can no longer play |

### Information

| Command | Level | What it does |
|---|---|---|
| `/radio quality` | Read | The audio from the station to Discord. Coming in: the codec, the bitrate and how it is known, sample rate and channels. Going out: the Opus target, the bitrate actually being sent, encryption and resampling |
| `/radio sources <station>` | Read | The station's sources, best first: which one plays, the fallback, and why each can or can't be used. While it plays, Control can switch to another usable source. Admins also get **Check sources again**, **Use this source first** and **Choose automatically** |
| `/radio inspect <station>` | Read | Everything in `sources`, plus each stream address (secret parts hidden), every bitrate figure, check history, health, start-up time and provenance |
| `/radio status` | Read | Whether the bot is connected, the station it is set to play, and the last problem |
| `/radio stats` | Admin | A private live panel with **Refresh** and **Close** (see below) |
| `/radio help` | Read | Short help. Admins also see the admin commands |

`/radio stats` covers four areas:

- **Stream input:** the requested host and where it redirected to (with a region hint), the connected address, codec, input bitrate over 10 s and 60 s, HLS segment counts, and the TCP round trip and jitter to the stream server (from connection handshakes only; no extra requests).
- **Output to Discord:** the Opus target, the rate actually being sent over 10 s and 60 s, packets per second (normally about 50), and late packets: how many left more than 40 ms after the one before, and the longest gap. A gap of about 55 ms or more is heard as a small cut, and the panel says so.
- **Discord voice connection:** the voice server and its region, the channel's region setting, voice WebSocket ping and jitter, gateway ping, encryption and DAVE (Discord's end-to-end voice encryption), and how often the bot has reconnected or switched source.
- **Bot health:** the process and FFmpeg, the User-Agent in use, each pack's coverage (stations with a known, working and verified stream), any packs that couldn't be loaded, recent incidents, and the event-loop delay over the last minute. Voice packets leave every 20 ms from that loop, so a delay of 20 ms or more means some left late.

### Station packs

| Command | Level | What it does |
|---|---|---|
| `/radio packs installed` | Admin | Every pack the bot has: version, station count, where it came from (the library, your `EXTRA_PACKS_DIR`, or the bot itself), available updates, packs that couldn't be loaded and why, and notices such as a withdrawn pack. A menu opens a pack's card, with **Update** and **Remove** (Operator) |
| `/radio packs library [search] [country]` | Admin | The official library's packs, filtered by words (company, brand, city or pack name) and country (a name or a code such as `GB`). A pack's card shows its company, stations, countries, languages and when its streams were last checked, with **Install** (Operator). Installs run in the background without interrupting what's playing; the card shows **Installing…** until it's done |
| `/radio packs sync [pack]` | Admin | Checks station names against each pack's official station list (or one `pack`), and reports stations added, renamed or missing, and stations whose sources all failed their last check. (This used to be `/radio sync`) |

Pack changes are limited to 10 an hour for the whole installation.

### Administration

| Command | Level | What it does |
|---|---|---|
| `/radio config [default_station] [manual_bitrate]` | Admin | The server's settings: allowed text and voice channels, DJ roles, idle mode, listener control, quality mode, preferred voice channel, channel lock, autostart, resume after restart, the notice channel, and the voice channel status |
| `/radio add <name> <url> [website] [description] [category] [language]` | Admin | Adds a custom station for this server. The URL must be public (private and local addresses are refused) and must pass a live check first. The reply has a **Play now** button |
| `/radio edit <station> [name] [url] [website] [description] [category] [language]` | Admin | Edits a custom station. A new URL is checked first, and the old one kept if the check fails |
| `/radio remove <station>` | Admin | Removes a custom station for good, with its favourites and queue entries. Pack stations can't be removed |
| `/radio rescan <station> [compare]` | Admin | Checks a station's sources again now (rate-limited). `compare:true` also compares about 40 s of audio with the verified source |
| `/radio export` | Admin | Downloads this server's settings as a JSON file, with no secrets: a custom station whose URL could hold one is left out, and has to be added again after an import |
| `/radio import <file>` | Admin | Shows what an export file would change. Nothing is applied until you press **Apply import** within 10 minutes |
| `/radio panel [channel]` | Admin | Posts a control panel that stays in the channel and keeps working after restarts |
| `/radio source pin <station> <source>` | Admin | Always uses this source. While it can't be used, playback is marked Degraded and a fallback plays |
| `/radio source prefer <station> <source>` | Admin | Uses this source whenever it can be used, and lets the bot choose otherwise |
| `/radio source auto <station>` | Admin | Lets the bot choose the source again |
| `/radio source verify <station> <source> <verdict>` | Admin (Operator for pack sources) | Records whether a source really plays this station (`verified`, `mismatch` or `clear`) |

> `/radio` uses all 25 top-level options Discord allows, which is why `queue`, `source` and `packs` are subcommand groups.

### Buttons and favourites

The now-playing card and the control panel have buttons in rows that fit a phone screen: **Previous** and **Next** (through the pack, or through your favourites), **Browse** and **Favourite**, **Sources** and **Inspect**, then **Refresh**, **Stop** and **Leave**. **Skip** appears when the queue isn't empty, and is always on the panel.

- **Favourites** are this server's shortlist. Anyone who can control the radio adds one with **Favourite** under a playing station. They come first in `/radio play` suggestions, have their own list (**Show favourites** in Browse, or `/radio list scope:favourites`), and Next and Previous step through them.
- **The default station** is the one station the bot starts by itself, set by an admin with `/radio config default_station`. `/radio join` and autostart play it.

## Discord application setup

Step-by-step instructions are in [docs/install.md](docs/install.md#1-create-your-discord-bot). In short:

- **Developer Portal:** create an application. Under **Bot**, reset and copy the token (`DISCORD_TOKEN`). Under **General Information**, copy the Application ID (`DISCORD_APPLICATION_ID`).
- **Gateway intents:** the bot uses only `Guilds` and `GuildVoiceStates`. Leave every privileged intent off: Presence, Server Members and Message Content.
- **Scopes:** `bot` and `applications.commands`.
- **Bot permissions,** the minimal set (integer `281474979908608`):

  | Permission | Why |
  |---|---|
  | View Channels | See the voice channel and the panel and notice channels |
  | Send Messages | Only for the optional control panel and the notice channel |
  | Embed Links | The control panel is an embed |
  | Attach Files | `/radio export` returns a JSON file |
  | Connect | Join the voice channel |
  | Speak | Play audio |
  | Set Voice Channel Status | Optional: show the station and song as the channel's status. Everything else works without it |

  Administrator, Manage Channels, Manage Roles, Manage Messages, Read Message History and Message Content are not needed.

- **Invite URL** (replace `APPLICATION_ID` with your own):

  ```text
  https://discord.com/oauth2/authorize?client_id=APPLICATION_ID&scope=bot%20applications.commands&permissions=281474979908608
  ```

`/radio` is registered as a server (guild) command in every server the bot is in, so it appears immediately. Registration happens at start-up and when the bot joins a server, and is skipped when nothing has changed.

## Configuration

Settings come from environment variables, usually in `.env`; [`.env.example`](.env.example) lists them all. They are checked at start-up: if one is invalid, the bot exits with code 78 and names the variable, without printing secret values. Each server's own settings are made in Discord with `/radio config` and stored in SQLite.

**Discord**

| Variable | Default | Meaning |
|---|---|---|
| `DISCORD_TOKEN` | **required** | Bot token. Never logged, and redacted from errors |
| `DISCORD_APPLICATION_ID` | **required** | Application (client) ID |
| `DISCORD_DEV_GUILD_ID` | empty | If set, `/radio` is registered only in this server. Useful for development |
| `REGISTER_COMMANDS_ON_START` | `true` | Register `/radio` at start-up and when the bot joins a server |
| `OPERATOR_USER_IDS` | empty | Discord user IDs (separated by commas or spaces) who may install, update or remove packs from Discord and review pack sources. They must also be an admin where they use the command. The application owner (or its team) is always allowed |
| `PRESENCE_MODE` | `track` | The bot's Discord status while it plays: `track` ("Listening to Station · Artist - Title"), `station` or `off`. With several servers playing it shows "Listening to radio in 3 servers". Custom stations are never named |

**Audio and playback**

| Variable | Default | Meaning |
|---|---|---|
| `DEFAULT_QUALITY_MODE` | `maximum` | Quality for new servers: `maximum` (the source's own bitrate, up to `MAX_OPUS_BITRATE_KBPS`), `balanced` (128 kbps, or the source's rate if lower) or `manual` (an admin's value, capped at `MAX_OPUS_BITRATE_KBPS`) |
| `MAX_OPUS_BITRATE_KBPS` | `510` | Highest Opus bitrate, 32–510. `maximum` follows each source's own bitrate up to it, and uses it when a source's bitrate is unknown. Lower it to save CPU and upload bandwidth |
| `DEFAULT_IDLE_MODE` | `leave_when_empty` | Idle mode for new servers: `24x7`, `pause_when_empty` or `leave_when_empty` |
| `AUTO_RESUME_DEFAULT` | `false` | "Resume after restart" for new servers |
| `FFMPEG_PATH` / `FFPROBE_PATH` | `ffmpeg` / `ffprobe` | Paths to the binaries; FFmpeg must include `libopus`. Leave unset in Docker |
| `STREAM_USER_AGENT` | empty | User-Agent for stream hosts (up to 300 characters). Empty means FFmpeg's own, `Lavf/<version>` |
| `ALLOW_INSECURE_HTTP_STREAMS` | `true` | Whether plain `http://` stream addresses are allowed, for custom stations and pack sources alike |

**Limits**

| Variable | Default | Meaning |
|---|---|---|
| `MAX_ACTIVE_GUILD_STREAMS` | `3` | Servers that can stream at once (1–1000) |
| `MAX_CONCURRENT_PROBES` | `2` | Source checks that can run at once (1–16). Checks of the same host always run one at a time |
| `MAX_CUSTOM_STATIONS_PER_GUILD` | `25` | Custom stations per server (0–500). `0` turns `/radio add` off |
| `PROBE_HISTORY_LIMIT` | `30` | Check results kept per source (1–1000) |
| `PROBE_HISTORY_DAYS` | `30` | Maximum age of stored check results, in days (1–365) |

**Station packs and takedowns**

| Variable | Default | Meaning |
|---|---|---|
| `EXTRA_PACKS_DIR` | empty | A directory of your own pack folders, for example `/app/data/my-packs` in Docker. Packs from the library live in the `installed-packs` folder next to the database instead |
| `ENABLED_PACKS` | empty | Pack IDs to switch on when their `enabledByDefault` is `false` |
| `DISABLED_PACKS` | empty | Pack IDs to switch off, such as `mypack`. Their stations are hidden and not synced |
| `DISABLED_STATION_IDS` | empty | Station IDs to take down, such as `mypack:my-station`. They show as Temporarily unavailable |
| `DISABLED_SOURCE_IDS` | empty | Source IDs to take down, for takedown requests or broken feeds |
| `CATALOG_SYNC_ENABLED` | `true` | Regularly check station names against each pack's official list, if it has one. Names and IDs only, never stream addresses |
| `CATALOG_SYNC_INTERVAL_HOURS` | `24` | Time between those checks, 6–720 hours, plus a random delay of up to 15 minutes |

**Storage, logs and diagnostics**

| Variable | Default | Meaning |
|---|---|---|
| `DATABASE_PATH` | `./data/radio-bot.sqlite` | The SQLite file. Backups, `health.json` and `installed-packs/` sit next to it. Docker sets `/app/data/radio-bot.sqlite` |
| `LOG_LEVEL` | `info` | `fatal`, `error`, `warn`, `info`, `debug`, `trace` or `silent`. Logs are JSON lines on stdout |
| `DIAGNOSTICS_PORT` | empty (off) | Optional JSON endpoint (`/healthz`, `/diagnostics`) on `127.0.0.1` only. If the port is taken, the bot logs a warning and carries on without it |
| `TELEMETRY_ENABLED` | `false` | Must stay `false`. Radio Bot has no telemetry, and `true` is refused at start-up |

## How it works

```text
 stream host ──HTTPS──▶ SafeHttpClient ──bytes──▶ FFmpeg (stdin) ──Ogg Opus──▶ @discordjs/voice ──DAVE──▶ Discord
   (Icecast/HLS)        SSRF policy, pinned DNS,   decode once,     48 kHz,       demux only,
                        redirects re-checked,       encode once     20 ms frames  no re-encode
                        ICY metadata stripped       with libopus
```

- **Choosing a source.** Each source is checked within a time limit: a few seconds of audio are held in memory, `ffprobe` reads the codec, sample rate and channels, a decode check confirms the audio is valid, and the sample is thrown away. A source can be used only if it is verified as the right station, healthy, and not resting after repeated failures. Direct streams always come first; HLS (audio delivered as a series of short files) is a last resort, because it starts more slowly and recovers less smoothly. Among sources of the same kind, the best evidence wins, and bitrates of different codecs are never compared, with one narrow exception: measured AAC-LC at twice the rate, and at least 96 kbps, beats HE-AAC. See [docs/station-verification.md](docs/station-verification.md).
- **Talking to stream hosts.** The bot identifies itself as FFmpeg's network library (`Lavf/<version>`), which is what decodes the audio. It doesn't imitate a browser and sends no `Referer`. A host that refuses (HTTP 401, 403 or 451) is reported as `ACCESS_DENIED`, and the bot moves on.
- **Recovery.** With no audio for 15 s, the bot retries the same source after about 1, 3 and 8 s, then switches to another verified source. Only failures that keep coming for more than a minute put a source on hold (10 minutes, doubling up to 2 hours), and even then it is tried every 2 minutes if nothing else can play. The bot moves back to a better source once it works again, at most once every 10 minutes. A lost voice connection is rebuilt, and playback more than 45 s behind live jumps forward. After a restart, playback resumes only if the server has turned that on.
- **Station packs.** Packs installed from a library are checked against the library's fingerprint, validated off the main thread and written to the database in small batches, so installing one never disturbs what is playing.
- **Permissions.** Every command, button, menu and form checks the user's permission when it is used. Buttons carry signed IDs that only work in their own server and usually expire. Plays, checks, custom stations, syncs, imports, pack changes and clicks are rate-limited. See [docs/permissions.md](docs/permissions.md).

The module map and data flow are in [docs/architecture.md](docs/architecture.md), and the audio path in detail in [docs/audio-quality.md](docs/audio-quality.md).

## What it can't do

- **Make a stream sound better than it is.** Many stations stream 128 kbps MP3 or AAC. Encoding at the source's bitrate keeps the one extra lossy step small, but nothing can restore what the station's own encoder removed. The bot never claims "HD" or "lossless".
- **Promise what each listener hears.** What a listener's Discord client receives hasn't been measured; see [Project status](#project-status).
- **Record.** Nothing is saved to disk. Audio exists only in a short playback buffer and, during a check, a few seconds in memory. The bot is self-deafened and never receives voice audio.
- **Play anything but live radio.** No music search, YouTube or Spotify. Titles appear only when the stream sends them (ICY metadata, so not for HLS), and they're labelled as stream metadata.
- **Play two stations in one server at once.** Each server gets one voice connection.
- **Get past restrictions.** No DRM, encrypted HLS, log-ins, geo-blocking or private APIs, by design.

## Project status

Version **1.2.2** is the current release; 1.0.0 was the first public release. Lint, the strict typecheck and the full unit and integration suite pass, and CI runs them on every push and pull request. The integration tests use a local fixture radio server with synthetic audio, never real stations or Discord. The following have **not** been verified yet, so you can judge for yourself:

- **Only one live Discord test so far.** On 1 November 2026, the bot was invited to a private test server with the minimum permissions and played a station from the pack that then shipped with the bot, heard in the Discord client: the direct MP3 source at 128 kbps, one Opus encode at 128 kbps, with DAVE end-to-end encryption negotiated and the Discord-side figures in `/radio stats` shown live. Not yet tested on a live call: the owner, DJ and member permission scenarios, station switching, and kick, move and channel-delete handling.
- **No 72-hour soak test** (a long unattended run) yet, so long-run memory growth and FFmpeg process clean-up over days are unmeasured.
- **Pack stations are only partly probed.** On 31 October 2026, live probes confirmed 3 of the 63 stations of the pack that used to ship with the bot (now in the library): direct MP3 and AAC-LC, and HLS AAC-LC, all at 128 kbps, 44.1 kHz stereo. The other 60 use the same host and address pattern but haven't been probed. One HLS address timed out, and one station's direct stream refuses access and is disabled. The evidence is in the pack's `evidence/` folder in the library.
- **The pack library has published its first release, but no bot has downloaded from it yet.** Its check and publish workflows passed on GitHub on 3 November 2026 and published `index.json` and the first bundle. Downloading, checking and installing packs are covered by tests against a local stand-in library only.
- **Installing, updating and removing packs from Discord** hasn't been tried on a live server yet, and nor has the automatic reinstall of the formerly included pack when an existing install updates.
- **"Identity verified" mostly rests on provenance** (the official player maps the stream to the station) plus a successful check. Audio comparison has confirmed two stations; the rest haven't been compared or checked by listening. `/radio rescan compare:true` and `/radio source verify` exist to strengthen this.
- **What listeners receive:** the bitrate a listener's Discord client actually receives hasn't been measured.
- **Resource use is measured for one stream only** (see [Requirements](#requirements)). Several streams at once, long runs and a Raspberry Pi haven't been measured yet.
- **The licence review of the FFmpeg build in the Docker image hasn't been done.** The image, published to GHCR by the release workflow, uses Debian's FFmpeg packages. The installer downloads it for release versions, and builds it on your machine if the download fails.
- **The installer and `radio-bot` command** are tested end to end in CI against a stand-in for Docker. `radio-bot update` has also taken a real Docker install from 1.0.1 to 1.0.3 (backup first, healthy straight away, settings kept); that run found the old-image clean-up bug fixed in 1.0.4. A fresh install hasn't yet been run against real Docker on a Linux server, a Raspberry Pi, macOS or Windows.
- **Rights:** no permission has been requested from or granted by any broadcaster. If you run an instance, that is your responsibility; see [docs/rights-and-disclaimer.md](docs/rights-and-disclaimer.md).

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

Use a separate Discord application and a private test server for development, never a production token. Read [CONTRIBUTING.md](CONTRIBUTING.md) before opening a pull request: changes to audio, streams, voice or station packs need a second reviewer, and there are firm rules about fixtures (no copyrighted audio), provenance and Discord permissions. AI coding agents should read [AGENTS.md](AGENTS.md). Station packs themselves are made in the [pack library](https://github.com/DangerMouseUK/radiobot-packs), which has its own playbook.

## Documentation

| Document | What it covers |
|---|---|
| [docs/install.md](docs/install.md) | **Start here:** the beginner's install guide and the `radio-bot` command |
| [docs/install-docker.md](docs/install-docker.md) | Docker Compose by hand: settings, volume, upgrades, backups and restores |
| [docs/install-linux.md](docs/install-linux.md) | Running directly on Linux with systemd |
| [docs/install-container-platforms.md](docs/install-container-platforms.md) | Hosted container platforms: requirements and limits |
| [docs/permissions.md](docs/permissions.md) | Discord permissions, the capability matrix and rate limits |
| [docs/troubleshooting.md](docs/troubleshooting.md) | Problems mapped to reason codes |
| [docs/architecture.md](docs/architecture.md) | Modules, data flow and the source-validation boundary |
| [docs/audio-quality.md](docs/audio-quality.md) | The audio path, choosing the Opus target, and honest limits |
| [docs/station-verification.md](docs/station-verification.md) | Source states, identity rules, ranking and pack coverage |
| [catalog/README.md](catalog/README.md) | The station pack format, where packs load from, pack libraries and the authoring tools |
| [docs/rights-and-disclaimer.md](docs/rights-and-disclaimer.md) | Unofficial status, rights, takedown and privacy |
| [docs/PRD.md](docs/PRD.md) | Product requirements, as built |
| [CHANGELOG.md](CHANGELOG.md) · [CONTRIBUTING.md](CONTRIBUTING.md) · [SECURITY.md](SECURITY.md) · [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) | Project policies |

## Licence

[MIT](LICENSE) for this project's original code. Third-party audio, station names, trademarks, artwork and the FFmpeg binaries in the Docker image are not covered by it, and belong to their owners.
