# Changelog

All notable changes to Radio Bot are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- After a failover, the bot stayed on the fallback source (often HLS or a lower bitrate) until someone played the station again, even once the better source was back. A steady stream now moves back to its station's better source once a background check shows that source works again, if it is a real step up: a direct stream instead of HLS, clearly better measured quality, or the source an admin chose. Each move is a brief cut, so it happens at most once every 10 minutes, and never when a listener chose the source that is playing. If the better source fails again before it has played steadily, the bot goes straight back to the source that was working, and waits twice as long each time before trying it again.
- A short blip on a station's only source, such as its encoder reconnecting, could leave the station silent for 10 minutes or more. Four quick failures within about 12 seconds put the source on hold, and a station on hold was never checked again until the hold ended. Now:
  - only failures that keep coming for more than a minute put a source on hold;
  - several servers hearing the same blip at the same moment count as one failure;
  - when nothing else can play, a source on hold is checked every 2 minutes, and a good check ends the hold;
  - with no source to play, the bot looks again after 15, 30 and 60 seconds instead of waiting 2 minutes.
- "Not found" (HTTP 404) from a station during playback switched source at once. Icecast servers answer 404 for a few seconds while the station's own encoder reconnects, so a 404 is now retried on the same source first.
- A background check of the playing source could mark it as failing (some stations refuse a second connection), and the next small hiccup then switched source or stopped the station. The playing source is no longer checked in the background, and 30 seconds of steady playback clears a failed check.
- A source that failed during playback was never checked again while another source played, so the bot couldn't tell when it was back. It is now checked again 5 minutes after the failure.
- After a Discord voice outage of more than about 6 minutes, the bot stopped trying to reconnect until someone played a station again. It now keeps trying every 2 minutes while playback is wanted, and says so once.
- Asking for the station that is already playing in that channel (`/radio play`, a Play button, a favourite) restarted it, cutting the audio and dropping a listener's chosen source. It now keeps playing.
- If saving the playback state failed (a full disk, for example), the stream stopped. It now keeps playing and logs the error.
- The "behind live" check counted the gap left when the HLS reader skipped forward to the live edge, so a healthy stream could be restarted for nothing.
- For HLS, the encoder could follow a lower rendition's bitrate than the one actually playing, if the last check couldn't load the best rendition. It now follows the rendition it opened when that is clearly higher.
- A check whose sample was too short to measure replaced the earlier measurement with the codec metadata figure, which for AAC is only an estimate. It now keeps the earlier measurement of the same stream.

- With `CATALOG_SYNC_INTERVAL_HOURS` above 596 (the allowed range goes up to 720), catalogue sync ran again and again without a pause, because Node can't wait that long with a single timer. Long intervals are now waited out in full.
- For stations with the longest allowed IDs, the admin buttons on the sources view (**Prefer the playing source** and **Back to automatic choice**) failed with "Something went wrong", because the button's ID went over Discord's 100-character limit. Button and menu IDs now fit that limit by design, whatever the station. A new, shorter way of writing the expiry leaves room for the longest station ID with every action, and it lasts until 2140 (the old one would have grown by a character in December 2038). Buttons sent by an earlier version say they have expired: run the command again. The control panel is redrawn when the bot starts.
- The detailed sources view of a station with many sources and a server override could go over Discord's 6000-character message limit and fail to send.
- **Previous station** with nothing playing now starts at the last station in the list, not the one before it. **Next** and **Previous** now say there is no other station to move to, instead of restarting the station that is playing.
- `/radio join` with a default station used two play tokens instead of one, so the per-user limit ran out after three joins rather than six.
- A station started within a second or two of the bot leaving the channel played without stall detection, so if the stream stopped sending audio, it was never restarted.
- An HLS station could repeat a few seconds of audio when its playlist servers were briefly out of step.
- For HLS streams in fMP4 format, one failed download of the stream's start-up section stopped the stream. That section is now retried once, like the audio segments.
- When FFmpeg failed to start, or the bot hit an internal error, the failure counted against the station's source. That could put a working source on hold and switch to a fallback for no reason. Such failures are now retried on the same source and never count against it. If FFmpeg can't start, the bot doesn't switch sources, because every source would fail the same way; after an unexpected internal error it still moves to a fallback once the retries run out.
- A voice connection that had just been handed over could still try to rejoin the channel on its own.
- Pressing **Favourite** twice, or on an older message, could undo it. **Favourite** now only adds and **Unfavourite** only removes, and each one says so when nothing needed to change.
- A new `/radio import` now replaces the server's earlier import preview, whose buttons then say it has expired. Imports are limited to five per server in ten minutes.
- The `channel` option of `/radio play` said it was for DJs and admins only. Listeners can use it too; with the default listener control, only for the channel they are in.
- `/radio join` after `/radio stop`, with the bot still in the channel, said "Already here" instead of starting the default station.
- The voice channel status could be set again just after the bot left a channel.
- A browse list now stays open for 15 minutes after it was last used, not 15 minutes after it was opened.
- Station suggestions that arrived after Discord had stopped waiting for them were logged as errors and counted as internal faults.
- If `DIAGNOSTICS_PORT` was already in use, the bot stopped at start-up, and Docker restarted it into the same error again and again. It now logs a warning and runs without the diagnostics endpoint.
- `/radio import` deleted the server's favourite custom stations and its custom default station, because exports leave those out. An import now keeps them: the custom-station favourites come after the file's favourites, and a custom default station stays when the file sets no default.
- When the bot is removed from a server, its settings and its custom stations are now deleted together, so a failure part-way can't delete one and keep the other.
- Some error messages in the logs, and the error stored in catalogue sync reports, could include a full stream or list URL with a token in it. They are now redacted like other logged errors.
- If an update stopped halfway (for example because the image download failed), the old version kept running, and running `radio-bot update` again only said "Already on the newest version". It now finishes the update, and `radio-bot status` says when an update didn't finish.
- `radio-bot update` carried on when switching a branch install to the new version failed. It now stops and says so.
- `radio-bot restore` now refuses a file that isn't a database backup before it stops anything. If copying the backup in fails or is interrupted, it starts the bot again on its existing data instead of leaving it stopped.
- The installer and `radio-bot` now also wait until FFmpeg is reported working before saying the bot is online, as Docker's health check does.
- Going back to an older version after an update didn't work as the install guide described: the update's backup stayed inside the bot's data, and `radio-bot backup` refused to run while the bot couldn't start. `radio-bot update` now copies its backup to the `backups` folder, `radio-bot backup` copies the existing backups out even when the bot isn't running, and the guide explains which backup to put back.
- Docs: status notes that apply to every release no longer say "v1.0.0", and the install guide now says that `radio-bot logs` shows the last 200 lines.

