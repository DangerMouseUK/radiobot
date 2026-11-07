# AGENTS.md

Instructions for AI coding agents (and humans) working in this repository. Read this file in full before changing anything. [CONTRIBUTING.md](CONTRIBUTING.md) is the human-facing version of the same rules. If the two disagree, fix whichever one is wrong in the same change.

## What this is

**Radio Bot** is a self-hosted Discord bot that plays live internet radio in voice channels. It is TypeScript on Node.js 24, using discord.js 14, `@discordjs/voice` with DAVE, FFmpeg/`libopus` and SQLite (`node:sqlite`). It runs as a single process with one SQLite file and outbound network access only. The repository is **public**.

- The product name is **Radio Bot** (npm package `radio-bot`, GitHub repository `DangerMouseUK/radiobot`). Never name it after a broadcaster or a station pack, or in any way that implies it belongs to a broadcaster.
- It is **unofficial**: it is not affiliated with or endorsed by any broadcaster. Station packs name stations only so that people can find them; the names, audio and artwork belong to their owners. Keep that generic disclaimer where it is needed, and never add broadcaster logos or artwork.
- Outside a pack's own folder (which lives in the pack library, `DangerMouseUK/radiobot-packs`, not in this repository), never name a pack's broadcaster or its stations, and never add a disclaimer or warning naming them; use generic examples (`mypack:my-station`). The generic "not affiliated with any broadcaster" disclaimer stays. The one exception is the README's Station packs section, which says in a single sentence that the bot ships with no packs, that they come from the official pack library, and that any of them can be installed, updated or removed; keep that sentence generic and add no more.
- Nothing personal or site-specific belongs in the repository: no home-lab, NAS or hosting-provider set-ups, personal names, e-mail addresses, IP addresses, Discord server, channel or user IDs, or tokens. Supported deployments are generic: Docker, bare-metal Linux with systemd, and container platforms that run an always-on worker.

## Commands

Use **pnpm** (the version is pinned in `packageManager`; run `corepack enable`) and Node **≥ 24.17**.

```sh
pnpm install --frozen-lockfile
pnpm typecheck                     # tsc --noEmit, strict
pnpm lint                          # biome check . (CI fails on any finding)
pnpm format                        # biome format --write .
pnpm test                          # vitest run: unit + integration
pnpm test:unit | pnpm test:integration
pnpm test:coverage                 # vitest run --coverage: how much of src/ and scripts/ the tests run, by file
pnpm test:lifecycle                # Linux or macOS: install.sh + radio-bot.sh against a fake docker
pnpm vitest run tests/unit/session.test.ts      # a single file
pnpm build                         # tsc -p tsconfig.build.json → dist/
pnpm smoke                         # after a build: migrations, the template pack, the worker threads, an encode, the healthcheck, from dist/
node scripts/validate-catalogue.ts # validate every station pack (and catalog/packs/_template), straight from source
node scripts/validate-catalogue.ts --pack <dir> --strict   # one pack, with the extra rules for library packs
node scripts/pack-author.ts new|export|generate|build-library|diff-check …
                                   # pack and library authoring tools (see catalog/README.md)
docker build --target test -t radio-bot:test . && docker run --rm --network none radio-bot:test
                                   # integration tests on the image's own Node and FFmpeg
```

**Definition of done** for any change: `pnpm typecheck`, `pnpm lint`, `node scripts/validate-catalogue.ts` and `pnpm test` all pass, and `pnpm build` and then `pnpm smoke` succeed. If you touch `install.sh`, `scripts/radio-bot.sh` or `tests/lifecycle/`, `shellcheck -x` on them and `pnpm test:lifecycle` must pass too. If you touch the `Dockerfile`, the test stage above must pass.

CI (`.github/workflows/ci.yml`) runs all of these, and also:

