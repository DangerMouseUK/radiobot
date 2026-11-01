# Station verification and source selection

Radio Bot follows one rule above all: **play the correct station before the highest bitrate.** This page explains how a candidate source becomes eligible, how station identity is decided, how sources are ranked, how admins can override the ranking, and what the bundled starter pack contains.

The code lives in `src/streams/identity.ts`, `src/streams/ranking.ts`, `src/streams/source-service.ts`, `src/catalogue/packs.ts` and `src/catalogue/sync.ts`. Radio Bot is unofficial and is not affiliated with or endorsed by any broadcaster; see [rights-and-disclaimer.md](rights-and-disclaimer.md).

## Stations and sources

- A **station** is an editorial programme, for example `mypack:my-station` ("My Station"). It has a stable ID, a display name, aliases, tags, a category and a catalogue status: `active`, `missing_from_official` or `retired`.
- A **source** is one endpoint that may carry a station. Besides its URL, a source records:
  - transport and codec hints (hints are not evidence);
  - measured facts: transport, container, codec, profile, sample rate, channels, and advertised, codec and measured bitrate;
  - identity status, confidence and an evidence log;
  - provenance;
  - health score, failure counters and cooldown;
  - enabled/disabled, with a reason.

Pack stations come from **station packs**. Each pack is a folder under `catalog/packs/` (or `EXTRA_PACKS_DIR`) with `pack.json`, `stations.json` and (optionally) `sources.json`; the authoring guide is [catalog/README.md](../catalog/README.md). Station IDs are `<pack-id>:<slug>`, and the station's provider is its pack ID. Custom stations (provider `custom`) belong to one Discord server and each has a single source.

## Candidate states

Each source has a `verification_state`. The PRD (§7.2) describes a longer chain; v1 sets only these states:

| State | Set when | Eligible? |
|---|---|---|
| `discovered` | Seeded from the manifest or added, and not probed yet. Also reset to this when a pack source's URL changes. | No: "not yet probed" |
| `eligible` | The last probe succeeded, the audio decoded, and the identity decision is `verified`. | Yes, unless something else in the gate fails (see below) |
| `degraded` | As `eligible`, but the decode check logged more than 3 errors. | Yes. The station shows as Degraded if this is its only kind of source. |
| `unverified` | The probe succeeded but identity is not verified. | No: "station identity not verified" |
| `offline` | The last probe failed: access denied (401/403/451), another HTTP status, a timeout, a decode failure, no audio and so on. It is re-probed at most every 10 min unless an admin rescans. | No: "last probe failed (code)" |
| `blocked_by_policy` | The probe failed on a policy rule: `ADDRESS_BLOCKED`, a disallowed URL host, port, scheme or credentials, or `HLS_ENCRYPTED`. | No |
| `cooldown` | Circuit-broken after 4 consecutive playback failures (the first plus three retries). | No, until `cooldown_until` passes |

The type definitions also reserve `resolved`, `transport_healthy`, `codec_verified`, `identity_verified` and `retired` for finer-grained tracking later; v1 does not set them. Each probe records the same facts in `source_probe_results` as evidence instead.

### The eligibility gate

`checkEligibility()` lets a source be selected only if **all** of these hold:

- it is enabled, and not disabled by the manifest or by `DISABLED_SOURCE_IDS` / `DISABLED_STATION_IDS`;
- its `rights_status` is not `blocked` (a database-level flag; v1 has no command to set it);
- its identity status is `verified`, and is not `mismatch`;
- it is not blocked by policy;
- it has been probed, its last probe did not fail, and a codec was measured;
- it is not in cooldown.

When nothing is eligible, the station is not played. **Another station is never played in its place**, and the reply lists why each source was rejected.

### Station availability labels

The labels shown in `/radio browse`, `list` and autocomplete come from `SourceService.availability()`:

