# Changelog

All notable changes to Radio Bot are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- A `CATALOG_SYNC_INTERVAL_HOURS` above 596 (the range goes up to 720) made catalogue sync run again and again without pause, because Node can't wait that long with a single timer. Long intervals are now waited out in full.
- The admin buttons on the sources view (**Prefer the playing source** and **Back to automatic choice**) failed with "Something went wrong" for stations with the longest allowed IDs, because the button's ID went over Discord's 100-character limit. Button and menu IDs now fit that limit by design, whatever the station: a new, shorter way of writing the expiry leaves room for the longest station ID with every action, and lasts until 2140 (the old one would have grown a character in December 2038). Buttons sent by an earlier version say they have expired; run the command again. The control panel is redrawn when the bot starts.
- A detailed sources view of a station with many sources and a server override could go over Discord's 6000-character message limit and fail to send.
- **Previous station** with nothing playing now starts from the last station, not the one before it, and **Next** or **Previous** says there is no other station instead of restarting the one that plays.
- `/radio join` with a default station used two play tokens instead of one, so the per-user limit ran out after three joins rather than six.
- A station started within a second or two of the bot leaving the channel played without stall detection, so a stream that stopped sending audio was never restarted.
- An HLS station whose playlist servers were briefly out of step could repeat a few seconds of audio.
- One failed download of an HLS stream's start-up section (fMP4 streams) stopped the stream; it is now retried once, like the audio segments.
- When FFmpeg failed to start, or the bot hit an internal error, the failure counted against the station's source, which could put a working source on hold and switch to a fallback for no reason. Such failures are now retried on the same source and never count against it.
- A voice connection that had just been handed over could still try to rejoin the channel on its own.
- Pressing **Favourite** twice, or on an older card, could undo it. **Favourite** now only adds and **Unfavourite** only removes, and each says so if nothing needed to change.
- A new `/radio import` now replaces the server's previous import preview, whose buttons then say it has expired, and imports are limited to five per server in ten minutes.
- The `channel` option of `/radio play` said it was for DJs and admins only. Listeners can use it too: with the default listener control, only for the channel they are in.
- `/radio join` after `/radio stop`, with the bot still in the channel, said "Already here" instead of starting the default station.
- The voice channel status could be set again just after the bot left a channel.
- A browse list now stays open for 15 minutes after its last use, not 15 minutes after it was opened.
- Station suggestions that Discord gave up waiting for were logged as errors and counted as internal faults.
- If `DIAGNOSTICS_PORT` was already in use, the bot stopped at start-up, and Docker restarted it into the same error again and again. It now logs a warning and runs without the diagnostics endpoint.
- `/radio import` deleted the server's favourite custom stations and its custom default station, because exports leave those out. An import now keeps them: custom-station favourites come after the file's favourites, and a custom default station stays when the file has none.
- When the bot is removed from a server, its settings and its custom stations are now deleted together, so a failure part-way can't delete one and keep the other.
- Some error messages in logs, and the error stored in catalogue sync reports, could include a full stream or list URL with a token in it. They are now redacted like other logged errors.
- An update that stopped halfway (for example, the image download failed) left the old version running, and running `radio-bot update` again only said "Already on the newest version". It now finishes the update, and `radio-bot status` says when one didn't finish.
- `radio-bot update` carried on when switching a branch install to the new version failed. It now stops and says so.
- `radio-bot restore` now refuses a file that isn't a database backup before it stops anything, and if copying the backup in fails or is interrupted, it starts the bot again on the data it had instead of leaving it stopped.
- The installer and `radio-bot` now also wait for FFmpeg to be reported working before saying the bot is online, as Docker's health check does.
- Going back to an older version after an update couldn't be done as the install guide described: the update's backup stayed inside the bot's data, and `radio-bot backup` refused to run while the bot couldn't start. `radio-bot update` now copies its backup to the `backups` folder, `radio-bot backup` copies the existing backups out even when the bot isn't running, and the guide explains which backup to put back.
- Docs: removed "v1.0.0" from status notes that apply to every release, and the install guide now says that `radio-bot logs` shows the last 200 lines.

