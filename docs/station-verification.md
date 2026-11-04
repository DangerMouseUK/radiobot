# Station verification and source selection

## In short

- **The right station comes first, quality second.** Each station can have several *sources* (stream addresses). The bot plays a source only when it has checked that it really carries that station and that it works.
- **If no source passes, nothing plays.** The bot says why. It never plays a different station in its place.
- **The bot checks every source itself.** It listens to a few seconds of each stream (kept in memory only, never saved) to find out its format, bitrate, sample rate and channels.
- **How it decides that a source is the right station:** the station pack records where each address came from, such as the broadcaster's own web player. The bot also reads the station name the stream announces. If that name belongs to a *different* station, the source is rejected. On request it can compare the audio of two sources to confirm they carry the same programme.
- **Among working sources, direct streams beat HLS,** then measured quality, then reliability and start-up time. Bitrates of different codecs (for example MP3 against AAC) are never compared, because the numbers don't mean the same thing.
- **Admins can override the choice for their server** by pinning or preferring a source, and anyone who can control the radio can switch the playing station to another working source until the station changes. No override can make an unchecked or wrong source playable.
- **A fresh install shows pack stations as "Unverified"** until their sources are first checked, which happens the first time someone plays them.

The rest of this page gives the precise rules. The code is in `src/streams/identity.ts`, `src/streams/ranking.ts`, `src/streams/source-service.ts`, `src/catalogue/packs.ts` and `src/catalogue/sync.ts`. Radio Bot is unofficial and is not affiliated with or endorsed by any broadcaster; see [rights-and-disclaimer.md](rights-and-disclaimer.md).

## Stations and sources

- A **station** is a programme, for example `mypack:my-station` ("My Station"). It has a permanent ID, a display name, aliases, tags, a category and a catalogue status: `active`, `missing_from_official` or `retired`.
- A **source** is one stream address that may carry a station. Besides its URL, a source records:
  - hints from the pack about its transport (a direct stream or HLS) and its codec (the audio format, such as MP3 or AAC). Hints are not evidence;
  - what the bot measured: transport, container, codec, profile, sample rate, channels, and the advertised, codec-metadata and measured bitrates;
  - its identity status, confidence and a log of the evidence;
  - its provenance (where the address came from);
  - a health score, failure counts and any cooldown (a rest after repeated failures);
  - whether it is enabled, and why not.

