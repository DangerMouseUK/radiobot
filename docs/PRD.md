# Radio Bot — Product Requirements Document

**Document version:** 1.0, written as built for release 1.0.0 and kept in line with the code since
**First written:** 31 October 2026
**Status:** Implemented. Open release gates are listed in §18 and §20.
**Product type:** Self-hosted Discord voice bot for live internet radio
**Licence:** MIT for the project's own code (see §14)

> **Central promise:** Make it easy to listen to live internet radio in a Discord voice channel, organised in reviewable **station packs** and starting with a bundled starter pack of 63 webradios, using the **best *verified* live source** that can legitimately be reached, with uninterrupted playback and truthful information about source and Discord audio quality.

> **Unofficial.** Radio Bot is an independent open-source project. It is not affiliated with, endorsed by or sponsored by any broadcaster. Station packs name stations only so that people can find them; the names, audio and artwork belong to their owners.

Section numbers and requirement IDs (FR-xxx, NFR-xx) are stable: the source code and the other documents refer to them.

---

## 1. Executive summary

Radio Bot is an open-source Discord application that plays live internet radio in voice channels. Its stations come from **station packs**. A pack is a folder of three reviewable JSON files, and nothing in the code is specific to any pack. The bot ships with one starter pack: the 63 webradios on one broadcaster's official list. Operators can add their own packs, and each server can add its own public streams.

What distinguishes it from a generic music bot is that it treats **station identity**, **delivery transport**, **codec**, **measured source quality** and **Discord output quality** as separate facts. It inspects every candidate stream itself, records the evidence, prefers the best *verified* source, and says plainly when something is unknown. It never claims a stream is "HD" because of a label, never treats HLS as a codec, and never plays a different station because its feed looked better.

Anyone can run their own instance with their own Discord application token. It runs as a single long-lived process with a small SQLite database, either in Docker, directly on a Linux host, or on a container platform that supports background workers with persistent storage (§12.4).

### 1.1 What success looks like

- A server can use the bot immediately after setup, without building a station list by hand.
- A pack's flagship station is never confused with a similarly named station of the same broadcaster, or with any other station.
- Each pack lists every station on its official list. Stations that cannot be played are shown honestly, never silently mapped to another feed.
- Every station shown as playable has at least one working, identity-verified source with codec and bitrate evidence.
- One command starts a station; a Discord-native browser makes switching easy.
- Audio reaches Discord as 48 kHz stereo Opus from a single encode at the source's own bitrate (up to 510 kbps), without "lossless" or "HD" claims.
- Playback recovers from stream, FFmpeg and Discord interruptions.
- Installation needs no external database, subscription, inbound port or domain.
- Servers can add their own legal, public streams without affecting any station pack, and operators can add packs without code changes.

### 1.2 Priorities

**P0 (in 1.0.0):** station packs (with the starter pack bundled), correct station identity, real audio inspection, live playback, single high-quality Opus encode, recovery, permissions, persistent settings, Docker and Linux installation.
**P1 (in 1.0.0):** interactive browser, now-playing metadata where available, source comparison, health scores and fallback, custom stations, import/export, documentation.
**P2 (future):** web management panel, shared community station directory, metrics dashboard, a centrally hosted public instance, languages beyond English.

---

## 2. Product principles

1. **Curated station packs come first.** The default experience is the enabled packs, which out of the box means the bundled starter pack, flagship first. Custom stations come second. There is no music search, playlist or song queue; the only queue lines up whole stations (FR-010).
2. **Correct station before higher bitrate.** A supposedly better feed is rejected if it carries another programme.
3. **Evidence over labels.** A source is described only by what was measured. Unknown values are shown as unknown.
4. **Quality is bounded by the source and by Discord.** Lost detail cannot be restored. HLS is a delivery protocol, not a codec.
5. **No audio processing by default.** No normalisation, EQ, compression or limiting; only the resampling to 48 kHz that Discord requires.
6. **Live radio, not file playback.** No recording, no caching of programme audio beyond short in-memory buffers.
7. **Simple to operate.** No Redis, PostgreSQL, Kubernetes, reverse proxy or public domain.
8. **Least privilege.** No Administrator permission, no message content, no privileged intents, no voice reception.
9. **Per-server isolation.** Each Discord server has its own settings, permissions and playback.
10. **Open source.** Public code and documentation, reproducible builds, local-only diagnostics, privacy by default.
11. **No bypassing.** The bot never gets around DRM, encryption, authentication, signed URLs, geo-blocking or any other access restriction. Towards stream hosts it identifies truthfully as FFmpeg's network library (`Lavf/<version>` of the installed FFmpeg, the software that decodes the audio). It does not imitate a web browser and sends no `Referer`.

### 2.1 Non-goals