| Label | Meaning |
|---|---|
| Available | At least one eligible source, and the best one's health is 30 or more. |
| Degraded | Eligible sources exist, but all are health < 30 or all are in the `degraded` state. |
| Unverified | Some enabled source hasn't been probed yet, or was probed but its identity is unverified. **On a fresh install every pack station shows this until its sources are probed**, which happens on first play or `/radio rescan`. |
| Temporarily unavailable | Every enabled source is failing, cooling down or mismatched, or the operator disabled the station. |
| No stream source known | The station is catalogued, but no enabled source is mapped. It cannot be played. |
| Retired | Retired from the catalogue. |

## Identity rules

`decideIdentity()` in `src/streams/identity.ts` combines the signals **in this order**:

1. **An administrator override is authoritative.** A `/radio source verify` verdict of `verified` or `mismatch` decides the status with `high` confidence, and is recorded in the evidence log as a subjective review. `clear` removes the override.
2. **Audio correlation with an already-verified source counts as strong support.** If the latest correlation evidence `supports`, the status is `verified` with `high` confidence.
3. **A metadata contradiction without correlation support means `mismatch`.** The source is never promoted automatically. This applies when the stream's `icy-name` is exactly the name of a *different* station in any loaded pack. That check comes **before** any match against this station's own aliases. A short alias such as "Example" can therefore never turn another station's name, such as "Example Dance", into support. The only exception is when that exact name is also one of this station's own names or aliases.
4. **Provenance from the official player, curation or the admin who added a custom station means `verified` with `medium` confidence.** If the `icy-name` also matches the station's name or an alias, confidence is `high`.
5. **Anything else is `unverified` with `low` confidence.** This covers sources that were discovered automatically and have no authoritative mapping.

**A correlation failure on its own never demotes a source.** A failed or weak alignment is recorded as *inconclusive*, not as a mismatch, because a few seconds of different adverts between two CDN feeds don't prove they carry a different programme.

### Brand labels

Some names are publisher or brand labels rather than programme names. Each pack declares its own in `pack.json` → `brandLabels`, for example `["Example Radio", "Example"]`. The starter pack declares its broadcaster's brand and network names.

When a stream's `icy-name` (normalised: case, accents and punctuation folded) is one of the station's pack's brand labels, the metadata signal is **inconclusive**. Seeing "Example Radio" in a stream header says nothing about whether it carries "Example Dance" or "Example Chill". Brand labels are also ignored among the station's own aliases. This is how the PRD §3.1 rule is applied.

Only the stream *name* (`icy-name`) is used for identity. `StreamTitle` (the current song) is only shown as now-playing text.

### Live re-check on every connection

`icy-name` is checked when a source is probed, and again **each time playback opens the source**. This covers the first start, reconnects and failovers. If a live connection names a *different* catalogue station, the connection is refused with `IDENTITY_MISMATCH`, and the contradiction is recorded with `SourceService.flagIdentityContradiction()`. Unless audio correlation supports the source, its identity becomes `mismatch` and it is excluded until it is verified again. The session then fails over to another eligible source. The live check is skipped when a `/radio source verify` override has explicitly marked the source `verified`.

### Audio correlation

`/radio rescan <station> compare:true` and `validate-catalogue --compare` run `compareSources()`:

- Both sources are sampled **at the same time** for about 40 s each, with a total budget of 90 s. HLS sources are opened 1 segment from the live edge for comparisons, instead of the usual 3, so the two feeds are close in time.
- Each sample is decoded to 8 kHz mono PCM, in memory only. It is reduced to a log-energy envelope at 100 frames per second, and then to its signed frame-to-frame change (energy flux).
- The first and last second of the envelope are trimmed, and outliers are clipped. This removes a decode-start artefact that otherwise lined unrelated stations up at lag 0.
- The two envelopes are cross-correlated over **±30 s** of lag, to allow for CDN and HLS delay, with at least **15 s** of overlap.
- The result **supports** identity when **both** of these hold (constants in `identity.ts`):
  - the normalised peak score is **≥ 0.3** (`CORRELATION_THRESHOLD`);
  - the peak stands out from the other lags with a prominence of **≥ 5** (`PROMINENCE_THRESHOLD`).
