# Source provenance: Example Radio Network (`template`)

This file records where every station and source in this pack came from, what was checked and what was not. Each source's `provenanceDetail` in `sources.json` repeats the key facts. Every source ID in `sources.json` must appear in this file.

> Radio Bot is **unofficial**. It is not affiliated with, endorsed by or sponsored by any broadcaster. Station names are used only to identify the stations. No logos, artwork or audio are included in this pack.

## Summary

| Item                  | Value                                                       |
| --------------------- | ----------------------------------------------------------- |
| Station list source   | `https://www.example.org/stations`, the public station list |
| Station list snapshot | 3 November 2026. 3 stations                                 |
| Source discovery      | 3 November 2026                                             |
| Candidate sources     | 5: 4 direct streams and 1 HLS playlist                      |
| Enabled sources       | 4. 1 is disabled; see [Disabled sources](#disabled-sources) |
| Provenance values     | `official-player` (4), `curated` (1)                        |

## Station list

- **Where.** The names come from the public station list on the network's own site.
- **What was added by hand.** Slugs, aliases, categories and tags were written for this pack. They are not official data.

## How the sources were found

1. Each station's own web player page (`/listen`) was opened in an ordinary browser.
2. The stream address the player links to was copied as it appears on the page, with no signed or expiring parts.
3. Example County Sound has no player of its own; its address comes from the network's published stream directory and was checked against the station's web player.

No authentication, DRM, geo-restriction or private API was bypassed. No audio was recorded.

## What was not verified

- No codec, bitrate or identity check at discovery: the `codecHint` values come from the file extension only. The bot checks every source itself before playing it.
- No check from other countries or networks.

## Disabled sources

- `template-example-news-mp3-low` returned HTTP 404 when checked on 3 November 2026, so it ships disabled.

## Sources

<!-- sources:start -->
| Source ID                           | Station              | Found at                            | Date       | Provenance      |
| ----------------------------------- | -------------------- | ----------------------------------- | ---------- | --------------- |
| `template-example-hits-mp3`         | Example Hits         | https://www.example.org/hits/listen | 2026-11-03 | official-player |
| `template-example-hits-hls`         | Example Hits         | https://www.example.org/hits/listen | 2026-11-03 | official-player |
| `template-example-news-aac`         | Example News         | https://www.example.org/news/listen | 2026-11-03 | official-player |
| `template-example-news-mp3-low`     | Example News         | https://www.example.org/news/listen | 2026-11-03 | official-player |
| `template-example-county-sound-mp3` | Example County Sound | https://www.example.org/streams     | 2026-11-03 | curated         |
<!-- sources:end -->