- Spotify, YouTube or other on-demand music; search; downloads; recording.
- Voice commands (commands are typed, including in a voice channel's text chat).
- Replacing any broadcaster's website or app.
- Access to private, authenticated, signed or region-restricted endpoints.
- Letting members point the bot at local or internal network resources.
- More than one voice connection per server.
- A hosted multi-server service (a possible later phase, §18).
- Any suggestion of a partnership with a broadcaster.

---

## 3. Station packs

Pack stations come from **station packs**. Each pack is a folder in `catalog/packs/` (bundled) or `EXTRA_PACKS_DIR` (the operator's own), with three files:

- `pack.json`: the ID, name, description, disclaimer, order, `enabledByDefault`, categories, brand labels and optional official-list `sync`;
- `stations.json`: the stations;
- `sources.json`: the candidate stream URLs, each with provenance.

Station IDs are `<pack-id>:<slug>`. A pack is enabled unless its `enabledByDefault` is `false`. Operators opt in with `ENABLED_PACKS` and switch packs off with `DISABLED_PACKS`. Every pack is validated at start-up, and an invalid pack stops start-up with a precise message. The authoring guide is `catalog/README.md`, and the formats are in Appendix B.

The rest of this section describes the bundled **starter pack**.

### 3.1 Station list and identity

The starter pack is seeded from its broadcaster's official webradio list as published on 31 October 2026: **63 stations** (Appendix A). The list is a snapshot of names and the site's stable station IDs, not proof that each station has a reachable stream.

- Every station has a stable ID (`<pack-id>:<slug>`, for example `mypack:my-station`), its official display name, aliases, category, tags and pack order.
- The flagship station's ID always means the flagship programme, even if its display name changes.
- The broadcaster's own brand and network names are publisher or brand labels, declared in the pack's `brandLabels`. Seeing one in stream metadata says nothing about which programme a feed carries, so such labels never confirm or contradict a station's identity. Every pack declares its own brand labels.

### 3.2 Candidate sources

The starter pack lists **126 candidate sources** (in its `sources.json`):

- **Official-player sources (125).** On 31 October 2026, each station entry of the official web player redirected to an unsigned stream mount on the broadcaster's stream host. That mapping, taken from the broadcaster's own player, is the source's provenance. Most stations have a direct MP3 (two have direct AAC) and an HLS rendition.
- **One curated source.** The flagship's direct AAC mount comes from an earlier technical investigation. It is the same mount as the official FM entry's HLS stream.
- **4 sources ship disabled** because they were broken or refused on the official site at discovery time (two HLS playlists returning 404, one HLS address serving plain MP3, one mount answering HTTP 401).

Codec and bitrate hints in the catalogue are not evidence. Every source is probed at runtime (§7). Short-lived signed play URLs from the official site were never stored or used.

**Live evidence (31 October 2026, in the pack folder's `evidence/`).** Three stations, the flagship and two others, were probed:

- direct MP3 at 128 kbps on all three;
- HLS AAC-LC at 128 kbps on all three;
- direct AAC-LC at 128 kbps on the flagship's curated mount;
- all 44.1 kHz stereo.

One flagship HLS address redirects and then never answers. No higher-bitrate feed exists among these sources. The other 60 stations use the same host and pattern, and have not been probed yet.

The host refuses unknown clients (HTTP 401) but serves standard media players. That is why the bot identifies as FFmpeg (§10.2).

Provenance details for each station are recorded in the pack folder's `SOURCE_PROVENANCE.md`, and probe evidence in its `evidence/` folder.

### 3.3 Coverage policy

- A station is **catalogued** when its name is present, **usable** when a source has decoded successfully, and **verified playable** when a source is also identity-verified and healthy. The three counts are reported separately for each pack (`/radio stats`).
- A station with no reachable verified source is shown as unverified or unavailable. It is never mapped to another station's feed.
- Removed, renamed and new stations are reconciled from each pack's official list without losing server favourites (FR-002).

---

## 4. Users and use cases

- **U1 — Listener.** Types `/radio play My Station` and hears it; switches to another station without knowing any URL.
- **U2 — Audio enthusiast.** Wants to see each candidate's codec, bitrate and evidence, the reason for the chosen source, an option to pin a source, and what Discord actually receives.
- **U3 — Server administrator.** Restricts the bot to approved text and voice channels, assigns DJ roles, sets idle behaviour, default station and restart behaviour.
- **U4 — Self-hoster.** Clones the repository or pulls the image, adds their own bot token, starts one service, keeps settings across upgrades and reads useful logs.
- **U5 — Listener of other stations.** Adds a public Icecast, SHOUTcast or HLS stream for their own server.

---

## 5. Functional requirements

### FR-001 — Station packs (P0)

- Stations are loaded from **station packs**: versioned, reviewable folders (`pack.json`, `stations.json`, `sources.json`) in `catalog/packs/` and `EXTRA_PACKS_DIR` (§3). No pack is special-cased in code.
- Station IDs are `<pack-id>:<slug>` and never change. The station's provider is its pack ID, or `custom` for custom stations.
- Each pack is validated at start-up:
  - schema, and pack IDs unique (`custom` is reserved);
  - slugs unique within the pack, and no name or alias shared by two of its stations;
  - declared categories, and source-to-station references;
  - no URL mapped to two stations;
  - source IDs unique across all packs.
- Packs are enabled by `enabledByDefault`, `ENABLED_PACKS` and `DISABLED_PACKS`. Stations of a disabled or missing pack are hidden.
- The bundled starter pack has all 63 names on its broadcaster's official list (Appendix A), with aliases and six categories.
- Partial and fuzzy search by name, alias, tag or category (for example `techno`, `deep`, `lounge`, or part of a station's name).
- `/radio browse` and `/radio list` group stations under pack headings in pack order, with custom stations last. They filter by pack and by category (categories come from the enabled packs), and are paged to fit Discord's component limits.
- Visible statuses: Available, Degraded, Unverified, Temporarily unavailable, No stream source known, Retired.
- Ambiguous input is never resolved silently: only an exact ID, name or alias match, or a single clearly dominant match, plays directly; otherwise the user picks from a list.

**Acceptance:** every pack station is listed with its status; similarly named stations are never substituted; adding a group of stations means adding a pack folder, not code.

### FR-002 — Catalogue synchronisation (P0/P1)

- A pack may declare an official list in `pack.json` (`sync: { adapter, url }`). The generic `CatalogueSync` fetches that list through the safe HTTP client, and a named **adapter** (`src/catalogue/sync-adapters.ts`) extracts station names and stable IDs:
  - `webradio-apidata`, used by the starter pack, reads a webradio list embedded in a station website's page (a `webradios[]` array in its `var apidata` JSON) and ignores, and never stores, any short-lived signed play URLs on that page;
  - `json-name-list` reads a plain JSON list of `{ id, name }`.
- Runs on its own jittered schedule for each enabled pack that declares a list (daily by default; `CATALOG_SYNC_INTERVAL_HOURS` from 6 hours to 30 days, each waited out in full), and on admin request (`/radio sync [pack]`), with rate limits.
- Renames are detected by stable ID (or a single clearly similar name); the station keeps its ID and favourites, and the old name becomes an alias.
- Stations no longer listed are marked *missing from official list* but kept. New names are added as catalogued-only and reported as needing a reviewed source mapping.
- A failed or implausible fetch changes nothing. A list is implausible when it has fewer than 10 names, or fewer than half the pack's stations for small packs. The pack's list is flagged as possibly stale.
- The sync report lists added, renamed, missing, returned and unreachable stations.
- Stream sources are never discovered automatically; new mappings are added to the pack's `sources.json` by review.

**Acceptance:** a renamed station keeps its ID and favourites; a vanished source falls back or is reported.

### FR-003 — Voice connection and playback (P0)

- Joins only standard voice channels where the bot has View Channel, Connect and Speak, and that are on the server's allowlist if one is set.
- Default target: the requester's voice channel. Admins can lock the bot to a preferred channel.
- One station per server at a time; switching replaces the pipeline.
- Self-deafened; never receives or records voice.
- Handles listeners joining and leaving, moves, kicks, deleted channels, voice server changes and gateway reconnects.
- 24/7 playback without listeners only when an admin enables it.

**Acceptance:** a permitted user starts a verified station with one command and switches without two pipelines running.

### FR-004 — Technical source inspection (P0)

For every candidate source the inspector records, when measurable:

- final host after redirects (URLs redacted in logs and UI);
- transport (direct HTTP stream or HLS) and container;
- codec and profile (MP3, AAC-LC, HE-AAC, Opus …);
- advertised bitrate (ICY or HLS manifest), codec-reported bitrate, and **measured** payload bitrate from packet sizes and durations, with the strength of each;
- sample rate, channels and layout, HLS renditions considered;
- ICY headers and stream name;
- probe time, duration, startup time, decode errors, outcome and failure reason.

`ffprobe` and a bounded FFmpeg decode check run over an in-memory sample that is discarded afterwards.

**Acceptance:** `/radio inspect <station>` shows this data for every candidate without inflating bitrates or calling HLS a codec.

### FR-005 — Correct-station verification (P0)

A source is **identity-verified** only through one of:

1. an operator's recorded review (for pack sources), or a server admin's (for that server's custom stations);
2. a time-aligned audio comparison that matches an already-verified source of the same station (§7.5);
3. authoritative provenance (official player mapping, or a curated mapping with recorded evidence) together with a successful probe and no contradicting metadata;
4. for custom stations, the administrator's declaration when adding the URL.

Stream metadata that names a *different* station exactly is a contradiction. This is checked before any match against the station's own aliases, so a short alias such as "Example" never turns "Example Dance" into support. A pack's brand labels are neutral. Without audio support, a contradicted source becomes a **mismatch** and is excluded. This is checked at probe time and again on every live connection. A failed or inconclusive audio comparison never demotes an established source. Automatically discovered sources are never verified on provenance alone.

**Acceptance:** a newly found higher-bitrate feed that actually carries another station of the same broadcaster is never selected for the flagship.

### FR-006 — Best verified source selection (P0)

Per station, in order (§7.4):

1. **Eligible:** enabled, not blocked, identity-verified, successfully probed, not cooling down.
2. **Transport tier, first:** direct stream (tier 0), then unknown transport (tier 1), then **HLS (tier 2), which is a last resort**. HLS plays only when no direct stream of the station is eligible, even if it measures higher. Segmented delivery makes live playback slower to start, further behind live and less smooth to recover. The explanation states when HLS was chosen only because no direct stream was eligible.
3. **Fidelity, within the tier:** compare measured evidence. Same codec: a measured bitrate difference of 15 % or more decides. Different codecs are **never** ranked by bitrate. Stereo beats mono; a ≥ 44.1 kHz source beats one below 32 kHz.
4. **Stability:** health score difference of 20 points or more.
5. **Latency:** startup time difference over 1.5 s.
6. **Catalogue order** as the documented default.

Admins can choose `auto`, `prefer` (use when eligible) or `pin` (use when eligible, otherwise mark Degraded and fall back), with the commands or the buttons under `/radio sources`. While a station plays, anyone who can control the radio can play it from another usable source with the picker under `/radio sources` (or the Sources button). That choice lasts until the station changes; if the chosen source fails, the bot goes back to choosing automatically. Only usable sources are offered, and each choice is checked again when it is made. Every decision comes with an explanation and a conclusion: *higher quality verified*, *equivalent*, *not conclusively determined*, *higher-quality source ranked lower*, *single source* or *no eligible source*.

**Acceptance:** an unverified "256 kbps" source is never chosen over a verified 128 kbps source, and an eligible direct stream is always chosen over HLS unless an admin pins or prefers the HLS source.

### FR-007 — Discord output (P0)

- FFmpeg decodes the source and encodes **once** with libopus: 48 kHz, stereo, 20 ms frames, VBR, music mode, compression level 10, in Ogg pages of 100 ms.
- The Ogg Opus stream is handed to `@discordjs/voice` as `StreamType.OggOpus`, which only demuxes it: no second encode, no inline volume.
- Target bitrate:
  - `maximum` (default) = the source's own bitrate (codec metadata, then measured, then manifest or advertised), capped at `MAX_OPUS_BITRATE_KBPS`: 510 kbps by default (libopus's stereo maximum), configurable from 32 to 510. An unknown source bitrate uses the cap;
  - `balanced` = 128 kbps, or the source's bitrate when lower;
  - `manual` = an admin-set value from 32 kbps up to `MAX_OPUS_BITRATE_KBPS`.
- The voice channel's bitrate setting is **reported but not used as a cap**. The setting applies to members' voices, not to a bot's stream, and the plan notes when the target is above it. What a listener receives has **not been measured** (§18).
- The encoder is rebuilt when the target changes (quality mode or manual bitrate).
- Opus sources are decoded and re-encoded once (no pass-through in 1.0.0).
- `/radio quality` states that a higher Opus target cannot restore detail missing from the source.

**Acceptance:** logs and `/radio quality` agree on input and output; tests confirm a single encode.

### FR-008 — Recovery (P0)

- Detects stream end, FFmpeg exit, missing audio progress, failed HLS segments and playlists, voice disconnection and a feed that starts identifying as another station.
- Reconnects the same source with jittered backoff (about 1, 3 and 8 s), then fails over to the next eligible source, then reports an error and retries every 2 minutes while playback is still wanted.
- A source with 4 consecutive failures (the first plus every retry) cools down (10 minutes, doubling to 2 hours).
- A failure in the bot's own domain (FFmpeg failing to start, an internal error) says nothing about the source: it is retried on the same source, never counts against it and never causes a failover. If those retries run out, the bot reports an error and tries again after 2 minutes.
- Desired state (playing, stopped, left, kicked, paused) is stored separately from runtime state. An explicit stop or leave is never overridden.
- Every FFmpeg process and network input is closed on switch, stop, leave, server removal and shutdown.
- Notices to a configured channel are coalesced (one per kind per 5 minutes, with a count).

**Acceptance:** a failed stream never leaves the bot claiming to play silence.

### FR-009 — Permissions and governance (P0)

- **Bot admins are the server owner and members with Discord's Administrator permission.** Manage Server alone does not count, and there is no admin-role setting.
- Admins choose approved command channels and voice channels, and DJ roles for playback control.
- Listener control modes: `same_channel` (default), `none` (DJs and admins only), `any`.
- Read-only commands, playback commands and admin commands are authorised separately, on the server, for every slash command, button and menu.
- Admin actions: adding, editing and removing custom stations, source overrides, rescans, sync, configuration, import and export, and `/radio stats`.
- Minimal permissions; guild-only commands; no message-content intent.

**Acceptance:** commands in other channels are refused with an actionable message; members cannot add URLs or move the bot to unapproved channels.

### FR-010 — Station browser and controls (P0/P1)

- `/radio browse`: paged, filterable, ephemeral station picker.
- Controls: Previous/Next station (within the current station's pack, in pack order, or through favourites), Stop, Leave, Browse stations, Refresh, Favourite or Unfavourite, Sources, Inspect. **Skip (n queued)** appears when stations are queued, and always on the persistent panel. **Favourite** only adds and **Unfavourite** only removes, so a second click or an older message never undoes the first; each says so when nothing needed to change.
- **Station queue.** Radio never ends, so the queue advances only on skip.
  - `/radio queue add <station>` plays the station at once if nothing is playing; otherwise it appends it, up to 25 stations.
  - `/radio queue list`, `/radio queue remove <position>` and `/radio queue clear` manage the queue.
  - `/radio skip` plays the next queued station, skipping any that are no longer playable.
  - Queue changes follow the same listener rules as play and stop.
  - Now-playing embeds show **Up next**.
  - The queue is stored per server (`guild_queue`).
- `/radio panel` posts a persistent control panel; it is re-rendered after restarts and its buttons keep working.
- The station is always distinguished from the current track; track information is never invented.

### FR-011 — Custom stations (P1)

- Admins add stations with a name and URL, optionally website, description, category and language.
- Direct MP3/AAC/Opus, Icecast/SHOUTcast (including PLS/M3U) and HLS are supported, through the same inspector and pipeline.
- Each URL must pass the URL policy (§10.2) and a live probe before it is saved.
- Custom stations belong to one server, appear in their own section, and are capped per server (default 25).
- Admins can edit and remove them; changing the URL keeps the old one if the new one fails.

**Acceptance:** custom stations never change any station pack and cannot reach localhost or private networks.

### FR-012 — Favourites, defaults and idle modes (P1)

- Server favourites (user-level favourites are a possible later addition): first in the `/radio play` suggestions, a Favourites filter in the browse list (and `/radio list scope:favourites`), and the Next/Previous order when two or more exist and one is playing.
- Default station (cleared with *No default station*), played by `/radio join` and by autostart, and first in the `/radio play` suggestions; preferred voice channel, optional lock, autostart on boot (which needs both the default station and the preferred channel, and says so when either is missing), resume after restart, and whether the voice channel status shows what's playing (on by default).
- Idle modes: `leave_when_empty` (default; leave after 60 s), `pause_when_empty` (stop the stream after 30 s, resume when someone joins), `24x7`. They are also checked as soon as the bot starts playing in, or joins, a channel that is already empty. Leaving an empty channel after `/radio stop` keeps the desired state *stopped*, so autostart doesn't fire on the next boot.
- When playback resumes after idling, stale sources are re-probed.

### FR-013 — Now playing (P1)

- Shows in-stream ICY `StreamTitle` when present, as **On air** (stations send songs, show names or other text), labelled as stream metadata with its time received. It is decoded as UTF-8, or Windows-1252 when it is not valid UTF-8. An empty, symbol-only or placeholder title ("Unknown", "Advert" and similar) clears the line rather than leaving the previous title showing. HLS sources show no title.
- Missing track data never blocks playback; the line then says there is no song or show title from the stream right now.
- No album art.
- The bot's own Discord status shows "Listening to" the station and track (`PRESENCE_MODE`: `track`, `station` or `off`; default `track`). It is one status for the whole installation, so it names a station only when every playing server plays that station, and otherwise says "radio in N servers". A server's custom station is never named. Updates are checked every 20 s and sent only when the text changes. No intent or permission is needed.
- The bot's voice channel shows the same as its status ("📻 Station · title"), per server, so a custom station may be named. It needs the optional Set Voice Channel Status permission, can be switched off per server (`/radio config` → Notifications, on by default), and is cleared when playback stops or the bot leaves. Without the permission nothing is set and nothing else changes.

### FR-014 — Observability (P0/P1)

- Structured JSON logs with secrets redacted, server-scoped context and reason codes.
- Counters and coalesced incidents attributed to upstream, Discord, bot, operator or user.
- `/radio status` for everyone. `/radio stats` for Administrators: a private live panel with Refresh and Close buttons. It shows:
  - **the stream**: requested and redirected host with a region hint parsed from the host name (labelled as such), connected IP and port, HLS segment counts and last segment host, codec, live input rate over 10 s and 60 s, and stream-endpoint round trip measured by 5 TCP handshakes to the exact stream IP, with no HTTP request;
  - **the output**: Opus target, the voice channel's setting (not a cap), the Ogg Opus rate pulled by the voice player, packets per second (about 50) and packets sent to Discord, and late packets (sent more than 40 ms after the one before while playing) with the longest gap;
  - **the Discord connection**: voice endpoint host with region hint and resolved IP, the channel's RTC region, voice WebSocket ping with jitter (`@discordjs/voice` 0.19 no longer measures a UDP round trip), gateway ping, encryption/DAVE mode, failovers, reconnects and encoder PID, and FFmpeg warnings;
  - **bot health**: process, FFmpeg, User-Agent, per-pack coverage, incidents, and the event-loop delay (typical, 99th percentile and worst over the last minute). A delay of 20 ms or more is flagged, because voice packets are sent every 20 ms from that loop; the delay is also in the diagnostics endpoint, and a minute with a delay of 50 ms or more is logged as a warning (other minutes at debug level). At debug level every interaction is also logged with its type, subcommand, time taken and the process's CPU time meanwhile, so a delay can be matched to its cause.
- No telemetry. An optional diagnostics endpoint listens only on 127.0.0.1.
- A heartbeat file drives the container health check.

### FR-015 — Packaging and upgrades (P0)

- MIT-licensed code, reproducible builds, automated tests, changelog, security policy and contribution guide.
- Docker image (multi-architecture, published to GHCR on release tags), Compose file, systemd unit, `.env.example`.
- Versioned SQLite migrations with checksums; a backup is taken before migrating an existing database; an older build refuses a newer database.

---

## 6. Commands

One top-level `/radio` command, registered per server.

| Command | Who | Purpose |
|---|---|---|
| `/radio browse [pack] [category] [search]` | Everyone | Station picker grouped by pack; pack and category autocomplete; choose to play |
| `/radio play <station> [channel]` | DJ / eligible listener | Play or switch station |
| `/radio stop` | DJ / eligible listener | Stop audio; stay connected briefly; cancel auto-resume |
| `/radio join [channel]` | DJ / eligible listener | Join, and play the default station if set |
| `/radio leave` | DJ / eligible listener | Disconnect; no rejoin until the next play |
| `/radio now` | Everyone | Station, state, source, output, track |
| `/radio list [packs\|custom\|favourites] [pack] [page]` | Everyone | Stations with statuses and IDs, grouped by pack |
| `/radio inspect <station>` | Everyone | Full technical inspection of all candidates |
| `/radio sources <station>` | Everyone | Candidates, choice and fallback |
| `/radio quality` | Everyone | Input vs output report |
| `/radio status` | Everyone | Connection and desired state |
| `/radio skip` | DJ / eligible listener | Play the next queued station |
| `/radio queue add\|list\|remove\|clear` | DJ / eligible listener (list: everyone) | Station queue (max 25); `add` plays at once if nothing is playing |
| `/radio stats` | Admin | Private live stream, output and Discord-connection statistics, plus bot health; Refresh and Close |
| `/radio add <name> <url> …` | Admin | Add a custom station |
| `/radio edit <station> …` | Admin | Edit a custom station |
| `/radio remove <station>` | Admin | Remove a custom station |
| `/radio rescan <station> [compare]` | Admin | Re-probe; optional ~40 s audio comparison |
| `/radio sync [pack]` | Admin | Reconcile packs with their official station lists |
| `/radio config [default_station] [manual_bitrate]` | Admin | Interactive settings panel |
| `/radio export` / `/radio import <file>` | Admin | Settings as JSON; import shows a preview first |
| `/radio panel [channel]` | Admin | Post a persistent control panel |
| `/radio source pin\|prefer\|auto` | Admin | Per-server source overrides |
| `/radio source verify <station> <source> <verdict>` | Admin (custom stations); Admin who is also an Operator (pack sources) | Record an identity review |
| `/radio help` | Everyone | Short help |

**Button and menu rules:** component IDs are HMAC-signed, bound to the server, and expire (10–30 minutes, counted in whole minutes; panel buttons are persistent). The signature only proves the control is genuine; every click is authorised again on the server. Every ID fits Discord's 100-character limit by design, whatever the station: actions have at most 7 characters and arguments at most 65, the length of the longest station ID. Buttons sent by 1.0.5 and earlier say they have expired.

---

## 7. Source quality system

### 7.1 Definitions

- **Station:** an editorial programme, not a URL.
- **Source:** one endpoint that may carry a station, with its own evidence and provenance.
- **Transport:** direct HTTP stream or HLS. Not a codec.
- **Codec:** the compressed audio format (MP3, AAC, Opus …).
- **Source bitrate:** measured payload rate where possible; otherwise codec-reported or advertised, labelled as such.
- **Output bitrate:** the Opus target sent to Discord. Not a measure of source fidelity.
- **Identity confidence / quality confidence:** how strong the evidence is.

### 7.2 Source states

`discovered` (not yet probed) → after a probe: `eligible`, `degraded` (works but with decode errors), `unverified` (works but identity not verified, or a mismatch), `offline` (probe failed) or `blocked_by_policy` (URL policy or encrypted stream). `cooldown` after repeated playback failures. Each probe stores its time, outcome, reason and evidence summary.

### 7.3 Probing pipeline

1. Validate the URL: scheme, credentials, host, port and length.
2. Resolve DNS and reject the connection if **any** address is loopback, private, link-local, multicast, metadata, reserved or otherwise non-public (IPv4, IPv6, IPv4-mapped, NAT64, 6to4).
3. Connect to the validated address only, with header size and time limits; follow at most 5 redirects, validating each.
4. Resolve PLS and M3U playlists (depth 2, bounded size).
5. For HLS, choose the best audio rendition: audio-only variants by declared audio bandwidth first, never the largest audio+video figure. `BANDWIDTH` values that are really sample rates (such as 44100, which the starter pack's host declares) or that are implausibly low are ignored. Encrypted HLS is refused.
6. Collect a sample of up to 7 s / 2 MB in memory, then run `ffprobe` (format, codec, packets) and an FFmpeg decode check on it. FFmpeg only ever reads standard input.
7. Discard the sample.
8. Decide identity (FR-005) and store the evidence.

**Budgets:** 22 s per basic probe (of which up to 15 s waiting for the server's first response); about 40 s per audio comparison (90 s total); 2 concurrent probes per installation by default (`MAX_CONCURRENT_PROBES`) and 1 per host, and background checks one at a time; working sources are re-probed after 24 h, and a failing source backs off (about 10 min, 1 h, 6 h, 12 h, then once a day, starting at 12 h when the address is gone with HTTP 404/410). When someone wants a station and none of its sources works, its failing sources are re-checked despite the back-off, at most every 10 min within a day of last working, then hourly. A source with no successful check for 7 days (and at least 5 failed checks in a row) is **paused**: it is no longer checked automatically at all, in the background or for a play, until an admin runs `/radio rescan` (or a pack update gives it a new address). A temporary outage of hours or days never pauses a source. A check someone is waiting for interrupts a background check on the same host; the interrupted check records nothing and runs again later. The name sync runs daily by default for each pack that declares an official list. Nothing samples all stations continuously.

### 7.4 Selection

See FR-006. Selection runs on every play and failover. The transport tier is applied first: direct streams, then unknown, then **HLS as a last resort**. HLS is used only when no direct stream is eligible, whatever it measures, because segmented delivery makes live playback start more slowly and recover less smoothly. Within a tier, the evidence decides. The chosen source and a distinct eligible fallback are reported with an explanation, which says when HLS was chosen only because no direct stream was eligible.

### 7.5 Audio comparison

Two sources are decoded at the same time to 8 kHz mono for about **40 s** each, within 90 s. HLS is opened 1 segment from live for comparisons.

The bot computes a signed log-energy flux envelope at 100 frames/s. It trims the first and last second (removing a decode-start artefact that otherwise lined unrelated stations up at lag 0) and clips outliers. It then cross-correlates the two envelopes over **±30 s**, requiring at least **15 s** of overlap. Decoding runs in FFmpeg at the lowest CPU priority; the correlation runs in small slices that give the event loop back in between, so a comparison never holds up voice packets.

A match needs a correlation of at least **0.3** and a peak prominence of at least **5** standard deviations. A uniqueness ratio is reported but not used, because repetitive dance music makes it unreliable.

Calibration on live radio on 31 October 2026:

- the same station across MP3, AAC and HLS scored **0.38–0.90**;
- different stations scored **0.08–0.14**.

A match is strong identity evidence. No match is *inconclusive*, not proof of a different station: one of the starter pack's probed stations, for example, matched in two runs and was inconclusive in a third. Listening reviews are recorded as subjective admin overrides.

### 7.6 Refresh

Known evidence is reused with its timestamp. A playback request probes in the foreground only when no source is eligible, best candidate first. The station's other due sources are re-checked in the background only after the stream has played steadily for 30 s, one at a time, and every check runs FFmpeg/FFprobe at the lowest CPU priority, so checks never compete with a live stream (NFR: stream stability comes before background work, including on single-core hosts).

---

## 8. Audio path

### 8.1 Reference path

```text
Approved stream URL
  ↓ safe HTTP client (validated, address-pinned) — direct stream or HLS segments
FFmpeg (stdin only): decode → 48 kHz stereo → libopus, one encode → Ogg Opus on stdout
  ↓
@discordjs/voice: Ogg demux only → DAVE-capable voice connection
  ↓
Discord voice channel
```

### 8.2 Discord bitrates

Discord voice channels have a bitrate setting of up to 96 kbps (no boosts), 128 kbps (level 1), 256 kbps (level 2) or 384 kbps (level 3). Radio Bot treats this as a setting for members' audio, **not a cap on the bot's own stream**: it reports the channel's setting but encodes at its own target (FR-007), up to 510 kbps. What listeners receive **has not been measured**. Neither the setting nor the bot's target is a guarantee of what listeners receive. Source and output bitrates are always reported separately.

### 8.3 Encoder policy

As in FR-007. `maximum` encodes at the source's own bitrate, up to `MAX_OPUS_BITRATE_KBPS` (default 510 kbps). Encoding above the source would cost bandwidth without adding detail the source lacks. Operators with limited upload bandwidth can lower `MAX_OPUS_BITRATE_KBPS` or use `balanced`. Mono sources are carried in stereo framing without inventing stereo detail. Loudness and dynamics are left untouched.

### 8.4 Buffering and live delay

Buffers are bounded (HLS reader 512 KB high-water mark, 16 MB segment cap). HLS starts three segments from the live edge and resynchronises if it falls out of the live window or sequence numbers reset. A playlist that is only a little behind what was already sent (a stale copy from another server of the same CDN) is ignored until the next poll, so no audio is sent twice. Each segment, and each fMP4 start-up (init) section, is tried twice before it counts as failed. If playback drifts more than 45 s behind live, the stream restarts at the live edge.

### 8.5 Process lifecycle

Each server has at most one authoritative pipeline. A process registry owns every FFmpeg/FFprobe child and terminates it (SIGTERM, then SIGKILL after 2 s) on switch, stop, failure and shutdown.

---

## 9. Playback state machine

### 9.1 States

`IDLE → JOINING → CONNECTED → BUFFERING → PLAYING`, plus `SWITCHING`, `RECOVERING`, `FAILING_OVER`, `STOPPING`, `LEAVING` and `ERROR`. Every newer command supersedes older work in progress; overlapping requests share one voice connection attempt.

### 9.2 Recovery timings

- First audio expected within 20 s of starting a source.
- No encoder output for 15 s counts as a stall.
- Same-source retries at about 1, 3 and 8 s (±25 % jitter), then failover.
- A source playing stably for 30 s resets its failure streak.
- Voice reconnects at about 2, 5, 10, 30 and 60 s, then a visible error.
- With no eligible source, retry every 2 minutes while playback is wanted.
- After `/radio stop`, leave the channel after 5 minutes unless the idle mode is 24/7.

### 9.3 Boot policy

On start-up, for each server: if playback was wanted and **resume after restart** is on, resume that station in that channel; otherwise, if **autostart** is on, a default station and preferred channel are set, and the last action was not an explicit stop, leave or kick, start the default; otherwise stay idle. Both options are off by default.

---

## 10. Permissions, safety and abuse controls

### 10.1 Capability matrix

| Capability | Everyone | DJ role | Admin |
|---|:-:|:-:|:-:|
| Browse, list, now, inspect, quality, status | Yes | Yes | Yes |
| Play, switch, stop, leave, favourite, skip, queue changes | Per listener control mode | Yes | Yes |
| Add, edit, remove custom stations | No | No | Yes |
| Rescan, sync, source overrides | No | No | Yes |
| Configure, import, export, panel, stats | No | No | Yes |
| Identity review of station-pack sources | No | No | Admins who are also Operators |

Admin = the server owner, or a member with Discord's **Administrator** permission. Manage Server does not count, and there is no admin-role setting. Operator = the Discord application's owner (or a member of the team that owns it) or a user listed in `OPERATOR_USER_IDS`; recording a review also needs admin rights in the server where the command is used. Admins may use commands outside the approved command channels. Bot permissions: View Channels, Send Messages, Embed Links, Attach Files, Connect, Speak, and the optional Set Voice Channel Status (permission integer 281474979908608; without the optional one the integer is 3197952 and everything but the channel status works). Intents: Guilds and Guild Voice States only.

### 10.2 URL and host security

- `http` and `https` only (plain `http` can be refused installation-wide); no credentials in URLs.
- Internal host names, sensitive service ports, and every non-public IPv4/IPv6 range are refused, checked on every connection, redirect and reconnect.
- Sockets connect only to the validated address, so DNS rebinding cannot swap the target.
- Limits on URL length, redirects, headers, playlist size, segment size, probe time and concurrency.
- FFmpeg never receives a URL or user-supplied argument; it reads only standard input (`-protocol_whitelist pipe`).
- The container runs as non-root with a read-only root filesystem and no capabilities; the systemd unit uses an unprivileged dynamic user and strict sandboxing.
- Tokens, cookies and query strings are redacted from logs, UI, reports and exports.
- Stream requests identify as FFmpeg's network library: `Lavf/<version>` from the installed FFmpeg (fallback `Lavf/61.7.100`). `STREAM_USER_AGENT` overrides it, and `/radio stats` shows it. No browser is imitated and no `Referer` is sent.
- Streams requiring authentication are not supported. HTTP 401/403/451 responses are reported as `ACCESS_DENIED` and not retried around.

### 10.3 Abuse resistance

Rate limits: station switches and joins 6 per user and 12 per server per 30 s; stream checks (rescans and custom-station URL changes) 3 per server per 10 minutes; adding stations 5 per server per hour; sync 2 per server per hour and 1 per installation per 10 minutes; imports 5 per server per 10 minutes (with one pending import preview per server); component clicks 20 per user per 20 s. Rapid repeated switches are superseded rather than queued. Installation-wide caps: active streams (default 3) and concurrent probes (default 2).

---

## 11. Data model

SQLite (`node:sqlite`) with versioned SQL migrations in `migrations/`: 0001 creates the schema, 0002 adds the voice channel status setting, and 0003 and 0004 add indexes (for the hourly clean-up of old probe results, and for the favourites, queue and source-preference columns that point to stations and sources).

### 11.1 Tables

- `stations` — pack and custom stations: provider (the pack ID, or `custom`), owning server (custom only), slug, official ID, name, aliases, tags, category, order, official page, catalogue status and dates.
- `station_sources` — URL, label, priority, hints, measured transport/codec/profile/sample rate/channels, advertised/codec/measured bitrates and evidence strength, identity status, confidence, evidence and admin override, rights status, provenance, enabled flag, state, health score, failure counters, cooldown.
- `source_probe_results` — per-probe evidence: timing, host, format, bitrate and evidence, headers and manifest summaries, identity evidence, outcome, probe version.
- `guild_settings` — channel allowlists, DJ roles, listener control mode, default station, preferred channel and lock, quality mode and manual bitrate, idle mode, autostart, resume, voice channel status, notification channel, panel location.
- `guild_playback_state` — desired station, channel and state, last requester, last good source, last error.
- `guild_source_preferences` — per-server `prefer`/`pin` choices.
- `guild_favourites` — per-server favourites.
- `guild_queue` — per-server station queue: station, who added it, and when. At most 25 entries.
- `catalogue_sync_reports` — sync reports, keyed by pack ID in the provider column.
- `app_meta` — the component signing secret and other small values.
- `schema_migrations` — version, time applied, checksum.

### 11.2 Retention and privacy

- Station and source facts, and server settings, are kept until removed.
- Probe history: the newest 30 per source and nothing older than 30 days (configurable).
- Logs go to standard output; the Compose file rotates them (5 × 10 MB). Under systemd, the journal applies its own policy.
- When the bot is removed from a server (not during an outage), that server's settings, favourites, queue, preferences, playback state and custom stations are deleted.
- Never stored: message content, voice audio, IP addresses, presence or member lists.
- Exports contain Discord IDs and preferences only; custom stream URLs with query strings are exported redacted.

---

## 12. Architecture

### 12.1 Technology

| Layer | Choice |
|---|---|
| Runtime | Node.js 24.17+ (type-stripped TypeScript in development, compiled JavaScript in production) |
| Language | TypeScript, strict mode |
| Discord | discord.js 14, `@discordjs/voice` 0.19 with DAVE (`@snazzah/davey`) |
| Audio | System FFmpeg and FFprobe with libopus |
| Storage | SQLite via `node:sqlite` |
| Validation | Zod |
| Logging | Pino |
| Lint/format | Biome |
| Tests | Vitest (unit tests and real-FFmpeg integration tests, with V8 coverage reports); a bash end-to-end test of the installer and manager |
| CI | GitHub Actions: type check, lint, catalogue validation, tests, build, shellcheck and the installer test, Docker build and smoke test, CodeQL, dependency audit, secret scanning; release images to GHCR after the same checks |

Dependencies and the base image are pinned to exact versions.

### 12.2 Modules

```text
Discord interactions (controller, signed components, views)
        │
Authorisation (per command and per click)
        │
Session manager → one GuildSession per server (state machine, recovery)
     │                     │                         │
Catalogue (packs,      Source service             Audio pipeline
custom, search, sync)  (probe, identity, ranking) (FFmpeg → Ogg Opus)
     │                     │                         │
          SQLite repositories              @discordjs/voice link
```

Command handlers never build FFmpeg commands or fetch stream URLs themselves; the source service and the pipeline are the only components that touch streams, and both go through the safe HTTP client.

### 12.3 Repository layout

```text
radiobot/
├── README.md, CHANGELOG.md, CONTRIBUTING.md, SECURITY.md, CODE_OF_CONDUCT.md, LICENSE
├── AGENTS.md, CLAUDE.md      instructions for coding agents (CLAUDE.md imports AGENTS.md)
├── install.sh                one-line installer: clones the repository, then runs `radio-bot.sh install`
├── .env.example, Dockerfile, compose.yaml, package.json, pnpm-lock.yaml
├── biome.json, tsconfig.json, tsconfig.build.json, vitest.config.ts, .gitleaks.toml
├── .github/workflows/        ci.yml, release.yml, security.yml
├── catalog/                  README.md (pack authoring guide)
│   └── packs/<pack-id>/      pack.json, stations.json, sources.json, SOURCE_PROVENANCE.md, evidence/
├── deploy/systemd/           radio-bot.service
├── docs/                     PRD.md and user/operator guides
├── migrations/               versioned SQL
├── scripts/                  register-commands, healthcheck, backup, validate-catalogue;
│                             radio-bot.sh (the `radio-bot` command for Docker Compose installs)
├── src/                      app, config, discord, catalogue, streams, audio, voice,
│                             persistence, import-export, observability, shared
└── tests/                    unit/, integration/ (synthetic, rights-free audio only),
                              lifecycle/ (installer and manager against a fake Docker)
```

### 12.4 Deployment profiles

The bot is one long-running process. It needs outbound HTTPS, WebSocket and UDP (for voice), FFmpeg with libopus, and a writable data directory. It needs no inbound port, domain or reverse proxy.

- **Profile A — Docker / Docker Compose.** One container, one named volume at `/app/data`. The image bundles Node.js and FFmpeg, runs as non-root with a read-only root filesystem, and has a health check. See `docs/install-docker.md`.
- **Profile B — Directly on Linux.** Node.js and FFmpeg installed on the host; a hardened systemd unit; data in `/var/lib/radio-bot`. See `docs/install-linux.md`.
- **Profile C — Container platforms.** Any platform that runs the image as a long-running background worker with outbound UDP and a persistent volume at `/app/data`. Platforms without persistent volumes lose settings on every redeploy. Serverless/function platforms (such as Vercel) are not suitable. See `docs/install-container-platforms.md`.
- **Future — a centrally hosted public bot.** Not part of 1.0.0; it would need its own rights clearance, scaling, abuse handling and operations.

Each installation can serve several servers, limited by `MAX_ACTIVE_GUILD_STREAMS`.

### 12.5 Configuration

Environment variables (all listed in `.env.example`): `DISCORD_TOKEN`, `DISCORD_APPLICATION_ID`, `DISCORD_DEV_GUILD_ID`, `REGISTER_COMMANDS_ON_START`, `DATABASE_PATH`, `LOG_LEVEL`, `FFMPEG_PATH`, `FFPROBE_PATH`, `EXTRA_PACKS_DIR`, `DISABLED_PACKS`, `ENABLED_PACKS`, `CATALOG_SYNC_ENABLED`, `CATALOG_SYNC_INTERVAL_HOURS`, `DISABLED_STATION_IDS`, `DISABLED_SOURCE_IDS`, `OPERATOR_USER_IDS`, `DEFAULT_QUALITY_MODE`, `MAX_OPUS_BITRATE_KBPS`, `DEFAULT_IDLE_MODE`, `AUTO_RESUME_DEFAULT`, `PRESENCE_MODE`, `MAX_ACTIVE_GUILD_STREAMS`, `MAX_CONCURRENT_PROBES`, `MAX_CUSTOM_STATIONS_PER_GUILD`, `PROBE_HISTORY_LIMIT`, `PROBE_HISTORY_DAYS`, `ALLOW_INSECURE_HTTP_STREAMS`, `STREAM_USER_AGENT`, `TELEMETRY_ENABLED` (must stay `false`), `DIAGNOSTICS_PORT`. Per-server settings are made in Discord with `/radio config`. The repository contains no server or user IDs.

---

## 13. Operating costs and scale

### 13.1 Resources

A small Linux machine or container should handle a few concurrent streams. CPU use depends mainly on the number of concurrent FFmpeg encodes and their bitrate; a high-bitrate station (up to the 510 kbps limit) is the most demanding case. Measured on a small cloud server (1 November 2026): one 128 kbps stream used about 8% of one CPU core and about 200 MB of memory in total (the bot about 5% and 126 MB, its FFmpeg process about 3% and 56 MB). The Opus encode alone took 2.1%, 2.4% and 2.7% of a core at 128, 320 and 510 kbps. Several concurrent streams, long runs and ARM boards have not been measured. The README's Requirements section gives the resulting minimum and recommended specification.

### 13.2 Bandwidth

Per active server: the source stream inbound (128 kbps ≈ 57.6 MB per hour) plus the Opus stream to Discord outbound, before protocol overhead. Outbound follows the station in the default `maximum` mode: 128 kbps ≈ 57.6 MB per hour, 320 kbps ≈ 144 MB per hour, and at most 510 kbps ≈ 230 MB per hour. One 24/7 stream is about 41 GB per month at 128 kbps and at most 165 GB at 510 kbps. This is per bot-to-Discord stream, not per listener: Discord distributes the audio. Continuous 24/7 playback runs about 720 hours a month.

### 13.3 Cost

The software costs nothing to run beyond the host. There is no paid tier and no "HD" unlock.

---

## 14. Rights, branding and release gate

Freely listenable web radio is not automatically licensed for retransmission to third parties. Music and recording rights, a broadcaster's stream terms, territorial restrictions and trademarks can all apply.

- The project is **unofficial**. Station names identify stations only; no logos or artwork are bundled.
- The MIT licence covers the project's own code only, not station names, trademarks, audio, artwork, or third-party binaries such as FFmpeg in the image.
- **Operators are responsible** for how they run an instance. Personal self-hosting and public or commercial operation are different situations; public operation needs the broadcaster's permission and appropriate music licensing.
- **Takedown:** an operator can disable stations or sources immediately (`DISABLED_STATION_IDS`, `DISABLED_SOURCE_IDS`) or whole packs (`DISABLED_PACKS`, for example `mypack`). Maintainers remove mappings from a pack on a valid request (see `SECURITY.md`).
- The bot respects access restrictions and never bypasses them (§2, principle 11). The architecture works with user-supplied streams and operator packs even if the starter pack cannot be used.

**Release gate (open for 1.0.0):** whether the starter pack's stations may be distributed and used for rebroadcast has not been cleared with the broadcaster. Releasing the code does not settle that question.

---

## 15. Privacy

- No accounts outside Discord; no analytics or telemetry.
- Discord IDs are kept only for server settings and enforcing permissions, and to record the last requester of playback and who queued a station.
- No Message Content, Guild Members or Presence intents.
- No voice reception, recording or transcription.
- No IP addresses of users or listeners.
- Logs stay local and redact secrets.
- Server data is deleted when the bot is removed from that server (§11.2).

---

## 16. Non-functional requirements

These are engineering targets, not guarantees about broadcasters or Discord.

| ID | Requirement | Target |
|---|---|---|
| NFR-01 | Start of playback | First audio within 10 s (p95) on a healthy direct stream with fresh evidence |
| NFR-02 | Station switch | Within 8 s (p95) on healthy direct streams |
| NFR-03 | Stall visibility | Missing audio progress detected within 20 s (implementation: 15 s) |
| NFR-04 | Recovery | Same or fallback source restored within 60 s when upstream allows |
| NFR-05 | Continuous operation | 72 h unattended without unrecovered silence, leaks or orphaned FFmpeg processes |
| NFR-06 | Audio integrity | Exactly one lossy encode to Opus; no default EQ, normalisation or compression; stereo preserved |
| NFR-07 | Station correctness | No knowingly mislabelled source among verified sources |
| NFR-08 | Security | No access to private or loopback targets by URL, DNS rebinding or redirect |
| NFR-09 | Crash consistency | An explicit stop stays stopped after restart; resume happens only when enabled |
| NFR-10 | Portability | Documented Docker, Linux and container-platform installs pass a smoke test |
| NFR-11 | Secrets | No tokens in the repository, logs, reports, exports or issues |
| NFR-12 | Truthful reporting | Output settings reported accurately; unknown values marked unknown |
| NFR-13 | Bounded resources | Stream, probe, buffer and process limits enforced |
| NFR-14 | Accessibility | Usable on Discord mobile, with text labels alongside any icons |

Diagnostics attribute faults to upstream, Discord, the bot, the operator or the user.

---

## 17. Test and validation plan

### 17.1 Unit tests (automated)

Station IDs, search and alias collisions; eligibility, fidelity comparison, pin/prefer/fallback; URL policy across IPv4, IPv6, IPv4-mapped, NAT64, 6to4, redirects, DNS rebinding and internal names; permission matrix; signed components; desired-state transitions and boot policy; migrations, backups and retention; import/export validation and redaction; identity rules and audio correlation; the session state machine with simulated failures (recovery, failover, stalls, kicks, idle modes, overlapping requests); the HLS reader (retries, stale playlists, resynchronisation); catalogue-sync scheduling; the bot status, voice channel status and late-packet count. `pnpm test:coverage` reports how much of `src/` and `scripts/` the tests run, file by file.

### 17.2 Stream integration tests (automated)

A local test radio serves **synthetic, rights-free audio**: direct MP3 and AAC, Ogg Opus, mono and low sample rates, ICY metadata, redirects, PLS, HTML and 404 responses, and a multi-variant HLS master with an audio+video decoy. The tests check measured codec, bitrate, sample rate and channels; HLS rendition choice; Ogg Opus output (48 kHz stereo header, 20 ms frames, one encoder process); that `@discordjs/voice` only demuxes; that stopped pipelines leave no FFmpeg process; and that two offset copies of one programme match while different programmes do not.

### 17.3 Discord end-to-end tests (manual, per release)

Fresh install with minimum permissions; audible playback confirmed from a separate client; switching between stations with identity checks; stop, leave, restart and resume; idle modes; channel bitrate changes; owner, DJ and member permission scenarios; kicks, moves, deleted channels, revoked permissions and network loss; a 72-hour soak test.

### 17.4 Audio-quality checks (per release)

Probe each bundled pack's sources on the release candidate's network; confirm labels match probe output; record evidence in the pack's `evidence/` folder (`catalog/packs/<pack-id>/evidence/`); never claim higher fidelity without reproducible evidence.

### 17.5 Catalogue checks (automated and per release)

All 63 starter-pack names present with stable IDs; every pack validates (`node scripts/validate-catalogue.ts` in CI; `--pack <dir>` for one folder); sync handles additions, renames and removals without losing favourites; the live official list is reviewed before each release.

### 17.6 Installer tests (automated, Linux)

`tests/lifecycle/run.sh` runs `install.sh` and the `radio-bot` command (install, status, update, backup, restore, uninstall) against a throwaway Git origin and a fake `docker`. CI runs it, together with `shellcheck`, on every pull request and push to `main`, and before every release.

---

## 18. Delivery status and roadmap

| Phase | Content | Status |
|---|---|---|
| 0 — Foundations | Repository, CI, Docker, URL policy, catalogue snapshot, validation harness | Done |
| 1 — Flagship | Probing, selection, single-encode pipeline, play/stop/leave/now/quality, recovery, SQLite | Done |
| 2 — Full catalogue | 63 stations with sources, sync, identity rules, browser, roles and permissions, overrides, health scores | Done in code; 3 stations verified live, 60 not yet probed |
| 3 — Public self-hosted 1.0.0 | Custom stations, import/export, migrations and backups, documentation, security policy, Docker/Linux/platform guides | Done in code; release gates open |
| 4 — Later | Public hosted instance, user favourites, Opus pass-through, richer metadata, web dashboard, more languages | Not started |

**Open release gates for 1.0.0:**

- **Starter pack: 3 of 63 stations confirmed playable by live probe.** The flagship and two other stations were confirmed (the probe report is in the pack folder's `evidence/`). Audio correlation also supports identity for two of the three, while the third was inconclusive in the latest run. The other 60 stations use the same host and pattern but have not been probed.
- One live Discord test (1 November 2026), and no 72-hour soak test. With the minimum permissions, the starter pack's flagship station played in a voice channel and was heard in the Discord client: the direct MP3 source at 128 kbps, one Opus encode at 128 kbps, and DAVE end-to-end encryption negotiated. The Discord-side figures in `/radio stats` (voice server, WebSocket ping, packets per second, encryption) were shown live. Permission scenarios, station switching, and kick, move and delete handling have not been tested live.
- The three installation profiles have not been smoke-tested on real hosts (the image is published by the release workflow).
- Resource use measured for a single stream only; no multi-stream, long-run or ARM measurements.
- Encoding above the voice channel's bitrate setting (up to 510 kbps): the bitrate a listener receives has **not been measured**.
- Rights clearance (§14) and the licence review of the bundled FFmpeg build not done.

---

## 19. Risks

| Risk | Severity | Mitigation |
|---|---|---|
| Stream hosts refuse unknown clients (observed on the starter pack's host until the bot identified as FFmpeg) | High | Identify truthfully as FFmpeg (`Lavf/<version>`), never as a browser and with no `Referer`; report `ACCESS_DENIED` honestly; never bypass; operator kill switches |
| Broadcaster changes its station list or stream mounts | High | Station packs separate from code; per-pack sync adapters; daily name sync; reviewed manifests; sync report |
| A better-looking feed carries another station | High | Identity gate; per-pack brand labels; exact-name contradiction before alias match; live metadata check; audio correlation |
| Codec or transport mistaken for quality | High | Measured evidence; no cross-codec bitrate ranking; explicit unknowns |
| Rebroadcast rights unclear | Critical | Unofficial status; operator responsibility; takedown switches; release gate |
| Discord voice/DAVE library changes | High | Pinned versions; integration tests; release monitoring |
| FFmpeg hangs or leaks | High | Process registry; watchdog; termination with SIGKILL fallback |
| Internal-network URL added | Critical | Address checks on every connection and redirect; admin-only additions |
| CPU load with many servers | Medium | Active-stream cap; diagnostics; benchmarking before scaling |
| Unexpected playback after restart | Medium | Desired-state persistence; stop takes precedence; resume off by default |
| Trademark misuse | High | "Radio Bot" name; unofficial notices; no bundled logos |

---

## 20. Definition of done — 1.0.0

| # | Criterion | Status |
|---|---|---|
| 1 | Docker image and documented installation with persistent storage | Done (image published by the release workflow) |
| 2 | Discord application setup documented; least-privilege permissions | Documented; live test open |
| 3 | Starter pack includes all official names; nothing falsely shown as playable | Done |
| 4 | Every station shown as playable has a verified, healthy source with evidence | Enforced by the eligibility gate; 3 starter-pack stations confirmed by live probe, 60 not yet probed |
| 5 | Flagship candidates re-probed; no hidden "HD" claims | Done: direct MP3 128k, direct AAC-LC 128k and HLS AAC-LC 128k all work; one HLS address times out; no HD feed exists |
| 6 | Source format shown separately from Discord output | Done |
| 7 | DAVE-capable voice, music-suitable Opus, single encode | Done in code and tests; live check open |
| 8 | Browse, play/switch/stop/leave, now playing, quality in approved channels | Done in code; live test open |
| 9 | Role and channel restrictions on commands and buttons | Done |
| 10 | Preferences persist; explicit stop respected after restart | Done |
| 11 | Reconnect/failover with no orphaned FFmpeg processes | Done in tests; soak test open |
| 12 | Custom streams pass SSRF and validation checks | Done |
| 13 | 72 h soak and all CI/security tests pass | CI passes locally; soak open |
| 14 | Secret redaction, backups, migrations, contributor docs | Done |
| 15 | Rights, access and branding review documented with a decision | Open |
| 16 | Release notes state the integration is unofficial and not endorsed | Done |

---

## Appendix A — Starter pack station list (63)

The starter pack has 63 stations, taken from its broadcaster's official list as published on 31 October 2026. The names are kept with the pack, not in this document: its `stations.json` lists them in official order, and its `SOURCE_PROVENANCE.md` maps each one to its sources.

---

## Appendix B — Manifest and inspection formats

All pack files have `"schemaVersion": 1`. `stations.json` wraps entries in `{ "schemaVersion": 1, "stations": [...] }`, and `sources.json` in `{ "schemaVersion": 1, "sources": [...] }`. Pack metadata is in B.4. The authoring guide is `catalog/README.md`.

### B.1 Station entry (`catalog/packs/<pack-id>/stations.json`)

The station ID is derived: `<pack id>:<slug>`, here `mypack:my-station`. Only `slug`, `displayName` and `order` are required.

```json
{
  "slug": "my-station",
  "displayName": "My Station",
  "externalId": "a1B2c3D4e5",
  "aliases": ["My Station Live"],
  "category": "flagship",
  "tags": ["flagship", "live", "dj", "electro", "house"],
  "order": 1,
  "officialPage": "https://www.example.com/my-station",
  "catalogueStatus": "active",
  "catalogueLastSeen": "2026-10-31"
}
```

### B.2 Source entry (`catalog/packs/<pack-id>/sources.json`)

`station` is the slug of a station in the same pack. `id` must be unique across all packs. `provenance` is `official-player` or `curated`.

```json
{
  "id": "mypack-my-station-mp3",
  "station": "my-station",
  "url": "https://stream.example.com/my-station",
  "label": "Direct MP3",
  "priority": 10,
  "transportHint": "http-continuous",
  "codecHint": "mp3",
  "provenance": "official-player",
  "provenanceDetail": "Official web player entry a1B2c3D4e5 redirected to this mount on 2026-10-31.",
  "enabled": true,
  "disabledReason": null
}
```

### B.3 Quality report (`/radio quality`)

Input: station and source ID, transport (and HLS rendition), codec and container, bitrate with its evidence strength and the live network rate, sample rate, channels. Output: Opus, 48 kHz, 2 channels, 20 ms, encoder target and mode, the voice channel's bitrate setting (marked as not a cap), observed encoder output rate, encryption state. Processing: number of lossy encodes, resampling, confirmation that no volume or loudness processing is applied, notes. Decision: conclusion and explanation.

### B.4 Pack metadata (`catalog/packs/<pack-id>/pack.json`)

```json
{
  "schemaVersion": 1,
  "id": "mypack",
  "name": "My Pack",
  "description": "The webradios listed on the broadcaster's website …",
  "disclaimer": "Unofficial: Radio Bot is not affiliated with or endorsed by any broadcaster. Station names identify the stations only.",
  "order": 10,
  "enabledByDefault": true,
  "brandLabels": ["Example Radio", "Example"],
  "categories": [{ "id": "flagship", "name": "Flagship" }, { "id": "chill", "name": "Chill" }],
  "sync": { "adapter": "webradio-apidata", "url": "https://www.example.com/webradios" },
  "snapshotDate": "2026-10-31"
}
```

The starter pack's file has the same shape and declares six categories. `sync` is optional (`null` for packs without an official list).

---

## Appendix C — References

1. The starter pack's official station list: the URL in its `pack.json` `sync` entry, also recorded in its `SOURCE_PROVENANCE.md`.
2. `@discordjs/voice`: <https://discord.js.org/docs/packages/voice/main>
3. Discord voice connections and DAVE: <https://docs.discord.com/developers/topics/voice-connections>
4. Discord audio bitrate FAQ: <https://support.discord.com/hc/en-us/articles/11635925354775-Audio-Bitrate-FAQ>
5. Discord application commands: <https://docs.discord.com/developers/interactions/application-commands>
6. Discord copyright and trademark policy: <https://discord.com/safety/copyright-trademark-policy-explainer>
7. PPL licensing for online radio (UK): <https://www.ppluk.com/licensing/playing-music-on-radio/>
8. GOV.UK guidance on music licences for online use: <https://www.gov.uk/find-licences/licences-use-music-online-mobile>
9. FFmpeg and FFprobe documentation: <https://ffmpeg.org/ffmpeg.html>, <https://ffmpeg.org/ffprobe.html>
10. HLS (RFC 8216): <https://www.rfc-editor.org/rfc/rfc8216>

---

## Appendix D — Key design decisions

| Decision | Choice |
|---|---|
| Product name | Radio Bot (unofficial) |
| Product focus | Curated station packs first (starting with the bundled starter pack); custom stations second |
| Station catalogue | Modular station packs (`pack.json`, `stations.json`, `sources.json`); no pack-specific code; per-pack sync adapters; operators can add packs via `EXTRA_PACKS_DIR` |
| Distribution | Public GitHub repository; operators self-host with their own token |
| Source of truth | Official station names (per pack) + reviewed source mappings + runtime evidence |
| Quality rule | Best *verified* source; correctness before bitrate |
| Transport | Direct streams first; HLS only as a last resort (segmented delivery hurts live playback) |
| Stream client identity | FFmpeg's `Lavf/<version>` User-Agent (truthful; FFmpeg decodes the audio); no browser imitation, no `Referer`; operator override via `STREAM_USER_AGENT` |
| Output | 48 kHz stereo Opus, one encode, at the source's bitrate up to `MAX_OPUS_BITRATE_KBPS` (default 510 kbps) in `maximum` mode; the channel setting is reported, not used as a cap (what listeners receive has not been measured) |
| Playback limit | One station and voice connection per server |
| Interface | One `/radio` command with Discord-native menus and buttons; it uses all 25 top-level options Discord allows, so further commands must go into subcommand groups (as `queue` and `source` do) |
| Bot administration | Server owner or Discord Administrator permission only; DJ roles for playback control |
| Station queue | Advances only on skip (radio never ends); max 25 |
| Storage | Local SQLite |
| Hosting | Docker, Linux with systemd, or a container platform with persistent storage |
| Access restrictions | Respected; never bypassed |
| Metadata | Best effort from the stream; never invented |
| Telemetry | None |