Pack stations come from **station packs**. Each pack is a folder with `pack.json`, `stations.json` and, optionally, `sources.json`, installed from the official pack library (or one of the operator's own, in `EXTRA_PACKS_DIR`); the format is described in [catalog/README.md](../catalog/README.md). Station IDs are `<pack-id>:<slug>`, and a station's provider is its pack ID. Custom stations (provider `custom`) belong to one Discord server and have one source each.

## Candidate states

Each source has a `verification_state`. The PRD (§7.2) describes a longer chain; this version uses only these states. A source that is *eligible* is one the bot may play. The last column quotes the reason the bot gives in `/radio sources` when it can't.

| State | Set when | Eligible? |
|---|---|---|
| `discovered` | Added from a pack or by an admin, and not checked yet. Also set again when a pack gives a source a new address. | No: "not checked yet" |
| `eligible` | The last check succeeded, the audio decoded, and the identity is `verified`. | Yes, unless another rule of the gate fails (see below) |
| `degraded` | As `eligible`, but the decode check logged more than 3 errors. | Yes. The station shows as Degraded if all its usable sources are in this state. |
| `unverified` | The check succeeded but the identity is not verified. | No: "not verified as this station" |
| `offline` | The last check failed: access denied (401/403/451), another HTTP status, a timeout, a decode failure, no audio and so on. See [Failed checks](#failed-checks). | No: "last check failed (code)" |
| `blocked_by_policy` | The check failed on a safety rule: `ADDRESS_BLOCKED`, a URL host, port, scheme or credentials that aren't allowed, or `HLS_ENCRYPTED`. | No: "blocked by the bot's safety rules" |
| `cooldown` | The circuit breaker tripped, so the bot rests the source for a while: at least 4 playback failures in a row over more than a minute. The bot's own faults, such as FFmpeg failing to start, don't count, and several servers failing at the same moment count once. When nothing else can play, the bot checks it every 2 min, and a good check ends the cooldown. | No, until the cooldown ends: "resting after repeated failures until …" |

The type definitions also reserve `resolved`, `transport_healthy`, `codec_verified`, `identity_verified` and `retired` for finer tracking later; this version doesn't set them. Each check stores its findings in `source_probe_results` instead.

### Failed checks

When a check fails, the next automatic check waits longer each time: about 10 min, 1 h, 6 h, 12 h, then once a day. When the address is gone (HTTP 404/410) the wait starts at 12 h. An admin's `/radio rescan` or **Check sources again** ignores the wait, as does the bot owner's **Check all sources again** ([below](#checking-every-source-again)), and a successful check resets it. `/radio sources` and `/radio inspect` show how many checks failed in a row and when the next one is.

A source with no successful check for 7 days, and at least 5 failed checks in a row, is **paused**. It is no longer checked automatically at all, neither in the background nor when someone plays the station, until an admin checks it again, the bot owner checks every source again, or a pack update gives it a new address. Because this needs a full week, an outage of hours or days never pauses a source.

### Checking every source again

`/radio rescan` checks one station's sources while the admin waits. The bot owner can also check **every source of every station pack** at once, with the **Check all sources again** button on `/radio packs installed` (after a confirm step). It is for the whole installation, so it needs an admin who is also an [operator](permissions.md#access-levels), and it can start once every 6 hours.

- **What it checks:** every enabled source of every switched-on pack, ignoring each source's wait after failed checks, its cooldown and its pause. It leaves out sources a pack ships switched off (`enabled: false`: the pack's curators decided that), sources the owner switched off with `DISABLED_SOURCE_IDS` or `DISABLED_STATION_IDS`, sources blocked for rights, retired stations and custom stations. A source that is playing somewhere is left alone, since steady playback already shows it works and some stations refuse a second connection.
- **What a result does:** a source that passes can be used at once (a cooldown ends, and the failure count resets, which ends a pause). One that fails is recorded as any failed check is, so its wait and its pause carry on.
- **How it runs:** each check goes through the same background queue as the automatic checks: one at a time, at the lowest CPU priority, waiting while any stream is starting, and giving way to a check that someone playing a station is waiting for (that source is checked again later). It never uses the foreground checks of `/radio rescan`. Listing the sources is split into slices of about 2 ms, so a big catalogue never holds up the audio. On a big installation the whole run can take hours.
- **Progress:** the reply says "Checked N of M" and, at the end, how many sources are working, how many are newly working and how many are failing. Discord lets the bot edit a reply for only 15 minutes, so after 14 minutes it stops following the run; `/radio packs installed` shows how the run stands (or how the last one ended) whenever it is opened. Nothing is posted in any channel.
- **Stopping:** **Stop the check** (on the same message, or on `/radio packs installed`) ends it at once, as does shutting the bot down. The check it interrupts records nothing. Its progress and last summary are kept in memory, so a restart clears them.

### The eligibility gate

`checkEligibility()` lets a source be selected only if **all** of these hold:

- it is enabled: not switched off in its pack, and not listed in `DISABLED_SOURCE_IDS` or `DISABLED_STATION_IDS`;
- its `rights_status` is not `blocked` (a database flag; no command sets it in this version);
- its identity status is `verified`, not `mismatch` or `unverified`;
- it is not blocked by the safety rules;
- it has been checked, its last check did not fail, and a codec was found;
- it is not cooling down.

When nothing is eligible, the station is not played. **Another station is never played in its place**, and the reply lists why each source was turned down.

### Station availability labels

`/radio browse`, `/radio list` and the station suggestions show these labels (from `SourceService.availability()`):

| Label | Meaning |
|---|---|
| Available | At least one eligible source, and the best one's health score is 30 or more. |
| Degraded | There are eligible sources, but all have a health score below 30 or are all in the `degraded` state. |
| Unverified | Some enabled source hasn't been checked yet, or was checked but its identity isn't verified. **On a fresh install every pack station shows this until its sources are checked**, which happens on first play or `/radio rescan`. |
| Temporarily unavailable | Every enabled source is failing, cooling down or plays a different station, or the operator has disabled the station. |
| No stream source known | The station is listed, but it has no enabled source. It cannot be played. |
| Retired | Retired from the catalogue. |

## Identity rules

`decideIdentity()` in `src/streams/identity.ts` weighs the evidence **in this order**:

1. **A human review decides.** A `/radio source verify` verdict of `verified` or `mismatch` sets the status with `high` confidence, and is kept in the evidence log as a human review. `clear` removes it. Only an operator can give a verdict on a pack source; for a custom station, a server admin can (see [Operator identity overrides](#operator-identity-overrides)).
2. **An audio match with an already verified source is strong support.** If the latest audio comparison supports the source, the status is `verified` with `high` confidence.
3. **A contradicting name, without an audio match, means `mismatch`.** The source is never promoted automatically. A name contradicts when the stream's announced name (its `icy-name` header) is exactly the name of a *different* station in any loaded pack. That check comes **before** any match against this station's own aliases, so a short alias such as "Example" can never turn another station's name, such as "Example Dance", into support. The only exception is when that exact name is also one of this station's own names or aliases.
4. **Trusted provenance (where the address came from) means `verified` with `medium` confidence.** That is a pack source marked `official-player` or `curated`, or a custom station's address added by a server admin. If the announced name also matches the station's name or an alias (exactly, or as whole words within it), confidence is `high`.
5. **Anything else is `unverified` with `low` confidence.** This covers sources found automatically, with nothing official linking them to the station.

**A failed audio comparison on its own never demotes a source.** A weak or failed match is recorded as *inconclusive*, not as a mismatch: a few seconds of different adverts between two feeds don't prove they carry a different programme.

### Brand labels

Some names belong to a publisher or network rather than to one programme. Each pack declares its own in `pack.json` → `brandLabels`, for example `["Example Radio", "Example"]`.

When a stream's announced name is one of the station's pack's brand labels, the name says nothing either way. (Names are compared ignoring case, accents and punctuation.) Seeing "Example Radio" in a stream header says nothing about whether it carries "Example Dance" or "Example Chill". Brand labels are also ignored among the station's own aliases. This is how the PRD §3.1 rule is applied.

Only the stream's *name* (`icy-name`) is used for identity. The current song title (`StreamTitle`) is only shown as now-playing text.

### Live re-check on every connection

The announced name is checked when a source is checked, and again **every time playback opens the source**: at the first start, on reconnects and on failovers. If a live connection names a *different* catalogue station, the connection is refused with `IDENTITY_MISMATCH` and the contradiction is recorded. Unless an audio comparison supports the source, its identity becomes `mismatch` and it is left out until it is verified again. Playback then fails over to another eligible source. The live check is skipped when an admin's `/radio source verify` review has marked the source `verified`.

### Audio correlation

`/radio rescan <station> compare:true` and `validate-catalogue --compare` compare two sources' audio with `compareSources()`:

- Both sources are recorded **at the same time** for about 40 s each, within a total limit of 90 s. HLS sources start one segment from the live edge for comparisons, instead of the usual three, so the two feeds are close in time.
- Each sample is decoded to 8 kHz mono audio, in memory only. It is reduced to a loudness curve at 100 points per second, and then to how much the loudness changes from one point to the next.
- The first and last second are trimmed and extreme values are clipped. This removes a jump at the start of every decode that would otherwise line up unrelated stations.
- The two curves are compared at every offset up to **±30 s**, to allow for delays between servers and HLS, with at least **15 s** of overlap. The work is done in small slices that give the main thread back in between, so it never holds up voice packets.
- The result **supports** identity only when **both** of these hold (constants in `identity.ts`):
  - the best match scores **0.3 or more** (`CORRELATION_THRESHOLD`);
  - the best match stands out from the other offsets by a *prominence* of **5 or more** (`PROMINENCE_THRESHOLD`).
- A *uniqueness* figure is reported but not used, because repetitive dance music gives several similar peaks even for the same programme.
- Anything weaker is inconclusive.
- **Calibration.** On live radio on 31 October 2026, the same station across MP3, AAC and HLS scored **0.38–0.90**, and different stations scored **0.08–0.14**. A comparison of the same station can still come out inconclusive, for example during a quiet passage. One checked station of the first library pack scored 0.08 in one run, after matching at 0.61 and 0.49 in earlier runs. That is why a failed comparison never demotes a source.
- Only the score, the offset and a short description are kept.

`SourceService.deepVerify()` compares each enabled source that isn't verified yet with the station's currently selected verified source. If there is no verified source, there is nothing to compare with, and the command says so.

### Operator identity overrides

What counts as verified for a pack source is shared by every server on the installation. So `/radio source verify` on a source of **any pack** is limited to the bot **operator**: a user listed in `OPERATOR_USER_IDS`, or the owner of the Discord application (or a member of its team). An admin who isn't an operator can still pin or prefer sources for their own server, but can't change what counts as verified for everyone. For a **custom** station, any admin of the server that owns it can record a verdict.

## Ranking sources

`selectSource()` in `src/streams/ranking.ts` follows PRD §7.4:

1. **Gate.** Only eligible sources are considered. A source that has just failed during this play is also left out.
2. **Transport tier first.** Direct streams (tier 0) come before sources whose transport is unknown (tier 1), which come before HLS (tier 2). **HLS is a last resort.** It is used only when no direct stream of the station is eligible, even if the HLS version measures higher, because segmented delivery starts more slowly, sits further behind live and recovers less smoothly.
3. **Measured quality, within a tier.** `compareFidelity(a, b)` uses evidence only:
   - Stereo beats mono.
   - A clear difference in audio bandwidth counts: one source below 32 kHz and the other at 44.1 kHz or above.
   - **Different codecs are never ranked by bitrate.** AAC against MP3, for example, is "different codecs are not ranked by bitrate". An unknown codec is inconclusive too.
   - **One narrow exception: AAC-LC against HE-AAC.** Both are AAC, but HE-AAC encodes only the lower half of the sound and rebuilds the treble from hints. That sounds good at low bitrates, but not as good as a full-rate stream. So AAC-LC wins only when both bitrates are measured, and AAC-LC is at least 96 kbps and at least twice the HE-AAC rate (128 against 64, say). Anything closer stays inconclusive, and HE-AAC never wins on bitrate.
   - Within the same codec (AAC-LC, HE-AAC, MP3 and so on each count separately), two **measured** bitrates within 3 % of each other are equal (a measurement is precise, so 112 against 128 kbps is a real difference). Otherwise figures within 15 % are equal, because codec metadata (for AAC only an estimate) and advertised figures are looser. A bigger gap counts only if both figures are measured or from codec metadata; if either is only advertised, the result is inconclusive.
4. **Reliability.** A difference in health score of 20 points or more decides.
5. **Start-up time.** A difference of more than 1.5 s in measured start-up time decides.
6. **The pack's `priority`** (lower first), then the source ID. This is what decides between, say, a 128 kbps MP3 and a 128 kbps AAC stream of similar health: different codecs aren't ranked, so the station pack's priority settles it, and the explanation says so.

The result includes a **conclusion**, shown at the top of `/radio sources` and in `/radio quality`:

| Conclusion | Shown as |
|---|---|
| `higher-quality-verified` | "Measurements show this source has better audio than the others." |
| `no-higher-quality-source-verified` | "The sources carry equivalent audio; none was verified as higher quality." |
| `not-conclusively-determined` | "Whether one source sounds better was not conclusively determined (different codecs are not compared by bitrate)." |
| `higher-quality-source-ranked-lower` | "A source with measurably better audio exists but ranks lower, because of how it is delivered, its reliability or an admin's choice." The explanation says which. |
| `single-source` | "Only one verified source can be used right now." |
| `no-eligible-source` | "No verified, working source is available right now." |

It also includes a short explanation and, when there is one, a different eligible **fallback**. For example: "All usable sources carry equivalent audio (both ≈128 kbps AAC-LC); direct feed selected for simpler live delivery." followed by "No independently verified higher-quality source found." When HLS is involved, the explanation adds one of:

- "Only HLS is available right now; no direct stream of this station can be used."
- "HLS sources are kept as a last-resort fallback: they start more slowly and recover less smoothly."
- "An admin chose this HLS source; a usable direct stream would normally come first."

### Choosing another source while a station plays

While a station plays, anyone who can control the radio can switch it to another usable source with the menu under `/radio sources` (or the Sources button). When an admin has pinned the station to one source, only admins can switch it.

- Only usable sources are offered, and the choice is checked again when it is made.
- The choice lasts through reconnects, but ends when the station changes. A stop is never undone by it.
- If the chosen source fails, the bot goes back to choosing automatically.
- The now-playing card says "Chosen by a listener for this play."

### When sources are checked

When someone plays a station (`prepareForPlayback`):

- **If an eligible source exists, it plays straight away.** The station's other sources that are due a check (last checked more than 24 h ago, or failing and past their wait) are then checked in the background:
  - only once the stream has played steadily for 30 s, and again about once a minute while it plays. That is how a source that failed earlier shows that it works again, so the bot can move back to it;
  - never the source that is playing: its steady playback is better evidence than a check, and 30 s of it clears a failed check.

  Background checks run one at a time, at the lowest CPU priority, so a live stream is never disturbed:
  - a source is queued once, and skipped if it was checked in the meantime;
  - no background check starts while any stream on the installation is in its first 30 s;
  - a check someone is waiting for interrupts a background check on the same stream host; the interrupted check records nothing and runs again later.
- **If none is eligible,** sources are checked while the person waits, one after another: the admin's preferred source first, then direct streams before others, then by `priority`. This stops as soon as one becomes eligible. Failing sources are checked again even if their wait isn't over, because nothing else can play, but no more than every 10 min within a day of last working, and hourly after that. Paused sources are skipped.

## Pin, prefer and auto

These are per-server overrides, stored in `guild_source_preferences`:

| Mode | Command | Behaviour |
|---|---|---|
| `auto` | `/radio source auto <station>` | The evidence-based choice described above. This is the default. |
| `prefer` | `/radio source prefer <station> <source>` | Uses that source whenever it is eligible. Otherwise the bot chooses automatically, without marking playback as degraded. |
| `pin` | `/radio source pin <station> <source>` | Uses that source whenever it is eligible. Otherwise playback is marked **Degraded: the pinned source can't be used (reason), so a fallback is playing.** |

Admins can also use the **Use this source first** button (the same as `prefer` with the source that is playing) and the **Choose automatically** button (the same as `auto`) under `/radio sources`. The view's "On this server" field says what each one does, and which source this server tries first or is pinned to.

When you pin or prefer a source that can't be used right now, the reply warns you and gives the reason. An override never makes an ineligible source playable: the identity and health gate always applies. An admin may pin or prefer an HLS source; that overrides the tier order, but not the gate. Catalogue sync and pack updates never touch these preferences, except that moving a source to a different station clears the preferences that pointed to it.

## Where pack sources come from

Radio Bot ships with no station packs. Packs are made and reviewed in the official pack library, [DangerMouseUK/radiobot-packs](https://github.com/DangerMouseUK/radiobot-packs), following its playbook, and installed from there with `/radio packs library` or `radio-bot packs add`. Each pack folder in the library has:

- **`pack.json`**: the pack ID, its name, version and owner, its countries and languages, categories, brand labels and, optionally, `sync` with an adapter and the broadcaster's official station list;
- **`stations.json`**: the stations as the official list names them, with `externalId` where the list has stable IDs, aliases, categories, tags and order;
- **`sources.json`**: the candidate sources, each with a `provenance` of `official-player` or `curated` and a `provenanceDetail` saying where and when the address was found. Hints are never evidence: every source is checked when the bot runs;
- **`SOURCE_PROVENANCE.md`**, which records where the station list and every source address came from, and what was and wasn't checked, and **`evidence/`**, which holds the check reports (`validate-catalogue --probe --json`). The date of the newest report is shown as "Streams last checked" on the pack's card in `/radio packs library`.

Library packs must pass the [strict checks](../catalog/README.md#strict-checks-for-library-packs): a version, an owner, countries and languages, every source in `SOURCE_PROVENANCE.md`, at least one evidence report, no images, and no URL that looks signed or expiring. Signed or tokenised play URLs found on a broadcaster's site are never stored: a pack holds only the plain, public stream addresses they lead to.

Every pack is validated and cross-checked when it is loaded, whether at start-up or when it is installed while the bot runs. A pack is refused if any of these is found:

- two packs with the same ID, two stations in a pack with the same slug, or two sources with the same ID (source IDs must be unique across all packs);
- a name or alias used by two stations of one pack (ignoring case, accents and punctuation);
- a category that the pack doesn't declare;
- a source that refers to a station the pack doesn't have;
- one URL mapped to two stations of a pack.

A refused pack in `EXTRA_PACKS_DIR` stops start-up. A refused installed pack is skipped and listed under _Not loaded_ in `/radio packs installed`; a refused download (`PACK_INVALID`) is never written.

### The first library pack

The pack that shipped with Radio Bot up to version 1.1.0 is now the first pack in the library, and an existing installation gets it back from there automatically when it updates. Its folder in the library holds its own provenance record and evidence, and is where its current figures live: how many stations and sources it has, how many are enabled, and what its latest live check found. The pack is maintained there, so this page doesn't repeat those figures. How its sources were found, and what the first checks showed when it moved to the library (31 October 2026):

- Its stations come from the broadcaster's official list. Its sources came from the official web player: each station's short-lived signed play URL redirected once to a plain, unsigned stream address, and those plain addresses are the sources. No signed URL or token was stored.
- On 31 October 2026, live checks covered 3 of its stations: direct MP3 at 128 kbps on all three, HLS AAC-LC at 128 kbps on all three, and a curated direct AAC-LC stream at 128 kbps on the flagship, all 44.1 kHz stereo. One HLS address redirected and then never answered. The other stations, on the same host and URL pattern, were checked later in the library.
- **Audio comparisons** on those dates supported identity for two of the three stations (scores of 0.58 to 0.90). The third matched in two earlier runs and was inconclusive (0.08) in the latest.

**Why its earlier checks failed.** Before the bot identified itself as FFmpeg, every check of that pack's stream host was answered with **HTTP 401**. The host refuses clients it doesn't recognise, but serves standard media players. Tested without a `Referer`, Radio Bot's old User-Agent got 401, while FFmpeg's `Lavf/61.7.100` and VLC got 200.

The bot now identifies itself to stream hosts as FFmpeg's network library, which is the software that decodes the audio. It sends the exact `Lavf/<version>` of the installed FFmpeg, and `STREAM_USER_AGENT` can override it. It does **not** pretend to be a web browser, sends no `Referer`, and never uses signed or tokenised URLs. A host that still refuses is reported as `ACCESS_DENIED`, and the bot respects that.

### Coverage

For pack sources, *identity verified* currently rests on official-player (or curated) **provenance** plus a successful check, strengthened where an audio comparison or an operator's review has been recorded. Read "verified" accordingly, and use `compare:true` or an operator's `/radio source verify` for stronger evidence.

The PRD asks for separate counts: **catalogued** (the station is listed), **usable** (a check has decoded one of its sources) and **verified playable** (it has an *eligible* source: checked, decoded, identity verified, healthy). The bot's live coverage is in `/radio stats`, with one line per pack: "N stations · N with a working stream · N verified and playable", followed by the state of the pack's list sync. The footer of `/radio list` also gives the number "with a known stream".

## Validating packs yourself

`scripts/validate-catalogue.ts` validates every pack in `catalog/packs/` and `EXTRA_PACKS_DIR` (plus the template pack), or one pack folder with `--pack`, such as a library pack you are writing, and can check sources live. `--strict` adds the rules for library packs. Run it straight from source with Node 24 (`node scripts/validate-catalogue.ts`, as CI does), or build first (`pnpm build`) and use `pnpm validate-catalogue`, which runs the built copy in `dist/`. Live checks need FFmpeg and FFprobe on the `PATH`, or `FFMPEG_PATH` and `FFPROBE_PATH` set.

```sh
# schema and consistency checks of every pack (no network)
node scripts/validate-catalogue.ts

# validate one pack folder, for example one you are writing
node scripts/validate-catalogue.ts --pack ./my-pack

# check specific stations, run the ~40 s audio comparison, and write the evidence
node scripts/validate-catalogue.ts --probe mypack:my-station mypack:other-station --compare --json evidence.json

# every enabled source of one pack: slow, and it loads the station's servers, so run it sparingly
node scripts/validate-catalogue.ts --probe --pack-id mypack
```

In the Docker container:

```sh
docker compose exec radio-bot node dist/scripts/validate-catalogue.js --pack /app/data/installed-packs/mypack --probe mypack:my-station
```

The script doesn't read the installed-packs folder by itself, so name an installed pack's folder with `--pack` (`/var/lib/radio-bot/installed-packs/<pack-id>` with the systemd unit).

- `--probe` needs station IDs or `--pack-id`; with neither, it stops with a message.
- `--compare` compares the first successfully checked source of each station with each of its other successful sources.
- Each check prints the transport, codec, measured, codec and advertised bitrates, sample rate, channels, the announced `icy-name` and the start-up time. A failure prints its reason code.
- Checks run one at a time. Audio samples stay in memory and are discarded.
- The script doesn't write to the bot's database. To refresh the evidence the bot uses, run `/radio rescan` in Discord.

## Catalogue sync

`CatalogueSync` (`src/catalogue/sync.ts`) keeps each **enabled pack that declares `sync`** in its `pack.json` in line with that pack's official station list. Each pack has its own schedule: once every `CATALOG_SYNC_INTERVAL_HOURS` (24 by default, 6 to 720) plus a random delay of up to 15 minutes. A pack that has never synced is first synced about 10 minutes after the bot starts. A scheduled sync follows the rules for background work: it runs one at a time with the background source checks and waits while any stream is in its first 30 s. `CATALOG_SYNC_ENABLED=false` turns the schedule off. Admins can also run `/radio packs sync [pack]` (formerly `/radio sync`), which starts at once (after any sync already running). The list is read by the adapter the pack names, from `src/catalogue/sync-adapters.ts`:

- `webradio-apidata` reads a list of web radios embedded in a station website's page (a `webradios[]` array in the page's `var apidata` JSON);
- `json-name-list` reads a plain JSON list of `{ id, name }`.

A sync:

- fetches the pack's `sync` URL through the bot's safe HTTP client, at most 6 MiB and 20 s;
- reads **only station names and stable IDs**. With `webradio-apidata` that is each `webradios` entry's `label` and `id`, skipping entries with `displayOnWebsite: false`, with the page's navigation menu as a fallback;
- **never collects stream URLs, and ignores any short-lived signed play URLs on the page.** New sources are only ever added by a reviewed change to the pack's `sources.json`;
- reads the list on a separate worker thread, so a large page never holds up the stream;
- treats a list as implausible, and changes nothing, when it has fewer than 10 names (or, for packs with fewer than 20 stations, fewer than half the pack's stations), or more than 5,000;
- matches stations by stable ID, then by name (ignoring case, accents and punctuation). An unmatched new name that closely resembles a single missing station is treated as a rename;
- on a **rename**, keeps the station ID, favourites and preferences, and keeps the old name as an alias;
- on a **new station**, adds it with no source and reports that it needs a reviewed source before it can play;
- on a **missing** station, marks it `missing_from_official`, keeps it (so favourites still work) and reports it. A station that reappears is reported as "Back on the list";
- applies all its changes together or none of them. Only a sync with more than 50 changes at once is written in parts of 50; the report then lists what was written, and if a part fails, the next sync finishes the job;
- on **failure**, keeps the existing entries and records a failed report. `/radio list` for that pack shows "list may be out of date" when no sync has succeeded within three intervals.

Each run is stored in `catalogue_sync_reports` with the pack ID as the provider. `/radio packs sync` shows one report per pack: what was added (new stations have no stream yet), renamed, dropped from or back on the official list, or "No stations were added, renamed, dropped or brought back."; then the stations whose sources all failed their last check. Long lists show 15 names and how many more.

A rename made by a sync survives restarts. While the pack's `stations.json` still has the old name, and that old name is an alias of the station, the bot keeps the synced name. Updating the pack file makes it permanent. The old name stays as an alias either way.
