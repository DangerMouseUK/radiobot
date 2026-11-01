# Contributing to Radio Bot

Thank you for helping. Radio Bot is a small, self-hosted Discord radio bot. Its core rules:

- play the **correct** station before the highest bitrate;
- make **no claim without evidence**;
- **encode once**;
- **ask for as little access as possible**.

Contributions that keep to these rules are very welcome. By taking part you agree to follow the [Code of Conduct](CODE_OF_CONDUCT.md).

**Naming:** the product is **Radio Bot** (package and image `radio-bot`; the repository is [DangerMouseUK/radiobot](https://github.com/DangerMouseUK/radiobot)). Don't call it "FG Radio" or anything else that implies it is a broadcaster's product. It is unofficial; see [docs/rights-and-disclaimer.md](docs/rights-and-disclaimer.md).

## Development setup

You need:

- **Node.js 24.17 or newer.** `package.json` enforces it with `engines`. The code runs straight from `.ts` files through Node's type stripping (`pnpm dev`, CI's catalogue check) and uses the built-in `node:sqlite`.
- **pnpm.** The version is pinned in `packageManager`. Run `corepack enable` and Node will provide the right one.
- **FFmpeg and FFprobe with `libopus`,** for playback and for the stream integration tests. `ffmpeg-static` and `ffprobe-static` are dev dependencies for local tests, or you can use a system FFmpeg and set `FFMPEG_PATH` and `FFPROBE_PATH`. On Linux, point the tests at the system FFmpeg (`FFMPEG_PATH=/usr/bin/ffmpeg FFPROBE_PATH=/usr/bin/ffprobe pnpm test`), because the `ffmpeg-static` Linux build crashes on the HLS fixtures.

```sh
corepack enable
pnpm install
pnpm typecheck      # tsc --noEmit (strict)
pnpm lint           # biome check .
pnpm test           # vitest run (unit + integration)
pnpm build          # compile to dist/
```

Other scripts:

| Script | What it does |
|---|---|
| `pnpm test:unit` / `pnpm test:integration` | Run one test suite only |
| `pnpm format` | Apply Biome formatting |
| `pnpm dev` | Run from source with `node --watch src/index.ts`. Needs the variables from a `.env` with a **test** bot token exported into your shell; the bot does not read `.env` itself. |
| `pnpm validate-catalogue` | Validates every station pack (plus `EXTRA_PACKS_DIR`). Add `--pack <dir>` to check one pack folder, or `--probe <stationId…>` / `--probe --pack-id <id>` for live probes, `--compare` for audio comparisons and `--json <file>` for an evidence report. Runs from `dist/`, so run `pnpm build` first. CI runs `node scripts/validate-catalogue.ts` straight from source. |
| `pnpm register-commands` | Force guild command registration (optionally pass guild IDs). Needs a build. |
| `pnpm healthcheck` / `pnpm backup` | Check the heartbeat file / write a manual database backup. Need a build. |
| `pnpm test:lifecycle` | Linux or WSL only: runs `install.sh` and `scripts/radio-bot.sh` (install, update, backup, uninstall) against a throwaway Git origin and a fake `docker`. CI runs it, plus `shellcheck`. |

Tests live in `tests/unit/` (fast; no FFmpeg, and only loopback sockets) and `tests/integration/` (real FFmpeg against a local fixture server, `tests/integration/fixture-server.ts`); shared helpers are in `tests/helpers.ts`. Test files are named `*.test.ts`.

Use a separate Discord application and a private test server for development. Never use a production token.

## Before opening a pull request

- `pnpm typecheck`, `pnpm lint` and `pnpm test` all pass.
- New behaviour has tests. Bug fixes have a test that failed before the fix.
- Documentation is updated where behaviour changed: `README.md`, `docs/` and `CHANGELOG.md` under *Unreleased*. The docs must describe what the code actually does.
- Commits and pull request descriptions explain *why*, not just *what*.
- There are no secrets anywhere: no tokens, no `.env`, no signed or tokenised stream URLs, and no real user, server or channel IDs in fixtures. For IDs, use the fakes the secret scanner already allows (`123456789012345678`, `223456789012345678`, `111111111111111111` and so on; see `.gitleaks.toml`).

## Rules for particular areas

### Catalogue changes

Station packs in `catalog/packs/<pack-id>/` (`pack.json`, `stations.json`, `sources.json`, `SOURCE_PROVENANCE.md`, `evidence/`) affect what every installation plays. The format is documented in [catalog/README.md](catalog/README.md). The bundled starter pack is `catalog/packs/fg/`. A new pack must be **labelled as unofficial** (with a `disclaimer` and no logos or artwork) unless the broadcaster has agreed otherwise. For these files:

- **Every source mapping needs provenance and evidence:**
  - **Provenance:** how the URL is tied to the station, and when. For example: "Official radiofg.com web player entry `<officialId>` redirected to this mount on YYYY-MM-DD". Put this in `provenanceDetail`, and add a row or section to `SOURCE_PROVENANCE.md`.
  - **Evidence:** what you checked and what you saw: HTTP status and content type, and ideally `validate-catalogue --probe` output (codec, measured bitrate, `icy-name`) and a `--compare` result against an already-verified source of the same station. Attach the `--json` evidence file, or its relevant excerpt, to the pull request.
- **Use only `official-player` or `curated` provenance.** Automatically discovered URLs don't belong in the manifest.
- **Pack URLs should be HTTPS.** The schema accepts `http://`, but such sources are refused when `ALLOW_INSECURE_HTTP_STREAMS=false`. They must not contain signatures, tokens, session or tracking parameters. Short-lived signed URLs must never be committed.
- **Never bypass access controls.** That covers DRM, authentication, geo-blocking and private or mobile-only APIs. A source that refuses access stays out.
- **Don't delete broken sources silently.** Set `enabled: false` with a `disabledReason`, and record why in the pack's `SOURCE_PROVENANCE.md`. Seeding already disables any source that disappears from the manifest, but an explicit record is clearer.
- **Station IDs (`<pack-id>:<slug>`) are permanent,** and so are pack IDs. They are what favourites and preferences point to. A rename changes `displayName` and adds the old name as an alias. Within a pack, no two stations may share a name or alias, and source IDs must be unique across all packs; start-up checks both.
- **Declare brand labels.** Publisher or network names that appear in several stations' stream metadata belong in `brandLabels`, so they are never treated as identity evidence.
- **Run `pnpm validate-catalogue`** (after `pnpm build`, or `node scripts/validate-catalogue.ts` from source) before pushing.
- **Takedown requests from rights holders take priority** and are handled as described in [docs/rights-and-disclaimer.md](docs/rights-and-disclaimer.md#takedown-procedure).

### Audio and source changes need a reviewer

A pull request that touches any of the following needs **at least one approving review from another maintainer** before merging:

- `src/audio/`
- `src/streams/`: probing, identity, ranking, inputs, URL policy, safe fetch
- `src/voice/`
- the station packs in `catalog/packs/`

In the description, explain the effect on:

- **correctness:** could a station be mislabelled?
- **fidelity:** any extra encode or processing?
- **safety:** any new network or FFmpeg surface?

In particular:

- **No second lossy encode, and no default EQ, AGC, normalisation or limiting.** FFmpeg reads **stdin only** (`-protocol_whitelist pipe`). Never pass a URL, a user string or a new protocol to FFmpeg arguments.
- **All network access goes through `SafeHttpClient`.** Don't add `fetch()` or `http.get()` calls that bypass the URL policy.
- **Don't relax the identity or eligibility gates** without a discussion in an issue first.

### Tests and fixtures

- **No copyrighted audio in fixtures. Ever.** That includes short clips of real stations. Generate test audio synthetically, for example with FFmpeg `lavfi` sources such as `sine`, `anoisesrc` or `aevalsrc`, or use audio you hold the rights to under a compatible licence, documented in the fixture directory. Generated fixtures go in `tests/fixtures/generated/`, which is ignored by git and Docker.
- **Integration tests must not hit real radio stations or Discord.** Use local fixtures and fakes. The `UrlPolicy` has a test-only `testAllowedAddresses` option for loopback test servers. It must never be wired to configuration.
- **SSRF tests** should cover IPv4, IPv6, IPv4-mapped IPv6, redirects, DNS rebinding, internal names and metadata addresses.

### Database migrations

- **Never edit a migration that has been released.** Its checksum is verified at start-up. Add a new `migrations/NNNN_description.sql` instead.
- **Migrations must not lose settings.** Start-up takes a backup before migrating; keep migrations transactional and test upgrading from the previous schema.

### Discord permissions

- **Ask for nothing new without discussion.** No new gateway intents and no new bot permissions unless they have been discussed in an issue. The documented minimal set is a feature.
- **Check permissions on the server side.** Every new command or component must call `authorize()` with the right capability. Components must use `ComponentIds`.
- **`/radio` is full.** It uses all 25 top-level options Discord allows. A new command has to go into a subcommand group (as `queue` and `source` do), or replace an existing subcommand.
- **Admin means owner or Administrator.** Don't reintroduce admin roles or Manage Server checks without an issue first.

### Installer and release changes

- `install.sh` and `scripts/radio-bot.sh` are what beginners run. Keep them bash 3.2-compatible (macOS), `shellcheck`-clean, and covered by `tests/lifecycle/run.sh`. Every prompt and message should make sense to someone who has never used a terminal; [docs/install.md](docs/install.md) documents them in that voice.
- A release is a `vX.Y.Z` tag. It must equal `package.json`'s `version` and the default image tag in `compose.yaml`, or the release workflow stops before publishing. `radio-bot update` moves installs to the newest such tag and pulls the matching image.

## Reporting bugs and security issues

- **Bugs:** open an issue with the version, the reason codes, and log lines at `info` or `debug` level. Check the logs before pasting; they are redacted, but never paste tokens or `.env`.
- **Security vulnerabilities:** please **don't** open a public issue. See [SECURITY.md](SECURITY.md).

## Licence

By contributing, you agree that your contributions are licensed under the [MIT licence](LICENSE). Only contribute code and documentation that you wrote or have the right to license this way.