- the typecheck and tests on the oldest Node that `engines` allows (24.17.0);
- `tests/integration/main-thread-budget.test.ts`, part of `pnpm test` (Vitest runs it on its own, after every other file): a stream plays through the real pipeline while `/radio stats`, browse, ranking, a 2000-station sync and a live install of a 2000-station pack run, and the event-loop delay and the longest stretch of synchronous work must stay under 50 ms;
- the lifecycle test on macOS with its bash 3.2 (`/bin/bash -n` on every script first);
- an offline check of the relative links and anchors in README.md, CONTRIBUTING.md, AGENTS.md, SECURITY.md, `docs/` and `catalog/README.md` (lychee);
- the Docker image build, then in the image: FFmpeg has `libopus`, a missing token exits with code 78, `dist/scripts/smoke.js` passes with no network, and the integration tests pass in the `test` stage (same base, no network).

`security.yml` adds `pnpm audit`, gitleaks, CodeQL and a Trivy scan of the image that fails on high or critical vulnerabilities with a fix available, on every push and pull request and weekly; releases repeat the scan. Dependabot (`.github/dependabot.yml`) proposes npm, GitHub Actions and Node base-image updates weekly (Node 24 only). Pin third-party actions that run with secrets or scan images by commit SHA, as the Trivy action is.

The tests need FFmpeg and FFprobe. They use `ffmpeg-static` / `ffprobe-static` from the dev dependencies, or a system FFmpeg via `FFMPEG_PATH` / `FFPROBE_PATH`. **On Linux, use the system FFmpeg** (`FFMPEG_PATH=/usr/bin/ffmpeg FFPROBE_PATH=/usr/bin/ffprobe pnpm test`): `ffmpeg-static`'s Linux build crashes while decoding the HLS fixtures, which is why CI installs the distro FFmpeg, as the Docker image does. The tests never touch the real network, real radio stations or Discord.

## TypeScript and style

- **Node runs `.ts` directly (type stripping), and tsc compiles to `dist/`.** `tsconfig.json` sets `erasableSyntaxOnly`, `verbatimModuleSyntax`, `allowImportingTsExtensions` and `rewriteRelativeImportExtensions`. This means:
  - relative imports **must** use the `.ts` extension, for example `import { x } from './foo.ts'`;
  - type-only imports use `import type`;
  - **no** `enum`, `namespace`, parameter properties (`constructor(private x)`) or other non-erasable syntax. Use `as const` objects or union types instead.
