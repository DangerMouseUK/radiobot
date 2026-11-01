# Station packs

Radio Bot's built-in stations come from **station packs**. A pack is a folder of three JSON files. The bot loads every pack folder it finds in `catalog/packs/` (shipped with the bot) and in `EXTRA_PACKS_DIR` (your own packs). Nothing in the code is specific to any pack: adding a group of stations means adding a folder.

The repository ships with one unofficial starter pack of 63 stations in [`packs/`](packs/). Each bundled pack's folder has its own `SOURCE_PROVENANCE.md` and an `evidence/` folder.

## Folder layout

```text
catalog/packs/<pack-id>/
├── pack.json            metadata (required)
├── stations.json        the stations (required)
├── sources.json         candidate stream URLs (optional; stations without sources are listed but not playable)
├── SOURCE_PROVENANCE.md where each source came from (recommended)
└── evidence/            probe reports from `validate-catalogue --json` (optional)
```

Folders whose names start with `.` or `_` are ignored.

## pack.json

```json
{
  "schemaVersion": 1,
  "id": "example",
  "name": "Example Radio Network",
  "description": "What this group of stations is.",
  "disclaimer": "Unofficial: not affiliated with Example Radio Network.",
  "order": 50,
  "enabledByDefault": true,
  "brandLabels": ["Example Radio", "Example Network"],
  "categories": [{ "id": "news", "name": "News" }, { "id": "music", "name": "Music" }],
  "sync": null,
  "snapshotDate": "2026-10-31"
}
```

Required: `schemaVersion` (always `1`), `id` and `name`. Everything else is optional and defaults as shown below.

| Field              | Meaning                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `id`               | Required. Lower-case letters, digits and `-`, starting with a letter or digit, up to 32 characters. Becomes the prefix of every station ID (`example:<slug>`). `custom` is reserved. Must be unique across all loaded packs.                                                                                                                                                                                                                                                                                                                     |
| `name`             | Required, 1–80 characters. Shown in `/radio browse`, `/radio list` and `/radio stats`.                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `description`      | Up to 500 characters (default empty).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `disclaimer`       | Up to 500 characters, or `null` (default). Shown with the pack; use it for stations the project is not affiliated with.                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `order`            | Integer 0–10000 (default 100). Packs are listed in ascending order (the starter pack uses 10).                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `enabledByDefault` | `true` (default) or `false`. If `false`, operators opt in with `ENABLED_PACKS`. Operators can switch any pack off with `DISABLED_PACKS`, which wins over `ENABLED_PACKS`.                                                                                                                                                                                                                                                                                                                                                                        |
| `brandLabels`      | Up to 50 strings of 1–60 characters (default none). Publisher or network names that appear in stream metadata of _several_ stations (for example "Example Radio"). They are never treated as evidence that a feed is a particular station.                                                                                                                                                                                                                                                                                                       |
| `categories`       | Up to 25 `{ "id", "name" }` objects (default none). `id` uses the slug format below; `name` is 1–60 characters. Stations may only use declared category IDs.                                                                                                                                                                                                                                                                                                                                                                                     |
| `sync`             | `null` (default) or `{ "adapter": "<name>", "url": "<official list URL>" }` to reconcile station names with an official list every `CATALOG_SYNC_INTERVAL_HOURS` (24 by default) and on `/radio sync`. Adapters live in `src/catalogue/sync-adapters.ts`: `webradio-apidata` (a `webradios[]` list in a page's embedded `var apidata` JSON; only each entry's `label` and `id` are read) and `json-name-list` (a JSON array of `{ "id", "name" }`, or `{ "stations": [...] }`). Sync only reads names and stable IDs; it never adds stream URLs. |
| `snapshotDate`     | `YYYY-MM-DD` or `null` (default): the date the station list was taken from the official source.                                                                                                                                                                                                                                                                                                                                                                                                                                                  |

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

A file holds 1–2000 stations. Only `slug`, `displayName` and `order` are required. The station ID is `<pack-id>:<slug>` and must never change once published, because server favourites and settings refer to it. Every name and alias must identify exactly one station in the pack.

| Field               | Meaning                                                                                                                                                                |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `slug`              | Required. Lower-case letters, digits and `-`, starting with a letter or digit, up to 32 characters (so station IDs fit in Discord button IDs). Unique within the pack. |
| `displayName`       | Required, 1–100 characters.                                                                                                                                            |
| `order`             | Required, integer 0–100000. Position within the pack.                                                                                                                  |
| `externalId`        | Up to 64 characters, or `null` (default). The station's ID in the official list, used to detect renames during sync.                                                   |
| `aliases`           | Up to 20 strings of 1–100 characters (default none).                                                                                                                   |
| `category`          | A category `id` declared in `pack.json`, or `null` (default).                                                                                                          |
| `tags`              | Up to 30 strings of 1–40 characters (default none). Used by search.                                                                                                    |
| `officialPage`      | A URL, or `null` (default).                                                                                                                                            |
| `catalogueStatus`   | `active` (default), `missing_from_official` or `retired`.                                                                                                              |
| `catalogueLastSeen` | `YYYY-MM-DD` or `null` (default).                                                                                                                                      |
| `description`       | Up to 300 characters, or `null` (default).                                                                                                                             |

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

