# AGENTS.md

Instructions for AI coding agents (and humans) working in this repository. Read this file in full before changing anything. [CONTRIBUTING.md](CONTRIBUTING.md) is the human-facing version of the same rules. If the two disagree, fix whichever one is wrong in the same change.

## What this is

**Radio Bot** is a self-hosted Discord bot that plays live internet radio in voice channels. It is TypeScript on Node.js 24, using discord.js 14, `@discordjs/voice` with DAVE, FFmpeg/`libopus` and SQLite (`node:sqlite`). It runs as a single process with one SQLite file and outbound network access only. The repository is **public**.

- The product name is **Radio Bot** (npm package `radio-bot`, GitHub repository `DangerMouseUK/radiobot`). Never name it after a broadcaster or a station pack, or in any way that implies it belongs to a broadcaster.
- It is **unofficial**: it is not affiliated with or endorsed by any broadcaster. Station packs name stations only so that people can find them; the names, audio and artwork belong to their owners. Keep that generic disclaimer where it is needed, and never add broadcaster logos or artwork.
- Outside a pack's own folder (`catalog/packs/<id>/`), never name a pack's broadcaster or its stations, and never add a disclaimer or warning naming them; use generic examples (`mypack:my-station`). The generic "not affiliated with any broadcaster" disclaimer stays.
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
pnpm test:lifecycle                # Linux/WSL only: install.sh + radio-bot.sh against a fake docker
pnpm vitest run tests/unit/session.test.ts      # a single file
pnpm build                         # tsc -p tsconfig.build.json → dist/
node scripts/validate-catalogue.ts # validate every station pack, straight from source
```

**Definition of done** for any change: `pnpm typecheck`, `pnpm lint`, `node scripts/validate-catalogue.ts` and `pnpm test` all pass, and `pnpm build` succeeds. If you touch `install.sh`, `scripts/radio-bot.sh` or `tests/lifecycle/`, `shellcheck -x` on them and `pnpm test:lifecycle` must pass too. CI (`.github/workflows/ci.yml`) runs all of these, then builds the Docker image and smoke-tests it (FFmpeg has `libopus`; a missing token exits with code 78).

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
  index.ts              entry: config → logger → createApp() → start; SIGTERM/SIGINT teardown
  app.ts                wiring: DB, repositories, packs, URL policy, HTTP client, sessions, Discord client, timers
  config/env.ts         every environment variable (Zod); invalid config → exit code 78
  catalogue/            station packs (packs.ts), official-list sync (sync.ts, sync-adapters.ts),
                        per-server custom stations (custom-provider.ts), search, shared types
  streams/              THE SOURCE-VALIDATION BOUNDARY: url-policy, safe-fetch (SSRF-safe client),
                        playlists (PLS/M3U/HLS), input (ICY demux, HLS reader), probe (ffprobe + decode),
                        identity (metadata + audio correlation), ranking (eligibility + selection),
                        source-service (orchestrates all of it)
  audio/                ffmpeg.ts (process registry, version checks), encoder.ts (bitrate plan, args),
                        pipeline.ts (stdin → FFmpeg → Ogg Opus, rate meters)
  voice/                link.ts (@discordjs/voice wrapper + stats), session.ts (per-guild state machine,
                        watchdog, recovery, failover), session-manager.ts (all guilds, boot/resume)
  discord/              controller.ts (every interaction), commands/definitions.ts (/radio),
                        permissions/authorize.ts, components/custom-id.ts (signed IDs), ui/ (views, format),
                        register.ts, notifier.ts, presence.ts (bot status),
                        voice-status.ts (voice channel status),
                        voice-access.ts, context.ts
  persistence/          db.ts (node:sqlite, migrations, backups), repositories/ (stations, guilds, meta)
  observability/        logger, health (health.json heartbeat, diagnostics server), metrics, netstats,
                        event-loop (event-loop delay for /radio stats)
  import-export/        /radio export and import
  shared/               errors (reason codes), backoff, rate limits, redaction, text, async helpers, paths
scripts/                validate-catalogue, register-commands, healthcheck, backup (CLI entry points);
                        radio-bot.sh, the bash manager behind the `radio-bot` command (install, update,
                        backup, restore, uninstall …) for Docker Compose installs
install.sh              one-line bootstrap: clones into ~/radio-bot, then runs `radio-bot.sh install`
migrations/             NNNN_name.sql, applied in order, checksummed
catalog/packs/<id>/     pack.json, stations.json, sources.json, SOURCE_PROVENANCE.md, evidence/
tests/unit/             fast, pure tests;  tests/integration/  local fixture radio server + synthetic audio
tests/helpers.ts        memoryDb(), makeSource(), silentLogger()
tests/lifecycle/        run.sh + fake-docker: end-to-end test of the installer and manager
docs/                   install.md (beginner guide, start here), install-docker/-linux/-container-platforms,
                        architecture, audio, verification, permissions, PRD, troubleshooting
deploy/systemd/         hardened unit file for bare-metal installs
```

