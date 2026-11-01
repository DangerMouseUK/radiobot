# Architecture

This page describes how Radio Bot is put together as implemented in `src/`. It is written for contributors and for operators who want to know what the process does. The product requirements are in [the PRD](PRD.md). Where the two ever disagree, the code is authoritative.

## Process overview

Radio Bot is a single Node.js 24 process. The entry point is `src/index.ts`, which:

1. Loads and validates configuration (`src/config/env.ts`, Zod). If configuration is invalid it exits with code 78. It also refuses `TELEMETRY_ENABLED=true`.
2. Creates a Pino logger that redacts the Discord token, URL fields and auth headers (`src/observability/logger.ts`).
3. Builds the application with `createApp()` (`src/app.ts`) and starts it.
4. On `SIGTERM` or `SIGINT`, tears everything down and force-exits after 10 s.

There are no other services. State lives in one SQLite file. All network traffic is outbound: the Discord gateway and voice servers, the station stream hosts, each pack's official station list page (sync), and Discord's CDN (for `/radio import` attachments). The only listening socket is the optional diagnostics endpoint, which binds to `127.0.0.1`.

```text
                          Discord (gateway, interactions, voice)
                                   ▲                 ▲
                 interactions      │                 │ Ogg Opus packets (DAVE)
                                   │                 │
┌──────────────────────────────────┴─────┐   ┌───────┴──────────────────────┐
│ discord/                                │   │ voice/                         │
│  controller ─ authorize ─ context       │   │  session-manager ─ session     │
│  views/format ─ custom-id ─ notifier    │──▶│  link (@discordjs/voice)       │
│  register (guild commands)              │   │  state-machine                 │
└───────┬───────────────┬─────────────────┘   └──────┬───────────────┬────────┘
        │               │                            │               │
        ▼               ▼                            ▼               ▼
┌──────────────┐ ┌─────────────────────────────────────────┐ ┌────────────────────┐
│ catalogue/    │ │ streams/  (source-validation boundary)  │ │ audio/              │
│  packs, sync  │ │  source-service ─ probe ─ identity      │ │  pipeline (FFmpeg   │
│  custom-prov. │ │  ranking ─ input (ICY, HLS) ─ playlists │ │   stdin → Ogg Opus) │
│  search       │ │  safe-fetch ─ url-policy                │ │  encoder (plan/args)│
└──────┬───────┘ └───────────────┬─────────────────────────┘ │  ffmpeg (registry)  │
       │                         │ policy-checked bytes       └─────────▲──────────┘
       ▼                         └────────────────────────────────────────┘
┌──────────────────────────────────────────────────────────────────────────┐
│ persistence/  Db (node:sqlite, migrations, backups) + repositories         │
└──────────────────────────────────────────────────────────────────────────┘
```

## Wiring (`src/app.ts`)

`createApp(config, logger)` constructs everything in this order:

1. **Database.** `new Db(DATABASE_PATH)` opens SQLite with WAL, foreign keys and `busy_timeout`, then runs `db.migrate()`. If the database already has a schema and migrations are pending, a backup is written to `data/backups/` first. `Db` keeps each prepared statement and reuses it, since compiling one costs more than running a small query, and counts rollbacks. `StationRepository`, the only writer of the station tables, reads every station and source once, parses and freezes them, and reuses them until its next write or a rollback. So suggestions, browse pages, coverage counts and availability badges are map lookups, not queries, on the thread that sends voice packets. A single-row read (`getStation`, `getSource`) uses the cache only while it is current; otherwise it queries that row, so seeding, which writes row by row, doesn't rebuild the whole cache after each write.
2. **Repositories.** `StationRepository`, `GuildRepository` (seeded with the installation defaults for quality mode, idle mode and resume) and `MetaRepository` (a key/value store for things like the component-signing secret and command hashes).
3. **Station packs.** `PackRegistry.load()` loads and validates every pack folder in `catalog/packs/` and in `EXTRA_PACKS_DIR`. It applies `ENABLED_PACKS` and `DISABLED_PACKS` on top of each pack's `enabledByDefault`. `seedPacks()` then runs in a single transaction and upserts each pack's `stations.json` and `sources.json`. Seeding:
   - keeps runtime evidence and guild data;
   - applies `enabled`/`disabledReason` from the manifest;
   - disables (never deletes) any pack source that has been removed from its manifest.
