# Station packs

Radio Bot's stations come from **station packs**. A pack is a folder of JSON files that lists a group of stations and the stream addresses (_sources_) that carry them. Nothing in the bot's code is specific to any pack: adding a group of stations means adding a pack, not code.

**The bot ships with no station packs.** Packs are made, reviewed and published in the official pack library, [DangerMouseUK/radiobot-packs](https://github.com/DangerMouseUK/radiobot-packs). It holds one pack per radio company, a playbook that explains step by step how to make and review a pack, and checks that run the bot's own tools on every change. Each library release publishes an `index.json` that lists every pack and one bundle file per pack. Admins install packs from it with `/radio packs library` in Discord, or with `radio-bot packs` on the machine that runs the bot.

This repository keeps one pack folder, [`packs/_template/`](packs/_template/): a complete, made-up example in which every field is filled in. Folders whose names start with `_` are never loaded, so the bot ignores it. This page is the reference for the pack format and the tools that check and build packs. To propose a new pack or a change to one, follow the library's playbook.

A pack only says where a station's streams are and where that information came from. The bot checks every source itself before playing it: format, bitrate, sample rate, channels and whether it really is that station. Nothing written in a pack is ever shown as a measured fact. How the bot decides is explained in [docs/station-verification.md](../docs/station-verification.md).

## Where the bot loads packs from

| Place                                    | What goes there                                                                                                                                                           | If a pack has a mistake                                                                                                                                        |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `catalog/packs/`                         | Packs shipped with the bot. There are none now: only `_template/`, which is ignored.                                                                                      | The bot doesn't start, and the message names the file and field.                                                                                               |
| `EXTRA_PACKS_DIR`                        | Your own packs, as folders in one directory that you look after yourself.                                                                                                 | The bot doesn't start, and the message names the file and field, so a broken edit is never half-loaded.                                                        |
| `installed-packs/`, next to the database | Packs installed from a pack library with `/radio packs library` or `radio-bot packs add`, and packs the bot put back by itself (see [Installed packs](#installed-packs)). | The pack is skipped and the bot carries on. Skipped packs are listed under _Not loaded_ in `/radio packs installed` and by `radio-bot packs list`, and logged. |

Only folders that contain a `pack.json` are loaded, and folders whose names start with `.` or `_` are ignored. Pack IDs and source IDs must be unique across all three places. An installed pack can't replace a pack with the same ID from `catalog/packs/` or `EXTRA_PACKS_DIR`; it is skipped instead.

`ENABLED_PACKS` and `DISABLED_PACKS` apply to packs from every place.

### Installed packs

The installed-packs folder is in the bot's data folder, next to the database (`DATABASE_PATH`), so it survives updates: `/app/data/installed-packs/` in Docker and `/var/lib/radio-bot/installed-packs/` with the systemd unit.

```text
installed-packs/
├── <pack-id>/        pack.json, stations.json, sources.json (as in the library's bundle)
└── installed.json    where each pack came from
```

`installed.json` records, for each pack, its `version`, its `source` (`official` for the official library, or the address of the other library's `index.json` or the path of the file it came from), the bundle's `sha256` and `installedAt`. Its `removed` list holds the packs someone removed on purpose. Each install is written to a hidden folder first and then renamed into place, so a half-written pack is never loaded.

Packs change while the bot runs, without a restart and without interrupting what is playing:

- **From Discord** (`/radio packs library` and `/radio packs installed`), an operator installs, updates or removes packs from the **official library only**. The bot downloads the bundle through its safe HTTP client, refuses it unless its SHA-256 matches the library's index, checks the pack with the same rules as a pack folder on a worker thread, writes it into the database in small steps and then shows its stations. This runs as background work, so it waits for any stream that is starting.
- **On the machine that runs the bot**, `radio-bot packs` (or `node dist/scripts/packs.js` with the bot's environment) changes the installed-packs folder. It can also use another library with `--from`. A running bot loads the change when it receives `SIGHUP`, which `radio-bot packs` sends and `systemctl reload radio-bot` sends on a systemd install. A stopped bot loads it when it starts.
- **At start-up, before anything plays,** the bot puts back packs that its database has stations from but that aren't loaded, by installing them from the official library: for example a pack that used to ship with the bot, or every pack after a backup was restored on a new machine. Packs in the `removed` list stay removed. If the library can't be reached, it tries again at the next daily check.
- **Once a day** (first 15 to 30 minutes after start), the bot checks the official library. It notes newer versions of installed packs, which `/radio packs installed` shows (nothing updates by itself: an operator installs updates); removes packs installed from the official library that the library has **withdrawn**, with a notice in `/radio packs installed` and stopping anything playing from them; and retries putting back missing packs.

Removing a pack hides its stations from every server. Favourites, queues and preferences that point to them are kept, so they come back if the pack is installed again.

### Pack libraries

A pack library publishes one `index.json` and one bundle file per pack. The official library's index is at `https://github.com/DangerMouseUK/radiobot-packs/releases/latest/download/index.json`; that address is fixed in the code (`src/catalogue/pack-library.ts`) and can't be configured. `radio-bot packs --from <address or index.json path>` can read another library, because whoever has a shell on the machine owns it anyway; Discord never can.

- **`index.json`** is `{ "schemaVersion": 1, "generatedAt", "packs": [ … ], "collections": [ … ] }`, at most 2 MiB. Each pack entry gives its `id`, `name`, `description`, `version`, `owner`, `countries`, `regions`, `languages`, the number of `stations` and `sources`, `lastChecked` (the date of its newest evidence report), `minBotVersion`, `status` (`available` or `withdrawn`, with a `withdrawnReason`), and the bundle's `file` (an address, absolute or relative to the index), `sha256` and `bytes`. A collection is `{ "id", "name", "description", "packs": [ … ] }`, a list of pack IDs that `radio-bot packs add --collection <id>` installs together. Most are hand-picked (see [Building a library](#building-a-library)); `build-library` also adds one per country the packs list, with the ID `country-<code>` (the country code in lower case, such as `country-gb`) and every pack with stations there, so IDs of that form are reserved.
- **`<pack-id>.json`** is a bundle: `{ "schemaVersion": 1, "pack": …, "stations": …, "sources": … }`, holding the pack's three files as parsed JSON, at most 8 MiB.

Every download goes through the bot's safe HTTP client and must finish within 20 s. A bundle whose SHA-256 doesn't match the index, that holds a different pack from the one asked for, or that fails the pack checks is refused with `PACK_INVALID`, and nothing is written.

## Folder layout

```text
<pack-id>/
├── pack.json            metadata (required)
├── stations.json        the stations (required)
├── sources.json         candidate stream URLs (optional; stations without sources are listed but can't play)
├── SOURCE_PROVENANCE.md where each source came from (required for library packs)
├── evidence/            check reports from `validate-catalogue --probe --json` (required for library packs)
└── intake.csv           optional: a spreadsheet of the stations and sources, for pack-author.ts
```

Each JSON file has `"schemaVersion": 1`. A field marked _optional_ below may be left out, and then takes the default shown.

## pack.json

```json
{
  "schemaVersion": 1,
  "id": "example",
  "name": "Example Radio Network",
  "description": "What this group of stations is.",
  "version": "2026.11.03",
  "owner": { "name": "Example Media Group", "kind": "group", "brand": "Example Radio" },
  "countries": ["GB"],
  "regions": ["Example County"],
  "languages": ["en"],
  "minBotVersion": "1.1.0",
  "disclaimer": "Unofficial: not affiliated with the stations listed.",
  "order": 100,
  "enabledByDefault": true,
  "brandLabels": ["Example Radio", "Example Network"],
  "categories": [{ "id": "news", "name": "News" }, { "id": "music", "name": "Music" }],
  "sync": null,
  "snapshotDate": "2026-11-03"
}
```

Required: `schemaVersion`, `id` and `name`. Library packs also need `version`, `owner`, at least one country and at least one language (see [Strict checks](#strict-checks-for-library-packs)).

| Field              | Meaning                                                                                                                                                                                                                                                                                                                                                                               |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`               | Required. Lower-case letters, digits and `-`, starting with a letter or digit, at most 32 characters. Becomes the first part of every station ID (`example:<slug>`), and is what operators use in `ENABLED_PACKS` and `DISABLED_PACKS`. `custom` is reserved. Must be unique across all loaded packs, and must never change once published.                                           |
| `name`             | Required, 1–80 characters. Shown in `/radio browse`, `/radio list`, `/radio stats` and `/radio packs`.                                                                                                                                                                                                                                                                                |
| `description`      | Optional, at most 500 characters (default empty). Shown on the pack's card in `/radio packs`.                                                                                                                                                                                                                                                                                         |
| `version`          | Optional, or `null` (default). The date the pack last changed, written `YYYY.MM.DD`, with `.2`, `.3` … for a later change on the same day (for example `2026.11.03.2`). The bot compares it with the library's version to tell whether an update is available. `pack-author.ts generate` sets it.                                                                                     |
| `owner`            | Optional, or `null` (default). Who the stations belong to: `{ "name", "kind", "brand" }`. `name` (1–100 characters) is the company. `kind` is `broadcaster` (one broadcaster's own stations), `group` (a company that owns several brands) or `curated` (a hand-picked list from several owners). `brand` is the brand name when a big brand has a pack of its own, otherwise `null`. |
| `countries`        | Optional, at most 50 two-letter country codes in capitals, such as `GB` or `FR` (default none). Used to filter the library by country.                                                                                                                                                                                                                                                |
| `regions`          | Optional, at most 50 strings of 1–60 characters (default none). Areas within those countries in plain words, such as a county or a city. Searched by `/radio packs library` and `radio-bot packs browse`.                                                                                                                                                                             |
| `languages`        | Optional, at most 20 language codes, such as `en`, `fr` or `pt-BR` (default none). Used to filter the library by language.                                                                                                                                                                                                                                                            |
| `minBotVersion`    | Optional, `X.Y.Z` or `null` (default). The oldest Radio Bot that can use the pack. An older bot refuses the pack: a pack folder in `catalog/packs/` or `EXTRA_PACKS_DIR` stops start-up, and an installed or downloaded one is skipped or refused.                                                                                                                                    |
| `disclaimer`       | Optional, at most 500 characters, or `null` (default). Shown in the footer of `/radio list` when this pack is listed. Use it for stations the project is not affiliated with, and don't use it to name a broadcaster.                                                                                                                                                                 |
| `order`            | Optional whole number from 0 to 10000 (default 100). Packs are listed lowest first.                                                                                                                                                                                                                                                                                                   |
| `enabledByDefault` | Optional, `true` (default) or `false`. With `false`, operators switch the pack on with `ENABLED_PACKS`. Operators can switch any pack off with `DISABLED_PACKS`, which wins over `ENABLED_PACKS`.                                                                                                                                                                                     |
| `brandLabels`      | Optional, at most 50 strings of 1–60 characters (default none). Publisher or network names that appear in the stream names of _several_ stations (for example "Example Radio"). The bot never treats them as evidence that a stream is one particular station. Names are compared ignoring case, accents and punctuation.                                                             |
| `categories`       | Optional, at most 25 `{ "id", "name" }` objects (default none). `id` uses the slug format below; `name` is 1–60 characters. Stations may only use categories declared here.                                                                                                                                                                                                           |
| `sync`             | Optional, `null` (default) or `{ "adapter": "<name>", "url": "<official list URL>" }`. See [Keeping names in line with an official list](#keeping-names-in-line-with-an-official-list).                                                                                                                                                                                               |
| `snapshotDate`     | Optional, `YYYY-MM-DD` or `null` (default): the date the station list was taken from the official source. When a pack has no evidence report, the library shows it as the date the streams were last checked.                                                                                                                                                                         |

### Keeping names in line with an official list

With `sync` set, the bot compares the pack's station names with the official list at that URL. It does this once every `CATALOG_SYNC_INTERVAL_HOURS` (24 by default, 6 to 720) plus a random delay of up to 15 minutes, and when an admin runs `/radio packs sync`. The fetch goes through the bot's safe HTTP client and is limited to 6 MiB and 20 s.

The `adapter` names the code that reads the list. Adapters live in `src/catalogue/sync-adapters.ts`:

| Adapter            | Reads                                                                                                                                                                                                                                                                           |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `webradio-apidata` | A web page with a `var apidata = { … }` script whose `webradios` array lists the stations. Only each entry's `label` (the name) and `id` are read, and entries with `displayOnWebsite: false` are skipped. If that script isn't found, the page's station menu is used instead. |
| `json-name-list`   | A JSON array of `{ "id", "name" }`, or an object `{ "stations": [ … ] }` holding one.                                                                                                                                                                                           |

A sync reads **only names and stable IDs**. It never adds stream URLs: new sources only ever come from a reviewed change to `sources.json`. It matches stations by `externalId` first, then by name. It handles renamed stations, new stations and stations that have left the list, without ever deleting anything. It refuses a list that looks broken and changes nothing: a list of more than 5,000 names, or of fewer than 10 (for a pack of fewer than 20 stations, fewer than half as many names as the pack has stations). The full behaviour is in [docs/station-verification.md](../docs/station-verification.md#catalogue-sync).

To support a new kind of official list, add a generic adapter function to `src/catalogue/sync-adapters.ts`, register it in `SYNC_ADAPTERS`, and name it in `pack.json`. Never add code that is specific to one pack. Adapters run on a separate worker thread, so they can't disturb the stream. An adapter is a plain function that takes the page text and returns names and IDs, and it must not import anything that needs the rest of the bot. A pack that names an adapter its bot doesn't have fails its checks, so give such a pack a `minBotVersion`.

## stations.json

```json
{
  "schemaVersion": 1,
  "stations": [
    {
      "slug": "example-one",
      "displayName": "Example One",
      "externalId": "123",
      "aliases": ["E1"],
      "category": "music",
      "tags": ["pop", "hits"],
      "order": 1,
      "officialPage": "https://example.org/one",
      "catalogueStatus": "active",
      "catalogueLastSeen": "2026-11-03",
      "description": null,
      "country": null,
      "region": null
    }
  ]
}
```

A file holds 1–2000 stations. Only `slug`, `displayName` and `order` are required.

The station ID is `<pack-id>:<slug>`, for example `example:example-one`. It must never change once published, because server favourites, queues, default stations and source preferences refer to it.

Every name and alias must identify exactly one station in the pack. Names are compared ignoring case, accents and punctuation.

| Field               | Meaning                                                                                                                                                                      |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `slug`              | Required. Lower-case letters, digits and `-`, starting with a letter or digit, at most 32 characters (so station IDs fit inside Discord button IDs). Unique within the pack. |
| `displayName`       | Required, 1–100 characters. The name people see.                                                                                                                             |
| `order`             | Required whole number from 0 to 100000. Position within the pack, lowest first.                                                                                              |
| `externalId`        | Optional, at most 64 characters, or `null` (default). The station's ID in the official list, used by sync to recognise a renamed station.                                    |
| `aliases`           | Optional, at most 20 strings of 1–100 characters (default none). Other names people may search for. Also used to recognise the station's announced stream name.              |
| `category`          | Optional, a category `id` declared in `pack.json`, or `null` (default).                                                                                                      |
| `tags`              | Optional, at most 30 strings of 1–40 characters (default none). Used by search, and the first three are shown in browse lists.                                               |
| `officialPage`      | Optional URL, or `null` (default). For reference; the bot doesn't show it.                                                                                                   |
| `catalogueStatus`   | Optional: `active` (default), `missing_from_official` or `retired`. A `retired` station is shown as Retired and can't be played.                                             |
| `catalogueLastSeen` | Optional, `YYYY-MM-DD` or `null` (default). When the station was last seen in the official list. For reference.                                                              |
| `description`       | Optional, at most 300 characters, or `null` (default). For reference; the bot doesn't show it.                                                                               |
| `country`           | Optional two-letter country code, or `null` (default). Only for the rare station in a different country from the rest of the pack. For reference; the bot doesn't show it.   |
| `region`            | Optional, 1–60 characters, or `null` (default). Only for a station in a different region from the rest of the pack. For reference; the bot doesn't show it.                  |

## sources.json

```json
{
  "schemaVersion": 1,
  "sources": [
    {
      "id": "example-one-mp3",
      "station": "example-one",
      "url": "https://stream.example.org/one.mp3",
      "label": "Direct MP3",
      "priority": 10,
      "transportHint": "http-continuous",
      "codecHint": "mp3",
      "provenance": "official-player",
      "provenanceDetail": "Linked from https://example.org/one/listen on 2026-11-03.",
      "enabled": true,
      "disabledReason": null
    }
  ]
}
```

A file holds at most 10000 sources. Required: `id`, `station`, `url`, `provenance` and `provenanceDetail`. A pack without `sources.json` is valid; its stations are listed but can't play.

| Field              | Meaning                                                                                                                                                                                                                                                                                       |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`               | Required. Lower-case letters, digits and `-`, starting with a letter or digit, at most 100 characters. Unique across **all** packs, so start it with the pack ID (the strict checks require it to start with the pack ID or the station's slug). Never reuse an ID for a different stream.    |
| `station`          | Required. The `slug` of a station in this pack.                                                                                                                                                                                                                                               |
| `url`              | Required. A public `http://` or `https://` stream: a direct stream (for example Icecast or SHOUTcast, in MP3, AAC or Opus), a PLS or M3U playlist, or an HLS playlist. No user names, passwords or signed or expiring tokens. One URL may belong to only one station of the pack.             |
| `label`            | Optional, at most 60 characters, or `null` (default). A short name shown in the sources list.                                                                                                                                                                                                 |
| `priority`         | Optional whole number from 0 to 10000 (default 100), lowest first. It is the last tie-break, after transport, measured quality, reliability and start-up time (PRD FR-006). When no source of a station works yet, it also sets the order in which sources are checked, after direct streams. |
| `transportHint`    | Optional: `http-continuous` (a direct stream), `hls` or `null` (default). Shown before the first check, and used to check direct streams first. Never treated as evidence.                                                                                                                    |
| `codecHint`        | Optional, at most 20 characters, or `null` (default). Shown before the first check. Never treated as evidence.                                                                                                                                                                                |
| `provenance`       | Required. `official-player` (the broadcaster's own player or site links this URL to this station) or `curated` (a reviewed mapping with recorded evidence). Either lets the source count as the right station once a check succeeds.                                                          |
| `provenanceDetail` | Required, 1–1000 characters: where the mapping came from and when.                                                                                                                                                                                                                            |
| `enabled`          | Optional, `true` (default) or `false`. Ship a broken source disabled rather than deleting it.                                                                                                                                                                                                 |
| `disabledReason`   | Optional, at most 300 characters, or `null` (default). Why the source is disabled; shown in the sources list.                                                                                                                                                                                 |

## Checking a pack

The script `scripts/validate-catalogue.ts` checks packs. Run it straight from source with Node 24, as CI does:

```bash
node scripts/validate-catalogue.ts --pack path/to/example
node scripts/validate-catalogue.ts --pack path/to/example --strict
node scripts/validate-catalogue.ts --pack path/to/example --probe --pack-id example --json path/to/example/evidence/probe-2026-11-03.json
```

Or build first and run the compiled copy: `pnpm build`, then `node dist/scripts/validate-catalogue.js` with the same options.

- **The first command** validates the files: the schema, unique slugs and names, category and station references, and no URL shared by two stations. It prints how many stations and sources the pack has, and lists stations with no enabled source. Without `--pack`, it validates every pack in `catalog/packs/` and `EXTRA_PACKS_DIR`, plus `catalog/packs/_template/`, and also checks that pack IDs and source IDs are unique across packs.
- **The second command** adds the [strict checks](#strict-checks-for-library-packs) for library packs.
- **The third command** checks every enabled source of the pack live, one at a time, and writes the evidence to the `--json` file. It needs FFmpeg and FFprobe: `FFMPEG_PATH` and `FFPROBE_PATH` if set, otherwise the ones on the `PATH`, otherwise the `ffmpeg-static` and `ffprobe-static` copies that `pnpm install` puts in a clone of this repository. It checks them before anything else, and prints the FFprobe it uses; if none runs, it stops with code 2 without contacting any server or writing a report. It identifies itself to stream hosts exactly as the bot does (`Lavf/<version>` of that FFmpeg, or `STREAM_USER_AGENT`). You need `--pack` as well only when the folder isn't in `catalog/packs/` or `EXTRA_PACKS_DIR`. Put the date in the report's file name: the library takes the newest one as the date the streams were last checked.
- Add `--compare` to compare the audio (about 40 s each) of the working sources of each checked station. To check only some stations, name them instead of `--pack-id`, for example `--probe example:example-one`.

The script exits with code 1 when a pack is invalid or fails the strict checks. It exits with code 2, before checking or contacting anything, when the command can't do what it was asked: an option it doesn't know (a typo such as `--stict` is never taken as a passing check), an option without its value, `--json` without `--probe`, a `--json` file in a folder that doesn't exist, `--probe` without stations or `--pack-id`, or names that match no enabled source.

Live checks connect to real stream servers. Run them only when you are deliberately gathering evidence, and sparingly.

### Strict checks for library packs

`--strict` adds the rules every pack in a library must meet (`strictProblems()` in `scripts/pack-author.ts`). Each problem is printed on its own line, and the script exits with code 1 if there are any:

- `pack.json` has a `version`, an `owner`, at least one country and at least one language;
- `SOURCE_PROVENANCE.md` exists and mentions every source ID;
- every source ID starts with the pack ID or the station's slug, followed by `-`;
- no source URL looks signed or expiring (a parameter such as a signature, token or expiry, or a value that looks like a long token);
- the pack folder holds no images (logos and artwork are never allowed);
- `evidence/` holds a check report, and the newest one (by the date in its file name) is a report from `--probe --json` that checks at least one of the pack's sources, in which at least one source played, and in which FFmpeg didn't fail to run (`FFMPEG_SPAWN`: such a report says nothing about the streams).

It also prints a warning, without failing, for each enabled source that failed in the newest report (`strictWarnings()`). The advice depends on how it failed, because the bot already backs off from, and after a week pauses, a source that keeps failing, and switches to the station's next source meanwhile:

- **Refused** (`ACCESS_DENIED`: HTTP 401, 403 or 451): switch it off (`enabled: false`) with that as the `disabledReason`. The host decided, and the bot never gets round a refusal.
- **Gone** (`NOT_FOUND`: HTTP 404 or 410): leave it on for now. Switch it off only if a check at least 7 days later finds it still gone; a mount being moved or restarted can answer 404 for a while.
- **Temporary** (`HTTP_TIMEOUT`, `PROBE_TIMEOUT`, `HTTP_ERROR`, `DNS_FAILED`, or `HTTP_STATUS` with a server error, HTTP 5xx): leave it on and check it again another day.
- **Anything else** (it didn't decode, had no audio, another HTTP status, and so on): find out why. If it can't play, switch it off with the reason; otherwise check it again.

Warnings never make `--strict` fail.

## Tools for writing packs

`scripts/pack-author.ts` holds the tools for writing packs and publishing a library. It runs straight from source with Node 24 and never touches the network, so the library's CI checks out this repository and runs it there. You will mostly use it from the library repository, as its playbook describes.

| Command                                                                                                                        | What it does                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `node scripts/pack-author.ts new <pack-id> [--root <folder>] [--ids <pack-ids.json>]`                                          | Starts a pack from `catalog/packs/_template/`, emptied out, in `<folder>/<pack-id>/`, and prints the next steps, with commands written to run from the current folder. `<folder>` is relative to the current folder, and defaults to `catalog/packs` there, which is right only inside a checkout of this repository. New packs belong in the pack library, so run it from the library checkout with `--root packs` (for example `node ../radiobot/scripts/pack-author.ts new mypack --root packs`). With a `pack-ids.json` (given, or found next to the root folder), it refuses an ID that has ever been used.                                                                                                                                                                                                                                                                                                                                                              |
| `node scripts/pack-author.ts export <pack-dir> [--force]`                                                                      | Writes the pack's stations and sources to `intake.csv`: one row per source, and one row with an empty `url` for each station that has no source yet. An `intake.csv` that already has rows saying something else may hold edits `generate` hasn't read yet, so `export` refuses to replace it (exit code 1, nothing changed): run `generate` first, or add `--force` to replace it anyway. The file is written whole and then renamed into place.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `node scripts/pack-author.ts generate <pack-dir> [--base <git-ref>]`                                                           | Reads `intake.csv` back into `stations.json`, `sources.json` and the sources table of `SOURCE_PROVENANCE.md` (between `<!-- sources:start -->` and `<!-- sources:end -->`). It never changes or removes an existing station slug or source ID, keeps an old name as an alias on a rename, makes slugs and source IDs for new rows, bumps `version` when a station or source changed, and writes nothing if any problem is found. It doesn't look at `pack.json`: after editing `pack.json` by hand, raise its `version` yourself, because `diff-check` refuses a change to a published pack whose version didn't go up. Without `--base`, every run that changes something bumps the version again (today's date, then `.2`, `.3` …). With `--base` (for example `origin/main` in a library checkout), it reads the published `pack.json` from git at that ref and bumps once against it, however often you run it; a pack that isn't there yet keeps the date `new` gave it. |
| `node scripts/pack-author.ts build-library <packs-root> <out-dir> --base-url <url> [--collections <dir>] [--withdrawn <file>]` | Writes a library's `index.json` and one bundle per pack into `<out-dir>`, with bundle addresses under `--base-url`. Withdrawn packs come from `withdrawn.json` (given, or found next to `<packs-root>`), and collections from one JSON file each in `--collections`. See [Building a library](#building-a-library) for those files and what it refuses.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `node scripts/pack-author.ts diff-check <old-pack-dir> <new-pack-dir>`                                                         | Checks a change to a published pack: the pack ID is the same, no station or source was removed (retire or disable them instead), and the `version` went up if anything changed.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |

### intake.csv

`intake.csv` is a spreadsheet of the pack that is easier to fill in than the JSON files. The first row names the columns; columns may be in any order and may be left out. An empty cell keeps the existing value (edit the JSON to clear one), with one exception: a row that sets `enabled` to `true` and leaves `disabled_reason` empty clears the source's `disabledReason`. Lists (`aliases`, `tags`) are separated by `|`.

| Column                                                                                                                  | Becomes                                                                                                                                                                                                                              |
| ----------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `station`                                                                                                               | The station's `displayName`. Required on every row; the rows of one station are matched by `slug`, then by name or alias.                                                                                                            |
| `slug`, `aliases`, `category`, `tags`, `order`, `external_id`, `official_page`, `country`, `region`, `catalogue_status` | The station's fields of the same names (`externalId`, `officialPage`, `catalogueStatus`). Where a station has several rows, they must agree, except `aliases`: those of all its rows are combined (and aliases are only ever added). |
| `url`                                                                                                                   | The source's address. A row without one only describes the station.                                                                                                                                                                  |
| `label`, `transport`, `codec`, `priority`, `provenance`, `provenance_detail`, `enabled`, `disabled_reason`              | The source's `label`, `transportHint`, `codecHint`, `priority`, `provenance`, `provenanceDetail`, `enabled` and `disabledReason`. A row with a `url` needs `provenance`.                                                             |
| `found_at`, `found_on`                                                                                                  | Where (a page address) and when (`YYYY-MM-DD`) the address was found. For a new source without `provenance_detail`, they make one: "Linked from … on …".                                                                             |

### Building a library

Besides the pack folders, a library keeps three kinds of file that the tools read:

- **`pack-ids.json`**, next to the folder of packs: `{ "schemaVersion": 1, "ids": ["…"] }`, every pack ID the library has ever used, withdrawn ones included. `new` refuses an ID in its `ids` list (only that list is read), and never edits the file: add the new ID yourself.
- **`withdrawn.json`**, next to the folder of packs (or given with `--withdrawn`): `{ "schemaVersion": 1, "packs": [ … ] }`, one entry per pack taken out of the library. Each entry needs `id`, `reason` (1–300 characters, shown to admins), `date` (`YYYY-MM-DD`) and `name` (1–80 characters), and may repeat the pack's `description`, `version`, `owner`, `countries`, `regions`, `languages`, `stations`, `sources` and `minBotVersion` for its listing. Without a `version`, the entry's is its date written `YYYY.MM.DD`. A withdrawn pack's folder must be gone.
- **Collections**, one JSON file each in the `--collections` folder, read in file-name order: `{ "id", "name", "description", "packs": [ … ] }`. `id` is lower-case letters, digits and `-`, starting with a letter or digit, at most 40 characters, and must not be `country-<code>` (those are made automatically, see [Pack libraries](#pack-libraries)); `name` is 1–80 characters; `description` is optional, at most 300; `packs` lists at most 500 IDs of packs in the library.

`build-library` checks everything before it writes anything, lists every problem it finds, and exits with code 1 if there are any. It refuses:

- a folder of packs that doesn't exist, or a folder in it (other than one starting with `.` or `_`) without a `pack.json`;
- a pack that fails the pack checks, whose folder isn't named after its ID, or that has no `version`;
- two packs with the same pack ID or source ID;
- a `withdrawn.json` that isn't valid, names a pack twice, or names a pack whose folder is still there;
- a bundle larger than 8 MiB;
- a `--collections` folder that doesn't exist, a collection file that isn't valid or names a pack that isn't available, a collection with a reserved `country-<code>` ID, and two collections with the same ID;
- an index that breaks the index format (for example more than 500 collections), or that would be larger than 2 MiB, the most a bot accepts.

## Your own packs (operators)

Put pack folders in one directory and point `EXTRA_PACKS_DIR` at it. In Docker, use a folder inside the data volume so it survives updates, for example `EXTRA_PACKS_DIR=/app/data/my-packs`. Don't point it at the installed-packs folder, which the bot and `radio-bot packs` manage. Restart the bot to load changes. A pack that fails validation stops start-up with a message naming the file and field, so a broken edit is never half-loaded.

## Changing a published pack

Pack files are read again on every start (and installed packs whenever they are installed, updated or reloaded) and copied into the database. Station IDs and source IDs are permanent keys, so never reuse one for something else.

- **Renaming a station:** change `displayName` and add the old name to `aliases`, so people searching for it still find it. The ID, favourites and queue entries stay. Aliases are only ever added: removing one from the file doesn't remove it from an installation that already has it.
- **Changing a source's URL** resets what the bot knew about that source: its measurements, identity evidence, health and any operator review. It is checked again the next time it's needed. Servers' pins and preferences for it stay.
- **Moving a source to another station** does the same, and also clears servers' pins and preferences that pointed to it.
- **Removing a source** from `sources.json`: the bot disables it when it next loads the pack ("removed from the pack manifest") and keeps its history. Setting `enabled: false` with a `disabledReason` is clearer, because the reason is shown. Library packs never remove a source (`diff-check` refuses it).
- **Removing a station:** give it `catalogueStatus: "retired"` instead of deleting it, so that servers see why it went away. A station deleted from `stations.json` (its sources must go too, or validation fails) stays in existing installations, listed as "No stream source known". Library packs never remove a station.

## Rules for packs

- Only publicly accessible streams. Never signed, expiring, authenticated or geo-restricted URLs, and nothing that needs the bot to pretend to be a browser or an app.
- Every source needs provenance and a date, in `provenanceDetail` and in a matching entry in the pack's `SOURCE_PROVENANCE.md`. Station-to-URL mappings must come from the broadcaster's own site or player, or be reviewed against it. Never commit addresses found automatically.
- Packs carry no logos or artwork. Radio Bot always shows its own "not affiliated with or endorsed by any broadcaster" notice with station lists, so a pack's `disclaimer` is optional. If you add one, don't use it to name the broadcaster.
- Read [docs/rights-and-disclaimer.md](../docs/rights-and-disclaimer.md) before proposing a pack, and the library's playbook for how packs are proposed, reviewed and withdrawn.