### Changed

- Docker installs now put the stream first on a busy host. `compose.yaml` gives the bot a large CPU share (`cpu_shares`), and tells the kernel to stop other programs before the bot if memory runs out (`oom_score_adj`). These are shares, never limits, so they can't hold the stream back. Rootless Docker quietly uses its own score instead, and the container still starts.
- The systemd unit adds `CPUWeight=1000`, `IOWeight=1000` and `OOMScoreAdjust=-500` beside `Nice=-5`, so the bot also comes ahead of other services, not only other processes in its own service.
- On Linux, stream checks mark themselves as the first processes to stop if memory runs out, so a check can never take the bot or its encoder down with it.
- `radio-bot` runs backups and health checks at the lowest disk priority as well as the lowest CPU priority.
- `radio-bot update` warns that the new version is downloaded (or built) while the station plays, which can cause small cuts on a small server.
- Smoother playback: the database's write-ahead log is now copied back into the database file on a separate thread every few minutes, not inside whichever write happened to fill it. On slow storage that copy, and its sync to disk, could hold up voice packets for 20–100 ms. If the separate thread can't run, SQLite's own copying takes over.
- Smoother playback: the health heartbeat (`health.json`) is written without blocking. Its contents and location are unchanged.
- Catalogue sync now waits its turn with background source checks, and never runs while a stream is starting. The official list is read on a separate thread, and changes are written in short steps. `/radio sync` still starts at once. A list with more than 5,000 names is refused as not a real station list. A sync with more than 50 changes is written in parts of 50, so if it fails part-way the parts already written stay (the next sync completes it); a normal sync is still all or nothing.
- AAC-LC now ranks above HE-AAC when both bitrates are measured and the AAC-LC stream is at least 96 kbps and at least twice the HE-AAC rate. Before, the two counted as different codecs that can't be compared, so a 48 kbps HE-AAC stream could play instead of a 320 kbps AAC-LC one. This is the only case where bitrates of different kinds of codec are compared.
- Two measured bitrates of the same codec now count as equal only within 3 % (it was 15 %), so a 128 kbps stream beats a 112 kbps one of the same codec. Codec metadata and advertised figures keep the 15 % margin, because they are looser.
- Alternate HLS audio renditions are now chosen by the bandwidth of the variants that use them, not just by which one is marked as the default.
- When a quality change briefly restarts the playing station, the reply to the admin now says so.
- In `maximum` mode the Opus target now follows the bitrate the bot measured for a source before the one its codec metadata reports, and is rounded up rather than to the nearest whole number. For AAC, the metadata is only an estimate: streams that measure 128.1 kbps reported anything from 114 to 176 kbps, so they were encoded below or above what the station sends. They are now encoded at 129 kbps, just above the source, never below it. MP3 streams are unchanged.
- Database migration 4 adds indexes, so deleting a station or source no longer reads every server's favourites, queue and source preferences. It is applied automatically at the next start, after a backup.
- Adding, editing or removing a custom station re-reads only that server's custom stations, not the whole catalogue.
- Manual backups (`backup.js`), the backups that `radio-bot` takes, Docker's health check and `radio-bot`'s own health checks now run at the lowest CPU priority, so they can't hold up the stream on a one-core host.
- Docker builds reuse downloaded packages and earlier build steps, so they are faster. The image is the same.
- The release workflow now runs every CI check, including the installer test and the image smoke test, before it publishes an image.
- The tests can now report coverage: `pnpm test:coverage` shows how much of the bot's code they run, file by file.
- CI now checks more of what ships, and releases repeat these checks before publishing:
  - `pnpm smoke` runs the compiled build with no network and no Discord: database migrations, both worker threads (database checkpoints and station-list parsing), an encode to Ogg Opus with the live encoder's settings, and the Docker health check. CI runs it after the build and inside the Docker image, with the image's own Node and FFmpeg.
  - The integration tests also run on the Docker image's own Node and FFmpeg, from a `test` stage of the Dockerfile that is never published. The published image's contents are unchanged.
  - The typecheck and tests also run on Node 24.17.0, the oldest version `package.json` allows.
  - A new test plays a stream through the real pipeline while `/radio stats`, browsing, source ranking and a sync of a 2,000-station list run, and fails if the event loop stalls for 50 ms or more.
  - The installer and `radio-bot` test also runs on macOS, with its bash 3.2.
  - Relative links in the README and docs are checked.
- The Docker image is scanned for known high and critical vulnerabilities that have a fix (Trivy) on every change, weekly and before every release. Dependabot proposes updates to npm packages, GitHub Actions and the Node base image weekly.

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