### Changed

- Database migration 4 (applied automatically after a backup at the next start) adds indexes, so deleting a station or source no longer reads every server's favourites, queue and source preferences.
- Adding, editing or removing a custom station re-reads only that server's custom stations, not the whole catalogue.
- Manual backups (`backup.js`, and the backups `radio-bot` takes) run at the lowest process priority, so they yield to the stream's encoder.
- Docker's health check, the backups that `radio-bot` takes and its own health checks now run at the lowest CPU priority, so they can't hold up the stream on a one-core host.
- Docker builds reuse downloaded packages and earlier build steps, so they are faster. The image is the same.
- The release workflow now runs every CI check, including the installer test and the image smoke test, before it publishes an image.

## [1.0.5] - 2026-11-02

### Added

- **Favourites are easy to get back to.** The station list from **Browse stations** has a **Favourites** button that shows only this server's favourites (and **All stations** to go back), and now-playing messages have the Browse stations button too, not just the control panel. Pressing **Favourite** now says where favourites show up, and `/radio help` explains favourites and the default station.
- The default station can be cleared: choose **No default station** in `/radio config default_station`.
- **Choosing another source.** `/radio sources` (and the Sources button) lists a station's sources best first, marks what is playing now, and shows why each can or can't be used. While the station plays, anyone who can control the radio can switch to another usable source from a menu (unless an admin has pinned the station to one source); it lasts until the station changes, and if that source fails the bot goes back to the best one by itself. Admins get buttons to make the playing source this server's preference, or to go back to automatic choice.

### Changed

- **Scales to big catalogues without holding up the stream.** Measured with synthetic catalogues of up to 10,000 stations and 100 streams:
  - A source check or a playback result now updates one cached row instead of making the next read re-read the whole catalogue: that took 12–20 ms on one core with the 63 bundled stations, and half a second with 2,000.
  - Each server's custom stations are kept apart, so lists and suggestions don't scan every server's.
  - Exact station names resolve without fuzzy-scoring every station, and fuzzy search stops early on names that can't match.
  - Panels are refreshed one server at a time, sync no longer rewrites unchanged stations, and the identity check reuses normalised names.
  - The hourly probe-history clean-up uses a new index (database migration 3, applied automatically after a backup at the next start) and no longer re-counts every source's history.
- **Clearer cards.** The now-playing card (from `/radio play`, `/radio now` and the control panel) leads with the song, puts the channel, the station's stream and what goes to Discord side by side, and gives one line on why this source plays; the full reasoning moved to Sources. `/radio help`, `/radio status`, the queue and `/radio config` are laid out in short sections instead of one block of text, the sources view shows each source in three short lines (the evidence stays in Inspect), and refusals and errors have a headline.
- When two sources can't be told apart on measured quality (for example 128 kbps MP3 against 128 kbps AAC), the explanation now says the station pack's own order decided.
- With nothing typed, `/radio play` suggests the default station first, then the favourites, each labelled, then everything else.
- `/radio config` explains what the default station is for, and says when autostart is on but can't work because the default station or the preferred voice channel is missing.

## [1.0.4] - 2026-11-01

### Added

- **Updates warn before stopping playback.** If the bot is playing in any server, `radio-bot update` says so before it restarts the bot, and asks whether to go ahead: a server only starts playing again by itself when an admin has turned on **Resume after restart** in `/radio config`. When updating from 1.0.3, it shows the warning but doesn't ask, because the older copy of the command starts the update.
- **The old version's logs are kept.** Replacing the container deletes its logs, so `radio-bot update` first saves the last 500 lines to the `logs` folder of the install (the newest 5 files are kept). If they can't be saved, it says so and carries on with the update.
- **Late voice packets are counted.** `/radio stats` shows how many voice packets went out more than 40 ms after the one before since the bot joined, and the longest gap, and says when that gap is long enough to hear.
- At debug level (`LOG_LEVEL=debug`), every command, button and suggestion is logged with how long it took and the CPU time the bot used meanwhile, so a delay can be matched to what caused it.

### Changed

