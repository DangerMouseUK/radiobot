# Source provenance: Radio FG starter pack (`fg`)

This file records where every entry in this pack's `stations.json` and `sources.json` (in `catalog/packs/fg/`) came from, what was checked, and what was not. Each source's `provenanceDetail` field in the JSON repeats the relevant facts.

> Radio Bot is **unofficial**. It is not affiliated with, endorsed by or sponsored by any broadcaster. Station names are used only to identify the stations. No logos, artwork or audio are included in this repository. Distributing or operating a playable catalogue is subject to the rights review described in [docs/rights-and-disclaimer.md](../../../docs/rights-and-disclaimer.md).

## Summary

| Item                                      | Value                                                                                                                                                                            |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Station list source                       | `https://www.radiofg.com/Webradios`, the server-rendered page's inline `var apidata` object, `webradios` array (site order)                                                      |
| Station list snapshot                     | 31 October 2026. 63 names, in official order (`stations.json`)                                                                                                                   |
| Source discovery                          | 31 October 2026 (`discoveredAt: 2026-10-31T14:09:29Z`)                                                                                                                           |
| Method                                    | Redirect resolution of the official web player's signed play URLs (below)                                                                                                        |
| Stations catalogued                       | 63                                                                                                                                                                               |
| Candidate sources                         | 126: 65 direct streams and 61 HLS playlists                                                                                                                                      |
| Enabled sources                           | 122. 4 are disabled; see [Disabled sources](#disabled-sources)                                                                                                                   |
| Stations with at least one enabled source | 63                                                                                                                                                                               |
| Provenance values                         | `official-player` (125), `curated` (1)                                                                                                                                           |
| Evidence in the files                     | None in the JSON files: hints are not evidence of codec, bitrate or identity, and the bot probes every source at run time. Release probe reports are in [`evidence/`](evidence/) |
| Host of every source                      | `stream.rcs.revma.com` (HTTPS)                                                                                                                                                   |

## Station list

- **Where.** The station names and the site's stable 10-character stream IDs (`externalId` in `stations.json`) are taken from `apidata.webradios[].label` and `apidata.webradios[].id`.
- **What else was checked.** The same data block appears on every page of the site. The fallback navigation list (`nav.HeaderSources … button.dropdown-item`) carried the same 63 names in the same order.
- **What was added by hand.** Each station's slug, aliases, category and tags were written for this project. They are not official data.
- **Official pages.** `officialPage` is set only for the stations that have a dedicated official page. The flagship's page, `/radiofg`, is the brand home page.
- **Ongoing sync.** The bot's automated sync (`CATALOG_SYNC_ENABLED`, daily by default) **only reconciles names and stable IDs** from the same `var apidata` → `webradios` data on `https://www.radiofg.com/webradios`. It **never harvests stream URLs**, and it ignores the short-lived signed play URLs on the page. A new station that appears in a sync is added with no source and flagged "needs a reviewed source mapping".

## Source discovery method (31 October 2026)

1. **Fetch the play URLs.** The page was fetched, and for each `apidata.webradios` entry, plus the main FM stream `apidata.radiostreams[0]`, the official **signed play URLs** were read: `.hd`, `.bd`/`sd` and `.hls`. These have the form `https://streams.lesindesradios.fr/play/radios/radiofg/<officialId>/any/300/<signature>?format=hd|sd|hls`. The signature changes on every page load and expires.
2. **Read the redirect.** Each signed URL was requested **once**, at about one request per second, with `GET`, `Range: bytes=0-0`, a browser User-Agent and the site as `Referer`, and **without following the redirect**. The play endpoint answered `302` with a `Location` on `stream.rcs.revma.com`.
3. **Record the target.** The unsigned redirect target was recorded as the candidate source. A tracking parameter (`?trk_ir_c=0`) on some redirects was stripped.
4. **Check content types.** One short `GET` per distinct direct or non-standard target recorded the HTTP status and `Content-Type`. That was 66 checks: 61 returned `200 audio/mpeg`, 2 returned `200 audio/aac` (FG CHIC BERLIN and FG CHIC LONDON), 2 returned `404` and 1 returned `401`.
5. **Not stored.** Standard-form HLS targets (`<mount>/hls.m3u8`) were **not individually requested**. Spot checks of `/hls.m3u8` on other mounts returned `200 application/vnd.apple.mpegurl`.

**What was never stored:**

- the signed play URLs and their signatures;
- tracking parameters;
- the per-connection load-balancer token (`rj-tok`) that `stream.rcs.revma.com` adds when it redirects to a node host;
- any audio.

No authentication, DRM, geo-restriction or private API was bypassed. Only the public web player data that any browser receives was used.

### What was **not** verified at discovery

- **No `ffprobe` analysis.** No codec, bitrate, sample rate or channel measurement. The `codecHint` values (`mp3`, `aac`) come from the content type or the play format only.
- **No identity check.** Nobody listened, and no audio comparison was run to confirm that each mount carries the programme it is mapped to. The mapping is exactly what the official player does.
- **No HLS playlist parsing,** so no check of renditions or segments.
- **No check from other locations or networks.** Some mounts may be restricted by location; see the 401 below.
- **No rights or terms review.** See [docs/rights-and-disclaimer.md](../../../docs/rights-and-disclaimer.md).

The bot treats an `official-player` or `curated` mapping as identity provenance. After a successful technical probe, it marks such a source _verified_ with _medium_ confidence. That is weaker than an independent listening or correlation check, and the docs say so. See [docs/station-verification.md](../../../docs/station-verification.md#identity-rules).

## The flagship: FG DJ RADIO

The official site has **two** entries that lead to the flagship programme:

- the webradio **FG DJ RADIO** (`z0fDRzUSa2`), which redirects to the MP3 mount `wknqhm4yuchvv` and to `wknqhm4yuchvv/hls.m3u8`;
- the main FM radiostream **RADIO FG** (`5gWkrl9VKE`, type `RADIO`, shown in the site header as "Live : FG DJ RADIO"), which redirects to the same MP3 mount `wknqhm4yuchvv` and to `gk9y379uquhvv/hls.m3u8`.

The pack therefore has four flagship sources:

| Source ID                       | URL                                                   | Provenance                                                                                                                                                                                                                                                                                            |
| ------------------------------- | ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `fg-dj-radio-mp3-wknqhm4yuchvv` | `https://stream.rcs.revma.com/wknqhm4yuchvv`          | `official-player`. Webradio `z0fDRzUSa2`, `hd`/`sd`. `200 audio/mpeg`                                                                                                                                                                                                                                 |
| `fg-dj-radio-hls-wknqhm4yuchvv` | `https://stream.rcs.revma.com/wknqhm4yuchvv/hls.m3u8` | `official-player`. Webradio `z0fDRzUSa2`, `hls`. Not individually requested                                                                                                                                                                                                                           |
| `fg-dj-radio-hls-gk9y379uquhvv` | `https://stream.rcs.revma.com/gk9y379uquhvv/hls.m3u8` | `official-player`. **Radiostream `5gWkrl9VKE`** ("RADIO FG"), `hls`. Not individually requested.                                                                                                                                                                                                      |
| `fg-dj-radio-aac-gk9y379uquhvv` | `https://stream.rcs.revma.com/gk9y379uquhvv`          | **`curated`**. Observed as about 128 kbps AAC, stereo, 44.1 kHz in a separate investigation on **30 October 2026** (PRD §3.2). **The official site does not reference this bare mount**; it only references its `/hls.m3u8`. Included as a candidate to compare, not as a claimed higher-quality feed |

The 30 October investigation also listed `wknqhm4yuchvv` as a direct MP3 of about 128 kbps. That observation predates this release and has not been re-measured here. Neither the investigation nor the discovery found a distinct 192/256/320 kbps or lossless flagship feed. No "HD" claim is made.

## Disabled sources

These four sources are in `sources.json` with `enabled: false` and `disabledReason: "Broken on the official site at discovery time (see provenance)."`. The bot never plays them. They are kept for transparency so that a later review can re-check and re-enable them. Every affected station still has at least one other enabled source.

| Source ID                             | Station        | Official entry                     | Finding                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ------------------------------------- | -------------- | ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `fg-buddha-bar-hls-kb8037g1t7uvv`     | FG BUDDHA BAR  | `gt0NmhAXye`, `format=hls`         | The redirect target `…/kb8037g1t7uvv.hls.m3u8` is malformed (`.hls.m3u8` instead of `/hls.m3u8`), and a short GET returned **HTTP 404**. The site's own HLS mapping appears broken for this station. The direct MP3 `zn73zqg1t7uvv` remains.                                                                                                                                                                                                                                                             |
| `fg-mix-melodic-hls-h0n0zbh1t7uvv`    | FG MIX MELODIC | `zXBoAmpxqQ`, `format=hls`         | Malformed target `…/h0n0zbh1t7uvv.hls.m3u8`, and a short GET returned **HTTP 404**. The direct MP3 `h0n0zbh1t7uvv` remains.                                                                                                                                                                                                                                                                                                                                                                              |
| `fg-disco-house-direct-ffn7zkskca3vv` | FG DISCO HOUSE | `jpZz0OFZPd`, `format=hls`         | The target `…/ffn7zkskca3vv.m3u8` has a non-standard suffix and returned `200 audio/mpeg`. It behaves like the plain MP3 mount, not like HLS, so it would be a **duplicate** of `fg-disco-house-mp3-ffn7zkskca3vv` with a misleading label.                                                                                                                                                                                                                                                              |
| `fg-hi-ibiza-direct-2ykcf6e1e2uvv`    | FG HÏ IBIZA    | `lzFQAVWWZQ`, `format=hd` and `sd` | The direct mount `2ykcf6e1e2uvv` answered **HTTP 401** at discovery, when it was checked with a browser User-Agent. It still answered **HTTP 401** when re-tested with the bot's FFmpeg User-Agent on 31 October 2026 (see [Release probe runs](#release-probe-runs-31-october-2026)). It may be geo- or rights-restricted, and the bot will not try to get around that. The HLS source `2ykcf6e1e2uvv/hls.m3u8` stays enabled but was not individually requested; it may be restricted in the same way. |

## Stations with a single source

FG NOMADE (`qggukqs0Pv`) and FG PULSE (`wCQirN0q1q`) have only a direct MP3 mount. Their official `format=hls` entry redirects to the same plain mount, and no HLS variant is exposed.

## Release probe runs (31 October 2026)

The release check is the bot's own probe, `validate-catalogue --probe` (plus `--compare`), run from the development environment against FG DJ RADIO, FG CHIC and FG DANCE. The latest output is in [`evidence/probe-2026-10-31.json`](evidence/probe-2026-10-31.json).

**Results (latest run).** 7 of the 8 sources played, all 44.1 kHz stereo:

| Source                                                      | Result                                                     |
| ----------------------------------------------------------- | ---------------------------------------------------------- |
| `fg-dj-radio-mp3-wknqhm4yuchvv`                             | Direct MP3, 128 kbps measured                              |
| `fg-dj-radio-aac-gk9y379uquhvv` (curated)                   | Direct AAC-LC, ≈128 kbps measured                          |
| `fg-dj-radio-hls-gk9y379uquhvv`                             | HLS AAC-LC, ≈128 kbps measured                             |
| `fg-dj-radio-hls-wknqhm4yuchvv`                             | **Failed**: redirects, then never answers (`HTTP_TIMEOUT`) |
| `fg-chic-mp3-cgvrymb6p98uv` / `fg-chic-hls-tde3349uquhvv`   | Direct MP3 128 kbps / HLS AAC-LC 128 kbps                  |
| `fg-dance-mp3-zfad8vm4srhvv` / `fg-dance-hls-kcgbx37uquhvv` | Direct MP3 128 kbps / HLS AAC-LC 128 kbps                  |

The HLS master playlists on this host declare `BANDWIDTH=44100`, which is a sample rate, not a bitrate. The bot ignores such values (`plausibleBandwidth()`), and the measured figures above come from the audio itself.

**Audio comparisons.** On live radio, 40 s samples were compared over ±30 s of lag. A match needs a score of 0.3 or more and a prominence of 5 or more.

- FG DJ RADIO: MP3 against HLS scored **0.58**, and MP3 against AAC scored **0.61**. Both support identity.
- FG DANCE: MP3 against HLS scored **0.90**, which supports identity.
- FG CHIC: MP3 against HLS was **inconclusive** in the latest run (0.08), having matched at 0.61 and 0.49 in earlier runs.

During calibration, different stations scored 0.08–0.14.

**No higher-bitrate feed was found.** Every working source carries about 128 kbps. The direct MP3 and AAC are not ranked against each other by bitrate, and HLS is kept as a last-resort fallback.

**Earlier runs that day (14:48 and 14:52 UTC) were refused with HTTP 401** for all 8 sources. The cause has been established: `stream.rcs.revma.com` refuses clients it doesn't recognise, but serves standard media players. Tested without a `Referer`:

- Radio Bot's old User-Agent (`RadioBot/1.0 …`) got **401**;
- FFmpeg's `Lavf/61.7.100` got **200 `audio/mpeg`**;
- VLC got **200**.

Radio Bot now identifies to stream hosts as FFmpeg's network library, the `Lavf/<version>` of the installed FFmpeg. That is accurate, because FFmpeg is the software that decodes the audio. `STREAM_USER_AGENT` can override it. The bot does **not** imitate a web browser, sends no `Referer`, and never uses the signed play URLs.

**End-to-end check (not a Discord call).** FG DJ RADIO's MP3 and HLS sources were run through the safe HTTP client, one FFmpeg libopus encode and `@discordjs/voice`, whose only stream edges were the Ogg/Opus demuxer. The output was about 486 kbps of Opus against the 510 kbps target. It used one encoder process, and none was left afterwards.

**What this means:**

- 3 of 63 stations are confirmed usable and verified playable.
- The other 60 use the same host and URL pattern, but have not been probed yet.
- FG HÏ IBIZA's disabled direct mount was refused with a browser User-Agent at discovery, and still answered **HTTP 401** when re-tested with the FFmpeg User-Agent on 31 October 2026, so it stays disabled as access-restricted. The station's HLS source remains enabled.
- One live Discord call so far (1 November 2026): FG DJ RADIO played on a private test server from the direct MP3 source at 128 kbps, with one Opus encode at 128 kbps and DAVE negotiated. No 72-hour soak test has been done.

## Changing this pack

Every source mapping needs:

- **provenance:** how it maps to the station, and on what date;
- **evidence:** what was checked, and the result;
- a reviewer, as required for every audio or source change.

See [CONTRIBUTING.md](../../../CONTRIBUTING.md#catalogue-changes). Never commit signed or tokenised URLs. Re-run `pnpm build && pnpm validate-catalogue` (and `pnpm validate-catalogue --probe <stationId…>` for the stations you touched) before opening a pull request. The pack format is described in [catalog/README.md](../../README.md).

If a broadcaster or rights holder asks for a station or source to be removed, follow the takedown procedure in [docs/rights-and-disclaimer.md](../../../docs/rights-and-disclaimer.md#takedown-procedure).

## Full mapping

Kinds are hints, not measurements. "Curated" and "disabled" are flagged. The `#` column is the site order.

|   # | Station                    | Station ID                      | Official ID  | Sources (ID — kind)                                                                                                                                                                     |
| --: | -------------------------- | ------------------------------- | ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
|   1 | FG DJ RADIO                | `fg:fg-dj-radio`                | `z0fDRzUSa2` | `fg-dj-radio-mp3-wknqhm4yuchvv` — direct MP3<br>`fg-dj-radio-hls-wknqhm4yuchvv` — HLS<br>`fg-dj-radio-hls-gk9y379uquhvv` — HLS<br>`fg-dj-radio-aac-gk9y379uquhvv` — direct AAC, curated |
|   2 | FG CHIC                    | `fg:fg-chic`                    | `RW32opoTnZ` | `fg-chic-mp3-cgvrymb6p98uv` — direct MP3<br>`fg-chic-hls-tde3349uquhvv` — HLS                                                                                                           |
|   3 | FG DANCE                   | `fg:fg-dance`                   | `7aU8RbLARV` | `fg-dance-mp3-zfad8vm4srhvv` — direct MP3<br>`fg-dance-hls-kcgbx37uquhvv` — HLS                                                                                                         |
|   4 | MAXXIMUM                   | `fg:maxximum`                   | `UQDF1VGpkJ` | `maxximum-mp3-nwhyn2c6p98uv` — direct MP3<br>`maxximum-hls-5kvvqu6uquhvv` — HLS                                                                                                         |
|   5 | FG STARTER FG BY HAKIMAKLI | `fg:fg-starter-fg-by-hakimakli` | `sd1AI1njys` | `fg-starter-fg-by-hakimakli-mp3-vww68g69n98uv` — direct MP3<br>`fg-starter-fg-by-hakimakli-hls-esyc4bn5rxhvv` — HLS                                                                     |
|   6 | FG AMSTERDAM DANCE EVENT   | `fg:fg-amsterdam-dance-event`   | `y01diAOJ4b` | `fg-amsterdam-dance-event-mp3-asxs2vgk5rcwv` — direct MP3<br>`fg-amsterdam-dance-event-hls-asxs2vgk5rcwv` — HLS                                                                         |
|   7 | FG DEEP DANCE              | `fg:fg-deep-dance`              | `HJCBHp5Pv4` | `fg-deep-dance-mp3-tmbhq479n98uv` — direct MP3<br>`fg-deep-dance-hls-1rd290m5rxhvv` — HLS                                                                                               |
|   8 | FG REMIX                   | `fg:fg-remix`                   | `tKes8II5ya` | `fg-remix-mp3-w1psqtmd342vv` — direct MP3<br>`fg-remix-hls-w1psqtmd342vv` — HLS                                                                                                         |
|   9 | FG AT WORK                 | `fg:fg-at-work`                 | `TY7ilzEFzJ` | `fg-at-work-mp3-2v1zz979n98uv` — direct MP3<br>`fg-at-work-hls-w0318rn5rxhvv` — HLS                                                                                                     |
|  10 | FG HITS                    | `fg:fg-hits`                    | `qnR0myCe2C` | `fg-hits-mp3-mxfbr0dusd3vv` — direct MP3<br>`fg-hits-hls-mxfbr0dusd3vv` — HLS                                                                                                           |
|  11 | FG DAVID GUETTA            | `fg:fg-david-guetta`            | `ooIRv0rSPL` | `fg-david-guetta-mp3-88h6r9dusd3vv` — direct MP3<br>`fg-david-guetta-hls-88h6r9dusd3vv` — HLS                                                                                           |
|  12 | FG BOB SINCLAR             | `fg:fg-bob-sinclar`             | `2WcSlGokTg` | `fg-bob-sinclar-mp3-wphm12m4403vv` — direct MP3<br>`fg-bob-sinclar-hls-wphm12m4403vv` — HLS                                                                                             |
|  13 | FG CHIC FRENCH             | `fg:fg-chic-french`             | `dIkofhW0zB` | `fg-chic-french-mp3-3x5uxtcxgkhvv` — direct MP3<br>`fg-chic-french-hls-d17gfqp5rxhvv` — HLS                                                                                             |
|  14 | FG CHIC LOUNGE             | `fg:fg-chic-lounge`             | `yjz51VQf2J` | `fg-chic-lounge-mp3-1grpmk88n98uv` — direct MP3<br>`fg-chic-lounge-hls-cbse4cp5rxhvv` — HLS                                                                                             |
|  15 | FG CHIC MIX                | `fg:fg-chic-mix`                | `aBFIRkF5VY` | `fg-chic-mix-mp3-9sw5gp3w7guvv` — direct MP3<br>`fg-chic-mix-hls-9sw5gp3w7guvv` — HLS                                                                                                   |
|  16 | FG CHIC SOUL               | `fg:fg-chic-soul`               | `6MGIxfbO3H` | `fg-chic-soul-mp3-y4r1v13w7guvv` — direct MP3<br>`fg-chic-soul-hls-y4r1v13w7guvv` — HLS                                                                                                 |
|  17 | FG CHIC & CHILL            | `fg:fg-chic-and-chill`          | `QaKQL1fU1X` | `fg-chic-and-chill-mp3-d9ucg01d0chvv` — direct MP3<br>`fg-chic-and-chill-hls-nr839fp5rxhvv` — HLS                                                                                       |
|  18 | FG CHIC SPA                | `fg:fg-chic-spa`                | `8BgfEjVadz` | `fg-chic-spa-mp3-ffynknv9n98uv` — direct MP3<br>`fg-chic-spa-hls-3f12dmp5rxhvv` — HLS                                                                                                   |
|  19 | FG YOGA                    | `fg:fg-yoga`                    | `OHtteIMT8D` | `fg-yoga-mp3-xryf0bck5rcwv` — direct MP3<br>`fg-yoga-hls-xryf0bck5rcwv` — HLS                                                                                                           |
|  20 | FG CHIC by Renault         | `fg:fg-chic-by-renault`         | `yd6CI7j7Ie` | `fg-chic-by-renault-mp3-kg2bvya6wzuvv` — direct MP3<br>`fg-chic-by-renault-hls-kg2bvya6wzuvv` — HLS                                                                                     |
|  21 | FG CHIC VINTAGE            | `fg:fg-chic-vintage`            | `cTM5zhVaI3` | `fg-chic-vintage-mp3-csfyhrgr60bwv` — direct MP3<br>`fg-chic-vintage-hls-csfyhrgr60bwv` — HLS                                                                                           |
|  22 | FG DISCO FUNK              | `fg:fg-disco-funk`              | `YO0c3jE07e` | `fg-disco-funk-mp3-cpkhx08pq18uv` — direct MP3<br>`fg-disco-funk-hls-vcxvzyn5rxhvv` — HLS                                                                                               |
|  23 | FG CLASSICS                | `fg:fg-classics`                | `W1dGE6vop9` | `fg-classics-mp3-37n8gxv9n98uv` — direct MP3<br>`fg-classics-hls-twxsptp5rxhvv` — HLS                                                                                                   |
|  24 | MAXXIMUM 90's              | `fg:maxximum-90s`               | `UEoZIbjJdj` | `maxximum-90s-mp3-maygqbdap98uv` — direct MP3<br>`maxximum-90s-hls-q2x6eeq5rxhvv` — HLS                                                                                                 |
|  25 | FG NEW WAVE                | `fg:fg-new-wave`                | `A5xqPuMNdI` | `fg-new-wave-mp3-4vpbw1ad633vv` — direct MP3<br>`fg-new-wave-hls-4vpbw1ad633vv` — HLS                                                                                                   |
|  26 | FG MADONNA                 | `fg:fg-madonna`                 | `fRVSCSKM7V` | `fg-madonna-mp3-aq4u4dhk5rcwv` — direct MP3<br>`fg-madonna-hls-aq4u4dhk5rcwv` — HLS                                                                                                     |
|  27 | FG POP LEGENDS             | `fg:fg-pop-legends`             | `HJBe7ed8bh` | `fg-pop-legends-mp3-hdzyzvtbxd3vv` — direct MP3<br>`fg-pop-legends-hls-hdzyzvtbxd3vv` — HLS                                                                                             |
|  28 | FG RnB LEGENDS             | `fg:fg-rnb-legends`             | `ZG6p106Dcx` | `fg-rnb-legends-mp3-kau7e6tbxd3vv` — direct MP3<br>`fg-rnb-legends-hls-kau7e6tbxd3vv` — HLS                                                                                             |
|  29 | FG DANCEFLOOR              | `fg:fg-dancefloor`              | `qdCybOfBTL` | `fg-dancefloor-mp3-kv9m762w7guvv` — direct MP3<br>`fg-dancefloor-hls-kv9m762w7guvv` — HLS                                                                                               |
|  30 | FG MIX HOUSE               | `fg:fg-mix-house`               | `kVyKhEEe1d` | `fg-mix-house-mp3-5kucq079n98uv` — direct MP3<br>`fg-mix-house-hls-n54bm7n5rxhvv` — HLS                                                                                                 |
|  31 | FG MIX AFRO HOUSE          | `fg:fg-mix-afro-house`          | `Z32AlGsNvJ` | `fg-mix-afro-house-mp3-uv0x66bap98uv` — direct MP3<br>`fg-mix-afro-house-hls-ycm6h2p5rxhvv` — HLS                                                                                       |
|  32 | FG BUDDHA BAR              | `fg:fg-buddha-bar`              | `gt0NmhAXye` | `fg-buddha-bar-mp3-zn73zqg1t7uvv` — direct MP3<br>`fg-buddha-bar-hls-kb8037g1t7uvv` — HLS, **disabled**                                                                                 |
|  33 | FG NOMADE                  | `fg:fg-nomade`                  | `qggukqs0Pv` | `fg-nomade-mp3-yukrx3dusd3vv` — direct MP3                                                                                                                                              |
|  34 | FG APERO                   | `fg:fg-apero`                   | `xDfwbc0TJN` | `fg-apero-mp3-3xvpxq50e2uvv` — direct MP3<br>`fg-apero-hls-3xvpxq50e2uvv` — HLS                                                                                                         |
|  35 | FG FRENCH TOUCH            | `fg:fg-french-touch`            | `XlmY3Z31aB` | `fg-french-touch-mp3-06y7t4gk5rcwv` — direct MP3<br>`fg-french-touch-hls-06y7t4gk5rcwv` — HLS                                                                                           |
|  36 | FG DISCO HOUSE             | `fg:fg-disco-house`             | `jpZz0OFZPd` | `fg-disco-house-mp3-ffn7zkskca3vv` — direct MP3<br>`fg-disco-house-direct-ffn7zkskca3vv` — direct, **disabled**                                                                         |
|  37 | FG DEEP HOUSE              | `fg:fg-deep-house`              | `7Hs1eCV4GG` | `fg-deep-house-mp3-02s8zcv9898uv` — direct MP3<br>`fg-deep-house-hls-02s8zcv9898uv` — HLS                                                                                               |
|  38 | FG TRAINING                | `fg:fg-training`                | `mSfORCFRRb` | `fg-training-mp3-8daakscap98uv` — direct MP3<br>`fg-training-hls-51sgywp5rxhvv` — HLS                                                                                                   |
|  39 | FG ON THE ROAD             | `fg:fg-on-the-road`             | `ylItEVhAqm` | `fg-on-the-road-mp3-yg315gmd633vv` — direct MP3<br>`fg-on-the-road-hls-yg315gmd633vv` — HLS                                                                                             |
|  40 | FG RELAX                   | `fg:fg-relax`                   | `HUulTEP3Dg` | `fg-relax-mp3-ptaswwyza43vv` — direct MP3<br>`fg-relax-hls-ptaswwyza43vv` — HLS                                                                                                         |
|  41 | FG DEFECTED                | `fg:fg-defected`                | `6io6o5ta7u` | `fg-defected-mp3-423ppf862quvv` — direct MP3<br>`fg-defected-hls-423ppf862quvv` — HLS                                                                                                   |
|  42 | FG PURPLE DISCO MACHINE    | `fg:fg-purple-disco-machine`    | `RI9Tq3uSPp` | `fg-purple-disco-machine-mp3-xfnmkhw5b1bwv` — direct MP3<br>`fg-purple-disco-machine-hls-xfnmkhw5b1bwv` — HLS                                                                           |
|  43 | FG USHUAÏA IBIZA           | `fg:fg-ushuaia-ibiza`           | `c6tymuRseC` | `fg-ushuaia-ibiza-mp3-fbmngsck5rcwv` — direct MP3<br>`fg-ushuaia-ibiza-hls-fbmngsck5rcwv` — HLS                                                                                         |
|  44 | FG HÏ IBIZA                | `fg:fg-hi-ibiza`                | `lzFQAVWWZQ` | `fg-hi-ibiza-direct-2ykcf6e1e2uvv` — direct, **disabled**<br>`fg-hi-ibiza-hls-2ykcf6e1e2uvv` — HLS                                                                                      |
|  45 | FG UNVRS                   | `fg:fg-unvrs`                   | `U2YejHWMvs` | `fg-unvrs-mp3-5z13wp6wsccwv` — direct MP3<br>`fg-unvrs-hls-5z13wp6wsccwv` — HLS                                                                                                         |
|  46 | FG MARTIN GARRIX           | `fg:fg-martin-garrix`           | `ZiQL5azoDm` | `fg-martin-garrix-mp3-6zg5tahk5rcwv` — direct MP3<br>`fg-martin-garrix-hls-6zg5tahk5rcwv` — HLS                                                                                         |
|  47 | FG CLUBBING                | `fg:fg-clubbing`                | `OH86mQAECS` | `fg-clubbing-mp3-007e1v9f772vv` — direct MP3<br>`fg-clubbing-hls-007e1v9f772vv` — HLS                                                                                                   |
|  48 | FG PULSE                   | `fg:fg-pulse`                   | `wCQirN0q1q` | `fg-pulse-mp3-rzqck8ad633vv` — direct MP3                                                                                                                                               |
|  49 | FG FUCKING GOOD MUSIC      | `fg:fg-fucking-good-music`      | `DfLr0ztMUw` | `fg-fucking-good-music-mp3-dvpevwak5rcwv` — direct MP3<br>`fg-fucking-good-music-hls-dvpevwak5rcwv` — HLS                                                                               |
|  50 | FG TECHNO                  | `fg:fg-techno`                  | `oJOKSeh3H1` | `fg-techno-mp3-1z19ak79n98uv` — direct MP3<br>`fg-techno-hls-1z19ak79n98uv` — HLS                                                                                                       |
|  51 | FG MIX TECHNO              | `fg:fg-mix-techno`              | `MZz9wlEBeV` | `fg-mix-techno-mp3-vat1rx60e2uvv` — direct MP3<br>`fg-mix-techno-hls-vat1rx60e2uvv` — HLS                                                                                               |
|  52 | FG MIX TRANCE              | `fg:fg-mix-trance`              | `eBkgtgkcQS` | `fg-mix-trance-mp3-v025nezpey3vv` — direct MP3<br>`fg-mix-trance-hls-v025nezpey3vv` — HLS                                                                                               |
|  53 | FG MIX FESTIVAL            | `fg:fg-mix-festival`            | `mSUEeSlUqN` | `fg-mix-festival-mp3-ky42f360e2uvv` — direct MP3<br>`fg-mix-festival-hls-ky42f360e2uvv` — HLS                                                                                           |
|  54 | FG MIX MELODIC             | `fg:fg-mix-melodic`             | `zXBoAmpxqQ` | `fg-mix-melodic-mp3-h0n0zbh1t7uvv` — direct MP3<br>`fg-mix-melodic-hls-h0n0zbh1t7uvv` — HLS, **disabled**                                                                               |
|  55 | FG MIX CLUB                | `fg:fg-mix-club`                | `nO37ZEca3Y` | `fg-mix-club-mp3-e88ff5a1e2uvv` — direct MP3<br>`fg-mix-club-hls-e88ff5a1e2uvv` — HLS                                                                                                   |
|  56 | FG PHONK & GAMING          | `fg:fg-phonk-and-gaming`        | `IF9ISZYJpJ` | `fg-phonk-and-gaming-mp3-vzx3q9762quvv` — direct MP3<br>`fg-phonk-and-gaming-hls-vzx3q9762quvv` — HLS                                                                                   |
|  57 | FG BEATPORT                | `fg:fg-beatport`                | `Nn26ftlm1e` | `fg-beatport-mp3-vb3b5749n98uv` — direct MP3<br>`fg-beatport-hls-q3we61n5rxhvv` — HLS                                                                                                   |
|  58 | FG BELGIUM                 | `fg:fg-belgium`                 | `mWtSvNivqQ` | `fg-belgium-mp3-5wesqhfap98uv` — direct MP3<br>`fg-belgium-hls-br6wu5p5rxhvv` — HLS                                                                                                     |
|  59 | FG CHIC BERLIN             | `fg:fg-chic-berlin`             | `DxsBAhrtub` | `fg-chic-berlin-aac-7pww0pn0742vv` — direct AAC<br>`fg-chic-berlin-hls-7pww0pn0742vv` — HLS                                                                                             |
|  60 | FG CHIC LONDON             | `fg:fg-chic-london`             | `b1SVanSa5f` | `fg-chic-london-aac-8ha6164v5znwv` — direct AAC<br>`fg-chic-london-hls-8ha6164v5znwv` — HLS                                                                                             |
|  61 | FG CHIC IBIZA              | `fg:fg-chic-ibiza`              | `WDaxl2Pwxj` | `fg-chic-ibiza-mp3-z8v9hmhp0f3vv` — direct MP3<br>`fg-chic-ibiza-hls-z8v9hmhp0f3vv` — HLS                                                                                               |
|  62 | FG DANCE TOP40             | `fg:fg-dance-top40`             | `sz4bG6I6TH` | `fg-dance-top40-mp3-x1csugb6wzuvv` — direct MP3<br>`fg-dance-top40-hls-x1csugb6wzuvv` — HLS                                                                                             |
|  63 | FG FEEL GOOD               | `fg:fg-feel-good`               | `OK0BUk2esV` | `fg-feel-good-mp3-yamg15ak5rcwv` — direct MP3<br>`fg-feel-good-hls-yamg15ak5rcwv` — HLS                                                                                                 |
