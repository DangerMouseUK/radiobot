# Station packs

Radio Bot's built-in stations come from **station packs**. A pack is a folder of JSON files that lists a group of stations and the stream addresses (_sources_) that carry them. The bot loads every pack folder it finds in `catalog/packs/` (shipped with the bot) and in `EXTRA_PACKS_DIR` (your own packs). Nothing in the bot's code is specific to any pack: adding a group of stations means adding a folder.

The repository ships with one unofficial starter pack of 63 stations in [`packs/`](packs/). Each bundled pack's folder has its own `SOURCE_PROVENANCE.md` and an `evidence/` folder.

A pack only says where a station's streams are and where that information came from. The bot checks every source itself before playing it: format, bitrate, sample rate, channels and whether it really is that station. Nothing written in a pack is ever shown as a measured fact. How the bot decides is explained in [docs/station-verification.md](../docs/station-verification.md).

## Folder layout

```text
catalog/packs/<pack-id>/
├── pack.json            metadata (required)
├── stations.json        the stations (required)
├── sources.json         candidate stream URLs (optional; stations without sources are listed but can't play)
├── SOURCE_PROVENANCE.md where each source came from (required for packs in this repository)
└── evidence/            check reports from `validate-catalogue --json` (optional)
```

Only folders that contain a `pack.json` are loaded. Folders whose names start with `.` or `_` are ignored.

Each JSON file has `"schemaVersion": 1`. A field marked _optional_ below may be left out, and then takes the default shown.

## pack.json

```json
{
  "schemaVersion": 1,
  "id": "example",
  "name": "Example Radio Network",
  "description": "What this group of stations is.",
  "disclaimer": "Unofficial: not affiliated with the stations listed.",
  "order": 50,
  "enabledByDefault": true,
  "brandLabels": ["Example Radio", "Example Network"],
  "categories": [{ "id": "news", "name": "News" }, { "id": "music", "name": "Music" }],
  "sync": null,
  "snapshotDate": "2026-10-31"
}
```

Required: `schemaVersion`, `id` and `name`.

| Field              | Meaning                                                                                                                                                                                                                                                                                                                                     |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`               | Required. Lower-case letters, digits and `-`, starting with a letter or digit, at most 32 characters. Becomes the first part of every station ID (`example:<slug>`), and is what operators use in `ENABLED_PACKS` and `DISABLED_PACKS`. `custom` is reserved. Must be unique across all loaded packs, and must never change once published. |
| `name`             | Required, 1–80 characters. Shown in `/radio browse`, `/radio list` and `/radio stats`.                                                                                                                                                                                                                                                      |
| `description`      | Optional, at most 500 characters (default empty). For people reading the file; the bot doesn't show it.                                                                                                                                                                                                                                     |
| `disclaimer`       | Optional, at most 500 characters, or `null` (default). Shown in the footer of `/radio list` when this pack is listed. Use it for stations the project is not affiliated with.                                                                                                                                                               |
| `order`            | Optional whole number from 0 to 10000 (default 100). Packs are listed lowest first; the starter pack uses 10.                                                                                                                                                                                                                               |
| `enabledByDefault` | Optional, `true` (default) or `false`. With `false`, operators switch the pack on with `ENABLED_PACKS`. Operators can switch any pack off with `DISABLED_PACKS`, which wins over `ENABLED_PACKS`.                                                                                                                                           |
| `brandLabels`      | Optional, at most 50 strings of 1–60 characters (default none). Publisher or network names that appear in the stream names of _several_ stations (for example "Example Radio"). The bot never treats them as evidence that a stream is one particular station. Names are compared ignoring case, accents and punctuation.                   |
| `categories`       | Optional, at most 25 `{ "id", "name" }` objects (default none). `id` uses the slug format below; `name` is 1–60 characters. Stations may only use categories declared here.                                                                                                                                                                 |
| `sync`             | Optional, `null` (default) or `{ "adapter": "<name>", "url": "<official list URL>" }`. See [Keeping names in line with an official list](#keeping-names-in-line-with-an-official-list).                                                                                                                                                     |
| `snapshotDate`     | Optional, `YYYY-MM-DD` or `null` (default): the date the station list was taken from the official source. For people reading the file; the bot doesn't show it.                                                                                                                                                                             |

### Keeping names in line with an official list

With `sync` set, the bot compares the pack's station names with the official list at that URL. It does this once every `CATALOG_SYNC_INTERVAL_HOURS` (24 by default, 6 to 720) plus a random delay of up to 15 minutes, and when an admin runs `/radio sync`. The fetch goes through the bot's safe HTTP client and is limited to 6 MiB and 20 s.

The `adapter` names the code that reads the list. Adapters live in `src/catalogue/sync-adapters.ts`:

| Adapter            | Reads                                                                                                                                                                                                                                                                           |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `webradio-apidata` | A web page with a `var apidata = { … }` script whose `webradios` array lists the stations. Only each entry's `label` (the name) and `id` are read, and entries with `displayOnWebsite: false` are skipped. If that script isn't found, the page's station menu is used instead. |
| `json-name-list`   | A JSON array of `{ "id", "name" }`, or an object `{ "stations": [ … ] }` holding one.                                                                                                                                                                                           |

A sync reads **only names and stable IDs**. It never adds stream URLs: new sources only ever come from a reviewed change to `sources.json`. It matches stations by `externalId` first, then by name. It handles renamed stations, new stations and stations that have left the list, without ever deleting anything. It refuses a list that looks broken and changes nothing: a list of more than 5,000 names, or of fewer than 10 (for a pack of fewer than 20 stations, fewer than half as many names as the pack has stations). The full behaviour is in [docs/station-verification.md](../docs/station-verification.md#catalogue-sync).

To support a new kind of official list, add a generic adapter function to `src/catalogue/sync-adapters.ts`, register it in `SYNC_ADAPTERS`, and name it in `pack.json`. Never add code that is specific to one pack. Adapters run on a separate worker thread, so they can't disturb the stream. An adapter is a plain function that takes the page text and returns names and IDs, and it must not import anything that needs the rest of the bot.

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
      "catalogueLastSeen": "2026-10-31",
      "description": null
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
      "provenanceDetail": "Linked from the station's own web player on 2026-10-31.",
      "enabled": true,
      "disabledReason": null
    }
  ]
}
```