- **Much less work on the thread that sends voice packets.** Database statements are compiled once and reused; stations and sources are read once and reused until they change; and search keeps each station's normalised names. In a local test, suggestions, availability badges and pack coverage became 7–60 times faster: the availability of every bundled station takes 0.04 ms instead of 2.4 ms. The audio comparison behind `/radio rescan compare:true` now works in short slices instead of one long burst. `/radio stats`, `/radio browse` and suggestions all run on that thread.
- Background source checks no longer pile up: a source is queued once however many servers ask, it is skipped if it was checked in the meantime, and nothing starts while any stream is in its first 30 s. Each check's results are written in one go, and probe history is trimmed as it is written instead of by an hourly scan of the whole table.
- The identity check closes the station's connection as soon as it has its sample, and stops the other stream's capture if one side fails.
- At start-up, only servers with a control panel are refreshed, one at a time, and the bot no longer creates a settings record for every server it is in.
- The systemd unit gives the bot a slightly higher CPU priority than ordinary jobs (`Nice=-5`). Docker installs can't do this without running the container as root, so they keep normal priority.
- The docs say that a one-core host is enough, but that other scheduled jobs on the same machine can cause brief audio hiccups.

### Fixed

- A summary of repeated problem notices was lost if the clock jumped forward (for example after the host was suspended); it is now sent.
- Open station lists from `/radio browse` are limited to the newest 500 as well as expiring after 15 minutes; an older list's buttons say it has expired.
- **`radio-bot update` now removes old images.** Each update used to leave the previous Docker image behind, about 1 GB per release, which slowly filled small disks: the clean-up looked for a label the published images don't carry, and skipped tagged images anyway. Once the new version is healthy, the update now removes the other versions of the bot's image, including ones left by earlier updates. If the new version doesn't start, the old image is kept so you can go back. Published images are also labelled "Radio Bot" again.
- If a start failed before a source was chosen (for example, an unexpected database error), the bot could try again immediately and indefinitely, which could freeze audio for every server. It now waits and retries, like any other start with no source.
- Scheduled catalogue syncs no longer keep a timer for every past run, and none is started after shutdown begins.
- A database commit that failed (for example on a full disk) left the database connection broken until the bot restarted, so every later save failed. It is now rolled back cleanly and the next save works.
- Two error logs now go through the same redaction as the rest, so a stream address with a token in it can't reach the logs.

## [1.0.3] - 2026-11-01

### Changed

- **Stream stability comes first, on any host.** Every stream check, comparison and version check runs FFmpeg/FFprobe at the lowest CPU priority, so the live encoder is always served first. Background checks run one at a time, and only once a stream has played steadily for 30 s; they no longer start at the same moment as the stream.
- **Failing sources back off.** Instead of every 10 minutes, a failing source's next automatic check waits about 10 min, 1 h, 6 h, 12 h, then once a day; a success resets it, and `/radio rescan` still checks at once. `/radio sources` and `/radio inspect` say how many checks failed in a row and when the next one is.
- **Dead sources stop being checked.** A source with no successful check for 7 days (and at least 5 failed checks in a row) is paused: no automatic checks at all until an admin runs `/radio rescan`. A temporary outage never pauses a source. While someone wants a station and none of its sources works, its failing sources are retried every 10 minutes (hourly after a day) instead of waiting out the back-off.
- **Plays never wait for background checks.** A check someone is waiting for interrupts a background check on the same stream host; the interrupted check records nothing and runs again later.
- **Gone addresses are recognised.** HTTP 404 and 410 are reported as the new reason code `NOT_FOUND` ("Nothing is at that address any more"), start the back-off at 12 h, and make playback fail over at once instead of retrying the same source. Checks wait up to 15 s for a server's first response (playback keeps 10 s), so a slow 404 is no longer reported as a timeout.
- `/radio rescan` shows progress after each source, and the source explanation says "not conclusively determined" once instead of repeating it.
- The bundled starter pack's display name (in `/radio browse`, `/radio list` and `/radio stats`) drops the broadcaster's legal name, and the pack no longer adds its own disclaimer naming the broadcaster: station lists show only Radio Bot's generic "not affiliated with or endorsed by any broadcaster" notice. Station IDs, favourites and settings are unaffected.

