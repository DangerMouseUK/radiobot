# Rights, disclaimer and privacy

This page is not legal advice. It explains what the Radio Bot project does and does not grant you, and what you are responsible for if you run an instance.

## Unofficial status

Radio Bot is an independent, community-maintained open-source project.

- **It is not affiliated with, endorsed by, sponsored by or approved by any broadcaster or rights holder.**
- Station packs, including the bundled starter pack, refer to stations by their **station names** only so that listeners can find them (this is called *nominative use*). The names, audio and artwork belong to their owners. The names are recorded as they appear on the broadcaster's official site. Their use does not imply any partnership.
- A pack's `pack.json` can carry its own unofficial disclaimer (the bundled pack doesn't). If it has one, it is shown in the footer of `/radio list` when that pack is listed. Radio Bot always shows its own "not affiliated with or endorsed by any broadcaster" notice with station lists either way.
- The repository contains **no station logos, artwork or audio**, and none should be added. Don't name, brand or present your instance or your Discord application in a way that suggests it is an official broadcaster product.
- The bot shows "Radio Bot is unofficial and not affiliated with or endorsed by any broadcaster." in its now-playing, quality, sources/inspect, browse, list and help views.

## What the MIT licence covers

The [MIT licence](../LICENSE) applies **only to the original code and documentation of this project**. It does **not** grant any rights to:

- the radio programmes, music, sound recordings or any audio the bot relays;
- station names, brands, trademarks, logos or artwork;
- the streams themselves or the servers that host them, which are subject to their operators' terms;
- third-party dependencies and binaries, which keep their own licences. In particular, the Docker image includes Debian's **FFmpeg** build, which is LGPL- or GPL-licensed depending on its configuration. Anyone redistributing the image is responsible for those licences' obligations, such as notices and source availability. A full dependency and binary licence review for the published image (PRD §14) **has not been completed** for any release so far.

## The release gate is not resolved by this software

The PRD (§14) sets a release gate: a broadcaster's stream being freely listenable on its website **does not automatically grant permission** to retransmit its programmes to third parties on Discord. Music rights, sound-recording rights, the station's own streaming terms, territorial restrictions and brand rights can all matter.

**For every release so far, this gate is open:**

- No permission has been requested from, or given by, the starter pack's broadcaster for third-party Discord rebroadcast or integration.
- No review of the stations' streaming terms is recorded.
- The software works the same whether or not you have permission. It cannot decide for you whether a given use is lawful.

**If you operate an instance, you are responsible for it.** Think about how you will use it.

