# Troubleshooting

Most problems come with a **reason code**: a short name in capitals, such as `NO_ELIGIBLE_SOURCE` or `ADDRESS_BLOCKED`, that says what went wrong. You will find reason codes:

- in some of the bot's error replies;
- in `/radio inspect`, as a source's last failure;
- in `/radio stats`, under *Recent problems*. Each one is labelled with where the fault lies: `upstream` (the station's side), `discord`, `bot`, `operator` (the person running the bot) or `user`;
- in the logs.

This page explains what each code means and what to do about it. The full list is in `src/shared/errors.ts`. Radio Bot is unofficial and is not affiliated with or endorsed by any broadcaster; see [rights-and-disclaimer.md](rights-and-disclaimer.md).

Installed with the installer? Start with `radio-bot status` and `radio-bot logs`, and see the beginner's table in [install.md → If something goes wrong](install.md#if-something-goes-wrong). Problems with the `radio-bot` command itself are under [The radio-bot command](#the-radio-bot-command). Commands on this page that start with `docker compose …` also work in the `~/radio-bot` folder of an installer-made install (put `sudo` in front if Docker needs it on your machine).

## Tools

| Tool | What it tells you |
|---|---|
| `/radio status` | Whether the bot is connected, what it was last asked to do and with which station, the source it is using, and the last problem. It also says when playback didn't start again after a restart because *Resume after restart* is off. |
| `/radio now` / `/radio quality` | What is playing, the source's format and whether it is verified, the bitrate the bot sends to Discord, the channel's bitrate setting (which doesn't limit the bot), the data rates measured while playing, and whether DAVE encryption is in use. |
| `/radio sources <station>` | Each of the station's sources (up to 10), which one is chosen and which is the fallback, and **why each of the others can't be used**. |
| `/radio inspect <station>` | As above, plus each source's address (with any secret parts hidden), every bitrate figure, when it was last checked and last failed, the last failure code, its health, start-up time and where the address came from. Admins also get a **Check sources again** button. |
| `/radio stats` | Admins only. A private live panel with Refresh and Close buttons, in four parts: Stream input, Output to Discord, Discord connection and Bot health. See [What `/radio stats` shows](#what-radio-stats-shows) below. |
| Logs | `radio-bot logs`, or `docker compose logs -f radio-bot`, or `journalctl -u radio-bot -f` on a systemd install. Set `LOG_LEVEL=debug` for more detail (state changes and the voice dependency report), or `trace` for everything. Set it back to `info` afterwards. |
| Check a source from the command line | `docker compose exec radio-bot node dist/scripts/validate-catalogue.js --pack /app/data/installed-packs/<pack> --probe <pack>:<station>` (or `--probe --pack-id <pack>`) checks an installed pack's stations and prints the raw results. |
| `/radio packs installed` / `radio-bot packs` | Admins: every station pack, its version and where it came from, available updates, packs that couldn't be loaded and why, and notices such as a pack withdrawn from the library. |

### What `/radio stats` shows

- **Stream input:** the session's state and source; the host asked for and the host it redirected to (with a region guessed from the host name); the IP address and port connected to; HLS segments; the codec; the input rate over 10 s and 60 s and the data received; and the round trip to the stream's server, timed by TCP handshake.
- **Output to Discord:** the Opus target; the channel's bitrate setting (not a limit); the Ogg Opus rate from the encoder; packets per second to Discord (about 50); late packets since the bot joined, with the longest gap; packets lost on the way to Discord's voice server, from Discord's own report (loss on the way on to each listener isn't included); silence the voice player filled in because no audio was ready; and the **Live delay** line: how much audio is waiting, the cushion, what was dropped to stay live, the network gaps and the station's clock drift (see [Staying live](audio-quality.md#staying-live)).
- **Discord connection:** the voice server's host (with a region guess) and IP address; the channel's RTC region; the voice WebSocket ping and its jitter; the gateway ping; encryption and DAVE; this server's failovers, voice reconnects and encoder process ID; and the last FFmpeg warnings.
- **Bot health:** uptime and memory; the event-loop delay over the last minute (20 ms or more means voice packets may have left late), and on the next line the memory clean-up (garbage collection) pauses, CPU use, how often the system took the CPU away, and on Linux the host's steal over the same minute; active streams and source checks against their limits; FFmpeg processes (running, started, cleaned up) and whether `libopus` is present; the stream User-Agent in use; the database schema version; each pack's station counts and last list sync; and recent incidents, with repeats grouped together.

## Commands don't appear

- **Commands are added server by server.** The bot adds `/radio` to each server when it starts (`REGISTER_COMMANDS_ON_START=true`, the default) and when it joins a new server. Check the logs for `slash commands registered` or `command registration failed for guild`.
- **`DISCORD_DEV_GUILD_ID` is set.** The bot then adds its commands only to that one server, both at start-up and when it joins servers. Clear the setting and restart to add them everywhere.
- **The bot was invited without the `applications.commands` scope.** Invite it again with the link from `radio-bot invite`, or the URL in [install.md](install.md#3-invite-the-bot-to-your-server). You don't need to kick it first.
- **You deleted the commands by hand.** The bot only sends its commands to Discord again when they have changed, so it won't notice. Force it with `docker compose exec radio-bot node dist/scripts/register-commands.js`, optionally followed by a server ID.
- **Your Discord app is showing an old command list.** Restart the app, or press Ctrl+R on desktop.
- **The command is visible but says "Radio Bot only works inside servers".** `/radio` works only in servers, not in direct messages.

## "Radio commands are only allowed in #…"

An admin has limited radio commands to some text channels (`/radio config` → Who can use it). Use one of the channels the message names, or the text chat of an approved voice channel. Admins aren't affected by this limit.

## "Only DJs and administrators…" / "Join a voice channel first…" / "The radio is in use in #…"

These mean the server limits who can control the radio (the *listener control mode*). See [permissions.md](permissions.md#listener-control-mode). With the default `same_channel` mode, a listener must be in a voice channel, and can only control the bot when it is idle or already in their channel. An admin can change the mode, or give someone a DJ role.

## The bot doesn't join or play

| Reason code | Meaning | What to do |
|---|---|---|
| `VOICE_PERMISSION` | The bot can't use that voice channel. The message says which of these it is: it isn't a standard voice channel (stage channels aren't supported); it isn't on the server's list of approved voice channels; the bot lacks View Channel, Connect or Speak there; or the channel is full. | Give the bot's role View Channel, Connect and Speak in that channel (channel settings → Permissions), add the channel to the approved list in `/radio config` → Who can use it, or pick another channel. |
| `VOICE_CONNECT_TIMEOUT` | The voice connection wasn't ready within 20 s. | Usually a network problem on the bot's host: outgoing **UDP** traffic to Discord voice is blocked, a firewall or VPN is in the way, or the host has no IPv4 connection. Check the host's (or VM's) firewall. For more detail, run with `LOG_LEVEL=debug`. |
| `VOICE_CHANNEL_GONE` | The channel was deleted, or the bot is no longer in that server. | Choose another channel. |
| `VOICE_KICKED` | A moderator disconnected the bot. | Deliberate: the bot won't rejoin or autostart. Use `/radio play` to start again. |
| `VOICE_DISCONNECTED` | The voice connection dropped and couldn't be rebuilt after several quick attempts (spread over about 2 min). The bot says so once, then keeps trying every 2 min while playback is wanted, so the station comes back by itself after a Discord outage. | Check connectivity, and Discord's status page. Wait for it to reconnect, or `/radio stop` to stop it trying. |
| `STREAM_LIMIT` | The bot is already playing in as many servers as `MAX_ACTIVE_GUILD_STREAMS` allows (3 by default). The limit also applies when a server resumes from pause, retries or reconnects; the bot then posts one notice and tries again about every 2 minutes. | Wait for another server to stop, or raise the limit in `.env` if your hardware can take it. |
| `RATE_LIMITED` | "Too many … in a short time. Try again in N s." (or "N min" or "N h" for longer waits). A per-user or per-server rate limit was hit (see [permissions.md](permissions.md#rate-limits)). | Wait the time shown. |
| `CUSTOM_STATION_LIMIT` | The server already has `MAX_CUSTOM_STATIONS_PER_GUILD` custom stations. | Remove one with `/radio remove`, or raise the limit. |
| `CANCELLED` | A newer command replaced this one before it finished (for example, a second `/radio play` while the first was still connecting), or a probe was stopped. | Nothing to fix: the newer command wins. |
| `INTERNAL` | Something the bot didn't expect, or an action that doesn't apply (for example "This pack has no official list to sync with."). The message says which. | If the message doesn't explain it, check `radio-bot logs` (or `docker compose logs`) for the error and report it as a bug. |

### DAVE / encryption

DAVE is Discord's end-to-end encryption for voice calls. The bot joins with DAVE switched on (`daveEncryption: true`), and the library it needs, `@snazzah/davey`, is included in the image. `/radio quality` shows either "DAVE end-to-end encrypted (privacy code …)" or "Encrypted in transit; DAVE end-to-end encryption not used for this call". Both are normal: Discord decides for each call whether DAVE is used.

Underneath DAVE, every packet is also encrypted in transit, with AES-256-GCM or XChaCha20-Poly1305, whichever Discord's voice server lists first. At start-up the bot checks that it can do both and logs `voice encryption available`. If it logs an error instead, a voice server that doesn't offer AES-256-GCM can't be used: reinstall the dependencies (`@noble/ciphers` provides XChaCha20-Poly1305), or use the Docker image.

If the voice connection fails consistently after a Discord-side protocol change:

- check the logs at `debug` level for the voice dependency report, which lists the encryption and DAVE libraries found;
- update to a release that pins newer `@discordjs/voice` and DAVE packages;
- if you run from source rather than Docker, make sure `@snazzah/davey` installed correctly. It is a native module, so its prebuilt binary must match your platform.

## "No verified, working source is available" (`NO_ELIGIBLE_SOURCE`)

A station can have several *sources* (stream addresses). The bot plays one only when it has checked that the source works and that it really carries this station, and nobody has switched it off. This message means none of the station's sources can be used right now, so nothing is played. (The bot never plays a different station instead.) The reply lists up to four sources with the reason each one can't be used, and `/radio sources <station>` shows all of them:

| Reason shown | Meaning | What to do |
|---|---|---|
| not checked yet | No check has run yet. A probe normally runs automatically when you play. | Admins: run `/radio rescan <station>`. |
| last check failed (CODE) | The last check failed. See the probe codes below. `/radio sources` shows how many checks failed in a row and when the next automatic one is. | Wait: failing sources are re-checked with a growing wait (about 10 min, 1 h, 6 h, 12 h, then once a day), and playback is retried after 15, 30 and 60 s, then every 2 min while it is wanted. Or rescan, which checks at once. A source that has had no successful check for a week and at least 5 failed checks in a row is **paused** ("Paused: no successful check for over a week…") and is only tested again when an admin rescans, the bot's operator runs **Check all sources again**, or a pack update gives it a new address. |
| not verified as this station | The check worked, but nothing confirms that this feed carries this station. | An admin can compare it with `/radio rescan <station> compare:true`. The operator (or, for a custom station, a server admin) can review it with `/radio source verify`. See [station-verification.md](station-verification.md#identity-rules). |
| plays a different station (identity mismatch) | The stream names itself as a different catalogue station, or an operator marked it as a mismatch. | Deliberate: the bot never plays a mismatched feed for this station. |
| resting after repeated failures until … | The source kept failing during playback for more than a minute, so the bot is resting it for a while. | Wait: if no other source can play, the bot checks this one again every 2 min and plays it as soon as a check works. Otherwise the rest ends by itself (10 min, doubling each time up to 2 h). If you run the stream, fix it. |
| disabled: … | Switched off in the station pack, or by the person running the bot with `DISABLED_SOURCE_IDS` / `DISABLED_STATION_IDS`. | Intentional. See [rights-and-disclaimer.md](rights-and-disclaimer.md#takedown-procedure). |
| blocked by the bot's safety rules | The source's address isn't allowed, leads to a blocked address, or the stream is encrypted. | See `ADDRESS_BLOCKED` and `HLS_ENCRYPTED` below. |
| codec not verified | The check didn't confirm what kind of audio the stream carries. | Admins: run `/radio rescan <station>`. |
| blocked by rights/takedown policy | The operator has blocked this source after a rights request. | Intentional. See [rights-and-disclaimer.md](rights-and-disclaimer.md#takedown-procedure). |
| skipped because it just failed | It failed a moment ago, so the bot is trying the others first. | Nothing: it can be tried again on the next attempt. |

"…is catalogued, but no stream source is known for it yet" means the station has no enabled source at all. This happens, for example, with a station newly added by `/radio packs sync`. Nothing else is played in its place. Someone has to add a reviewed source mapping to the pack's `sources.json`: for a library pack, through a change to the pack library, then an update of the pack (see [catalog/README.md](../catalog/README.md)).

## Probe and stream errors

These codes come from checking a stream (a *probe*) or playing it. Most of them are problems on the station's side. During playback the bot reacts by itself: it retries the same source where that can help, then switches to another verified source of the same station if there is one. Usually there is nothing for you to do except wait, or try again later.

| Code | Meaning |
|---|---|
| `ACCESS_DENIED` | The stream host refused access with HTTP 401, 403 or 451, for the stream itself or for an HLS playlist or segment. This can mean the stream is only for listeners in certain countries, is restricted for rights reasons, or is only served to certain apps. Retrying the same source wouldn't help, so the bot moves straight to a fallback.<br><br>By default the bot identifies as FFmpeg's network library, `Lavf/<version>` from the installed FFmpeg. Many hosts that refuse unknown clients accept that, because it is a standard media player's network stack. Check the value in use in `/radio stats`. If you changed `STREAM_USER_AGENT`, clear it to return to FFmpeg's own.<br><br>The bot does not imitate a web browser, sends no `Referer`, and never uses signed or tokenised URLs. A host that still refuses is respected. |
| `NOT_FOUND` | The address no longer exists (HTTP 404 or 410): the mount was removed or renamed. During playback a 404 is first retried on the same source, because an Icecast server answers 404 for a few seconds while the station's own encoder reconnects; if it keeps failing, playback fails over. A check that finds it gone re-checks it after 12 h, then daily, in case it returns. If it stays gone, the pack's maintainer should disable it (`enabled: false` with a `disabledReason`). |
| `HTTP_STATUS` | The stream server answered with another non-2xx status, such as 5xx. |
| `HTTP_TIMEOUT` / `HTTP_ERROR` | The server didn't respond in time, or the connection failed. A check waits up to 15 s for the server's first response, and playback up to 10 s. |
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
| `PROBE_FAILED` / `PROBE_TIMEOUT` | `ffprobe` couldn't analyse the sample, or the check's 22 s time limit ran out (including while following redirects or playlists). |

## URL rejected when adding a custom station

| Code | Meaning |
|---|---|
| `URL_INVALID` | Not a valid URL, or a validation message about the name or website. |
| `URL_SCHEME_NOT_ALLOWED` | Only `http://` and `https://` are accepted. If this installation has `ALLOW_INSECURE_HTTP_STREAMS=false`, only `https://`. |
| `URL_CREDENTIALS_NOT_ALLOWED` | URLs containing `user:pass@` are refused. Authenticated streams are not supported. |
| `URL_PORT_NOT_ALLOWED` | Ports below 1024 other than 80 and 443, and common internal-service ports (SSH, databases, Docker API and so on), are refused. Ports such as 8000 and 8080 are allowed. |
| `URL_HOST_NOT_ALLOWED` | `localhost`, single-label names, and suffixes such as `.local`, `.lan`, `.internal` or `.home.arpa` are refused. |
| `URL_TOO_LONG` | Over 2048 characters. |
| `ADDRESS_BLOCKED` | The host resolves to a private, loopback, link-local, CGNAT, multicast or reserved address (IPv4 or IPv6), or a redirect leads to one. This stops anyone using the bot to reach machines on its own network (see [SSRF](permissions.md#custom-station-safety-ssrf)), and it can't be switched off. So a stream on your own home or office network can't be added. |

A custom station is only saved if the bot's check of its stream succeeds. Otherwise the reply says "Nothing was added". `/radio edit` with a new URL keeps the old URL if the new one fails.

## Playback stops, stutters or switches source

| Code | Meaning |
|---|---|
| `STREAM_STALLED` | No audio came out of the encoder for 15 s while playing, or none arrived within 20 s of starting. The bot retries the same source (after about 1, 3 and 8 s), then fails over. See [audio-quality.md](audio-quality.md#recovery-and-continuity). |
| `STREAM_EOF` | The station closed the stream. Live radio shouldn't end, so this is treated as a fault and recovered. A probe also fails with `STREAM_EOF` when a direct stream ends within its sample window, which is typical of a short "station offline" file. |
| `FFMPEG_EXIT` | The encoder exited. The message includes the last FFmpeg error lines, redacted. |
| `IDENTITY_MISMATCH` | When the bot connected, the stream named itself (`icy-name`) as a *different* catalogue station. The source is marked as a mismatch, and the bot fails over to another verified source. An admin can re-compare it with `/radio rescan <station> compare:true`; the operator (or, for a custom station, a server admin) can review it with `/radio source verify`. |

- "The radio is now playing from a fallback source (…)", and "Playing from a fallback" in `/radio now`, mean the best source failed and another verified source of the same station is playing. The bot moves back to the usual source by itself once a check shows that it works again (see [audio-quality.md → Recovery and continuity](audio-quality.md#recovery-and-continuity)).
- If a notification channel is set, the first notice of each kind is posted, and repeats within 5 minutes are summarised in one follow-up message.
- **The voice channel status doesn't show what's playing:** the bot needs **Set Voice Channel Status** in that voice channel. Invites made with the current link include it; for an older invite, re-invite the bot with `radio-bot invite` or give its role the permission. Check that the `/radio config` overview shows **Channel status: on** under Notices. The status follows the stream's titles, so it shows only the station during adverts or on stations that send no titles.
- **Short drops followed by a speed-up, with no error logged:** voice packets reached Discord late, and Discord's player is catching up. To find out why:
  1. In `/radio stats`, look at **Late packets** under Output to Discord. A longest gap of about 55 ms or more is enough to hear.
  2. Then look at the event-loop delay under Bot health. If the worst delay is 20 ms or more (flagged in the panel, and logged as a warning at 50 ms), the bot couldn't send packets on time. The line below it says why, as does the warning in the log, which also lists that minute's late packets with their times. A long **memory clean-up** pause (garbage collection) means the bot's own memory work held it up. High **preempted** counts or **host steal** mean the host was too busy: other programs on it, or other machines on the same physical server. Give it more CPU, or run fewer streams. On a one-core host, most of these come from other scheduled jobs (stats collectors, `docker stats` loggers, backups): move them to another machine, run them less often, or use a lighter tool. To match a delay to its cause, set `LOG_LEVEL=debug`: each minute's worst delay is logged, and so is every interaction, with the CPU time used while it ran. On a systemd install the unit already gives the bot a higher CPU priority (`Nice=-5`).
  3. Look in the log at that time for **"voice connection resuming"** (or "voice connection interrupted"), followed by "voice connection ready again". Discord's voice connection closed and the bot resumed it. No audio can be sent until it is ready again, usually a fraction of a second, so listeners hear a short gap. The bot drops that audio to stay live, so the music has moved on by the length of the gap when the sound comes back (`skippedMs`); any backlog in the live queue is dropped at the same moment (`caughtUpMs`). The cause is on the network or Discord's side, and an occasional one is normal. If the connection isn't ready again within 30 s (for example a resume that Discord never answers), the bot logs **"voice connection stuck; rejoining"** as a warning and rejoins the voice channel; if that hasn't brought it back 15 s later, it logs **"voice connection still stuck; joining again from scratch"**, gives the connection up and joins again, which gets a new voice server from Discord (the log then shows the lost voice link and the reconnect). `afterMs` is how long the connection had not been ready. Many of these point to trouble on Discord's voice service or the host's route to it.
  4. Look in the log for **"caught up with live"** near that time. With `reason: "gap"`, the station's audio stopped arriving for a moment (a network gap) and the listeners heard a break; the bot then dropped the audio that piled up (`droppedMs`), so the break doesn't leave the stream behind live, and keeps a little more in hand (`cushionMs`) for the rest of the stream. With `reason: "settle"`, the bot dropped a late part of the connect burst shortly after the start; that is normal. Frequent gaps point to the network between the host and the station, or to the station's server. `reason: "limit"` means the queue stayed 3 s above its margin with no break to hide the cut, usually because the station's clock runs fast; an occasional one is expected.
  5. If the delay stays low and nothing was logged, the packets left on time and were held up on the network, between the host and Discord or between Discord and the listener. To tell which, look at **Lost on the way to Discord** under Output to Discord, which comes from Discord's own report of what its voice server received (see [audio-quality.md → Discord's receiver report](audio-quality.md#discords-receiver-report)). Press Refresh after a cut and compare the count with the one before:
     - **It went up:** packets left the host but never reached Discord's voice server. The loss is between the host and Discord: the host's network or its provider. A jitter of more than a few milliseconds points the same way.
     - **It stayed the same:** Discord's server had every packet, so the loss was between that server and the listener (their own connection, or a voice server far from them: see step 6). A listener can check their side in Discord's own voice debug panel, where lost packets and NACKs (requests to send a packet again) are counted for each person in the call.
     The count starts again at 0 with each new voice connection (a reconnect, a move or a voice server change), and the line shows a dash after a resume until Refresh is pressed.
  6. **Check where the call is hosted.** One Discord voice server carries the whole call. With the channel's region on automatic (`channel region: automatic` in `/radio stats`), Discord places the call near whoever joins the empty channel first, and keeps it there until the channel empties. If the bot joins first (autostart, or resuming after a restart), the call sits near the bot's host, and because the bot stays connected it can stay there, however far away the listeners are. The voice server's host and its region guess are under Discord connection in `/radio stats`. If it is far from most listeners, a server admin can set the voice channel's **Region Override** (in the channel's settings) to a region near them.
- **The radio is further behind live than expected** (for example, behind the station's own player or a broadcast you can hear at the same time): a direct stream plays about 1 s behind what the station sends, plus Discord's own buffering (about 0.1 s); see [audio-quality.md → Staying live](audio-quality.md#staying-live). The station's own web player and its broadcast on air have delays of their own, different from the stream the bot plays, so they are not a fair comparison. To check:
  1. In `/radio stats`, look at the **Live delay** line under Output to Discord, for example `Live delay: 1.0 s waiting (cushion 1.5 s) · … · 1 network gap · station clock 42 ppm fast`. The first figure is how much audio is waiting to be sent. On a direct stream the cushion is 1 s and grows by 0.5 s after each network gap, up to 3 s; after 30 minutes without a gap it eases back by 0.5 s, at the next catch-up (for example the next voice resume). A high cushion with many network gaps means the connection to the station is unsteady.
  2. An HLS stream is further behind by design: its cushion is the segment length plus the 1 s margin (growing to plus 3 s after network gaps), and the bot starts three segments behind the newest one. Check `/radio sources` to see why a direct stream isn't used.
  3. The log shows each time the bot dropped audio to stay live: **"started behind live by the cushion; dropped the connect burst"** at the start of a stream (normal: that is the burst the station's server sends on connect), then **"caught up with live"**, with why (`settle`, `gap`, `resume`, `limit` or `cap`) and how much (`droppedMs`).
  4. The bot never speeds the audio up or resamples it to catch up, so clock drift is reported (`station clock … ppm fast` or `slow` in `/radio stats`, after 10 minutes of steady play) rather than corrected. If playback ever falls more than 45 s behind live, the bot reopens the source at the live edge and logs "playback drifted behind live; resynchronising".
- **Frequent stalls on HLS** usually mean the server that delivers its segments is slow or overloaded. (*HLS* sends audio as a series of short files instead of one continuous stream.) HLS only plays when no direct stream of the station can be used. Check `/radio sources` to see why the direct streams are left out: for example a failed check, a rest after repeated failures, a source switched off by the person running the bot, or an admin pin to the HLS source.
- **No song or show title, or the title disappears for a while:** titles come only from the text the station sends inside its stream (ICY metadata). Many stations send none, and HLS sources never carry one. When the station clears the title or replaces it with a placeholder (such as "Unknown" or "Advert"), the bot hides it, and the line comes back with the next real title. Accented characters from older servers are read as Windows-1252 when the text is not valid UTF-8.
- **Audio quality is lower than expected:** check `/radio quality`. The station's own stream (its codec and bitrate) is the real limit: the bot can't add detail the station doesn't send. The bitrate the bot sends to Discord (its *Opus target*) comes from the server's quality mode: `maximum` matches the source's own bitrate up to `MAX_OPUS_BITRATE_KBPS` (510 by default), but never goes below 128 kbps (96 for mono), and `balanced` uses 128 kbps or less. A target equal to the source's bitrate is intended, not a downgrade, and so is a target of 128 kbps for a lower-rate station (see [audio-quality.md → The re-encode floor](audio-quality.md#the-re-encode-floor)). The voice channel's bitrate setting is shown but doesn't limit the bot; what a listener's Discord app receives above that setting has not been measured.

## FFmpeg problems

- **`FFMPEG_SPAWN`**, or the log line "FFmpeg/FFprobe not available — install FFmpeg or set FFMPEG_PATH/FFPROBE_PATH": the binary wasn't found. This is a fault on the bot's side, so it never counts against the station's source: the bot retries the same source instead of switching to a fallback. In Docker it comes from the image, so leave `FFMPEG_PATH` and `FFPROBE_PATH` unset (they are commented out in `.env.example`). Outside Docker, install FFmpeg or point the variables at it.
- **"FFmpeg was found but has no libopus encoder; playback will fail."**, or `/radio stats` showing `libopus: missing`: your FFmpeg build lacks `libopus`. Use the Docker image, or an FFmpeg build compiled with `--enable-libopus` (check with `ffmpeg -hide_banner -encoders | grep libopus`). Probes still work without it, but playback doesn't.
- **FFmpeg process count keeps growing** in `/radio stats` while nothing is playing: file a bug with the counts and your logs. Every pipeline and probe process is supposed to be reaped.

## Start-up failures

| Message | Cause |
|---|---|
| `Invalid configuration: …` (exit code 78) | A missing or invalid environment variable. The message names it. For example, `DISCORD_APPLICATION_ID` must be a 17–20-digit ID. |
| `TELEMETRY_ENABLED=true is not supported` | Remove the variable or set it to `false`. |
| `Migration … was modified after being applied (checksum mismatch)` | A migration file was edited. Restore the original. Schema changes need a new migration. |
| `Database has migrations newer than this build` | You started an older version against a database that a newer version has already migrated. Run the newer version again, or restore the `radio-bot-pre-v<N>-…` backup the newer version took just before it migrated. With the installer, follow [install.md → Going back to an earlier version](install.md#going-back-to-an-earlier-version). By hand, the backups are in the `backups` folder next to the database (`/app/data/backups/` in Docker, `/var/lib/radio-bot/backups/` with systemd). |
| `diagnostics endpoint unavailable; carrying on without it` (a warning, not a failure) | `DIAGNOSTICS_PORT` is already in use. The bot carries on without the diagnostics endpoint; choose another port, or leave the variable empty. |
| `…/pack.json is invalid`, `duplicate station slug …`, `"…" is used by both …`, `source … references unknown station …`, `Two packs use the id …`, `this pack needs Radio Bot … or later` | One of your own packs in `EXTRA_PACKS_DIR` (or a pack folder added to `catalog/packs/` by hand) is invalid. The message names the pack, file and field. Run `node scripts/validate-catalogue.ts --pack <dir>`. See [catalog/README.md](../catalog/README.md). Installed packs never stop start-up: see [Station packs](#station-packs). |
| The container keeps restarting with `Fatal: …` about the token, or the healthcheck reports `not connected to Discord` | Wrong or reset token (reset it in the Developer Portal and update `.env`, or run `radio-bot config`), or no outbound access to Discord. |
| The healthcheck reports `ffmpeg unavailable or missing libopus` | Outside Docker: install FFmpeg with `libopus`, or point `FFMPEG_PATH`/`FFPROBE_PATH` at a build that has it (`ffmpeg -hide_banner -encoders \| grep libopus`). The Docker image always has it. |

## Station packs

- **"No stations yet. An admin can add station packs with `/radio packs library`…"**: no station packs are installed. Radio Bot ships with none. Add some with `radio-bot packs browse` and `radio-bot packs add <pack>` on the bot's machine, or, as the bot's operator, with `/radio packs library` in Discord. See [install.md → Adding and removing stations](install.md#adding-and-removing-stations).
- **The stations of a pack disappeared after updating from 1.1.0 or earlier:** those versions included a pack, and newer ones get it from the pack library instead. At start-up the bot reinstalls every pack its database has stations from but no longer has, before anything plays. If it couldn't reach the library, the log says `could not reach the pack library to restore missing station packs; will try again later`, and the daily check tries again. To do it now, run `radio-bot packs add <pack>` (the pack ID is the first part of the station IDs, before the `:`). A pack you removed on purpose is never put back by itself.
- **"Couldn't reach the pack library: …"** (Discord), or a network error from `radio-bot packs`: the bot's host couldn't reach the library on `github.com`. Check its outbound HTTPS. `/radio packs installed` still lists the installed packs, without update information.
- **"…only the bot owner can install, update or remove them."**: installing, updating or removing a pack affects every server, so it needs an admin who is also the bot's operator: listed in `OPERATOR_USER_IDS`, or the owner of the bot's Discord application (or a member of its team). See [permissions.md](permissions.md#access-levels).
- **"This bot has no data folder, so it can't install station packs."**: `DATABASE_PATH` is `:memory:`, so there is nowhere to keep installed packs. Use a database file.
- **"Too many station pack changes in a short time"** (`RATE_LIMITED`): the whole installation accepts 10 pack changes an hour from Discord.
- **"The pack library has no pack called …"**: the pack ID is wrong, or the pack has been withdrawn from the library. `radio-bot packs browse` lists what there is.
- **A pack is listed under _Not loaded_** in `/radio packs installed` (also as `Not loaded: …` in `/radio stats` and `radio-bot packs list`), and the log says `installed station pack skipped`: an installed pack's files failed their checks, needed a newer Radio Bot, or clash with another pack (the same pack ID or source ID as one of your `EXTRA_PACKS_DIR` packs, for example). The reason is shown next to it. The bot carries on without that pack. Update the pack with `radio-bot packs update <pack>`, update Radio Bot, or remove the pack, whichever the reason calls for.
- **A notice says a pack "was withdrawn from the pack library … and has been removed."**: the library took the pack out, for example at the request of the radio company, and the bot removed it at its daily check, stopping anything that was playing from it. Favourites and queues are kept but its stations are hidden. Packs you installed from another library with `--from` are never removed this way.
- **`radio-bot packs` says "Couldn't tell Radio Bot to load the change."**: the pack was changed, but sending the running bot `SIGHUP` failed. Run `radio-bot restart` to load it.
- **An update is available but nothing changed:** packs never update by themselves. Press **Update** on the pack's card in `/radio packs installed`, or run `radio-bot packs update`.

`PACK_INVALID` is the reason code for a pack or pack list the bot refused. Nothing is written, and an installed copy is left as it was:

| Message | Meaning |
|---|---|
| `The download of "…" doesn't match the library's fingerprint, so it was not used.` | The bundle's SHA-256 differs from the one in the library's index: the download was cut short or changed on the way, or the library is being republished. Try again later. |
| `The download of "…" is not a pack.` / `… holds a different pack (…)` | The library sent something other than the bundle of the pack asked for. Try again later, and report it to the library if it persists. |
| `The pack library sent something that is not a pack list.` / `The pack library's list is not valid (at …).` | The library's `index.json` couldn't be read. With `--from`, check the address. |
| `…/pack.json is invalid …`, `this pack needs Radio Bot … or later`, or another pack check | The pack failed the same checks as a pack folder, or needs a newer Radio Bot than this one. Update Radio Bot. |
| `A pack called "…" is already loaded from EXTRA_PACKS_DIR …` / `Source id "…" is used by packs …` | The pack clashes with a pack you already have. Rename or remove your own pack, or don't install this one. |

## Catalogue sync

- **"…: the sync failed. …"**: the pack's official list couldn't be fetched, or looked implausible (fewer than 10 names, or fewer than half the pack's stations for small packs). Nothing changed, and existing entries are kept. `/radio list pack:<pack>` shows "list may be out of date" if no sync has succeeded within three intervals.
- **"None of the enabled station packs has an official list to check against."**: none of the enabled packs declares `sync` in its `pack.json`.
- **"That pack is either not enabled or has no official list to check against."**: the pack you named is disabled, or doesn't declare `sync`.
- **"Added: … (no stream yet: they can't play until a reviewed source is added to the pack)"**: new stations appeared on the official list. The sync deliberately never collects stream URLs, so someone has to add the station's sources to the pack's `sources.json` through a reviewed change (for a library pack, in the library), after which the pack is updated.
- **"No longer on the official list: … (kept here, so favourites still work)"**: the station was kept (marked `missing_from_official`), and favourites are intact.
- Long lists show the first 15 names and how many more there are.

## After a restart nothing plays

That is normal: after a restart the bot stays silent unless one of these is switched on for the server in `/radio config` → Playing:

- With *Resume after a restart* on, the station that was playing (or paused in an empty channel) starts again.
- With *Autostart* on, the default station starts in the preferred voice channel. Autostart can only be switched on once both are set; if one is cleared later, the overview says what autostart still needs.

A `/radio stop`, a `/radio leave` or a moderator disconnecting the bot always prevents automatic playback. `/radio status` says when the bot didn't resume.

## Importing settings

- **"This import preview expired. Run /radio import again."**: a preview lasts 10 minutes, and each server has only one at a time, so a newer `/radio import` replaces the older preview and its buttons stop working.
- **"Too many imports in a short time"** (`RATE_LIMITED`): a server can run `/radio import` five times in ten minutes. The file must be at most 256 KB. Custom stations re-added by an import count towards the limit on adding custom stations, and any over it are listed as "not added" so you can add them later with `/radio add`.
- **Custom stations "were left out of the export"**: their URLs had a query string or a user name, which could hold a secret, so the export redacted them. Add them again with `/radio add`.
- **Custom-station favourites or a custom default station are missing from the file:** that is deliberate. Exports leave them out, and an import keeps the ones the server already has.

## The radio-bot command

| Message | What to do |
|---|---|
| `Docker is not installed.` | On Linux, let the installer install it (answer `y`), or install Docker Engine yourself. On a Mac or Windows PC, install Docker Desktop (see [install.md](install.md#2-install-radio-bot)). |
| `Docker is installed but not running.` | Start Docker Desktop, or run `sudo systemctl start docker`, then try again. |
| `Docker Compose … is too old; Radio Bot needs 2.24 or newer.` | Update Docker. `compose.yaml` uses an optional settings file, which older Compose releases reject. |
| `Radio Bot stopped while starting. The lines above say why.` | Read the log lines printed above it. A wrong token or Application ID is the most common cause: fix them with `radio-bot config`. |
| `Radio Bot still isn't ready after 90 seconds.` | The bot is running but hasn't reported itself healthy (connected to Discord, database working, FFmpeg ready). Check `radio-bot logs` and the host's connection to Discord. |
| `Files in … were edited, so updating could overwrite them.` | Move your changes into `compose.override.yaml`, run the `git … checkout -- .` command the message shows (it discards the edits), and update again. |
| `Couldn't reach GitHub to check for updates.` | The host can't reach GitHub. Check its connection and try again. |
| `Couldn't reach the pack library just now. Try later with: radio-bot packs browse` (during `install`) | The installer couldn't show the pack library, so no packs were added. Check the connection, then run `radio-bot packs browse` and `radio-bot packs add <pack>`. |
| `Radio Bot isn't running. The change takes effect when it starts: radio-bot start` (from `packs`) | Expected: the pack was changed while the bot was stopped, and is loaded when it starts. |
| `Couldn't tell Radio Bot to load the change. It loads it at its next restart: radio-bot restart` (from `packs`) | The pack was changed, but the running bot couldn't be told. Run `radio-bot restart` to load it now. |
| `… isn't installed. See the installed packs with: radio-bot packs` or `"…" isn't a pack name.` (from `packs remove`) | Nothing was changed, and the name isn't remembered as removed. Check the name against the list `radio-bot packs` shows. |
| `Couldn't check the bot's station packs just now. To add stations later, run: radio-bot packs browse` (during `install`) | The installer couldn't ask the bot which packs it has. Add packs later with `radio-bot packs browse` and `radio-bot packs add <pack>`. |
| `Version … was not found.` (from `update`) | The version you named doesn't exist. Release names start with `v`, as in `radio-bot update v1.5.1`. |
| `Couldn't switch to the newest …; nothing was restarted.` (from `update`) | The update couldn't change to the new version's files, so the bot kept running the old one. The lines above say why; fix that and try again. |
| `Docker Compose v2 is missing.` | Install the Docker Compose plugin (it comes with Docker Desktop), then try again. |
| `There is no terminal to ask … in.` | The command needs to ask a question, but wasn't run in a terminal (for example from a script). Run it in a terminal window. |
| `No text editor found.` (from `config`) | Install `nano` (for example `sudo apt install nano`), or set `EDITOR` to the editor you use, then try again. |
| `Couldn't save a copy of the bot's data, so nothing was removed.` (from `uninstall`) | Nothing was removed. The lines above say why the copy failed. Fix that, or answer no to saving a copy if you don't need one. |
| `Couldn't back up the database, so nothing was changed.` (during `update`) | The update stopped before changing anything. The lines above say why; fix that, or check `radio-bot logs`, then try again. |
| `The last update to … didn't finish` (from `update` or `status`) | An earlier update switched versions but stopped before the bot ran the new one, for example because the download failed. `radio-bot update` finishes it. |
| `Radio Bot isn't running, so no new backup can be made.` (from `backup`) | Expected when the bot can't start. The backups it made earlier are still copied to the `backups` folder. If it then says `Couldn't copy the backups out of the bot's data`, the bot hasn't made any backups yet. `There is no Radio Bot container to copy backups from` means the bot has never been started on this install: run `radio-bot start`. |
| `… isn't a Radio Bot backup (a .sqlite file), so nothing was changed.` (from `restore`) | The file isn't a SQLite database. Choose a `.sqlite` file from the `backups` folder. |
| `The backup wasn't restored. Radio Bot has been started again with the data it had.` | Copying the backup in failed, and nothing was changed. The lines above say why. |
| `The backup may or may not have been restored; to be sure, run the same restore again.` | You pressed Ctrl+C while the backup was being copied in. The copy may have finished just before. Radio Bot has been started again either way; running the same `radio-bot restore` again makes sure. |

## Getting help

When filing an issue, include:

- the Radio Bot version or image tag, and the FFmpeg version (logged at start-up in the `ffmpeg detected` line; `/radio stats` shows the DB schema version and stream User-Agent);
- the reason codes;
- the relevant log lines at `info` or `debug` level.

**Never paste your token or `.env`.** Logs are redacted, but check them before you paste. Report security issues privately: see [SECURITY.md](../SECURITY.md).