## [1.0.2] - 2026-11-01

### Changed

- The sync adapter that reads a `webradios[]` list from a page's embedded JSON is now called `webradio-apidata`; a pack that names it by its old name must be updated (the bundled pack already is), or it fails validation at start-up.
- The documentation outside the station packs uses generic examples (`mypack:my-station`) and no longer names a pack's broadcaster or stations. Pack-specific detail stays in each pack's own folder. The README says in one sentence which starter pack is bundled and that it can be switched off, deleted or replaced.
- Release notes no longer name a broadcaster; they carry only the generic "not affiliated with or endorsed by any broadcaster" statement.

## [1.0.1] - 2026-11-01

### Fixed

- Official-list sync decodes each HTML entity in a station name exactly once, so `&amp;quot;` becomes `&quot;` rather than `"` (reported by CodeQL as double unescaping). A numeric entity outside the Unicode range is now left as it is instead of stopping the sync with an error, and hexadecimal entities such as `&#x26;` are decoded.

## [1.0.0] - 2026-11-01

First public release. The items not yet verified are listed under *Release status* below.

> **Unofficial, not endorsed by any broadcaster.** Radio Bot is an independent project. It is not affiliated with, endorsed by or sponsored by any broadcaster. The bundled starter station pack names stations only so that people can find them; the names, audio and artwork belong to their owners. The MIT licence covers this project's original code only. The rights and branding release gate (PRD §14) is **not** resolved by this release; see [docs/rights-and-disclaimer.md](docs/rights-and-disclaimer.md).

### Added

**Station packs**

- **Modular station packs.** Each pack is a folder with `pack.json`, `stations.json` and `sources.json`, loaded from `catalog/packs/` and `EXTRA_PACKS_DIR`. Nothing in the code is specific to a pack.
  - Station IDs are `<pack-id>:<slug>`.
  - Each pack has its own categories, brand labels, disclaimer and optional official-list sync.
  - Packs are switched on according to `enabledByDefault`, `ENABLED_PACKS` and `DISABLED_PACKS`.
  - The authoring guide is `catalog/README.md`.
