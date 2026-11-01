# Troubleshooting

Most problems surface as a **reason code**, for example `NO_ELIGIBLE_SOURCE` or `ADDRESS_BLOCKED`. Reason codes appear in logs, in `/radio stats` (under *Recent incidents*, tagged with a fault domain: `upstream`, `discord`, `bot`, `operator` or `user`), in `/radio inspect` as a source's last failure, and in some error replies. The full list is in `src/shared/errors.ts`. Radio Bot is unofficial and is not affiliated with or endorsed by any station named on this page; see [rights-and-disclaimer.md](rights-and-disclaimer.md).

Installed with the installer? Start with `radio-bot status` and `radio-bot logs`, and see the beginner's table in [install.md → If something goes wrong](install.md#if-something-goes-wrong). The commands below written as `docker compose …` also work from the `~/radio-bot` folder (use `sudo docker compose …` if Docker needs `sudo` on your machine).

## Tools

| Tool | What it tells you |
|---|---|
| `/radio status` | Connection state, desired state and station, the current source, and the last problem. It also says when playback was not resumed after a restart because *Resume after restart* is off. |
| `/radio now` / `/radio quality` | What is playing, the source format and verification, the Discord output target, the channel's bitrate setting (not a cap), the observed rates, and whether DAVE is in use. |
| `/radio sources <station>` | Every candidate (up to 10), which one is selected and the fallback, and **why each other one is not eligible**. |
| `/radio inspect <station>` | As above, plus the redacted endpoint, every bitrate figure, probe and failure times, the last failure code, health, start-up time and provenance. Admins also get a **Check sources again** button. |
| `/radio stats` (Administrators; private, with Refresh and Close) | **Live stream**: session state and source, requested and redirected host (with a region hint from the host name), connected IP and port, HLS segments, codec, input rate over 10 s and 60 s and data received, and round trip to the stream endpoint by TCP handshake. **Output**: Opus target, channel setting (not a cap), Ogg Opus rate, and packets per second to Discord (about 50). **Discord**: voice server host (with a region hint) and IP, the channel's RTC region, voice WebSocket ping with jitter, gateway ping, encryption/DAVE, and this server's failovers, voice reconnects and encoder PID, plus the last FFmpeg warnings. **Bot health**: uptime and memory; active streams and probes against their limits; FFmpeg processes (active, spawned, reaped) and whether `libopus` is present; the stream User-Agent in use; database schema version; per-pack catalogue coverage and last list sync; recent coalesced incidents. |
| Logs | `docker compose logs -f radio-bot`. Set `LOG_LEVEL=debug` for state transitions and the voice dependency report, and `trace` for everything. Return to `info` afterwards. |
| Probe from the CLI | `docker compose exec radio-bot node dist/scripts/validate-catalogue.js --probe <pack>:<station>` (or `--probe --pack-id <pack>`) prints raw probe results for pack stations. |

## Commands don't appear