A file holds at most 10000 sources. Required: `id`, `station`, `url`, `provenance` and `provenanceDetail`. A pack without `sources.json` is valid; its stations are listed but can't play.

| Field              | Meaning                                                                                                                                                                                                                                                                                       |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`               | Required. Lower-case letters, digits and `-`, starting with a letter or digit, at most 100 characters. Unique across **all** packs, so start it with the pack ID. Never reuse an ID for a different stream.                                                                                   |
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
node scripts/validate-catalogue.ts --pack catalog/packs/example
node scripts/validate-catalogue.ts --pack catalog/packs/example --probe --pack-id example --json catalog/packs/example/evidence/probe.json
```

Or build first and run the compiled copy: `pnpm build`, then `node dist/scripts/validate-catalogue.js` with the same options.

- **The first command** validates the files: the schema, unique slugs and names, category and station references, and no URL shared by two stations. It prints how many stations and sources the pack has, and lists stations with no enabled source. Without `--pack`, it validates every pack in `catalog/packs/` and `EXTRA_PACKS_DIR`, and also checks that pack IDs and source IDs are unique across packs.
- **The second command** checks every enabled source of the pack live, one at a time, and writes the evidence to the `--json` file. It needs FFmpeg and FFprobe (on the `PATH`, or set `FFMPEG_PATH` and `FFPROBE_PATH`). You need `--pack` as well only when the folder isn't in `catalog/packs/` or `EXTRA_PACKS_DIR`.
- Add `--compare` to compare the audio (about 40 s each) of the working sources of each checked station. To check only some stations, name them instead of `--pack-id`, for example `--probe example:example-one`.

Live checks connect to real stream servers. Run them only when you are deliberately gathering evidence, and sparingly.

## Your own packs (operators)

Put pack folders in one directory and point `EXTRA_PACKS_DIR` at it, for example `EXTRA_PACKS_DIR=/app/data/packs` in Docker (inside the data volume, so it survives updates). Restart the bot to load changes. A pack that fails validation stops start-up with a message naming the file and field, so a broken edit is never half-loaded.

## Changing a published pack

Pack files are read again on every start and copied into the database. Station IDs and source IDs are permanent keys, so never reuse one for something else.

- **Renaming a station:** change `displayName` and add the old name to `aliases`, so people searching for it still find it. The ID, favourites and queue entries stay. Aliases are only ever added: removing one from the file doesn't remove it from an installation that already has it.
- **Changing a source's URL** resets what the bot knew about that source: its measurements, identity evidence, health and any operator review. It is checked again the next time it's needed. Servers' pins and preferences for it stay.
- **Moving a source to another station** does the same, and also clears servers' pins and preferences that pointed to it.
- **Removing a source** from `sources.json`: the bot disables it at the next start ("removed from the pack manifest") and keeps its history. Setting `enabled: false` with a `disabledReason` is clearer, because the reason is shown.
- **Removing a station:** give it `catalogueStatus: "retired"` instead of deleting it, so that servers see why it went away. A station deleted from `stations.json` (its sources must go too, or validation fails) stays in existing installations, listed as "No stream source known".

## Rules for packs in this repository

- Only publicly accessible streams. Never signed, expiring, authenticated or geo-restricted URLs, and nothing that needs the bot to pretend to be a browser or an app.
- Every source needs provenance and a date, in `provenanceDetail` and in a matching entry in the pack's `SOURCE_PROVENANCE.md`. Station-to-URL mappings must come from the broadcaster's own site or player, or be reviewed against it. Never commit addresses found automatically.
- Packs carry no logos or artwork. Radio Bot always shows its own "not affiliated with or endorsed by any broadcaster" notice with station lists, so a pack's `disclaimer` is optional. If you add one, don't use it to name the broadcaster.
- Read [docs/rights-and-disclaimer.md](../docs/rights-and-disclaimer.md) before proposing a pack.