- `strict` and `noUncheckedIndexedAccess` are on. Indexed reads are `T | undefined`; the codebase uses `!` deliberately where the index is known to be valid (Biome's `noNonNullAssertion` is off). `noExplicitAny` is an error.
- ESM only (`"type": "module"`). Use the `node:` prefix for built-ins (enforced).
- Biome formatting: 2 spaces, single quotes, semicolons, trailing commas, line width 110. Biome checks everything under `src/`, `scripts/`, `tests/` and `catalog/` (including the Markdown there) plus root JSON and TS files, so run `pnpm format` after editing them.
- Private class state uses `#private` fields. Validation uses Zod 4. Logging uses Pino through `src/observability/logger.ts`, which redacts secrets; never `console.log` in `src/`.
- Match the surrounding code: comment density, naming, and British English in user-facing text and docs ("favourites", "licence", "catalogue").

## Layout

```text
src/
  index.ts              entry: config → logger → createApp() → start; SIGTERM/SIGINT teardown;
                        SIGHUP reloads the installed packs
  app.ts                wiring: DB, repositories, packs, URL policy, HTTP client, sessions, Discord client, timers
  config/env.ts         every environment variable (Zod); invalid config → exit code 78
  catalogue/            station packs (packs.ts: schema, loading, PackRegistry, seeding),
                        pack libraries (pack-library.ts: index and bundle formats, OFFICIAL_LIBRARY_URL),
                        the installed-packs folder (pack-store.ts), installs/updates/removals, restore
                        and the daily check (pack-manager.ts, checks on pack-worker.ts),
                        official-list sync (sync.ts, sync-adapters.ts, sync-schedule.ts),
                        per-server custom stations (custom-provider.ts), search, shared types
  streams/              THE SOURCE-VALIDATION BOUNDARY: url-policy, safe-fetch (SSRF-safe client),
                        playlists (PLS/M3U/HLS), input (ICY demux, HLS reader), probe (ffprobe + decode),
                        identity (metadata + audio correlation), ranking (eligibility + selection),
                        source-service (orchestrates all of it), full-check (the owner's
                        "Check all sources again", through the background queue)
  audio/                ffmpeg.ts (process registry, version checks), encoder.ts (bitrate plan, args),
                        pipeline.ts (stdin → FFmpeg → Ogg Opus, rate meters)
  voice/                link.ts (@discordjs/voice wrapper + stats), live-queue.ts (the live edge: Ogg demux,
                        cushion, catch-up, drift), packet-timing.ts (late-packet count), state-machine.ts,
                        session.ts (per-guild state machine, watchdog, recovery, failover),
                        session-manager.ts (all guilds, boot/resume)
  discord/              controller.ts (every interaction), commands/definitions.ts (/radio),
                        permissions/authorize.ts, components/custom-id.ts (signed IDs),
                        ui/ (views, format, packs-view, settings-view: the /radio config card),
                        register.ts, notifier.ts, presence.ts (bot status),
                        voice-status.ts (voice channel status),
                        voice-access.ts, context.ts
  persistence/          db.ts (node:sqlite, migrations, backups), checkpoint.ts + checkpoint-worker.ts
                        (WAL checkpoints on a worker thread), repositories/ (stations, guilds; MetaRepository lives in guilds.ts)
  observability/        logger, health (health.json heartbeat, diagnostics server), metrics, netstats,
                        event-loop (event-loop delay for /radio stats)
  import-export/        /radio export and import
  shared/               errors (reason codes), backoff, rate limits, redaction, text, async helpers, paths,
                        workers (one-off worker threads), version (the bot's version, for minBotVersion)
scripts/                validate-catalogue, register-commands, healthcheck, backup, smoke (CLI entry points);
                        packs (installed packs: list, browse, info, add, update, remove);
                        pack-author (new, export, generate, build-library, diff-check; strictProblems(), strictWarnings());
                        radio-bot.sh, the bash manager behind the `radio-bot` command (install, update,
                        backup, restore, packs, uninstall …) for Docker Compose installs
install.sh              one-line bootstrap: clones into ~/radio-bot, then runs `radio-bot.sh install`
migrations/             NNNN_name.sql, applied in order, checksummed
catalog/packs/_template/  the only pack folder here: a complete example pack, never loaded (the `_` prefix);
                        real packs live in the pack library (DangerMouseUK/radiobot-packs)
tests/unit/             fast, pure tests;  tests/integration/  local fixture radio server + synthetic audio
tests/helpers.ts        memoryDb(), makeSource(), silentLogger()
tests/fixtures/packs/   demo/: a made-up pack the tests use (no real stations)
tests/lifecycle/        run.sh + fake-docker: end-to-end test of the installer and manager
vitest.config.ts        test settings, including the coverage report for `pnpm test:coverage`
.github/workflows/      ci.yml, release.yml, security.yml (dependency audit, gitleaks, CodeQL, image scan);
                        .github/dependabot.yml
docs/                   install.md (beginner guide, start here), install-docker/-linux/-container-platforms,
                        architecture, audio-quality, station-verification, permissions, rights-and-disclaimer,
                        PRD, troubleshooting; assets/: the icon and banner (SVG sources, PNGs for the
                        README and Discord's developer portal)
deploy/systemd/         hardened unit file for bare-metal installs
```

## The stream comes first

This rule outranks every other rule in this file, and every feature. The live stream must play at the best quality the station offers, from the station through to Discord, with no audible hiccup, on a host with **1 vCPU and 1 GB of memory**. Everything else the bot does is secondary and must be written so that it cannot disturb the stream. Code that runs cleanly on one core runs cleanly on any machine; the reverse isn't true.

**Why it breaks easily.** `@discordjs/voice` sends one Opus packet every 20 ms from a timer on Node's main thread. Every command, button, autocomplete, database query (`node:sqlite` is synchronous), timer and log call runs on that same thread. While the thread is busy, packets wait, then leave in a burst. Discord's client then stretches the audio and speeds it up again, and a gap of about 55 ms or more is heard as a small cut. Measured on a one-core host, a single `/radio stats` delayed a packet by 47 ms.

These are coding rules. A change that breaks one is a bug, even if the tests pass:

1. **Budget the main thread.** Any stretch of synchronous work (a handler, a timer, an event callback, up to its next `await`) should take under 10 ms on a 1-vCPU host. 20 ms or more is a bug. Work that grows with the catalogue (stations × sources), the number of servers or stored history must be batched, cached, paged or capped. One query that returns what's needed beats a query per station, and never run one per keystroke when the answer can be cached.
2. **Heavy work leaves the main thread.** Decoding, probing, comparing and anything else CPU-bound runs in a child process through `ProcessRegistry`, at the lowest priority (`lowerPriority()`). Only the live encoder runs at normal priority. Otherwise, split the work into small slices that yield to the event loop between them. While streams play, the main thread does no large synchronous file I/O, compression, hashing or JSON work.
3. **Background work yields to playback.**
   - Background jobs run one at a time.
   - They don't start during a stream's first 30 s.
   - They back off when they fail.
   - Anything a listener is waiting for interrupts them.
   - When in doubt, do less and do it later.
4. **The audio path stays minimal.** Code that runs for every packet (every 20 ms) is constant-time: no logging, I/O, `await` or per-packet allocation of its own. Add no buffering or latency beyond what the pipeline needs (see "Live means live"). Encode once, add no processing, and follow the source's bitrate (invariants 1–3).
5. **Memory is bounded.** Caches, histories and queues have a limit. The bot and one FFmpeg encoder must fit comfortably in 1 GB alongside the operating system.
6. **Measure, don't guess.** A change that adds work on the main thread says in its pull request what that work costs and how this was measured, for example a timing against a 2000-station pack. On a running bot, use the event-loop delay and the late-packet count in `/radio stats`. Profile before optimising: in 1.0.4 the cost of `/radio stats` turned out to be statement compilation, not the code that looked slow.
7. **Logging costs nothing when it's off.** Never log per packet. When building a debug log entry costs anything, guard it with `logger.isLevelEnabled('debug')`.

## Live means live

Every station is live, so the delay from the station to the listener must be as small as possible, and it must never grow during a session. This rule ranks second only to "The stream comes first": a cushion that prevents audible cuts is part of playing the stream well, so never shrink a cushion below what the network needs just to make the delay look smaller.

1. **Every buffer earns its place, sized in time.** Each buffer between the station and Discord has a stated reason and a size in milliseconds, not bytes. Today the only deliberate one is the cushion of the live queue (`src/voice/live-queue.ts`): the chunk plus a safety margin. The chunk is how much audio arrives in one go: nothing for a direct stream, a whole segment for HLS (the playlist's target duration, counted at up to 12 s). The margin is 1 s, as VLC's network cache; it grows by 0.5 s after each network gap, up to 3 s, and eases back by 0.5 s after 30 calm minutes, taking effect at the next catch-up (for example the next voice resume). So a direct stream keeps 1 s to 3 s, and HLS the segment length plus 1 s to 3 s (at most 15 s). After a gap, playback goes on once the margin is back in hand (for HLS, with the next segment), as at the start (VLC rebuffers the same way): listeners are already hearing the gap, and playing on from an empty queue would make every later hiccup audible. The delay comes back to the cushion, never more. Before the queue, nothing holds audio back for more than a packet or so: FFmpeg writes one 20 ms packet per Ogg page (`-page_duration 20000`; its Ogg muxer keeps a finished page until the next one begins, so longer pages add delay), and the queue takes each packet as soon as it is written. After the queue, `@discordjs/voice` prepares (and encrypts) each packet one 20 ms frame before it sends it.
2. **No backlog builds up unseen.** Audio that waits, waits in the live queue, where it is measured: its depth, the cushion, what was dropped to stay live, the network gaps and the clock drift are shown in `/radio stats`, and every drop is logged (`started behind live by the cushion; dropped the connect burst`, then `caught up with live`). A new buffer, pipe or queue on the audio path must either be measured there too or be kept to a few packets.
3. **Correct it in the least audible way.** The burst a station's server sends on connect is dropped before anything is heard, once it has landed (audio no longer arriving faster than real time), so a direct stream starts about 1 s behind live, plus Discord's own buffering (about 0.1 s). A second look shortly after the start (1 s for a direct stream, a segment plus 1 s for HLS, whose start fetches three segments one after another) is a backstop for any late part of that burst. A backlog past the cushion is dropped where the listener has just heard a break anyway: after a network gap and after a voice resume. Only when the queue's floor (its lowest point over a few seconds) stays 3 s above the margin with no such break (a station whose clock runs fast) is the backlog dropped on its own.
4. **A break is never paid for again with lasting delay.** When something has already interrupted the sound (a network gap, a voice resume), don't hold the audio back to avoid skipping it: that leaves the stream behind live for the rest of the session. When Discord's voice connection resumes, the audio that can't be sent is dropped and playback stays at the live edge.
5. **The audio is never altered to stay live.** No resampling, time-stretching, speeding up or slowing down. Clock drift between the station and the host is measured (in ppm) and reported, not corrected.

## Invariants: do not break these

These are product rules, not style preferences. A change that breaks one is wrong even if the tests pass.

**Audio**

1. **Encode once.** FFmpeg decodes the source and encodes **once** with `libopus` into Ogg Opus. The live queue only demuxes it, and `@discordjs/voice` receives the Opus packets as `StreamType.Opus` and sends them as they are. Never add a second lossy encode, and never add default EQ, AGC, loudness normalisation, compression or limiting.
2. **Follow the source, not the channel.** In `maximum` mode the Opus target is the source's own bitrate (measured, then codec metadata, then manifest or advertised), rounded up to a whole kbps, capped at `MAX_OPUS_BITRATE_KBPS` (default 510, range 32–510); the cap is the target only when the source's bitrate is unknown. Below the **re-encode floor** of 128 kbps (96 kbps for a mono source) the target is the floor instead, still capped at `MAX_OPUS_BITRATE_KBPS`: a re-encode is a second lossy generation, and below about 134 kbps libopus codes the stereo above a bitrate-dependent frequency as one signal (above 3.2 kHz at 48 kbps, 5.6 kHz at 64, 12 kHz at 96), throwing away stereo and treble a low-rate source (and HE-AAC's rebuilt treble and stereo) still has. Never encode below the source's rate or the floor, never pad a source above the floor beyond its own rate (never under-encoding comes first), and never cap it at the voice channel's bitrate setting, which is reported only. A target above the source's rate says why in the plan's notes and never claims added detail. The measured figure comes first because AAC codec metadata is an estimate that can be well off in either direction. `manual` is the admin's value capped at `MAX_OPUS_BITRATE_KBPS` (like `maximum` until one is set), and `balanced` is 128 kbps or the source's bitrate if lower. See `planEncoder()` in `src/audio/encoder.ts`.
3. **FFmpeg reads stdin only** (`-protocol_whitelist pipe`). Never pass a URL, a user-supplied string or a new protocol into FFmpeg or FFprobe arguments. Bytes reach FFmpeg only from `SafeHttpClient`.

**Network**

4. **All stream, playlist, segment, sync and import traffic goes through `SafeHttpClient`** (`src/streams/safe-fetch.ts`). It validates URLs with `UrlPolicy`, pins DNS, blocks private and reserved ranges (including IPv4-mapped, NAT64 and 6to4 forms), and re-validates every redirect. Never add a bare `fetch()`, `http.get()` or `net.connect()` to a user- or pack-supplied host. The one exception is `tcpPing()` in `src/observability/netstats.ts`, which is only ever called with an address already checked with `policy.assertAddressAllowed()`.
5. **User-Agent.** Stream requests identify as FFmpeg's network library, `Lavf/<version>` from the installed FFmpeg (fallback `Lavf/61.7.100`), overridable with `STREAM_USER_AGENT`. Do **not** add a browser User-Agent, `Referer`, cookies or anything else designed to get past a host's access control. A host that refuses with HTTP 401, 403 or 451 is reported as `ACCESS_DENIED`, and that is the correct outcome.
6. **No bypassing:** no DRM, encrypted HLS, authentication, geo-blocking, signed or tokenised URLs, or private or mobile APIs.

**Correctness**

7. **The correct station beats the best bitrate.** A source is eligible only if its identity is verified, it is healthy and it is not in cooldown (`src/streams/ranking.ts`). If a station has no eligible source, the bot says so and plays nothing in its place. Don't relax the identity or eligibility gates without an issue first.
8. **Transport tier comes first:** direct streams (tier 0), then unknown (1), then HLS (2) as a last resort, whatever their bitrate. Within a tier, rank by evidence. Never compare bitrates across codecs, with one deliberately narrow exception: AAC-LC beats HE-AAC (v1 or v2) when both rates are measured and AAC-LC is at least 96 kbps and at least twice the HE-AAC rate (`aacLcOverHeAac()` in `src/streams/ranking.ts`). Never widen it without an issue first.
9. **No claim without evidence.** User-facing text distinguishes `measured`, `codec-metadata`, `manifest`, `advertised` and `unknown` bitrates, and says "not conclusively determined" when that's the truth. Never claim "HD" or "lossless".
10. **No recording.** Probe samples are held in memory and then discarded. The bot is self-deafened and never receives voice audio.

**Discord**

11. **Minimal access.** The intents are `Guilds` and `GuildVoiceStates` only. The bot permission integer is `281474979908608`: View Channels, Send Messages, Embed Links, Attach Files, Connect and Speak (`3197952`), plus the **optional** Set Voice Channel Status. The bot must keep working without the optional one: check it per channel and skip quietly. Adding an intent or permission needs an issue first.
12. **Authorise on the server side, every time.** Every command, button, select menu and form (modal) calls `authorize()` (`src/discord/permissions/authorize.ts`) with `read`, `control` or `admin`. Component and form custom IDs must be built with `ComponentIds` (signed and bound to the server). A new action goes into `COMPONENT_ACTIONS` in `src/discord/components/custom-id.ts`, at most 7 characters long, and its argument is at most 65 characters (the longest station ID), so every ID fits Discord's 100-character limit. Never raise either limit.
13. **Admin means the server owner or Discord's Administrator permission. Nothing else.** There are no admin roles, and Manage Server doesn't count. DJ roles grant `control`. Installation-wide decisions (identity reviews of pack sources) also need the user to be an operator: in `OPERATOR_USER_IDS`, or the application owner or a member of its team. The admin check still applies first.
14. **`/radio` is full.** `src/discord/commands/definitions.ts` has exactly **25** top-level options, which is Discord's maximum. A new command must go into a subcommand group (as `queue`, `source` and `packs` do) or replace an existing one. Option names and descriptions must stay within Discord's length limits.
15. Stats and diagnostics are **ephemeral and admin-only** (`/radio stats`, with Refresh and Close). Never post them publicly.

**Data**

16. **Station and pack IDs are permanent** (`<pack-id>:<slug>`). Favourites, queues and preferences point to them. A rename changes `displayName` and adds the old name as an alias.
17. **Migrations.** Once a migration has been released, never edit it: its SHA-256 checksum is verified at start-up. Add `migrations/NNNN_description.sql` instead, keep it transactional, and make sure it loses no settings. When adding guild-scoped tables, include them in `GuildRepository.purgeGuild()` and in export/import where they hold settings.
18. **No telemetry.** `TELEMETRY_ENABLED=true` is refused at start-up. Keep it that way.

## Station packs

- A pack is a folder `<id>/` with `pack.json`, `stations.json` and `sources.json`, validated by the Zod schemas in `src/catalogue/packs.ts`. The format reference is [catalog/README.md](catalog/README.md).
- **Packs are authored in the pack library** (`DangerMouseUK/radiobot-packs`), following its playbook, not in this repository. This repository keeps only `catalog/packs/_template/`; don't add other pack folders here.
- The code must stay **pack-agnostic**. Never special-case a pack ID in `src/`. Pack-specific behaviour lives in pack data (`brandLabels`, `categories`, `sync`) or in a named, generic sync adapter in `src/catalogue/sync-adapters.ts` (`webradio-apidata`, `json-name-list`).
- Source provenance must be `official-player` or `curated`, with `provenanceDetail` and a matching entry in the pack's `SOURCE_PROVENANCE.md`. Never commit automatically discovered or signed URLs. Disable broken sources with `enabled: false` and a `disabledReason`; don't delete them.
- `custom` is a reserved provider ID (per-server custom stations).
- Validate with `node scripts/validate-catalogue.ts` (`--pack <dir> --strict` for a library pack). Live probing (`--probe`, `--compare`) hits real stream hosts, so run it only when you're deliberately gathering evidence, never in tests. Tests use the made-up pack in `tests/fixtures/packs/demo/`.

## Tests

- Vitest. `tests/unit/` holds pure, fast tests; `tests/integration/` runs against `tests/integration/fixture-server.ts`, a local fixture radio server that serves synthetic audio generated with FFmpeg `lavfi` into `tests/fixtures/generated/` (git-ignored).
- **Never use copyrighted audio**, not even a short clip of a real station. Never hit real stations, Discord or the public internet in tests.
- The `UrlPolicy` `testAllowedAddresses` option lets tests reach loopback fixtures. It must **never** be wired to configuration.
- Use `memoryDb()` from `tests/helpers.ts` for an in-memory, migrated database, and `makeSource()` for source fixtures. Match the existing style: import from `'../../src/…ts'`, with `describe`/`it` and plain `expect`.
- New behaviour needs a test. A bug fix needs a test that failed before the fix. Avoid timing-sensitive assertions; inject clocks (for example `RateMeter`'s `now`) instead of sleeping.
- CI runs `pnpm test:coverage`, which fails if coverage falls below the thresholds in `vitest.config.ts`. Add tests rather than lowering them.
- `tests/integration/main-thread-budget.test.ts` guards rule 1 of "The stream comes first". If it fails, find the slow step (the test prints each step's longest stretch without an event-loop turn) and make it cheaper; don't raise the bound. A new heavy path that a listener or a timer can trigger belongs in that test. It runs in a Vitest project of its own (`vitest.config.ts`) that starts after every other file has finished, so other test processes aren't measured as delay; keep it that way.

## Documentation must match the code

The docs describe what the code **actually does**. When you change behaviour, update the affected docs in the same change:

| If you change… | …update |
|---|---|
| an environment variable | `src/config/env.ts`, `.env.example`, the README configuration table, and install docs if relevant |
| a command, option or button | `definitions.ts`, the help text (`#cmdHelp` in `src/discord/controller.ts`), README Commands, `docs/permissions.md` |
| audio, encoder or live-queue behaviour | `docs/audio-quality.md`, README |
| ranking, identity or probing | `docs/station-verification.md`, `docs/architecture.md` |
| the pack schema, adapters, the library format or the pack tools | `catalog/README.md`, `catalog/packs/_template/` |
| reason codes (`src/shared/errors.ts`) | `docs/troubleshooting.md` |
| `install.sh`, `scripts/radio-bot.sh`, `compose.yaml` or the Discord setup steps | `docs/install.md` (written for beginners: plain words, every click), `docs/install-docker.md`, README Quick start, `tests/lifecycle/run.sh` |
| anything user-visible | `CHANGELOG.md` under *Unreleased* |

`docs/PRD.md` is the as-built product requirements document. Keep its section numbers (§1–§20), FR and NFR IDs stable.

The README's "Project status" section lists what has **not** been verified, such as a live Discord call, the soak test and unprobed stations. Don't remove an item unless it has actually been verified, and say how.

## Safety and secrets

- Never commit `.env`, tokens, real Discord IDs, or signed or tokenised stream URLs. Logs and errors pass through redaction (`src/shared/redact.ts`, the logger's redact paths); keep new fields that could hold secrets or URLs covered.
- CI runs gitleaks on every push and pull request and over the whole history weekly. `.gitleaks.toml` keeps every default rule and allowlists only the fake values used in docs and tests (`replace-with-your-…` placeholders, `123456789012345678`-style and repeated-digit IDs). Use those fakes in new docs and tests; never widen the allowlist to make a real-looking value pass.
- Use a separate Discord application and a private test server for any live testing.
- Don't commit, push, tag or publish images unless the maintainer asks.
- A release tag `vX.Y.Z` must equal `package.json`'s `version` and the default image tag in `compose.yaml`; the release workflow refuses otherwise, and `radio-bot update` relies on that match to pull the right image.
- `radio-bot.sh` is rewritten by `git checkout` while `update` runs. Keep its body inside functions and the final `main "$@"; exit $?` on one line, and keep it bash 3.2-compatible (macOS).
