# Contributing to Radio Bot

Thank you for helping. Radio Bot is a small, self-hosted Discord radio bot. Its core rules:

- **the stream comes first:** nothing the bot does may cause a hiccup in the live stream, even on a 1-vCPU host (see [the coding rules below](#the-stream-comes-first));
- **live means live:** the delay from the station to the listener stays as small as possible and never grows (see [below](#live-means-live));
- play the **correct** station before the highest bitrate;
- make **no claim without evidence**;
- **encode once**;
- **ask for as little access as possible**.

Contributions that keep to these rules are very welcome. By taking part you agree to follow the [Code of Conduct](CODE_OF_CONDUCT.md).

**Naming:** the product is **Radio Bot** (package and image `radio-bot`; the repository is [DangerMouseUK/radiobot](https://github.com/DangerMouseUK/radiobot)). Never name it after a broadcaster or a station pack, or in any way that implies it is a broadcaster's product. It is unofficial and not affiliated with or endorsed by any broadcaster; see [docs/rights-and-disclaimer.md](docs/rights-and-disclaimer.md).

**Pack names stay in the pack:** outside a pack's own folder (which lives in the pack library, [DangerMouseUK/radiobot-packs](https://github.com/DangerMouseUK/radiobot-packs), not in this repository), never name a pack's broadcaster or its stations, and never add a disclaimer or warning naming them. Use generic examples (`mypack:my-station`). The generic "not affiliated with any broadcaster" disclaimer stays. The only exception is the one sentence in the README's Station packs section saying, without naming any pack, that the bot ships with no packs, that they come from the official pack library, and that any of them can be installed, updated or removed.

## Development setup

You need:

- **Node.js 24.17 or newer.** `package.json` enforces it with `engines`. The code runs straight from `.ts` files through Node's type stripping (`pnpm dev`, CI's catalogue check) and uses the built-in `node:sqlite`.
- **pnpm.** The version is pinned in `packageManager`. Run `corepack enable` and Node will provide the right one.
- **FFmpeg and FFprobe with `libopus`,** for playback and for the stream integration tests. `ffmpeg-static` and `ffprobe-static` are dev dependencies for local tests, or you can use a system FFmpeg and set `FFMPEG_PATH` and `FFPROBE_PATH`. On Linux, point the tests at the system FFmpeg (`FFMPEG_PATH=/usr/bin/ffmpeg FFPROBE_PATH=/usr/bin/ffprobe pnpm test`), because the `ffmpeg-static` Linux build crashes on the HLS fixtures.

```sh
corepack enable
pnpm install --frozen-lockfile
pnpm typecheck      # tsc --noEmit (strict)
pnpm lint           # biome check .
pnpm test           # vitest run (unit + integration)
pnpm build          # compile to dist/
pnpm smoke          # check the build: database, the template pack, worker threads, an encode, the healthcheck
```

Other scripts:

| Script | What it does |
|---|---|
| `pnpm test:unit` / `pnpm test:integration` | Run one test suite only |
| `pnpm vitest run tests/unit/session.test.ts` | Run a single test file |
| `pnpm test:coverage` | Run every test and report how much of `src/` and `scripts/` they run, file by file (V8 coverage; settings in `vitest.config.ts`). CI runs this, and fails if coverage drops below the minimums set there |
| `pnpm format` | Apply Biome formatting (run it after editing anything Biome checks: `src/`, `scripts/`, `tests/`, `catalog/` and the root JSON and TS files) |
| `pnpm dev` | Run from source with `node --watch src/index.ts`. Needs the variables from a `.env` with a **test** bot token exported into your shell; the bot does not read `.env` itself. |
| `pnpm validate-catalogue` | Validates every station pack in `catalog/packs/` and `EXTRA_PACKS_DIR`, plus `catalog/packs/_template/`. Add `--pack <dir>` to check one pack folder, `--strict` for the extra rules for library packs, or `--probe <stationId…>` / `--probe --pack-id <id>` for live probes, `--compare` for audio comparisons and `--json <file>` for an evidence report. Runs from `dist/`, so run `pnpm build` first. CI runs `node scripts/validate-catalogue.ts` straight from source. |
| `node scripts/pack-author.ts …` | The pack and library authoring tools, run straight from source: `new` (start a pack from the template), `export` and `generate` (round-trip a pack through `intake.csv`), `build-library` (write a library's `index.json` and bundles) and `diff-check` (check a change to a published pack). The pack library's CI runs them; see [catalog/README.md](catalog/README.md#tools-for-writing-packs). |
| `pnpm register-commands` | Register `/radio` now, even if nothing has changed, without starting the bot: in the servers whose IDs you pass, or else in `DISCORD_DEV_GUILD_ID` or every server the bot is in. Needs a build. |
| `pnpm healthcheck` / `pnpm backup` | Check the heartbeat file / write a manual database backup. Need a build. |
| `pnpm smoke` | After `pnpm build`: runs the compiled code with no network and no Discord. It opens a temporary database (migrations run), seeds the template pack and loads it again on the pack worker thread, checkpoints the database on the worker thread, parses a station list on the parse worker, encodes two seconds of a synthetic tone to Ogg Opus with the live encoder's arguments and checks a heartbeat with the healthcheck. Uses `FFMPEG_PATH` / `FFPROBE_PATH`, or `ffmpeg` / `ffprobe` on the `PATH`. CI also runs it inside the Docker image. |
| `pnpm test:lifecycle` | Linux or macOS (where it needs `python3`): runs `install.sh` and `scripts/radio-bot.sh` (install, status, update, backup, restore, uninstall) against a throwaway Git origin and a fake `docker`. CI runs it on Linux, plus `shellcheck`, and on macOS with the system's bash 3.2. |
| `docker build --target test -t radio-bot:test .` then `docker run --rm --network none radio-bot:test` | The integration tests on the Docker image's own Node and FFmpeg (the `test` stage shares the image's base; the published image is built without it). CI runs this. |

Tests live in `tests/unit/` (fast; no FFmpeg, and only loopback sockets) and `tests/integration/` (real FFmpeg against a local fixture server, `tests/integration/fixture-server.ts`). `tests/integration/main-thread-budget.test.ts` plays a stream through the real pipeline while the heaviest commands, a large catalogue sync and a live install of a 2000-station pack run, and fails if the event loop stalls for 50 ms or more; if it fails, make the slow step cheaper rather than raising the bound. It prints each step's longest stretch of synchronous work, and Vitest runs it on its own, after every other test file, so the rest of the suite isn't measured with it.

CI also runs the typecheck and tests on the oldest supported Node (24.17.0), checks the relative links and anchors in the docs without going online, and scans the Docker image for high and critical vulnerabilities that have a fix (with Trivy, also weekly). Dependabot proposes dependency, action and base-image updates weekly.

Shared test helpers are in `tests/helpers.ts`: `memoryDb()` gives an in-memory, migrated database and `makeSource()` a source fixture. Tests that need a station pack use the made-up one in `tests/fixtures/packs/demo/`. Test files are named `*.test.ts`, import from `'../../src/….ts'` and use `describe`/`it` with plain `expect`.

## Code style

- **Node runs the `.ts` files directly** (type stripping), and `tsc` compiles them to `dist/`. So relative imports end in `.ts` (`import { x } from './foo.ts'`), type-only imports use `import type`, and syntax that can't simply be stripped is not allowed: no `enum`, `namespace` or parameter properties. Use `as const` objects or union types instead.
- TypeScript is `strict`, with `noUncheckedIndexedAccess`; `any` is an error. The code is ESM only, and built-in modules use the `node:` prefix.
- Biome formats the code: 2 spaces, single quotes, semicolons, trailing commas, lines up to 110 characters.
- Private class state uses `#private` fields, validation uses Zod, and logging goes through `src/observability/logger.ts` (Pino, with secrets redacted). Never use `console.log` in `src/`.
- User-facing text and docs use British English ("favourites", "licence", "catalogue").

Use a separate Discord application and a private test server for development. Never use a production token.

## Before opening a pull request

- `pnpm typecheck`, `pnpm lint`, `node scripts/validate-catalogue.ts` and `pnpm test` all pass, and `pnpm build` and then `pnpm smoke` succeed. If you touched `install.sh`, `scripts/radio-bot.sh` or `tests/lifecycle/`, `shellcheck -x` on them and `pnpm test:lifecycle` pass too. If you touched the `Dockerfile`, the Docker `test` stage (in the table above) passes too.
- New behaviour has tests. Bug fixes have a test that failed before the fix.
- If the change adds work to the bot's main thread, the description says what it costs and how you measured it (see [The stream comes first](#the-stream-comes-first)).
- Documentation is updated where behaviour changed: `README.md`, `docs/` and `CHANGELOG.md` under *Unreleased*. The docs must describe what the code actually does; the table in [AGENTS.md](AGENTS.md#documentation-must-match-the-code) says which documents go with which kind of change.
- Commits and pull request descriptions explain *why*, not just *what*.
- There are no secrets anywhere: no tokens, no `.env`, no signed or tokenised stream URLs, and no real user, server or channel IDs in fixtures. For IDs, use the fakes the secret scanner already allows (`123456789012345678`, `223456789012345678`, `111111111111111111` and so on; see `.gitleaks.toml`).

## The stream comes first

This rule outranks every other rule and every feature. The live stream must play at the best quality the station offers, from the station through to Discord, with no audible hiccup, on a host with 1 vCPU and 1 GB of memory. Everything else must be written so that it cannot disturb the stream. If it runs cleanly on one core, it runs cleanly anywhere.

Voice packets go out every 20 ms from Node's main thread. That's the same thread that runs every command, button, autocomplete, database query (`node:sqlite` is synchronous) and log call. While it is busy, packets leave late, and a gap of about 55 ms or more is heard as a small cut. So, in any code that runs in the bot process:

1. **Budget the main thread.** Keep each synchronous stretch of work under 10 ms on a 1-vCPU host; 20 ms or more is a bug. Batch, cache, page or cap anything that grows with the number of stations, sources, servers or stored history.
2. **Move heavy work off it.** Run CPU-bound work in a child process at the lowest priority (`lowerPriority()` in `src/audio/ffmpeg.ts`), or split it into slices that yield to the event loop. Only the live encoder runs at normal priority. While streams play, do no large synchronous file I/O, compression, hashing or JSON work on the main thread.
3. **Background work yields.**
   - Run background jobs one at a time.
   - Don't start them during a stream's first 30 s.
   - Back off when they fail.
   - Let anything a listener is waiting for interrupt them.
   - When in doubt, do less and do it later.
4. **Keep the audio path minimal.** Per-packet code is constant-time, with no logging, I/O, `await` or per-packet allocation of its own. Add no buffering, no extra latency, no second encode and no processing (see [Live means live](#live-means-live)).
5. **Bound memory.** Every cache, history and queue has a limit. The bot and one FFmpeg encoder must fit comfortably in 1 GB alongside the operating system.
6. **Measure, don't guess.** Say in the pull request what new main-thread work costs and how you measured it. On a running bot, the event-loop delay and the late-packet count in `/radio stats` show the effect.
7. **Logging costs nothing when it's off.** Never log per packet, and guard costly debug entries with `logger.isLevelEnabled('debug')`.

## Live means live

Every station is live, so the delay from the station to the listener must be as small as possible, and must never grow during a session. Only "The stream comes first" ranks above this: a cushion that stops the network's unevenness being heard is worth its delay, so don't shrink one just to make the delay look better.

1. **Every buffer earns its place, sized in time.** Give each buffer on the audio path a reason and a size in milliseconds. Today the only deliberate one is the cushion of the live queue (`src/voice/live-queue.ts`): a 1 s safety margin (for HLS, the segment length plus that margin, with segments counted at up to 12 s). The margin grows by 0.5 s after each network gap up to 3 s, and eases back after 30 calm minutes, at the next catch-up (for example the next voice resume). After a gap, playback goes on once the margin is back in hand (for HLS, with the next segment), as at the start. FFmpeg writes one 20 ms packet per Ogg page, and the queue takes each one as soon as it is written.
2. **No hidden backlog.** Audio may only wait where it is measured. The live queue's depth, cushion, catch-ups, network gaps and drift are shown in `/radio stats`, and each drop is logged (`caught up with live`, or at the start, `started behind live by the cushion; dropped the connect burst`). A new buffer on the audio path is either measured there too or kept to a few packets.
3. **Correct it as quietly as possible.** The station's connect burst is dropped before anything is heard, once it has landed, so a direct stream starts about 1 s behind live, plus Discord's own buffering (about 0.1 s), and a second look shortly after the start is a backstop for any late part of it. A backlog is dropped where listeners have just heard a break anyway (after a network gap or a voice resume), or, with no such break, once the queue's lowest point stays 3 s above the margin.
4. **Never pay for a break twice.** Don't hold audio back to avoid skipping it after an interruption: the stream would stay behind live for the rest of the session. When Discord's voice connection resumes, the audio that couldn't be sent is dropped.
5. **Never alter the audio to stay live.** No resampling or time-stretching. Clock drift is measured and reported, not corrected.

## Rules for particular areas

### Catalogue changes

Station packs (`pack.json`, `stations.json`, `sources.json`, `SOURCE_PROVENANCE.md`, `evidence/`) affect what every installation plays. **They are authored in the pack library**, [DangerMouseUK/radiobot-packs](https://github.com/DangerMouseUK/radiobot-packs), following its playbook, and proposed there; this repository keeps only the example in `catalog/packs/_template/`, so don't add other pack folders here. The format is documented in [catalog/README.md](catalog/README.md). The code must stay pack-agnostic: never special-case a pack ID in `src/`. A pack carries no logos or artwork, and must not present itself as official unless the broadcaster has agreed. Radio Bot always shows its own "not affiliated with or endorsed by any broadcaster" notice with station lists, so a pack's own `disclaimer` is optional. For these files:

- **Every source mapping needs provenance and evidence:**
  - **Provenance:** how the URL is tied to the station, and when. For example: "Official web player entry `<officialId>` redirected to this mount on YYYY-MM-DD". Put this in `provenanceDetail`, and add a row or section to `SOURCE_PROVENANCE.md`.
  - **Evidence:** what you checked and what you saw: HTTP status and content type, and ideally `validate-catalogue --probe` output (codec, measured bitrate, `icy-name`) and a `--compare` result against an already-verified source of the same station. Attach the `--json` evidence file, or its relevant excerpt, to the pull request.
- **Use only `official-player` or `curated` provenance.** Automatically discovered URLs don't belong in the manifest.
- **Pack URLs should be HTTPS.** The schema accepts `http://`, but such sources are refused when `ALLOW_INSECURE_HTTP_STREAMS=false`. They must not contain signatures, tokens, session or tracking parameters. Short-lived signed URLs must never be committed.
- **Never bypass access controls.** That covers DRM, authentication, geo-blocking and private or mobile-only APIs. A source that refuses access stays out.
- **Don't delete broken sources silently.** Set `enabled: false` with a `disabledReason`, and record why in the pack's `SOURCE_PROVENANCE.md`. At start-up the bot already disables any source that has been removed from `sources.json`, but an explicit record is clearer.
- **Station IDs (`<pack-id>:<slug>`) are permanent,** and so are pack IDs. They are what favourites and preferences point to. A rename changes `displayName` and adds the old name as an alias. Within a pack, no two stations may share a name or alias, and source IDs must be unique across all packs; start-up checks both. `custom` is reserved for each server's own stations and can't be a pack ID.
- **Declare brand labels.** Publisher or network names that appear in several stations' stream metadata belong in `brandLabels`, so they are never treated as identity evidence.
- **Run `node scripts/validate-catalogue.ts --pack <dir> --strict`** (or `pnpm validate-catalogue` after `pnpm build`) before pushing.
- **Takedown requests from rights holders take priority** and are handled as described in [docs/rights-and-disclaimer.md](docs/rights-and-disclaimer.md#takedown-procedure).

### Audio and source changes need a reviewer

A pull request that touches any of the following needs **at least one approving review from another maintainer** before merging:

- `src/audio/`
- `src/streams/`: probing, identity, ranking, inputs, URL policy, safe fetch
- `src/voice/`
- the template pack in `catalog/packs/_template/` (station packs themselves are reviewed in the pack library)

In the description, explain the effect on:

- **the stream:** any new work on the main thread or in the audio path, and what it costs;
- **correctness:** could a station be mislabelled?
- **fidelity:** any extra encode or processing?
- **safety:** any new network or FFmpeg surface?

In particular:

- **No second lossy encode, and no default EQ, AGC, normalisation or limiting.** FFmpeg reads **stdin only** (`-protocol_whitelist pipe`). Never pass a URL, a user string or a new protocol to FFmpeg arguments.
- **Follow the source's bitrate, not the channel's.** In `maximum` mode the Opus target is the source's own bitrate (the measured figure first, then codec metadata, then the manifest or advertised one), rounded up to a whole kbps and capped at `MAX_OPUS_BITRATE_KBPS`; the cap is the target only when the source's bitrate is unknown. Below the re-encode floor of 128 kbps (96 kbps for mono), the floor is the target, because a second encode at a low rate throws away stereo and treble the source still has. Never encode below the source's rate or the floor, never pad a source above the floor beyond its own rate, and never cap it at the voice channel's bitrate setting (see `planEncoder()` and [docs/audio-quality.md](docs/audio-quality.md)).
- **All network access goes through `SafeHttpClient`.** Don't add `fetch()`, `http.get()` or `net.connect()` calls that bypass the URL policy. The one exception is `tcpPing()` in `src/observability/netstats.ts`, which only connects to an address the policy has already checked.
- **Identify truthfully.** Stream requests use FFmpeg's `Lavf/<version>` User-Agent. Don't add a browser User-Agent, a `Referer`, cookies or anything else meant to get past a host's access control; HTTP 401, 403 and 451 are reported as `ACCESS_DENIED`.
- **Don't relax the identity or eligibility gates** without a discussion in an issue first. The correct station beats the best bitrate, and direct streams come before HLS whatever their bitrate. Bitrates of different codecs are never compared, except the one narrow case of measured AAC-LC (at least 96 kbps, and at least twice the rate) against HE-AAC; don't widen it without an issue first.
- **No claim without evidence.** User-facing text says which kind of bitrate evidence it shows (`measured`, `codec-metadata`, `manifest`, `advertised` or `unknown`), and never claims "HD" or "lossless".
- **No recording.** Probe samples are held in memory and then discarded. The bot is self-deafened and never receives voice audio.

### Tests and fixtures

- **No copyrighted audio in fixtures. Ever.** That includes short clips of real stations. Generate test audio synthetically, for example with FFmpeg `lavfi` sources such as `sine`, `anoisesrc` or `aevalsrc`, or use audio you hold the rights to under a compatible licence, documented in the fixture directory. Generated fixtures go in `tests/fixtures/generated/`, which is ignored by git and Docker.
- **Integration tests must not hit real radio stations or Discord.** Use local fixtures and fakes. The `UrlPolicy` has a test-only `testAllowedAddresses` option for loopback test servers. It must never be wired to configuration.
- **SSRF tests** should cover IPv4, IPv6, IPv4-mapped IPv6, redirects, DNS rebinding, internal names and metadata addresses.

### Database migrations

- **Never edit a migration that has been released.** Its checksum is verified at start-up. Add a new `migrations/NNNN_description.sql` instead.
- **Migrations must not lose settings.** Start-up takes a backup before migrating; keep migrations transactional and test upgrading from the previous schema.
- **New per-server tables** must be deleted by `GuildRepository.purgeGuild()` when the bot leaves a server, and included in `/radio export` and `/radio import` if they hold settings.

### Discord permissions

- **Ask for nothing new without discussion.** No new gateway intents and no new bot permissions unless they have been discussed in an issue. The documented minimal set is a feature.
- **Check permissions on the server side.** Every new command, component or form (modal) must call `authorize()` with the right capability (`read`, `control` or `admin`). Components and forms must use `ComponentIds`. Add a new action to `COMPONENT_ACTIONS` in `src/discord/components/custom-id.ts` (at most 7 characters); its argument can be at most 65 characters, which is the longest station ID, so every ID fits Discord's 100-character limit.
- **Statistics stay private.** `/radio stats` and other diagnostics are ephemeral and admin-only; never post them publicly.
- **`/radio` is full.** It uses all 25 top-level options Discord allows. A new command has to go into a subcommand group (as `queue`, `source` and `packs` do), or replace an existing subcommand.
- **Admin means owner or Administrator.** Don't reintroduce admin roles or Manage Server checks without an issue first. Installation-wide decisions (identity reviews of pack sources, installing or updating packs) also need the user to be an operator: in `OPERATOR_USER_IDS`, or the application owner or a member of its team. The admin check still applies first.
- **No telemetry.** `TELEMETRY_ENABLED=true` is refused at start-up; keep it that way.

### Installer and release changes

- `install.sh` and `scripts/radio-bot.sh` are what beginners run. Keep them bash 3.2-compatible (macOS), `shellcheck`-clean, and covered by `tests/lifecycle/run.sh`. Every prompt and message should make sense to someone who has never used a terminal; [docs/install.md](docs/install.md) documents them in that voice.
- `radio-bot update` rewrites `scripts/radio-bot.sh` (through `git checkout`) while the script is running. So keep its body inside functions, and keep the last line `main "$@"; exit $?` on one line.
- A release is a `vX.Y.Z` tag. It must equal `package.json`'s `version` and the default image tag in `compose.yaml`, or the release workflow stops before publishing. `radio-bot update` moves installs to the newest such tag and pulls the matching image.

## Reporting bugs and security issues

- **Bugs:** open an issue with the version, the reason codes, and log lines at `info` or `debug` level. Check the logs before pasting; they are redacted, but never paste tokens or `.env`.
- **Security vulnerabilities:** please **don't** open a public issue. See [SECURITY.md](SECURITY.md).

## Licence

By contributing, you agree that your contributions are licensed under the [MIT licence](LICENSE). Only contribute code and documentation that you wrote or have the right to license this way.