- **Commands are guild commands.** They are registered for each server when the bot starts (`REGISTER_COMMANDS_ON_START=true`, the default) and when it joins a new server. Check the logs for `slash commands registered` or `command registration failed for guild`.
- **`DISCORD_DEV_GUILD_ID` is set.** Commands are then registered only in that server, both at start-up and when the bot joins servers. Clear it and restart to register in every server.
- **The bot was invited without the `applications.commands` scope.** Re-invite it with the link from `radio-bot invite`, or the URL in [install.md](install.md#3-invite-the-bot-to-your-server). You don't need to kick it first.
- **You deleted the commands by hand.** Registration is skipped while the stored definition hash is unchanged. Force it with `docker compose exec radio-bot node dist/scripts/register-commands.js`, optionally followed by a guild ID.
- **The Discord client is caching an old command list.** Restart the client, or press Ctrl+R on desktop.
- **The command is visible but says "Radio Bot only works inside servers".** `/radio` is guild-only; it doesn't work in DMs.

## "Radio commands are only allowed in #…"

The server has a command-channel allowlist (`/radio config` → Access). Use one of those channels, or the text chat of an approved voice channel. Admins aren't affected by this restriction.

## "Only DJs and administrators…" / "Join a voice channel first…" / "The radio is in use in #…"

These come from the listener control mode. See [permissions.md](permissions.md#listener-control-mode). With the default `same_channel` mode, a member must be in a voice channel, and can only control the bot when it is idle or already in their channel.

## The bot doesn't join or play

| Reason code | Meaning | What to do |
|---|---|---|
| `VOICE_PERMISSION` | One of: the target isn't a standard voice channel (stage channels aren't supported); it isn't on the server's approved list; the bot lacks View Channel, Connect or Speak in it; or the channel is full. The message names which. | Fix the channel's permission overwrites for the bot's role, add the channel to the approved list, or pick another channel. |
| `VOICE_CONNECT_TIMEOUT` | The voice connection didn't become ready within 20 s. | Usually a network problem: outbound **UDP** to Discord voice is blocked, there is a firewall or VPN in the way, or the host has no IPv4 route. Check the host or VM firewall. Run with `LOG_LEVEL=debug`. |
| `VOICE_CHANNEL_GONE` | The channel was deleted, or the bot is no longer in that server. | Choose another channel. |
| `VOICE_KICKED` | A moderator disconnected the bot. | Deliberate: the bot won't rejoin or autostart. Use `/radio play` to start again. |
| `VOICE_DISCONNECTED` | The voice connection dropped and couldn't be rebuilt after several attempts (spread over about 2 min). | Check connectivity, and Discord's status page. Then `/radio play` again. |
| `STREAM_LIMIT` | The installation is already streaming to `MAX_ACTIVE_GUILD_STREAMS` servers. The limit also applies when a server resumes from pause, retries or reconnects; the bot then posts one notice and tries again about every 2 minutes. | Wait for another server to stop, or raise the limit in `.env` if your hardware allows. |
| `RATE_LIMITED` | "Too many … in a short time. Try again in N s." A per-user or per-server rate limit was hit (see [permissions.md](permissions.md#rate-limits)). | Wait the number of seconds shown. |
| `CUSTOM_STATION_LIMIT` | The server already has `MAX_CUSTOM_STATIONS_PER_GUILD` custom stations. | Remove one with `/radio remove`, or raise the limit. |
| `CANCELLED` | A newer command replaced this one before it finished (for example, a second `/radio play` while the first was still connecting), or a probe was stopped. | Nothing to fix: the newer command wins. |
| `INTERNAL` | Something the bot didn't expect, or an action that doesn't apply (for example "This pack has no official list to sync with."). The message says which. | If the message doesn't explain it, check `radio-bot logs` (or `docker compose logs`) for the error and report it as a bug. |

### DAVE / encryption

The bot joins with DAVE end-to-end encryption enabled (`daveEncryption: true`), and the `@snazzah/davey` dependency is bundled in the image. `/radio quality` shows either "DAVE end-to-end encrypted (privacy code …)" or "Transport-encrypted; DAVE not negotiated for this call". Both are normal: DAVE is negotiated per call.

If the voice connection fails consistently after a Discord-side protocol change:

- check the logs at `debug` level for the voice dependency report, which lists the encryption and DAVE libraries found;
- update to a release that pins newer `@discordjs/voice` and DAVE packages;
- if you run from source rather than Docker, make sure `@snazzah/davey` installed correctly. It is a native module, so its prebuilt binary must match your platform.

## "No verified, working source is available" (`NO_ELIGIBLE_SOURCE`)

None of the station's sources passed the eligibility gate. The reply lists up to four sources with their reasons. `/radio sources <station>` shows all of them:

| Reason shown | Meaning | What to do |
|---|---|---|
| not yet probed | No probe has run yet. A probe normally runs automatically when you play. | Admins: run `/radio rescan <station>`. |
| last probe failed (CODE) | The last probe failed. See the probe codes below. | Wait. The bot re-probes failed sources at most every 10 min, and retries playback every 2 min while playback is wanted. Or rescan. |
| station identity not verified | The probe worked, but nothing confirms that this feed carries this station. | An admin can compare it with `/radio rescan <station> compare:true`. The operator (or, for a custom station, a server admin) can review it with `/radio source verify`. See [station-verification.md](station-verification.md#identity-rules). |
| identity mismatch | The stream names itself as a different catalogue station, or an operator marked it as a mismatch. | Deliberate: the bot never plays a mismatched feed for this station. |
| cooling down after repeated failures until … | The circuit breaker tripped after 4 consecutive playback failures. | Wait for the cooldown (10 min, doubling up to 2 h), or fix the upstream. |
| disabled: … | Disabled in the manifest, or by the operator via `DISABLED_SOURCE_IDS` / `DISABLED_STATION_IDS`. | Intentional. See [rights-and-disclaimer.md](rights-and-disclaimer.md#takedown-procedure). |
| rejected by URL safety policy | The source resolves to a blocked address or uses a disallowed URL. | See `ADDRESS_BLOCKED` below. |

"…is catalogued, but no stream source is known for it yet" means the station has no enabled source at all. This happens, for example, with a station newly added by `/radio sync`. Nothing else is played in its place. Someone has to add a reviewed source mapping to the pack's `sources.json` (see [catalog/README.md](../catalog/README.md) and [CONTRIBUTING.md](../CONTRIBUTING.md#catalogue-changes)).

## Probe and stream errors

| Code | Meaning |
|---|---|
| `ACCESS_DENIED` | The stream host refused access with HTTP 401, 403 or 451, for the stream itself or for an HLS playlist or segment. This can mean geo-restriction, rights restriction, or a host that only serves certain clients. Retrying the same source is pointless, so the bot moves straight to a fallback.<br><br>By default the bot identifies as FFmpeg's network library, `Lavf/<version>` from the installed FFmpeg. Many hosts that refuse unknown clients accept that, because it is a standard media player's network stack; the starter pack's host is one of them. Check the value in use in `/radio stats`. If you changed `STREAM_USER_AGENT`, clear it to return to FFmpeg's own.<br><br>The bot does not imitate a web browser, sends no `Referer`, and never uses signed or tokenised URLs. A host that still refuses is respected. |
| `HTTP_STATUS` | The stream server answered with another non-2xx status, such as 404 or 5xx. |
| `HTTP_TIMEOUT` / `HTTP_ERROR` | The server didn't respond in time, or the connection failed. For example, one of FG DJ RADIO's HLS addresses (`wknqhm4yuchvv/hls.m3u8`) redirected and then never answered in the 31 Oct 2026 probe. |
| `DNS_FAILED` | The host name didn't resolve. |
| `REDIRECT_LIMIT` | More than 5 redirects. |
| `CONTENT_TYPE_REJECTED` | The URL serves HTML, JSON or an image, not audio. This often means a station's web page was given instead of its stream URL. |
| `PLAYLIST_INVALID` | The PLS, M3U or HLS playlist was malformed, empty, too large or nested too deeply. |
| `HLS_ENCRYPTED` | The HLS stream uses encryption or DRM. It is not supported. |
| `HLS_NO_AUDIO` | No audio rendition could be loaded from the HLS master playlist. |
| `HLS_PLAYLIST_FAILED` / `HLS_SEGMENT_FAILED` | The live playlist couldn't be refreshed 5 times in a row, or more than 3 consecutive segments failed. |
| `BODY_TOO_LARGE` | A playlist, segment or response exceeded its size cap. |
| `NO_AUDIO_STREAM` | Almost no data arrived, or `ffprobe` found no audio stream. |
| `DECODE_FAILED` | FFmpeg couldn't decode at least 0.5 s of the sample. |
| `PROBE_FAILED` / `PROBE_TIMEOUT` | `ffprobe` couldn't analyse the sample, or the 15 s probe budget ran out (including while following redirects or playlists). |

## URL rejected when adding a custom station

| Code | Meaning |
|---|---|
| `URL_INVALID` | Not a valid URL, or a validation message about the name or website. |
| `URL_SCHEME_NOT_ALLOWED` | Only `http://` and `https://` are accepted. If this installation has `ALLOW_INSECURE_HTTP_STREAMS=false`, only `https://`. |
| `URL_CREDENTIALS_NOT_ALLOWED` | URLs containing `user:pass@` are refused. Authenticated streams are not supported. |
| `URL_PORT_NOT_ALLOWED` | Ports below 1024 other than 80 and 443, and common internal-service ports (SSH, databases, Docker API and so on), are refused. Ports such as 8000 and 8080 are allowed. |
| `URL_HOST_NOT_ALLOWED` | `localhost`, single-label names, and suffixes such as `.local`, `.lan`, `.internal` or `.home.arpa` are refused. |
| `URL_TOO_LONG` | Over 2048 characters. |
| `ADDRESS_BLOCKED` | The host resolves to a private, loopback, link-local, CGNAT, multicast or reserved address (IPv4 or IPv6), or a redirect leads to one. This is the SSRF protection, and it can't be switched off. A stream on your own LAN can't be added. |

A custom station is only saved if the probe succeeds. Otherwise the reply says "Nothing was added". `/radio edit` with a new URL keeps the old URL if the new one fails.

## Playback stops, stutters or switches source

| Code | Meaning |
|---|---|
| `STREAM_STALLED` | No encoder output for 15 s while playing, or no first audio within 20 s. The bot retries the same source (after about 1, 3 and 8 s), then fails over. See [audio-quality.md](audio-quality.md#recovery-and-continuity). |
| `STREAM_EOF` | The station closed the stream. Live radio shouldn't end, so this is treated as a fault and recovered. A probe also fails with `STREAM_EOF` when a direct stream ends within its sample window, which is typical of a short "station offline" file. |
| `FFMPEG_EXIT` | The encoder exited. The message includes the last FFmpeg error lines, redacted. |
| `IDENTITY_MISMATCH` | When the bot connected, the stream named itself (`icy-name`) as a *different* catalogue station. The source is marked as a mismatch, and the bot fails over to another verified source. An admin can re-compare it with `/radio rescan <station> compare:true`; the operator (or, for a custom station, a server admin) can review it with `/radio source verify`. |

- "The usual source failed, so the radio is playing from a fallback (…)", and **Degraded** in `/radio now`, mean the best source failed and a verified alternative is playing. The original is retried after its cooldown.
- If a notification channel is set, the first notice of each kind is posted, and repeats within 5 minutes are summarised in one follow-up message.
- **The voice channel status doesn't show what's playing:** the bot needs **Set Voice Channel Status** in that voice channel. Invites made with the current link include it; for an older invite, re-invite the bot with `radio-bot invite` or give its role the permission. Check that `/radio config` → Notifications shows **Voice channel status: on**. The status follows the stream's titles, so it shows only the station during adverts or on stations that send no titles.
- **Short drops followed by a speed-up, with no error logged:** Discord's player is catching up after voice packets arrived late. Check the event-loop delay in `/radio stats` → Bot health. If the worst delay is 20 ms or more (flagged in the panel, and logged as a warning at 50 ms), the bot's host was too busy to send packets on time: give it more CPU, or run fewer streams. If the delay stays low, the packets left on time and were delayed on the network between the host and Discord, or between Discord and the listener.
- **Frequent stalls on HLS** usually mean a slow or overloaded segment host. HLS only plays when no direct stream of the station is eligible. Check `/radio sources` to see why the direct streams are excluded: for example a failed probe, a cooldown, an operator disable, or an admin pin to the HLS source.
- **No song or show title, or the title disappears for a while:** titles come only from the stream's own ICY metadata. Many stations send none, HLS sources never carry one, and the bot hides a title the station clears or replaces with a placeholder (such as "Unknown" or "Advert"), so the line comes back with the next real title. Accented characters from older servers are decoded as Windows-1252 when the text is not valid UTF-8.
- **Audio quality is lower than expected:** check `/radio quality`. The source's own codec and bitrate are the real limit. The Opus target comes from the server's quality mode: `maximum` matches the source's own bitrate up to `MAX_OPUS_BITRATE_KBPS` (510 by default), and `balanced` uses 128 kbps or less. A target equal to the source's bitrate is intended, not a downgrade. The voice channel's bitrate setting is shown but is not used as a cap. In the one live test so far, 128 kbps into a 96 kbps channel sounded right, but what a listener's client receives above that setting has not been measured.

## FFmpeg problems

- **`FFMPEG_SPAWN`**, or the log line "FFmpeg/FFprobe not available — install FFmpeg or set FFMPEG_PATH/FFPROBE_PATH": the binary wasn't found. In Docker it comes from the image, so leave `FFMPEG_PATH` and `FFPROBE_PATH` unset (they are commented out in `.env.example`). Outside Docker, install FFmpeg or point the variables at it.
- **"FFmpeg was found but has no libopus encoder; playback will fail."**, or `/radio stats` showing `libopus NO`: your FFmpeg build lacks `libopus`. Use the Docker image, or an FFmpeg build compiled with `--enable-libopus` (check with `ffmpeg -hide_banner -encoders | grep libopus`). Probes still work without it, but playback doesn't.
- **FFmpeg process count keeps growing** in `/radio stats` while nothing is playing: file a bug with the counts and your logs. Every pipeline and probe process is supposed to be reaped.

## Start-up failures

| Message | Cause |
|---|---|
| `Invalid configuration: …` (exit code 78) | A missing or invalid environment variable. The message names it. For example, `DISCORD_APPLICATION_ID` must be a 17–20-digit ID. |
| `TELEMETRY_ENABLED=true is not supported` | Remove the variable or set it to `false`. |
| `Migration … was modified after being applied (checksum mismatch)` | A migration file was edited. Restore the original. Schema changes need a new migration. |
| `Database has migrations newer than this build` | You started an older image against a newer database. Run the newer image, or restore a pre-migration backup from `data/backups/`. |
| `…/pack.json is invalid`, `duplicate station slug …`, `"…" is used by both …`, `source … references unknown station …`, `Two packs use the id …` | A station pack is invalid, either a bundled one after a local edit or one in `EXTRA_PACKS_DIR`. The message names the pack, file and field. Run `pnpm validate-catalogue --pack <dir>` (after `pnpm build`). See [catalog/README.md](../catalog/README.md). |
| The container keeps restarting with `Fatal: …` about the token, or the healthcheck reports `not connected to Discord` | Wrong or reset token (reset it in the Developer Portal and update `.env`, or run `radio-bot config`), or no outbound access to Discord. |
| The healthcheck reports `ffmpeg unavailable or missing libopus` | Outside Docker: install FFmpeg with `libopus`, or point `FFMPEG_PATH`/`FFPROBE_PATH` at a build that has it (`ffmpeg -hide_banner -encoders \| grep libopus`). The Docker image always has it. |

## Catalogue sync

- **"…: the sync failed. …"**: the pack's official list couldn't be fetched, or looked implausible (fewer than 10 names, or fewer than half the pack's stations for small packs). Nothing changed, and existing entries are kept. `/radio list pack:<pack>` shows "list may be out of date" if no sync has succeeded within three intervals.
- **"No enabled station pack has an official list to sync with."**: none of the enabled packs declares `sync` in its `pack.json`.
- **"That pack is not enabled or has no official list to sync with."**: the pack you named is disabled, or doesn't declare `sync`.
- **"Needs a reviewed source mapping before it can play"**: a new station appeared on the official list. The sync deliberately never collects stream URLs, so someone has to add the station's sources to the pack's `sources.json` through a reviewed change.
- **"No longer listed"**: the station was kept (marked `missing_from_official`), and favourites are intact.

## After a restart nothing plays

This is by design unless the server opted in. With *Resume after restart* on, the last desired station resumes. With *Autostart* on, plus a default station and a preferred voice channel, the default starts. An explicit `/radio stop`, `/radio leave` or a moderator kick always prevents automatic playback. `/radio status` explains when resume was skipped.

## Getting help

When filing an issue, include:

- the Radio Bot version or image tag, and the FFmpeg version (logged at start-up in the `ffmpeg detected` line; `/radio stats` shows the DB schema version and stream User-Agent);
- the reason codes;
- the relevant log lines at `info` or `debug` level.

**Never paste your token or `.env`.** Logs are redacted, but check them before you paste. Report security issues privately: see [SECURITY.md](../SECURITY.md).