4. **Network policy.** It creates a `UrlPolicy` (honouring `ALLOW_INSECURE_HTTP_STREAMS`) and a `SafeHttpClient` that enforces it.
5. **`ProcessRegistry`.** Every FFmpeg and FFprobe child process is registered here.
6. **`SourceService`.** This is the source-validation boundary, with the probe concurrency limit and the operator disable lists.
7. **The discord.js `Client`.** Its intents are **`Guilds` and `GuildVoiceStates` only**. Message, presence and reaction caches are disabled, member and user caches are capped at 200 entries, and `allowedMentions` is empty.
8. **`Notifier`, `SessionManager`, `PresenceUpdater`, `CatalogueSync`, `CustomStationService`**, and `ComponentIds`, whose HMAC secret is generated once and persisted in `app_meta` so that panel buttons keep working across restarts.
9. **`RadioController`**, which receives every interaction.

`start()` then does the following:

- Runs `ffmpeg -version`, `ffprobe -version` and `ffmpeg -encoders`. It logs an error if a binary is missing or `libopus` is absent.
- Subscribes to interactions, client errors, shard disconnects (recorded as incidents) and `GuildCreate` (registers commands for newly joined servers).
- On `ClientReady`, fetches the application (needed for the owner check), registers guild commands, writes the first heartbeat, runs `restoreOnBoot()`, sets the bot's status and re-renders each server's control panel, one at a time (`guildsWithPanel()`). On every `ShardReady` it sends the status again, because a new gateway session starts without it.
- Starts timers: a heartbeat every 30 s; a bot-status check every 20 s (`PresenceUpdater`, which sends only changes); hourly rate-limit sweeping and probe-history pruning by age (the per-source limit is applied as each check is written); a panel refresh every 5 min; and the catalogue sync. Each enabled pack that declares an official list gets its own schedule. It first runs about 10 min after start (if it has never run) or when it is due, then every `CATALOG_SYNC_INTERVAL_HOURS`, with up to 15 min of jitter (`scheduleCatalogueSyncs()` in `sync-schedule.ts`: one pending timer per pack, none after shutdown begins).
- Starts the optional diagnostics HTTP server on `127.0.0.1:DIAGNOSTICS_PORT`.
- Logs in.

`stop()` clears timers, closes the diagnostics server, destroys every session, closes the notifier, destroys the client, kills any remaining child processes and closes the database.

## Modules

### `streams/`: finding, fetching and judging sources

- **`url-policy.ts`** does syntactic URL validation before any network activity. It allows only `http:`/`https:` (and `http:` only when `ALLOW_INSECURE_HTTP_STREAMS=true`). It rejects:
  - URLs over 2048 characters;
  - user info (credentials) in the URL;
  - ports below 1024 other than 80 and 443, and a deny-list of common internal-service ports;
  - `localhost`, `metadata`, `.local`, `.internal`, `.lan`, `.home.arpa`, `.arpa` and similar suffixes, plus single-label host names;
  - literal private or reserved IPv4 and IPv6 addresses.

  The IPv6 check understands IPv4-mapped, IPv4-compatible, NAT64 and 6to4 forms, and anything outside `2000::/3` is blocked. `assertAddressAllowed()` checks a resolved address.