- **The bundled starter pack.** It has all 63 stations on its broadcaster's official list as of 31 October 2026, and 126 candidate sources from the official web player's redirects. 122 sources are enabled. 4 are disabled because the site's own mapping was broken: two HLS 404s, one duplicate mislabelled as `.m3u8`, and one direct mount returning 401. Provenance is in the pack folder's `SOURCE_PROVENANCE.md`.
- **Pack validation at start-up.** Start-up checks the schema; unique pack IDs, slugs and (across packs) source IDs; names and aliases unique within a pack; declared categories; source-to-station references; and that no URL is mapped to two stations.
- **Per-pack catalogue sync through adapters** (`json-name-list`, and an adapter for a webradio list embedded in a station website's page, now called `webradio-apidata`). It reconciles names and stable IDs with each pack's official list, on one daily schedule per syncable pack, or on `/radio sync [pack]`. It never harvests stream URLs and ignores signed play URLs. Renames keep station IDs and favourites. Missing stations are kept and flagged. New stations need a reviewed source mapping. Each run produces a report.
- Truthful station availability labels: Available, Degraded, Unverified, Temporarily unavailable, No stream source known, Retired. Nothing else is ever played in a station's place.

**Source inspection and selection**

- The source-validation boundary (`SourceService`). Probes are bounded: 15 s, a 7 s sample, at most 2 MiB in memory. Each probe runs `ffprobe` and a decode check over the in-memory sample and records codec, profile, sample rate, channels, and advertised, codec and measured bitrate with the type of evidence. Concurrency is limited globally and per host.
- Station identity decisions from provenance, ICY stream name (with each pack's brand labels ignored, and an exact match to another station's name treated as a contradiction before any own-alias match), optional time-aligned audio correlation, and operator overrides. The correlation was calibrated on live radio on 31 October 2026. It takes 40 s samples over ±30 s of lag, trims the envelope edges and clips outliers, and needs at least 15 s of overlap. A match needs a score of 0.3 or more and a prominence of 5 or more. The same station across MP3, AAC and HLS scored 0.38–0.90, and different stations 0.08–0.14. The `icy-name` is re-checked live on every connection (`IDENTITY_MISMATCH`).
- Correctness-gated ranking. Transport tier comes first: direct, then unknown, then HLS. HLS is a last resort, used only when no direct stream is eligible, whatever it measures. Then come evidence-based fidelity (never across codecs by bitrate), stability, latency and priority. Each decision has an explanation and a fallback.
- Per-server `pin`, `prefer` and `auto` source overrides, and operator-only identity verdicts for the sources of any pack (`OPERATOR_USER_IDS` or the application owner).
- `scripts/validate-catalogue.ts`: validation of every pack (`--pack <dir>` for one folder), live probes (`--probe <stationId…>` or `--probe --pack-id <id>`), audio comparison, and a JSON evidence report. CI runs it from source.

**Audio and voice**

- Playback with a single encode: source bytes → FFmpeg (stdin only, `-protocol_whitelist pipe`) → `libopus` 48 kHz stereo, music mode, 20 ms, VBR → Ogg Opus → `@discordjs/voice` with `StreamType.OggOpus`. There is no second encode, and no normalisation, EQ or compression.
- In `maximum` mode the Opus target matches the source's own bitrate (codec metadata, then measured, then manifest or advertised) up to `MAX_OPUS_BITRATE_KBPS` (default 510 kbps), so a 128 kbps station is sent at 128 kbps, not padded to 510; an unknown source bitrate uses the limit. `balanced` uses 128 kbps, or the source's rate if that is lower, and `manual` uses an admin-set value capped at `MAX_OPUS_BITRATE_KBPS`. The voice channel's bitrate setting is reported but not used as a cap, and a note appears when encoding above it. The encoder is rebuilt when the target changes.
- DAVE end-to-end encryption is requested. The bot joins self-deafened.
- An HLS reader (live edge, rendition ranking that ignores `BANDWIDTH` values which are really sample rates such as 44100, segment retry, resync, encrypted HLS refused), PLS/M3U resolution, and ICY metadata demuxing, which supplies now-playing text from stream metadata only.
- Recovery:
  - a stall watchdog (15 s) and a first-audio timeout (20 s);
  - same-source retry with jittered backoff, then failover;
  - a circuit breaker with escalating cooldown;
  - a no-source retry every 2 min;
  - voice reconnects, live-lag resync, and kick detection. A failed voice reconnect (`VOICE_CONNECT_TIMEOUT` or `VOICE_DISCONNECTED`) is retried after about 2, 5, 10, 30 and 60 s before the bot gives up with a visible error;
  - overlapping play requests share one voice connection attempt. A `/radio stop` during joining is honoured, and `/radio join` to another channel while playing brings the station along;
  - probes are shared between callers, and one caller cancelling neither cancels the probe nor records a failure. The HLS reader resynchronises when media sequence numbers go backwards.
- A per-server desired state kept separate from runtime state, with an opt-in boot policy (resume or autostart). An explicit stop, leave or kick always wins.
- Idle modes: `leave_when_empty`, `pause_when_empty` and `24x7`.
- `ProcessRegistry`, which owns and reaps every FFmpeg and FFprobe process.

**Discord**

- One `/radio` guild command using all 25 top-level options Discord allows: browse, play, stop, join, leave, now, list, inspect, quality, sources, status, stats, skip, add, edit, remove, rescan, sync, config, export, import, panel, help, and the groups `queue add|list|remove|clear` and `source pin|prefer|auto|verify`. Favourites are listed with `/radio list scope:favourites`.
- A station queue. `/radio queue add` plays the station at once if nothing is playing; otherwise it queues it (max 25). `/radio skip` plays the next playable queued station. Playback controls get a **Skip (n queued)** button, which is always on the panel, and now-playing embeds show **Up next**. The queue is stored in `guild_queue` and purged with the server.
- `/radio stats` (Administrators): a private live statistics panel with Refresh and Close. It shows:
  - **stream**: hosts with region hints, connected IP and port, HLS segments, input rate over 10 s and 60 s, and TCP round trip to the stream endpoint;
  - **output**: Opus target, Ogg Opus rate and packets per second to Discord;
  - **Discord connection**: voice endpoint, RTC region, voice WebSocket ping with jitter, gateway ping, encryption/DAVE;
  - **bot health**, including the event-loop delay over the last minute, so late voice packets can be told apart from network problems.
- Server-side authorisation on every command, button and menu. Access levels are admin (server owner or Discord's Administrator permission only; Manage Server doesn't count and there is no admin-role setting), DJ (DJ roles) and member. Listener control modes are `none`, `same_channel` and `any`. There are command and voice channel allowlists, which admins bypass for commands, and an optional voice-channel lock.
- Signed, guild-bound, expiring component IDs, plus a persistent control panel that is re-rendered after restarts.
- Rate limits on play/switch, probes, custom-station adds, syncs and button clicks. Installation-wide limits on concurrent streams and probes, and a per-server limit on custom stations.
- Recovery and error notices to an optional channel, with repeats coalesced.
- Stream titles, which may be songs or shows, are shown as **On air** in now-playing views. Titles from older servers that send Latin-1 or Windows-1252 keep their accented characters. Empty and placeholder titles ("Unknown", "Advert" and similar) clear the line instead of leaving the last song showing, and separators left by an empty half ("Artist - ") are removed.
- The voice channel's status shows what that server is playing: "📻 Station · Artist - Title", following the same title changes, cleared when playback stops or the bot leaves. It needs the optional Set Voice Channel Status permission (now in the invite link) and can be switched off per server in `/radio config` → Notifications. A server's custom station can be named here, because only that server sees it. Migration `0002` adds the setting, on by default.
- The bot's own Discord status shows what it plays: "Listening to My Station · Artist - Title". `PRESENCE_MODE` chooses `track` (default), `station` or `off`. With several servers playing different stations it shows "radio in N servers", and a server's custom station is never named. It needs no extra intent or permission.
- Least privilege: the `Guilds` and `GuildVoiceStates` intents only, and the permissions View Channels, Send Messages, Embed Links, Attach Files, Connect and Speak, plus the optional Set Voice Channel Status (`281474979908608`; `3197952` without it).

**Custom stations and configuration**

- Per-server custom stations. They are kept in a separate section, validated against the SSRF policy on every hop with DNS pinning, and probed before they are accepted.
- JSON export and import of server settings. Exports contain no secrets, and imports are validated and previewed before they are applied.
- Operator kill switches: `DISABLED_PACKS`, `DISABLED_STATION_IDS` and `DISABLED_SOURCE_IDS`.
- When the bot is removed from a server, that server's settings, favourites, queue, source preferences, playback state and custom stations are deleted automatically. Discord outages don't trigger this.
- Reason codes for user-facing limits: `STREAM_LIMIT` (installation stream cap), `RATE_LIMITED` (slow down) and `CUSTOM_STATION_LIMIT` (per-server cap). `ACCESS_DENIED` is returned for HTTP 401, 403 and 451 from a stream host.

**Operations**

- SQLite (`node:sqlite`) with versioned, checksummed migrations. A consistent backup is taken before migrating an existing database, and `scripts/backup.ts` takes manual backups. Each kind rotates separately: the newest 5 pre-migration backups and the newest 10 manual ones are kept.
- A heartbeat-file healthcheck (`scripts/healthcheck.ts`), `scripts/register-commands.ts`, and an optional diagnostics endpoint on `127.0.0.1`.
- Stream requests identify as FFmpeg's network library: `Lavf/<version>` of the installed FFmpeg, overridable with `STREAM_USER_AGENT`, and shown in `/radio stats`. Stream hosts that refuse unknown clients but serve standard media players, such as the starter pack's host, now answer. No browser is imitated and no `Referer` is sent.
- Structured, redacted JSON logs. There is no telemetry, and `TELEMETRY_ENABLED=true` is refused.
- **A one-line installer and the `radio-bot` command.** `install.sh` downloads the newest release into `~/radio-bot` and hands over to `scripts/radio-bot.sh`. That script checks for Docker (and on Linux offers Docker's official installer), asks for the Application ID and token, pulls the release image or builds it, starts the bot, waits until it is connected, and prints the invite link. Afterwards `radio-bot` offers `status`, `logs`, `start`/`stop`/`restart`, `config`, `invite`, `backup`, `restore`, `update` (backs up first, newest `vX.Y.Z` release, refuses to overwrite edited files) and `uninstall` (offers a data copy, asks before deleting the volume). It runs on Linux, macOS and Windows through WSL, and is tested end to end in CI against a fake Docker (`tests/lifecycle/`).
- A beginner's install guide, `docs/install.md`.
- A Dockerfile and a Compose file, which run as non-root with a read-only root filesystem. The Compose project is always named `radio-bot`, so the volume is `radio-bot_radio-bot-data` wherever it is cloned; local changes go in a git-ignored `compose.override.yaml`.
- A hardened systemd unit (`deploy/systemd/radio-bot.service`) for running directly on Linux without containers. A configuration error (exit code 78) is not restarted in a loop.
- The release workflow runs the full test job first, and refuses a tag that doesn't match `package.json` and the default image tag in `compose.yaml`.
- Documentation: README; architecture; audio quality; station verification; permissions; installation with Docker, directly on Linux, or on a container platform; troubleshooting; rights, disclaimer and privacy; contribution and security policies.

### Fixed in pre-release QA (1 November 2026)

A full code review before tagging found and fixed these; each has a regression test.

- **Voice:** an `error` event on a voice connection could crash the process (it is now handled per connection). `/radio join` into the bot's own channel stopped the audio while still showing "Playing", and now says it is already there. A pending `pause_when_empty` timer could undo an explicit stop, and leaving an empty channel turned "stopped" into "idle", which let autostart fire on the next boot. Idle modes now also apply when the bot starts playing in, or joins, an empty channel. Disconnects during an outage no longer start overlapping reconnect loops. The voice player no longer gives up after 5 s without audio, so the documented 15 s stall watchdog decides. Resume, retry and reconnect respect `MAX_ACTIVE_GUILD_STREAMS`. A failure before first audio is reported as "retrying", not "superseded".
- **Boot:** resume and autostart skip retired stations and stations of packs switched off with `DISABLED_PACKS`.
- **Streams:** a probe no longer accepts a direct stream that ends within the sample (such as a short "offline" file). A playlist with any encrypted segment stays refused as encrypted. HLS playlist and segment 401/403/451 report `ACCESS_DENIED`. A probe that runs out of time reports `PROBE_TIMEOUT`, not `CANCELLED`. A duplicated or invalid `icy-metaint` header can no longer let metadata bytes reach FFmpeg. A huge `#EXT-X-TARGETDURATION` is clamped. Source selection no longer depends on database row order, and the explanation no longer calls a conclusive comparison "not conclusively determined".
- **Discord:** picking from the "Which station did you mean?" list always started playback, whatever command produced it; only `/radio play` now offers the picker (keeping its `channel`), and other commands ask for the exact name. An ambiguous name in `/radio queue add` no longer reports an internal error. Stream track titles are shown as plain text (no links or headings). `/radio rescan` stays within Discord's per-message size limit. `/radio join` and `/radio edit url:` are rate-limited, and importing the same file twice no longer duplicates custom stations, whose probes now count against the add limit.
- **Playback (found in the first live Discord test):** every start cancelled itself, so nothing ever played and `/radio play` answered "Superseded". Tearing down the previous run aborted the new run's requests as well. The session tests now use a stream opener that honours cancellation, as the real HTTP client does. `/radio stats` no longer shows a voice UDP ping: `@discordjs/voice` 0.19 stopped measuring it, so the line could only ever say "not measured yet".
- **Probe:** the decode check stops at the start of the sample's last packet. The sample is cut wherever the sampling window closes, usually mid-frame, and MP3 reported that cut as a decode error ("invalid new backstep") on some probes by chance.
- **Final QA:** changing the idle mode while an empty-channel timer was pending no longer lets the old timer leave or pause. Applying an import now updates the playing stream's quality and idle behaviour at once. The stats panel's Close button is authorised like every other button. `manual` quality with no bitrate set follows the station like `maximum` (it used the 510 kbps limit). Truncated text never splits an emoji. `radio-bot restart` now recreates the container, so edits to `.env` take effect; `radio-bot uninstall` moves earlier backups out of the folder before deleting it, and says when it can't copy the data; `radio-bot restore` accepts a file named from the current folder; the manager refuses Docker Compose older than 2.24, which `compose.yaml` needs; and the installer explains when it asks for the `sudo` password.
- **Secret scanning:** `.gitleaks.toml` allowlists the documented fake IDs and the `replace-with-your-…` placeholders, which gitleaks reported as Discord credentials on the first push. Every default rule stays on.
- **Data:** a source moved to another station by a pack update is moved on upgrade, with its old evidence and pins cleared. A failed custom-station URL edit restores the previous source exactly. Import ignores other servers' custom stations and repeated favourites. Removing the bot from a server also clears its command-registration record, so a re-invite registers `/radio` again. Catalogue sync applies all-or-nothing, and keeps its last 50 reports per pack. A manual backup run as root keeps the service user's ownership. The health check reports unhealthy when FFmpeg or `libopus` is missing, and ignores a heartbeat left by a previous run.

### Release status: not yet verified

The following PRD acceptance items (§17, §20) are **open** for this release:

- **Only 3 of the starter pack's 63 stations are confirmed by live probe.** On 31 October 2026 (the probe report is in the pack folder's `evidence/`), the three probed stations all played: direct MP3 at 128 kbps, HLS AAC-LC at 128 kbps, and the flagship's direct AAC-LC at 128 kbps, all 44.1 kHz stereo. One flagship HLS address timed out. The other 60 stations use the same host and pattern but have not been probed.
- Identity "verified" for pack sources rests on official-player provenance. Audio correlation additionally supports two of the three probed stations (scores of 0.58 to 0.90). The third was inconclusive in the latest run, having matched in earlier runs. No listening review has been recorded.
- One live Discord test has been run. On 1 November 2026, the bot was invited to a private test server with the minimum permissions and played the starter pack's flagship station in a voice channel, where it was heard in the Discord client. It used the direct MP3 source at 128 kbps and one Opus encode at 128 kbps, and DAVE end-to-end encryption was negotiated. The Discord-side figures in `/radio stats` (voice server, WebSocket ping, packets per second, encryption) were shown live. It found the self-cancelling start that is fixed above. Not yet tested live: station switching with identity checks, permission scenarios, and kick, move and delete handling.
- No 72-hour soak test has been run.
- The release workflow publishes the Docker image to GHCR, but the Docker, Linux (systemd) and container-platform deployments have not been smoke-tested on real hosts.
- Resource use is measured for one stream only: about 8% of one CPU core and about 200 MB of memory at 128 kbps (the README now has a Requirements section). Several streams at once, long runs and ARM boards are unmeasured. DAVE negotiation has been seen on one live call only.
- Encoding above the voice channel's bitrate setting (up to 510 kbps): the bitrate received by a listener's client has not been measured.
- The rights and branding review (PRD §14) and the licence review of the redistributed image's binaries (FFmpeg) have not been done.

[Unreleased]: https://github.com/DangerMouseUK/radiobot/compare/v1.0.5...HEAD
[1.0.5]: https://github.com/DangerMouseUK/radiobot/compare/v1.0.4...v1.0.5
[1.0.4]: https://github.com/DangerMouseUK/radiobot/compare/v1.0.3...v1.0.4
[1.0.3]: https://github.com/DangerMouseUK/radiobot/compare/v1.0.2...v1.0.3
[1.0.2]: https://github.com/DangerMouseUK/radiobot/compare/v1.0.1...v1.0.2
[1.0.1]: https://github.com/DangerMouseUK/radiobot/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/DangerMouseUK/radiobot/releases/tag/v1.0.0