- A *uniqueness* ratio is reported but not used: repetitive dance music produces several similar peaks even for the same programme.
- Anything weaker is inconclusive.
- **Calibration.** On live radio on 31 October 2026, the same station across MP3, AAC and HLS scored **0.38–0.90**. Different stations scored **0.08–0.14**. A comparison can still come out inconclusive for the same station, for example during a quiet passage. One of the starter pack's probed stations scored 0.08 in one run, having matched at 0.61 and 0.49 in earlier runs. That is why a failed comparison never demotes a source.
- Nothing is saved apart from the score, the lag and a short description.

`SourceService.deepVerify()` compares each enabled source that isn't verified yet against the currently selected verified source of the same station. If no verified source exists, there is nothing to compare against and the command says so.

### Operator identity overrides

Identity facts about pack sources are shared by every server on the installation. So `/radio source verify` on a source of **any pack** is restricted to the bot **operator**: a user listed in `OPERATOR_USER_IDS`, or the Discord application's owner (or team members). A server admin who is not an operator can still pin or prefer sources for their own server, but cannot change what counts as verified for everyone. For a **custom** station, any admin of the server that owns it can record a verdict.

## Ranking sources

`selectSource()` in `src/streams/ranking.ts` follows PRD §7.4:

1. **Gate.** Only eligible sources are considered, and a source that just failed in this session is also excluded.
2. **Transport tier, first.** Direct streams (tier 0) come before sources of unknown transport (tier 1), which come before HLS (tier 2). **HLS is a last resort.** It is used only when no direct stream of the station is eligible, even if the HLS rendition measures higher. The project owner's reasoning is that segmented delivery makes live playback start more slowly, sit further behind live and recover less smoothly. The explanation then says either "Only HLS is available right now; no direct stream of this station is eligible." or "HLS sources are kept as a last-resort fallback (segmented delivery)."
3. **Fidelity, from evidence only, within a tier.** `compareFidelity(a, b)`:
   - Stereo beats mono.
   - A clear difference in audio bandwidth counts: one source below 32 kHz and the other at 44.1 kHz or above.
   - **Different codecs are never ranked by bitrate.** For example, AAC against MP3 is "inconclusive: different codecs are not ranked by bitrate".
   - Within the same codec family (AAC-LC, HE-AAC, MP3 and so on are each separate families), bitrates within 15 % of each other are "equal". A larger gap counts only if both figures are measured or codec metadata; if either is only advertised, the result is inconclusive.
4. **Stability.** A health-score difference of 20 points or more decides.
5. **Latency.** A difference in measured start-up time of more than 1.5 s decides.
6. **Catalogue priority**, then source ID.

An admin can still `pin` or `prefer` an HLS source for their server. That choice overrides the tier order, but not the eligibility gate.

The result includes a **conclusion**:

| Conclusion | Shown as |
|---|---|
| `higher-quality-verified` | "Higher-fidelity source verified by measurement." |
| `no-higher-quality-source-verified` | "Sources are technically equivalent; no higher-quality source verified." |
| `not-conclusively-determined` | "Quality difference not conclusively determined (different codecs are not ranked by bitrate)." |
| `higher-quality-source-ranked-lower` | "A source with measurably higher fidelity is available but ranks lower (delivery, health or an administrator's choice)." The explanation names which. |
| `single-source` | "Only one verified source is currently eligible." |
| `no-eligible-source` | "No verified, healthy source is currently available." |

It also includes a short explanation, for example "All eligible sources carry equivalent audio (both ≈128 kbps AAC); direct feed selected for simpler live delivery. No independently verified higher-quality source found.", and a distinct eligible **fallback** when one exists.

Probing order (`prepareForPlayback`):

- When an eligible source exists, it is used immediately, and stale sources (last probed more than 24 h ago, or failed more than 10 min ago) are refreshed in the background.
- When none is eligible, unprobed or stale sources are probed in the foreground, one after another: the admin's preferred source first, then direct before HLS, then by priority. This stops as soon as one becomes eligible, and the rest are refreshed in the background.