A file holds up to 10000 sources. Required: `id`, `station`, `url`, `provenance` and `provenanceDetail`. A pack without `sources.json` is valid; its stations are listed but not playable.

| Field              | Meaning                                                                                                                                                                                                                                                                                                                                                            |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `id`               | Required. Lower-case letters, digits and `-`, starting with a letter or digit, up to 100 characters. Unique across **all** packs; prefix it with the pack ID. Never reuse an ID for a different URL.                                                                                                                                                               |
| `station`          | Required. The station's `slug` in this pack.                                                                                                                                                                                                                                                                                                                       |
| `url`              | Required. A public `http(s)` stream: direct (Icecast/SHOUTcast/MP3/AAC/Opus), PLS/M3U, or HLS. No credentials or signed/expiring tokens. A URL may belong to only one station.                                                                                                                                                                                     |
| `label`            | Up to 60 characters, or `null` (default). Display only.                                                                                                                                                                                                                                                                                                            |
| `priority`         | Integer 0–10000 (default 100). Lower first; used only as the final tie-break after transport, measured quality, health and latency (PRD FR-006).                                                                                                                                                                                                                   |
| `transportHint`    | `http-continuous`, `hls` or `null` (default). Shown before the first probe; never treated as evidence.                                                                                                                                                                                                                                                             |
| `codecHint`        | Up to 20 characters, or `null` (default). Shown before the first probe; never treated as evidence.                                                                                                                                                                                                                                                                 |
| `provenance`       | Required. `official-player` (the broadcaster's own player or site maps this URL to this station) or `curated` (a reviewed mapping with recorded evidence). Either lets the source be identity-verified after a successful probe; sources discovered any other way stay unverified until an operator reviews them or an audio comparison matches a verified source. |
| `provenanceDetail` | Required, 1–1000 characters: where the mapping came from and when.                                                                                                                                                                                                                                                                                                 |
| `enabled`          | `true` (default) or `false`. Ship a known-broken source disabled rather than deleting it.                                                                                                                                                                                                                                                                          |
| `disabledReason`   | Up to 300 characters, or `null` (default). Why the source is disabled.                                                                                                                                                                                                                                                                                             |

The bot probes every source itself (codec, bitrate, sample rate, channels, identity) before using it, so hints and labels never become claims.

## Checking a pack

```bash
pnpm build
node dist/scripts/validate-catalogue.js --pack catalog/packs/example
node dist/scripts/validate-catalogue.js --probe --pack-id example --json catalog/packs/example/evidence/probe.json
```

The first command validates the files (schema, unique slugs and names, category and station references, no URL shared by two stations). Without `--pack` it validates every pack in `catalog/packs/` and `EXTRA_PACKS_DIR`, and also checks that pack IDs and source IDs are unique across packs. The second probes every enabled source of the pack once, one at a time, and writes the evidence. Add `--compare` to run an audio comparison (about 40 s) between the working sources of each probed station, or name stations instead of `--pack-id` (for example `--probe example:example-one`).

## Your own packs (operators)

Put pack folders in a directory and point `EXTRA_PACKS_DIR` at it, for example `EXTRA_PACKS_DIR=/app/data/packs` in Docker (inside the persistent volume). Restart the bot to load changes. A pack that fails validation stops start-up with a message naming the file and field, so a broken edit is never half-loaded.

## Changing a published pack

Pack files are re-read and re-seeded into the database on every start. Station IDs and source IDs are stable keys, so never reuse an ID for something else.

- **Renaming** a station keeps its ID, favourites and queue entries.
- **Changing a source's URL, or moving a source to another station,** resets that source's identity evidence, health and operator override, and clears any server's pin or preference for it, because the evidence was about a different stream. It is re-probed the next time it's needed.
- **Removing** a source or station from the files doesn't delete history: give the station `catalogueStatus: "retired"`, or disable the source, so that servers see why it went away.

## Rules for packs in this repository

- Only publicly accessible streams. Never signed, expiring, authenticated or geo-restricted URLs, and nothing that requires imitating a browser or app.
- Every source needs provenance and a date. Station-to-URL mappings must come from the broadcaster's own site or player, or be reviewed against it.
- Packs carry no logos or artwork. Radio Bot always shows its own "not affiliated with or endorsed by any broadcaster" notice with station lists, so a pack's `disclaimer` is optional; if you add one, don't use it to name the broadcaster.
- Read [docs/rights-and-disclaimer.md](../docs/rights-and-disclaimer.md) before proposing a pack.