## Invariants: do not break these

These are product rules, not style preferences. A change that breaks one is wrong even if the tests pass.

**Audio**

1. **Encode once.** FFmpeg decodes the source and encodes **once** with `libopus` into Ogg Opus. `@discordjs/voice` receives `StreamType.OggOpus` and only demuxes it. Never add a second lossy encode, and never add default EQ, AGC, loudness normalisation, compression or limiting.
2. **Follow the source, not the channel.** In `maximum` mode the Opus target is the source's own bitrate (codec metadata, then measured, then manifest or advertised), capped at `MAX_OPUS_BITRATE_KBPS` (default 510, range 32–510); the cap is the target only when the source's bitrate is unknown. Never pad a stream above its source's rate, and never cap it at the voice channel's bitrate setting, which is reported only. `manual` is the admin's value capped at `MAX_OPUS_BITRATE_KBPS` (like `maximum` until one is set), and `balanced` is 128 kbps or the source's bitrate if lower. See `planEncoder()` in `src/audio/encoder.ts`.
3. **FFmpeg reads stdin only** (`-protocol_whitelist pipe`). Never pass a URL, a user-supplied string or a new protocol into FFmpeg or FFprobe arguments. Bytes reach FFmpeg only from `SafeHttpClient`.

**Network**

4. **All stream, playlist, segment, sync and import traffic goes through `SafeHttpClient`** (`src/streams/safe-fetch.ts`). It validates URLs with `UrlPolicy`, pins DNS, blocks private and reserved ranges (including IPv4-mapped, NAT64 and 6to4 forms), and re-validates every redirect. Never add a bare `fetch()`, `http.get()` or `net.connect()` to a user- or pack-supplied host. The one exception is `tcpPing()` in `src/observability/netstats.ts`, which is only ever called with an address already checked with `policy.assertAddressAllowed()`.
5. **User-Agent.** Stream requests identify as FFmpeg's network library, `Lavf/<version>` from the installed FFmpeg (fallback `Lavf/61.7.100`), overridable with `STREAM_USER_AGENT`. Do **not** add a browser User-Agent, `Referer`, cookies or anything else designed to get past a host's access control. A host that refuses with HTTP 401, 403 or 451 is reported as `ACCESS_DENIED`, and that is the correct outcome.
6. **No bypassing:** no DRM, encrypted HLS, authentication, geo-blocking, signed or tokenised URLs, or private or mobile APIs.

**Correctness**

7. **The correct station beats the best bitrate.** A source is eligible only if its identity is verified, it is healthy and it is not in cooldown (`src/streams/ranking.ts`). If a station has no eligible source, the bot says so and plays nothing in its place. Don't relax the identity or eligibility gates without an issue first.
8. **Transport tier comes first:** direct streams (tier 0), then unknown (1), then HLS (2) as a last resort, whatever their bitrate. Within a tier, rank by evidence. Never compare bitrates across codecs.
9. **No claim without evidence.** User-facing text distinguishes `measured`, `codec-metadata`, `manifest`, `advertised` and `unknown` bitrates, and says "not conclusively determined" when that's the truth. Never claim "HD" or "lossless".
10. **No recording.** Probe samples are held in memory and then discarded. The bot is self-deafened and never receives voice audio.

**Discord**