## Pin, prefer and auto

These are per-server overrides, stored in `guild_source_preferences`:

| Mode | Command | Behaviour |
|---|---|---|
| `auto` | `/radio source auto <station>` | Evidence-based selection as described above. This is the default. |
| `prefer` | `/radio source prefer <station> <source>` | Uses that source whenever it is eligible. Otherwise falls back to automatic selection without marking playback degraded. |
| `pin` | `/radio source pin <station> <source>` | Uses that source whenever it is eligible. Otherwise playback is marked **Degraded: the pinned source can’t be used (reason), so a fallback is playing.** |

When you pin or prefer a source that isn't eligible right now, the reply warns you and gives the reason. An override never makes an ineligible source playable: the identity and health gate always applies. The catalogue sync and seeding never touch these preferences.

## The bundled starter pack

### Files

The starter pack is a folder in `catalog/packs/`, like any other pack:

- **`pack.json`** holds:
  - the pack ID, its name and an unofficial disclaimer;
  - six categories and the pack's brand labels;
  - `sync` with the `webradio-apidata` adapter on the broadcaster's official station list page;
  - snapshot date 2026-10-31.
- **`stations.json`** has 63 stations, the official list snapshot of 31 October 2026. For each: `slug`, `displayName` as listed, `externalId` (the site's stable 10-character stream ID), `aliases`, `category`, `tags`, `order`, `officialPage` where one exists, `catalogueStatus` and `catalogueLastSeen`.
- **`sources.json`** has 126 candidate sources. For each: `id`, `station` (the slug), `url`, `label`, `priority`, `transportHint`, `codecHint`, `provenance` (`official-player` or `curated`), `provenanceDetail`, `enabled` and `disabledReason`. Every URL in this pack is HTTPS, and hints are never evidence: every source is probed at run time.
- **`SOURCE_PROVENANCE.md`** is the full provenance record, and **`evidence/`** holds the probe reports. Each bundled pack's folder has both; the station-by-station details are recorded there.

At start-up every pack is validated with Zod and cross-checked. Start-up fails if any of these is found:

- a duplicate pack ID, slug or source ID (source IDs must be unique across all packs);
- a name or alias used by two stations of a pack;
- an undeclared category;
- a source that references an unknown station;
- a URL mapped to two stations.

### How the sources were discovered

On **31 October 2026** each station's entry in the broadcaster's official web player data was used. The site's page embeds this data as JSON, with one entry per station plus the main FM stream. Each entry carries short-lived **signed play URLs**, one per format (`hd`, `sd`, `hls`).

- Each signed URL was requested once, without following redirects. The signed URL answered with a **302 redirect** to an unsigned mount on the broadcaster's stream host. Those redirect targets are the pack's sources.
- **Signed URLs and tokens were never stored.** That includes the signed play URLs, a tracking parameter, and the load-balancer token that the stream host adds on its own next redirect.
- Typically each station resolved to a direct MP3 mount (from `hd`/`sd`) and an HLS playlist of the form `<mount>/hls.m3u8` (from `hls`). In 36 of the 61 HLS entries the playlist is on the same mount as the station's direct source. In the other 25 it is on a different mount. In neither case is it assumed to carry the same encoding. Two stations expose only the direct mount, because their HLS entry redirects to the same plain mount. Two stations serve AAC on the direct mount.
- One short GET per distinct direct or non-standard target recorded the `Content-Type`. The HLS targets in the standard `<mount>/hls.m3u8` form were not individually checked; spot checks on other mounts returned an HLS playlist.

**Four sources are disabled** because the official site's own mapping was broken at discovery time. They are kept for transparency and so that a future check can re-enable them:

| Problem | Sources |
|---|---|
| Malformed HLS target (`.hls.m3u8`), HTTP 404 | 2 |
| `.m3u8` URL serving plain `audio/mpeg`, a duplicate of the station's MP3 mount, not HLS | 1 |
| Direct mount answered HTTP 401 at discovery (browser User-Agent), and again on 31 October 2026 with the bot's FFmpeg User-Agent. Access is restricted, so it stays disabled. The station's HLS source remains enabled. | 1 |

The flagship station has four sources:

- its webradio entry's MP3 mount and HLS playlist;
- the HLS playlist of the site's main FM stream, which carries the same programme;
- an extra **direct AAC** mount, recorded as **`curated`**. It comes from an earlier investigation on 30 October 2026 (about 128 kbps AAC, stereo, 44.1 kHz at the time). The site itself does not reference that bare mount; it only references its `/hls.m3u8`. It is in the catalogue as a candidate to compare, not as a claimed higher-quality feed.

### Coverage

The PRD asks for separate counts. For the starter pack:

| Count | Value | How it is determined |
|---|---|---|
| Catalogued | **63** | Station names in the official list snapshot of 31 Oct 2026. |
| With a source | **63** | Stations with at least one enabled source: 126 sources, of which 122 are enabled. |
| Usable | **3 confirmed**; 60 not probed yet | Stations with a source that a probe has successfully decoded. This is determined at run time. See the probe run below. |
| Verified playable | **3 confirmed** | Stations with an *eligible* source: probed, decoded, identity verified, healthy. For the starter pack, identity comes from official-player provenance. Audio correlation additionally supports two of the three. |

**Release probe run.** The evidence from 31 October 2026 is in the pack folder's `evidence/`. It covers the 8 sources of three stations: the flagship and two others.

| Station | Source | Result |
|---|---|---|
| Flagship | direct MP3 | MP3, 128 kbps measured, 44.1 kHz stereo |
| Flagship | direct AAC (curated) | AAC-LC, ≈128 kbps measured, 44.1 kHz stereo |
| Flagship | HLS (main FM stream's playlist) | AAC-LC, ≈128 kbps measured, 44.1 kHz stereo |
| Flagship | HLS (webradio entry's playlist) | Failed: redirects, then never answers (`HTTP_TIMEOUT`) |
| Second station | direct MP3 / HLS | MP3 128 kbps / AAC-LC 128 kbps, both 44.1 kHz stereo |
| Third station | direct MP3 / HLS | MP3 128 kbps / AAC-LC 128 kbps, both 44.1 kHz stereo |

Audio comparisons in the same run:

- Flagship: MP3 against HLS scored 0.58, and MP3 against AAC scored 0.61. Both support identity.
- Third station: MP3 against HLS scored 0.90, which supports identity.
- Second station: MP3 against HLS was inconclusive in this run, having matched at 0.61 and 0.49 in earlier runs.

No higher-bitrate feed was found: the direct and HLS sources all carry about 128 kbps. Because of the transport tier, the bot plays the direct MP3, or the flagship's direct AAC, and keeps HLS as the fallback.

**Why earlier probes failed.** Earlier the same day, every probe was answered with **HTTP 401**. The stream host refuses clients it doesn't recognise, but serves standard media players. Tested without a `Referer`:

- Radio Bot's old User-Agent got 401;
- FFmpeg's `Lavf/61.7.100` got `200 audio/mpeg`;
- VLC got 200.

The bot now identifies to stream hosts as FFmpeg's network library. It uses the exact `Lavf/<version>` of the installed FFmpeg, which is the software that decodes the audio, and `STREAM_USER_AGENT` can override it. It does **not** imitate a web browser, sends no `Referer`, and never uses signed or tokenised URLs. A host that still refuses is reported as `ACCESS_DENIED` and respected.

The other **60 stations** use the same host and URL pattern but have **not been probed yet**.

For pack sources, *identity verified* currently rests on official-player (or curated) **provenance** plus a successful probe. Audio correlation additionally supports two of the three probed stations, as above. No listening test has been recorded. Read "verified" accordingly. Use `compare:true` or an operator's `/radio source verify` for stronger evidence.

The bot's live coverage is in `/radio stats`, with one line per pack: "N catalogued · N usable · N verified playable", followed by the pack's list-sync status. The footer of `/radio list` for packs adds the "with a known source" count.

## Validating packs yourself

`scripts/validate-catalogue.ts` validates every pack (in `catalog/packs/` and `EXTRA_PACKS_DIR`) and can probe sources live. CI runs it straight from source with `node scripts/validate-catalogue.ts`. Locally, either do the same on Node 24, or build first and use `dist/`. Probing needs FFmpeg/FFprobe on the `PATH`, or `FFMPEG_PATH`/`FFPROBE_PATH` set.

```sh
# schema and consistency checks of every pack (no network)
pnpm validate-catalogue

# validate one pack folder, e.g. one you are writing
pnpm validate-catalogue --pack ./my-pack

# probe specific stations, run the ~40 s audio comparison, and write the evidence
pnpm validate-catalogue --probe mypack:my-station mypack:other-station --compare --json evidence.json

# every enabled source of one pack: slow, and it loads the broadcaster's servers, so run it sparingly
pnpm validate-catalogue --probe --pack-id mypack
```

In the Docker container:

```sh
docker compose exec radio-bot node dist/scripts/validate-catalogue.js --probe mypack:my-station
```

`--probe` needs station IDs or `--pack-id`; with neither, it stops with a message. `--compare` compares the first successfully probed source of each station with each of its other successful sources. Each probe line prints the transport, codec, measured, codec and advertised bitrates, the sample rate, the channels, the `icy-name` and the start-up time. A failure prints its reason code. Probes run one at a time. Audio samples stay in memory and are discarded. The script does not write to the bot's database. To refresh the evidence the bot uses, run `/radio rescan` in Discord.

## Catalogue sync

`CatalogueSync` (`src/catalogue/sync.ts`) reconciles each **enabled pack that declares `sync`** in its `pack.json` with that pack's official list. It runs on its own jittered schedule for each pack, daily by default (`CATALOG_SYNC_ENABLED`, `CATALOG_SYNC_INTERVAL_HOURS`), and on `/radio sync [pack]`. The list is parsed by the adapter the pack names in `src/catalogue/sync-adapters.ts`:

- `webradio-apidata` reads a webradio list embedded in a station website's page (a `webradios[]` array in the page's `var apidata` JSON); the starter pack uses it;
- `json-name-list` reads a plain JSON list of `{ id, name }`.

A sync:

- fetches the URL in the pack's `sync` through the safe HTTP client, capped at 6 MiB and 20 s;
- reads **only station names and stable IDs**. With `webradio-apidata` that is each `webradios` entry's `label` and `id`, skipping entries with `displayOnWebsite: false`, with the page's navigation list as a fallback;
- **never collects stream URLs, and ignores any short-lived signed play URLs on the page.** New sources are only ever added by a reviewed change to the pack's `sources.json`;
- treats a list as implausible, and changes nothing, when it has fewer than 10 names, or fewer than half the pack's stations for packs with fewer than 20;
- matches by stable ID, then by normalised name. If an unmatched new name closely resembles a single missing station, it is treated as a rename;
- on a **rename**, keeps the station ID, favourites and preferences, and keeps the old name as an alias;
- on a **new station**, adds it with no source and reports it as "Needs a reviewed source mapping before it can play";
- on a **missing** station, marks it `missing_from_official`, keeps it (favourites stay intact) and reports it. A station that reappears is reported as "Back on the list";
- on **failure**, keeps the existing entries and records a failed sync report. `/radio list` for that pack shows "list may be out of date" when no sync has succeeded within three intervals.

Each run is stored in `catalogue_sync_reports` with the pack ID as the provider. `/radio sync` shows one report per pack: added, renamed, no longer listed, back on the list, needs a source mapping, and stations whose probed sources are all failing.

A rename applied by a sync is kept across restarts: while the pack's `stations.json` still has the old name, and that old name is an alias of the station, seeding keeps the synced name. Updating the pack file makes it permanent. The old name stays as an alias either way.