- **`safe-fetch.ts`** (`SafeHttpClient`) is the only HTTP client used for stream URLs, playlists, manifests, HLS segments, the official station list and import attachments. On every hop it validates the URL, resolves DNS itself and rejects the hop if *any* resolved address is blocked. It pins the socket to the validated address (no second lookup, so DNS rebinding cannot swap the target), re-checks the connected peer address, follows at most 5 redirects manually and re-validates each one. It caps header size (16 KiB), per-hop header time and body size, and sends a User-Agent of FFmpeg's network library: `Lavf/<version>`. At start-up, `app.ts` sets the exact version from the installed FFmpeg (`lavfUserAgent()` parses `ffmpeg -version`). The fallback is `Lavf/61.7.100`, and `STREAM_USER_AGENT` overrides it. FFmpeg is what decodes the audio, so this is accurate. Some stream hosts, including the starter pack's, refuse unknown clients but serve standard media players. The client never imitates a web browser and sends no `Referer`.
- **`playlists.ts`** contains parsers for PLS, plain M3U and HLS (master and media). For HLS it ranks audio renditions. `BANDWIDTH` values that are really sample rates (such as 44100, which the starter pack's host declares) or that are implausibly low are ignored (`plausibleBandwidth()`). The order is: audio-only variants by declared bandwidth, then variants without `CODECS`, then alternate audio renditions, then muxed audio and video variants (whose `BANDWIDTH` says nothing about audio). It caps playlists at 5000 lines and strips ID3 from packed-audio segments.
- **`input.ts`** opens a source as a byte stream:
  - `openSourceInput()` follows PLS/M3U indirection up to 2 levels deep and tries the first 5 entries. It rejects HTML, JSON and image content types.
  - For direct streams it requests ICY metadata and runs an `IcyDemuxer`, which strips the interleaved metadata blocks and surfaces `StreamTitle` as now-playing text. The text is read as UTF-8 when valid, otherwise as Windows-1252 (older SHOUTcast servers send Latin-1). `parseIcyStreamTitle()` trims separators left by an empty half ("Artist - "), and treats an empty, symbol-only or placeholder title ("Unknown", "Advert" and similar) as cleared, so the previous title is not left showing. The text may be a song, a show or anything else the station chooses, so it is labelled **On air**, never parsed into artist and title. HLS sources carry no title: ID3 tags in segments are skipped, not read.
  - For HLS it uses an `HlsReader`. The reader starts 3 segments behind the live edge and polls the playlist at half the target duration. It retries each segment once, skips a segment that still fails, and gives up after more than 3 consecutive segment failures (`HLS_SEGMENT_FAILED`) or 5 consecutive playlist failures (`HLS_PLAYLIST_FAILED`). It refuses encrypted playlists (`HLS_ENCRYPTED`) and resynchronises near the live edge if it falls out of the window, or if the media sequence numbers go backwards (for example after an upstream encoder restart). Segments are capped at 16 MiB and playlists at 512 KiB.
- **`probe.ts`** (`probeSource()`) runs one bounded technical probe. The defaults are a 22 s total budget, up to 15 s for the server's first response (playback keeps 10 s; the longer wait lets a slow server that ends with 404 be reported as `NOT_FOUND`, not a timeout), 7 s of sampling and at most 2 MiB held in memory. It runs `ffprobe` (format, stream and packet data) and then an FFmpeg decode check over the same in-memory sample, which stops at the start of the sample's last packet (from FFprobe's packet positions) so that the probe's own mid-frame cut is not counted as a decode error. The sample is discarded afterwards. Measured bitrate is payload bits divided by audio duration from the packet table, needing at least 3 s of packets; it is not network timing. The probe records which bitrate evidence it used: `measured`, `codec-metadata`, `manifest`, `advertised` or `unknown`. A direct stream that ends inside the sample window fails with `STREAM_EOF` (live radio doesn't end; a short "offline" file does), and a run-out budget is `PROBE_TIMEOUT`, never `CANCELLED`. An unreadable `icy-metaint` header makes the input re-request the stream without ICY metadata, so metadata bytes can never reach FFmpeg.
- **`identity.ts`** decides whether a source plays the station it claims to. It uses provenance, the ICY stream name (a pack's brand labels, such as a network name shared by several stations, are ignored) and optional time-aligned audio correlation. See [station-verification.md](station-verification.md).
- **`ranking.ts`** contains the eligibility gate and the correctness-gated, multi-criteria selection (`selectSource()`): the transport tier comes first (direct, then unknown, then HLS as a last resort), then evidence. It returns a selected source, a distinct fallback, a conclusion and a human-readable explanation.
- **`source-service.ts`** (`SourceService`) is the boundary. It is the only component that probes. It deduplicates in-flight probes: several callers can wait on the same probe, and if one of them cancels, only that caller stops waiting. The shared probe is neither cancelled nor recorded as a failure. It limits concurrency globally (`MAX_CONCURRENT_PROBES`) and per host (one at a time). It applies probe outcomes and identity decisions to the database, records probe history, applies the operator disable lists, and works out station availability and coverage counts. Playback calls `prepareForPlayback()`, which uses cached evidence when an eligible source exists and probes in the foreground, best candidate first, only when nothing is eligible. It starts no background work: the session calls `refreshStation()` once its stream has played steadily for 30 s, and background checks run one at a time through their own queue. A failing source's next automatic check backs off (`nextAutomaticCheck()`: about 10 min, 1 h, 6 h, 12 h, then once a day; a gone address, `NOT_FOUND`, starts at 12 h); a success resets it, and `/radio rescan` ignores it and reports progress after each source. For a play with no working source, `needsProbe(…, 'foreground')` re-checks failing sources at most every 10 min (hourly after a day without success). `isPaused()` (no success for 7 days and 5+ failures in a row) makes a source never due, in either mode, until an admin rescan succeeds. A foreground `probe()` interrupts a background check of another source on the same host (its result is discarded, not recorded); a play that joins a background check of the same source makes it uninterruptible. Playback reports health back through `recordPlaybackSuccess()` and `recordPlaybackFailure()`, and the latter trips the circuit breaker. Background checks (`refreshInBackground`) queue each source once, decide whether it is still due when its turn comes, and wait while any stream is in its first 30 s (`holdBackground`, called by the session at each start). Each check's results are written in one transaction, and the source's history is trimmed to `PROBE_HISTORY_LIMIT` there; the hourly job only deletes results older than `PROBE_HISTORY_DAYS`.

### `audio/`: one FFmpeg process per playing server

- **`ffmpeg.ts`** holds the `ProcessRegistry`, which tracks every child process by owner (`session:<guild>`, `probe:<source>`, `identity:<source>`) and kind, can kill by owner or kill everything, and counts processes spawned and reaped. `terminate()` sends SIGTERM, then SIGKILL after 2 s. `runWithInput()` runs a short-lived tool over an in-memory buffer on stdin with a timeout, a stdout cap and abort support. Those jobs (stream checks, comparisons, version checks) run at the lowest CPU priority (`lowerPriority()`); only the live encoder keeps normal priority, so on a busy or single-core host the stream is served first. `checkFfmpeg()` checks the versions and that `libopus` is present.
- **`encoder.ts`** contains `planEncoder()`, which chooses the Opus target from the quality mode, the source's own bitrate (`sourceBitrate()`: codec metadata, then measured, then manifest or advertised) and `MAX_OPUS_BITRATE_KBPS` (it reports the channel's bitrate setting but doesn't use it as a cap), and `buildEncodeArgs()`, which builds the fixed FFmpeg argument list. See [audio-quality.md](audio-quality.md).
- **`pipeline.ts`** (`AudioPipeline`) spawns the encoder. It pipes the policy-checked source bytes into stdin and passes stdout through a counting `Transform`, which feeds the stall watchdog and the observed output rate. It emits `failed` exactly once: `FFMPEG_SPAWN`, `FFMPEG_EXIT` with the last stderr lines (redacted), `STREAM_EOF`, or an input error. `stop()` is idempotent. It closes the network input and the pipes and reaps FFmpeg.

### `voice/`: sessions and the playback state machine

- **`link.ts`** (`DiscordVoiceLink`) joins the voice channel through `@discordjs/voice` with `selfDeaf: true`, `selfMute: false` and `daveEncryption: true`. It creates an `AudioResource` with `inputType: StreamType.OggOpus` and no inline volume. On disconnect it tries to reconnect up to 5 times. Close code 4014 that does not reconnect within 5 s is treated as a kick. `encryption()` reports whether DAVE was negotiated, using the voice privacy code. `timePackets()` wraps the connection's `dispatchAudio` once, so the link's `PacketTiming` (`packet-timing.ts`) counts packets sent more than 40 ms after the one before while playing, and the longest gap; a pause or a voice reconnect resets the gap. `stats()` reports them for `/radio stats`.
- **`state-machine.ts`** defines the PRD §9.1 states: `IDLE`, `JOINING`, `CONNECTED`, `BUFFERING`, `PLAYING`, `SWITCHING`, `RECOVERING`, `FAILING_OVER`, `STOPPING`, `LEAVING` and `ERROR`, with the allowed transitions. An unexpected transition is logged, not thrown.
- **`session.ts`** (`GuildSession`) handles one server. It owns at most one voice link and one pipeline. It keeps the **desired state** (persisted in `guild_playback_state`: `idle`, `playing`, `paused_empty`, `stopped`, `left` or `kicked`) separate from the runtime state. A generation counter means a newer command always supersedes an older one that is still pending. Overlapping play requests share a single voice connection attempt, so a quick double-click doesn't open two connections. A `/radio stop` that arrives while the bot is still joining is honoured: nothing plays once the join completes. `/radio join` to a different channel while a station is playing moves the bot and brings the station along. The session also contains: `useSource()` plays the current station from a source a listener chose (`manualSourceId`); later restarts of the same station use it, and it is dropped when the station changes or that source fails over.
  - the stall watchdog;
  - the live-lag resynchronisation;
  - the retry, failover and circuit-breaker logic;
  - the "no eligible source" retry (every 2 min);
  - the idle modes;
  - re-encoding when the target changes after the quality mode is changed in the `/radio config` settings menu, or a new `manual_bitrate` is set (`refreshEncoder()`).

  Timings are listed in [audio-quality.md](audio-quality.md#recovery-and-continuity).
- **`session-manager.ts`** (`SessionManager`) keeps one session per guild and enforces `MAX_ACTIVE_GUILD_STREAMS`. It wires gateway events:
  - moves: leaves if moved into a channel that isn't approved, or away from the preferred channel while *Lock to preferred channel* is on;
  - listener-count changes;
  - channel bitrate changes;
  - channel deletion;
  - guild removal. When Discord reports a real removal (`guild.available` is true), the session is destroyed and the server's data is purged with `GuildRepository.purgeGuild()` and `StationRepository.deleteGuildCustomStations()`. A server that is only unavailable because of an outage keeps its data.

  It also implements the boot policy (`restoreOnBoot()` / `bootDecision()`) and shutdown.

### `discord/`: interactions and authorisation

- **`commands/definitions.ts`** defines one `/radio` command with guild context and guild-install integration only. It uses exactly **25 top-level options**, which is Discord's maximum: 23 subcommands plus the `queue` and `source` groups. **A new command must therefore go into a subcommand group, or replace an existing one.** **`register.ts`** registers it per guild with a REST `PUT` and skips the call when a hash of the definition is unchanged for that guild.
- **`controller.ts`** (`RadioController`) handles every autocomplete, slash command, button and select menu. Each handler builds an `AuthContext` from the interaction itself (roles from the interaction member, voice channel from the voice-state cache, so no member intent is needed). It calls `authorize()` and only then acts. Long operations defer their reply. `RadioController.handle()` logs every interaction at debug level with `describeInteraction()`, the time taken and the process's CPU time meanwhile.
- **`permissions/authorize.ts`** contains the capability matrix: `read`, `control` and `admin`. See [permissions.md](permissions.md).
- **`components/custom-id.ts`** (`ComponentIds`) produces signed, guild-bound component IDs with optional expiry.
- **`context.ts`** holds the `AppContext`, the `RateLimits`, and station visibility. Pack stations are visible only while their pack is enabled, custom stations only to their own guild, and stations are sorted in pack order. It also holds voice-channel choice and the operator check.
- **`voice-access.ts`** validates a voice target: it exists, is a standard voice channel (not a stage), is on the allowlist, the bot has View Channel, Connect and Speak, and it is joinable. It also counts human listeners from voice states.
- **`ui/views.ts`, `ui/format.ts`** contain the embeds and components: browse, list, the ambiguity picker, now-playing (with "Up next"), quality, sources/inspect, control rows (with **Skip (n queued)** when stations are queued, and always on the panel) and the configuration pages. The controller handles the queue in `#queueGroup` and `#cmdSkip`, and builds the `/radio stats` panel in `#statsView`. The now-playing, quality, sources/inspect, browse, list and help views carry the unofficial disclaimer.
- **`notifier.ts`** sends recovery and error notices to the configured notification channel. It sends the first notice of a given kind, then counts repeats within 5 minutes and sends one summary.
- **`presence.ts`** (`PresenceUpdater`) sets the bot's own "Listening to" status from the live sessions, according to `PRESENCE_MODE`. There is one status for the whole bot, so `presenceText()` names a station only when every playing server plays that one (otherwise "radio in N servers"), never names a server's custom station, and flattens the stream title to one line of at most 128 characters. It sends only changes.
- **`voice-status.ts`** (`VoiceStatusUpdater`) sets the status of each server's bot voice channel to "📻 Station · title" on the same 20 s timer, sending only changes. It needs the optional Set Voice Channel Status permission (checked per channel) and the server's `voiceChannelStatus` setting; discord.js has no helper, so it calls `PUT /channels/{id}/voice-status` through the client's REST manager. Because only that server sees the status, a custom station can be named. When a session leaves, it stops the audio at once but keeps the voice connection open until the `onLeaving` hook has cleared the status (at most 1.5 s), because Discord refuses the change once the bot has left; a play during that wait takes over the open connection. Shutdown clears every status first. A failed request is logged once and not retried until the text changes.

### `catalogue/`

- **`packs.ts`** loads and cross-validates station packs: `pack.json`, `stations.json` and an optional `sources.json`. It checks:
  - the schema, and that pack IDs are unique (`custom` is reserved);
  - that slugs are unique, and that no two stations of a pack share a name or alias;
  - declared categories, and source-to-station references;
  - that no URL is mapped to two stations;
  - that source IDs are unique across all packs.

  `PackRegistry` exposes the enabled packs, pack order, categories and per-pack brand labels. `seedPacks()` writes the packs to the database. The authoring guide is [catalog/README.md](../catalog/README.md).
- **`sync.ts`** (`CatalogueSync`) reconciles each pack that declares `sync` in its `pack.json` with that pack's official list. **`sync-adapters.ts`** holds the list parsers (`webradio-apidata` for a webradio list embedded in a station website's page, and `json-name-list`). Adapters read station names and stable IDs only. See [station-verification.md](station-verification.md#catalogue-sync).
- **`custom-provider.ts`** (`CustomStationService`) handles guild-scoped custom stations. It cleans the text fields, validates the URL with `UrlPolicy`, probes the source, and rolls back if the probe fails. It enforces the per-guild cap.
- **`search.ts`** does ranked fuzzy search. `resolveStation()` returns a match only for an exact identity (ID, slug, name or alias) or a single clearly dominant hit. Otherwise the controller shows an "ambiguous" picker. Each station's normalised names are worked out once and kept per row.

### `observability/netstats.ts` and live statistics

`/radio stats` is built by `RadioController.#statsView()` from three sources:

- `GuildSession.liveStats()`: input and output `RateMeter`s over 10 s and 60 s, HLS segment counters and last segment host, and the connected stream IP and port.
- `DiscordVoiceLink.stats()`: voice endpoint and WebSocket ping (the voice library no longer measures a UDP round trip), sampled every 5 s into a `LatencySeries` whose jitter is the mean absolute difference between neighbouring samples, and packets sent, with the late-packet count and longest gap from `PacketTiming`.
- `netstats.ts` helpers:
  - `tcpPing()` makes 5 TCP handshakes to the exact stream IP, which is re-checked against the URL policy first. It sends no HTTP request.
  - `regionHint()` turns host-name conventions (`n01-eu2.example.net` → Europe, `c-lhr05` → London) into a best-effort label, shown as "from host name".

### `persistence/`

`Db` wraps `node:sqlite` (`DatabaseSync`). It provides nested transactions (savepoints) and versioned SQL migrations from `migrations/`. Checksums are verified: an edited applied migration aborts start-up, and so does a database that is newer than the build. `backup()` uses `VACUUM INTO` to write a consistent copy into `data/backups/` and rotates each kind separately: the newest 5 pre-migration backups (`pre-vN`) and the newest 10 manual ones (`backup.js`). The rotation class is the label without its trailing digits. The tables are listed in [rights-and-disclaimer.md](rights-and-disclaimer.md#privacy-policy-for-a-self-hosted-instance).

### `import-export/`

`config-io.ts` defines the export schema `radio-bot/guild-config` version 1: settings, pack-station favourites, prefer/pin source preferences and custom stations. Custom URLs that have a query string or credentials are redacted and flagged. `parseImport()` validates with Zod. `previewImport()` reports what would change and warns about channels and roles that don't exist in the target server. Nothing changes until an admin clicks **Apply import**. Redacted custom stations are skipped, and the rest go through the normal add path, including the probe.

### `observability/`

- **`logger.ts`**: Pino, writing JSON lines to stdout.
- **`metrics.ts`**: in-process counters and a ring buffer of 200 incidents. Repeats of the same code are coalesced within 5 minutes, and each incident is tagged with a fault domain: `upstream`, `discord`, `bot`, `operator` or `user`.
- **`health.ts`**: the heartbeat file (`health.json` next to the database), read by `scripts/healthcheck.ts`, and the optional local diagnostics server.
- **`event-loop.ts`** (`EventLoopMonitor`): Node's event-loop delay, sampled every 10 ms and summarised per minute (typical, 99th percentile, worst). Voice packets are sent every 20 ms from that loop, so `/radio stats` flags a delay of 20 ms or more, a minute with 50 ms or more is logged as a warning (other minutes at debug level), and the diagnostics endpoint includes the figures.

## Data flow: `/radio play`

1. `RadioController` resolves the station. It accepts an ID or an exact name; an ambiguous query shows a picker.
2. It chooses the voice channel in this order: the locked preferred channel, an explicit `channel` option, the channel the bot is already in, the requester's channel, the preferred channel.
3. It authorises the `control` capability against that target, checks availability (it refuses to play a station with no known source and does not substitute another), applies the per-user and per-guild play rate limits, and defers the reply.
4. `SessionManager.play()` checks `MAX_ACTIVE_GUILD_STREAMS` and calls `GuildSession.play()`, which persists desired state `playing`.
5. The session makes sure a voice link exists. `resolveVoiceTarget()` re-checks the allowlist and the bot's permissions, then connects.
6. `SourceService.prepareForPlayback()` returns a `SelectionResult`, probing in the foreground only if no source is eligible.
7. `planEncoder()` takes the server's quality mode, the selected source's bitrate and the installation's `MAX_OPUS_BITRATE_KBPS`, and records the channel's bitrate setting for reporting. `openSourceInput()` opens the selected source through `SafeHttpClient`, which follows redirects and any playlist or HLS manifest. `AudioPipeline` starts FFmpeg and pipes the bytes in.
8. `DiscordVoiceLink.play()` hands the Ogg Opus output to the audio player.
9. When the first Opus bytes arrive (within 20 s), the state becomes `PLAYING` and the reply shows the now-playing embed and the "Why this source" explanation. After 30 s of stable playback, the source's health score goes up.

## The source-validation boundary

The PRD (§12.2) requires that command handlers never construct FFmpeg commands or fetch stream URLs themselves. In the implementation:

- **Only `SafeHttpClient` talks to stream hosts.** Every URL, redirect and connection goes through `UrlPolicy`, and DNS is resolved and pinned by the client. Probes (`probe.ts`), playback (`input.ts` via the session manager), identity comparisons, the catalogue sync and import attachments all use it. The import attachment host is also limited to `cdn.discordapp.com` and `media.discordapp.net`.
- **Only `SourceService` probes.** It decides when a probe is needed and applies the results. Command handlers ask it for a selection, an availability state or a rescan.
- **The command layer never builds FFmpeg arguments.** The arguments are fixed lists in `encoder.ts`, `probe.ts` and `identity.ts`. User input never reaches an FFmpeg command line. The only variable values are the bitrate (an integer computed by the planner), the channel count and the sample rate.

### Why FFmpeg only ever reads stdin

Every FFmpeg and FFprobe invocation uses `-i pipe:0` with `-protocol_whitelist pipe`. It receives bytes that the bot has already fetched under the URL policy, and it is not allowed to open anything else. The reasons:

- **No SSRF through FFmpeg.** FFmpeg has its own HTTP, HLS, `concat:`, `file:`, `subfile:`, `data:` and other protocol handlers. If FFmpeg were given a URL, or a playlist or HLS manifest that points elsewhere, it would fetch those targets with its own resolver. That would bypass the private-address checks, the redirect re-validation and the DNS pinning. With the pipe-only whitelist, a hostile manifest cannot make FFmpeg open `http://169.254.169.254/` or `file:///etc/passwd`.
- **One place to enforce limits.** Timeouts, size caps, redirect limits and segment retries all live in `SafeHttpClient`, `input.ts` and `HlsReader`, where they are tested. The bot also resolves HLS itself, which lets it choose the audio rendition properly instead of following whatever FFmpeg's demuxer would pick.
- **Clean recovery.** Reconnects and failover are decided by the session, not by FFmpeg's internal reconnect options, so the state machine always knows what is playing.

## Persistence and state

- **Desired state vs runtime state.** Runtime state (the `PlaybackState`, the pipeline and the link) lives in memory only. Desired state lives in `guild_playback_state` and survives restarts. An explicit stop, leave or kick is persisted and suppresses autostart.
- **Boot policy** (`bootDecision()`):
  - If desired state was `playing` or `paused_empty` and the server enabled *Resume after restart*, the bot resumes in the saved channel.
  - Otherwise, if *Autostart* is on, a default station and preferred channel are set, and no explicit stop, leave or kick is on record, it starts the default.
  - Otherwise it stays idle. If playback was desired but resume is off, the bot records `RESUME_DISABLED`, which `/radio status` explains.
  - Resume and autostart skip retired stations and stations the server can no longer see (for example a pack switched off with `DISABLED_PACKS`), using the same visibility rule as the commands.
  - Leaving an empty channel after `/radio stop` keeps the desired state *stopped*, so autostart stays suppressed.
- **Station facts** (codec, bitrates, identity evidence, health, cooldown) are shared by all guilds. **Preferences** (pin and prefer), favourites and settings are per guild.

## Concurrency and resource bounds

- At most one voice connection and one encoder FFmpeg process per guild, and at most `MAX_ACTIVE_GUILD_STREAMS` guilds streaming. The limit is enforced on every path that starts a stream, including resume from pause, retries and voice reconnects.
- At most `MAX_CONCURRENT_PROBES` probes at once, and one per host. Each probe runs one `ffprobe` and one `ffmpeg` over a sample of at most 2 MiB. An identity comparison decodes two samples of 40 s each, at most 4 MiB each, within 90 s. HLS is opened 1 segment from the live edge for comparisons.
- The HLS reader's internal buffer is bounded (512 KiB high-water mark plus one segment of at most 16 MiB). Back-pressure stops fetching when FFmpeg is not reading.
- The rate-limiter maps and incident ring are bounded or swept. Browse and import preview state expires after 15 and 10 minutes respectively.