11. **Minimal access.** The intents are `Guilds` and `GuildVoiceStates` only. The bot permission integer is `281474979908608`: View Channels, Send Messages, Embed Links, Attach Files, Connect and Speak (`3197952`), plus the **optional** Set Voice Channel Status. The bot must keep working without the optional one: check it per channel and skip quietly. Adding an intent or permission needs an issue first.
12. **Authorise on the server side, every time.** Every command, button and select menu calls `authorize()` (`src/discord/permissions/authorize.ts`) with `read`, `control` or `admin`. Component custom IDs must be built with `ComponentIds` (signed and bound to the server).
13. **Admin means the server owner or Discord's Administrator permission. Nothing else.** There are no admin roles, and Manage Server doesn't count. DJ roles grant `control`. Installation-wide decisions (identity reviews of pack sources) also need the user to be an operator: in `OPERATOR_USER_IDS`, or the application owner or a member of its team. The admin check still applies first.
14. **`/radio` is full.** `src/discord/commands/definitions.ts` has exactly **25** top-level options, which is Discord's maximum. A new command must go into a subcommand group (as `queue` and `source` do) or replace an existing one. Option names and descriptions must stay within Discord's length limits.
15. Stats and diagnostics are **ephemeral and admin-only** (`/radio stats`, with Refresh and Close). Never post them publicly.

**Data**

16. **Station and pack IDs are permanent** (`<pack-id>:<slug>`). Favourites, queues and preferences point to them. A rename changes `displayName` and adds the old name as an alias.
17. **Migrations.** Once a migration has been released, never edit it: its SHA-256 checksum is verified at start-up. Add `migrations/NNNN_description.sql` instead, keep it transactional, and make sure it loses no settings. When adding guild-scoped tables, include them in `GuildRepository.purgeGuild()` and in export/import where they hold settings.
18. **No telemetry.** `TELEMETRY_ENABLED=true` is refused at start-up. Keep it that way.

## Station packs

- A pack is `catalog/packs/<id>/` with `pack.json`, `stations.json` and `sources.json`, validated by the Zod schemas in `src/catalogue/packs.ts`. The authoring guide is [catalog/README.md](catalog/README.md).
- The code must stay **pack-agnostic**. Never special-case a pack ID in `src/`. Pack-specific behaviour lives in pack data (`brandLabels`, `categories`, `sync`) or in a named, generic sync adapter in `src/catalogue/sync-adapters.ts` (`webradio-apidata`, `json-name-list`).
- Source provenance must be `official-player` or `curated`, with `provenanceDetail` and a matching entry in the pack's `SOURCE_PROVENANCE.md`. Never commit automatically discovered or signed URLs. Disable broken sources with `enabled: false` and a `disabledReason`; don't delete them.
- `custom` is a reserved provider ID (per-server custom stations).
- Validate with `node scripts/validate-catalogue.ts`. Live probing (`--probe`, `--compare`) hits real stream hosts, so run it only when you're deliberately gathering evidence, never in tests.

## Tests

- Vitest. `tests/unit/` holds pure, fast tests; `tests/integration/` runs against `tests/integration/fixture-server.ts`, a local fixture radio server that serves synthetic audio generated with FFmpeg `lavfi` into `tests/fixtures/generated/` (git-ignored).
- **Never use copyrighted audio**, not even a short clip of a real station. Never hit real stations, Discord or the public internet in tests.
- The `UrlPolicy` `testAllowedAddresses` option lets tests reach loopback fixtures. It must **never** be wired to configuration.
- Use `memoryDb()` from `tests/helpers.ts` for an in-memory, migrated database, and `makeSource()` for source fixtures. Match the existing style: import from `'../../src/…ts'`, with `describe`/`it` and plain `expect`.
- New behaviour needs a test. A bug fix needs a test that failed before the fix. Avoid timing-sensitive assertions; inject clocks (for example `RateMeter`'s `now`) instead of sleeping.

## Documentation must match the code

The docs describe what the code **actually does**. When you change behaviour, update the affected docs in the same change:

| If you change… | …update |
|---|---|
| an environment variable | `src/config/env.ts`, `.env.example`, the README configuration table, and install docs if relevant |
| a command, option or button | `definitions.ts`, the help text (`#cmdHelp` in `src/discord/controller.ts`), README Commands, `docs/permissions.md` |
| audio or encoder behaviour | `docs/audio-quality.md`, README |
| ranking, identity or probing | `docs/station-verification.md`, `docs/architecture.md` |
| the pack schema or adapters | `catalog/README.md` |
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