- **Personal or private self-hosting**, for example you and a few friends in a private server, is the scenario the project was designed for. Even then, check the station's terms and the law where you live and where your listeners are.
- **Publishing a playable station pack**, running a bot that anyone can invite, or relaying to large or commercial communities is a very different situation. Before doing any of that:
  - Ask the broadcaster (or the relevant station) whether third-party Discord rebroadcast is permitted, and record their reply and any conditions.
  - Check the collecting-society licensing that applies to online streams and simulcasts in your territory. For the UK, see [PPL: playing music on radio and online](https://www.ppluk.com/licensing/playing-music-on-radio/) and [GOV.UK: licences to use music online and on mobile](https://www.gov.uk/find-licences/licences-use-music-online-mobile). Other countries have equivalent bodies, such as SACEM and SCPP in France.
  - Read Discord's [copyright and trademark policy](https://discord.com/safety/copyright-trademark-policy-explainer). It forbids unauthorised streaming of copyrighted content.
  - Get legal advice for your situation.
- **Custom stations:** server admins who add their own streams are responsible for having the right to relay them.
- **No bypassing.** Radio Bot doesn't bypass DRM, authentication, geographic restrictions or private APIs, and must not be modified to do so. Towards stream hosts the bot identifies as FFmpeg's network library: `Lavf/<version>` from the installed FFmpeg, which is the software that decodes the audio. It does not imitate a web browser, sends no `Referer`, and never uses signed or tokenised URLs. If a stream host still refuses access (`ACCESS_DENIED`), the bot stops using that source.

If permission for a pack's sources cannot be obtained, the software is still useful for streams you are authorised to relay. Switch that pack off with `DISABLED_PACKS` (for example `DISABLED_PACKS=mypack`; the pack ID is the first part of every station ID), and use custom stations or your own packs instead.

## Takedown procedure

### For broadcasters and rights holders

If you represent a broadcaster or rights holder and want a station, a source or a name removed from one of the project's bundled station packs:

1. **Contact the maintainers privately.** Use the repository's **Security → Report a vulnerability** form (GitHub private reporting), with "Takedown request" in the title, or the maintainer contact on the repository profile. Include the station or source IDs or names, and who you represent. Please don't post takedown requests as public issues if they contain personal contact details.
2. **The maintainers will acknowledge the request** and, where it is from the rights holder or their representative, **remove the affected entries**. A source is removed by deleting it from the pack's `sources.json` (`catalog/packs/<pack-id>/sources.json`), or by setting `enabled: false` with a `disabledReason`. A station is removed by deleting it from the pack's `stations.json` where appropriate, and a whole pack by deleting its folder. The change is published in a new release. When an upgraded instance starts, it **disables** any pack source that is no longer in the pack's files, so it stops using that source automatically. Stations whose pack is no longer loaded are hidden. The removal is recorded in `CHANGELOG.md` and the pack's `SOURCE_PROVENANCE.md`.
3. **Earlier releases and self-hosted copies** are controlled by their operators, not the maintainers. The maintainers will mention the takedown in the release notes so that operators can act.

This is a volunteer project and there is no guaranteed response time, but takedown requests are given priority over other work.

### For operators (immediate kill switches)

You can stop playing a station or source on your own instance immediately, without waiting for a release. Set one of the following in `.env` and restart the container:

| Setting | Effect |
|---|---|
| `DISABLED_STATION_IDS=mypack:my-station,mypack:other-station` | Every source of those stations is disabled. They show as *Temporarily unavailable* and cannot be played. |
| `DISABLED_SOURCE_IDS=mypack-my-station-mp3` | Only those sources are disabled. Other sources of the station can still be used. |
| `DISABLED_PACKS=mypack` | Hides **all** stations of those packs from every server, stops their catalogue sync, and stops them resuming or autostarting after a restart. Custom stations and other packs keep working. |

Station and source IDs are shown in `/radio list` and `/radio inspect`. If a server admin was asked to remove a custom station, they can use `/radio remove`.

## Privacy policy for a self-hosted instance

Radio Bot runs on your hardware, under your Discord application. **You, the operator, are the data controller for your instance**: you decide what happens to the data it keeps, and you are responsible for it. The project's maintainers receive no data from it. The bot sends no telemetry, has no analytics SDK and doesn't forward crash reports. `TELEMETRY_ENABLED=true` is refused at start-up.

### What is stored (SQLite file in the data volume)

| Data | Where | Why |
|---|---|---|
| Server (guild) IDs | `guild_settings`, `guild_playback_state`, `guild_favourites`, `guild_source_preferences`, custom `stations` | Per-server configuration |
| Channel IDs: allowed command and voice channels, preferred voice channel, notification channel, panel channel and message ID | `guild_settings` | Enforce settings, post notices, maintain the panel |
| Role IDs: DJ roles | `guild_settings` | Authorisation |
| Settings: idle mode, quality mode and manual bitrate, listener control mode, autostart, resume, lock, default station, voice channel status on/off | `guild_settings` | Behaviour |
| Favourite stations (per server, not per user) | `guild_favourites` | Favourites |
| Station queue: station, time added, and **the user ID of whoever queued it** | `guild_queue` | `/radio queue`, `/radio skip` |
| Desired playback state, desired station and channel, time of the last request, and **the user ID of the last person who started playback** | `guild_playback_state` | Restart behaviour and diagnostics |
| Custom stations: name, URL, website, description, category, language, and **the user ID of the admin who added it** | `stations`, `station_sources` | Custom catalogue |
| Source preferences (pin and prefer), with **the user ID of the admin who set them** | `guild_source_preferences` | Overrides |
| Station and source facts: codec, bitrates, identity evidence, health, and probe history (stream host names, response header summaries, failure codes) | `station_sources`, `source_probe_results` | Source selection. No personal data |
| Catalogue sync reports | `catalogue_sync_reports` | Admin reporting |
| Installation metadata: the button-signing secret, command registration hashes | `app_meta` | Operation |

### What is **not** stored or collected

- **No message content.** The bot has no Message Content intent and doesn't read chat history.
- **No voice audio from users.** The bot joins self-deafened and never receives, records or transcribes anyone's voice.
- **No IP addresses** of Discord users or listeners. The bot never sees them.
- **No presence or full member lists.** The bot uses no privileged intents. Its member and user caches are in memory only, capped and never persisted.
- **No per-user listening history or analytics.**
- **No recordings of radio programmes.** Probe and audio-comparison samples are held in memory only while they are analysed (seconds, or about 40 s for a comparison), then discarded.

### Logs

Logs are JSON lines written to stdout and kept by your container runtime. They stay on your host. The shipped Compose file keeps at most about 50 MB, rotated. Replacing the container deletes its log, so `radio-bot update` first saves the last 500 lines to the install's `logs` folder, readable only by your user (the newest 5 files are kept). Logs contain server IDs, reason codes, stream host names and timings. They also contain a user ID when someone records an identity review with `/radio source verify`, or switches a playing station to another source with the source menu under `/radio sources`. Tokens, URL query strings and credentials are redacted. Probe history in the database is pruned to `PROBE_HISTORY_LIMIT` results per source and at most `PROBE_HISTORY_DAYS` days old (30 and 30 by default).

### Exports and backups

`/radio export` produces a JSON file with channel and role IDs, settings, favourites of pack stations, source preferences and custom stations. Custom station URLs that contain a query string or credentials are left out. Database backups contain everything in the table above. The bot keeps them in `backups/` inside its data folder; with a Docker Compose install, `radio-bot backup` and `radio-bot update` also copy them to the `backups` folder of the install. Store exports and backups as carefully as the database itself.

### Retention and deletion

- Data is kept until it is changed or removed.
- **Removing the bot from a server deletes that server's data automatically.** When Discord reports that the bot has left or been removed from a server, the bot deletes, in one step, the server's settings, favourites, queue, source preferences and playback state, its custom stations with their sources and check history, and its command-registration record. This does not happen when a server is only temporarily unavailable because of a Discord outage. If the bot is removed while it is offline, it never receives the removal event, so that server's data stays until you delete the volume.
- To delete a server's data without removing the bot, an admin can remove its custom stations with `/radio remove`. The simplest way to clear everything else is to kick the bot and invite it again.
- **Copies made earlier are not changed.** Backups and exports still contain the old data until they are rotated out or deleted.
- To delete everything, remove the data volume (`docker compose down -v`), the install's `backups` folder, and any backups or exports you copied elsewhere.
- If you run a **public** instance, publish your own privacy notice based on this section, give a contact for deletion requests, and respond to them.
