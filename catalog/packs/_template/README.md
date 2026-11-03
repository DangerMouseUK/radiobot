# Template pack

This folder is a complete, working example of a station pack. Every field is filled in, so you can see what each one looks like. All the names and addresses are made up (`example.org` addresses never lead anywhere).

The bot never loads this folder by itself, because its name starts with `_`. To start a pack of your own, copy it with the pack tool rather than by hand:

```bash
node scripts/pack-author.ts new my-pack --root catalog/packs
```

That makes `catalog/packs/my-pack/` with the files below, emptied out and ready to fill in, and prints the next steps. The full rules for packs are in [catalog/README.md](../../README.md).

JSON files can't hold comments, so this file explains them instead.

## The files

- **`pack.json`**: what the pack is and who the stations belong to.
- **`stations.json`**: the stations: their names, and how they are grouped and sorted.
- **`sources.json`**: the stream addresses for each station, and where each address came from.
- **`SOURCE_PROVENANCE.md`**: a written record of where the station list and every stream address came from, what was checked and what wasn't. Every source ID must appear in it. The table between `<!-- sources:start -->` and `<!-- sources:end -->` is written by `pack-author.ts generate`; write everything else yourself.
- **`evidence/`**: reports from checking the streams, written by `node scripts/validate-catalogue.ts --probe --json evidence/probe-YYYY-MM-DD.json`. The date in the file name tells people when the streams were last checked. The report here is a made-up example.
- **`intake.csv`** (not in this folder): a spreadsheet of the stations and streams that `pack-author.ts export` writes and `pack-author.ts generate` reads back into the JSON files. One row per stream; a station with no stream yet gets one row with an empty `url`.

Never put logos, artwork or other images in a pack.

## pack.json

- `schemaVersion`: always `1`.
- `id`: the pack's permanent ID, such as `my-pack`. Lower-case letters, digits and `-`, at most 32 characters. It becomes the first part of every station ID (`my-pack:my-station`) and can never change once published. `custom` is reserved.
- `name`: the name people see, up to 80 characters.
- `description`: a sentence or two about the pack, up to 500 characters.
- `version`: the date the pack last changed, written `YYYY.MM.DD`. For a second change on the same day, add `.2`, then `.3` and so on. `pack-author.ts generate` sets it for you.
- `owner`: who the stations belong to. `name` is the company; `kind` is `broadcaster` (one broadcaster's own stations), `group` (a company that owns several brands) or `curated` (a hand-picked list from several owners); `brand` is the brand name when a big brand has a pack of its own, otherwise `null`.
- `countries`: the countries the stations are in, as two-letter codes in capitals, such as `GB` or `FR`.
- `regions`: areas within those countries, in plain words, such as a county or a city. Up to 60 characters each. May be empty.
- `languages`: the languages the stations broadcast in, as language codes such as `en`, `fr` or `pt-BR`.
- `minBotVersion`: the oldest Radio Bot that can use the pack, such as `1.1.0`, or `null`. Older bots skip the pack.
- `disclaimer`: an optional note shown with the station list, or `null`. Don't use it to name a broadcaster.
- `order`: where the pack is listed among other packs, lowest first. `100` is fine.
- `enabledByDefault`: `true` to switch the pack on for everyone who installs it; `false` to leave it off until an operator switches it on.
- `brandLabels`: names that appear in the stream names of several stations (a network name, for example). The bot never takes them as proof that a stream is one particular station.
- `categories`: the groups that stations can be put in, each with an `id` (like a slug) and a `name`.
- `sync`: `null`, or a link to an official station list that the bot compares names with. See catalog/README.md.
- `snapshotDate`: the date the station list was taken, `YYYY-MM-DD`, or `null`.

## stations.json

Each station has:

- `slug`: the station's permanent ID within the pack, such as `example-hits`. Lower-case letters, digits and `-`, at most 32 characters. Never change it: favourites and queues point to it.
- `displayName`: the name people see. To rename a station, change this and keep the old name in `aliases`. `pack-author.ts generate` does that for you.
- `externalId`: the station's ID in the official list, or `null`.
- `aliases`: other names people might search for.
- `category`: one of the category IDs from `pack.json`, or `null`.
- `tags`: a few words for search, such as `pop` or `news`. The first three are shown in lists.
- `order`: the station's position in the pack, lowest first.
- `officialPage`: the station's own web page, or `null`.
- `catalogueStatus`: `active`, `missing_from_official` (no longer in the official list) or `retired` (closed; it can't be played). Never delete a station: retire it.
- `catalogueLastSeen`: when the station was last seen in the official list, `YYYY-MM-DD`, or `null`.
- `description`: a short note for people reading the file, or `null`.
- `country` and `region`: only for a station in a different country or region from the rest of the pack; otherwise `null`.

## sources.json

Each source is one stream address for one station:

- `id`: the source's permanent ID. Start it with the pack ID, as in `template-example-hits-mp3`. It must be unique across every pack. `pack-author.ts generate` makes one for you.
- `station`: the slug of the station it belongs to.
- `url`: the public stream address, starting `https://` (or `http://`). No user names, passwords, or signed or expiring tokens.
- `label`: a short name shown in the sources list, such as `Direct MP3`.
- `priority`: a tie-break between otherwise equal sources, lowest first.
- `transportHint`: `http-continuous` for a direct stream, `hls` for an HLS playlist, or `null`. Only a hint: the bot checks for itself.
- `codecHint`: the format, such as `mp3` or `aac`, or `null`. Only a hint.
- `provenance`: `official-player` (the broadcaster's own player or site links this address to this station) or `curated` (a reviewed mapping with a written record).
- `provenanceDetail`: where the address was found and on what date, such as "Linked from https://www.example.org/hits/listen on 2026-11-03."
- `enabled`: `true`, or `false` for a source that doesn't work. Never delete a source: switch it off.
- `disabledReason`: why a source is switched off, or `null`.

## Checking your pack

```bash
node scripts/validate-catalogue.ts --pack catalog/packs/my-pack --strict
```

`--strict` adds the rules for packs in the pack library: a version, an owner, at least one country and language, every source in `SOURCE_PROVENANCE.md`, a report in `evidence/`, no images and no signed addresses.
