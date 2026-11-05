# Audio quality

## In short

- **The bot passes the station's sound through as faithfully as it can.** It converts the station's stream to Opus, the format Discord uses, exactly once. It adds no volume levelling, EQ, compression or other effects.
- **It follows the station's own bitrate.** *Bitrate* is how much data per second a stream uses; more data can carry more detail. By default (`maximum` quality) the bot sends each station at the bitrate the station itself uses, up to 510 kbps. A 128 kbps station is sent at 128 kbps. Sending it at more would use more bandwidth without adding any detail.
- **It cannot improve on the station.** Whatever detail the station's own stream has lost is gone. No setting brings it back.
- **The voice channel's bitrate setting doesn't limit the bot.** That setting is for people's voices. The bot sends its stream at its own target and shows the channel setting for information only.
- **Admins can choose a different quality** in `/radio config`: `balanced` (at most 128 kbps, to save bandwidth) or `manual` (a fixed bitrate).
- **`/radio quality` shows exactly what is happening:** the station's format and bitrate, how sure the bot is of each figure, and what it sends to Discord.
- **If the stream fails, the bot tries to recover by itself:** first by reconnecting to the same stream, then by switching to another verified stream of the same station. It never plays a different station instead.

Radio Bot is unofficial and is not affiliated with or endorsed by any broadcaster; see [rights-and-disclaimer.md](rights-and-disclaimer.md). The rest of this page explains each point in detail.

## The audio path

```text
Station stream (a direct HTTP(S) stream, or HLS)
   │  fetched by the bot itself (SafeHttpClient): every address and redirect checked,
   │  DNS pinned; PLS/M3U playlists followed; HLS playlists and segments fetched by
   │  the bot; in-stream song titles (ICY metadata) taken out
   ▼
FFmpeg, reading only from its standard input  (-protocol_whitelist pipe -i pipe:0)
   │  decode AAC / MP3 / Opus / … → first audio stream only (-map 0:a:0)
   │  -ac 2 -ar 48000      two channels, 48 kHz (Discord requires 48 kHz)
   │  -c:a libopus -b:a <target>k -vbr on -compression_level 10
   │  -application audio -frame_duration 20
   │  -f ogg -page_duration 100000 -flush_packets 1
   ▼
Ogg Opus on FFmpeg's standard output
   ▼
@discordjs/voice: createAudioResource(…, { inputType: StreamType.OggOpus, inlineVolume: false })
   │  unpacks the Ogg container into Opus packets; no decoding, no second encode
   ▼
Discord voice connection (self-deafened; DAVE end-to-end encryption where Discord negotiates it)
```

*HLS* (HTTP Live Streaming) delivers audio as a series of short files ("segments") listed in a playlist that keeps being updated. A *direct stream* is one long, continuous download. The exact FFmpeg arguments are in `buildEncodeArgs()` in `src/audio/encoder.ts`. Only the target bitrate changes at run time. User input never reaches them.

What is deliberately **not** in the chain: loudness normalisation, ReplayGain, EQ, dynamic-range compression, limiting, filters and volume scaling. `inlineVolume` is off, so the voice library doesn't decode the audio to change its volume either. The only conversions are the ones Discord requires:

- **Resampling to 48 kHz** when the source uses another sample rate. 44.1 kHz is common for internet radio.
- **Stereo framing** (see [Mono and sample rate](#mono-and-sample-rate)).

Metadata and non-audio streams are dropped (`-map_metadata -1 -vn -sn -dn`). Corrupt packets are discarded (`-fflags +discardcorrupt`), so that one bad frame doesn't stop the stream.

### How HLS streams are read

The bot reads HLS itself; FFmpeg only ever sees the audio bytes.

- **Start:** playback begins three segments behind the newest one (the "live edge"), so there is a little buffer.
- **Refreshing the playlist:** the bot asks for the playlist again every half segment length (at least 1 s, at most 10 s). If 5 refreshes in a row fail, the stream fails with `HLS_PLAYLIST_FAILED`.
- **Out-of-date copies:** a playlist that is a little behind what has already been played (a stale copy from another server of the same network) is ignored, so no audio is repeated. A playlist that has gone back further than its own length means the station restarted its encoder; the bot then starts again near the live edge.
- **Segments:** each segment is downloaded up to twice. Some HLS streams (fMP4) also have a start-up section that the segments need; it is downloaded up to twice as well. If more than 3 segments in a row can't be downloaded, the stream fails with `HLS_SEGMENT_FAILED`.
- **Falling behind:** if a long pause leaves the bot behind the playlist, it skips ahead to near the live edge.
- **Encrypted HLS** is refused (`HLS_ENCRYPTED`). The bot never bypasses encryption.

## Why there is no double encode

A common mistake in Discord music bots is to decode the source and then let the voice library encode Opus, after FFmpeg has already transcoded it once. That adds a second lossy step for nothing. (*Lossy* means some detail is thrown away to save space; each lossy step loses a little more.)

Radio Bot does the encoding inside FFmpeg (`libopus`) and hands the voice library a finished **Ogg Opus** stream, marked as such with `StreamType.OggOpus`. For this input type, `@discordjs/voice` only unpacks the Ogg container into Opus packets and sends them as they are. With `inlineVolume: false` it has no reason to decode them. A typical AAC or MP3 station therefore goes through exactly one lossy encode by the bot: source codec → Opus.

A source that is already Opus is still decoded and encoded again at the target bitrate. There is no pass-through without re-encoding in this version. The PRD lists that as a possible later optimisation, only if framing, DAVE and stability can be guaranteed.

## How the Opus target is chosen

`planEncoder()` (`src/audio/encoder.ts`) works the target out from:

- the server's quality mode, and the manual bitrate if one is set;
- the installation's ceiling, `MAX_OPUS_BITRATE_KBPS` (default 510, allowed range 32–510);
- the source's own bitrate: the measured figure, else the figure from its codec metadata, else the figure declared in its HLS playlist (manifest) or advertised in its HTTP headers.
  - The measured figure comes first because it is what the station really sends. For MP3 it and the codec metadata always agree, but for AAC the codec metadata is only an estimate: in the checks of the first library pack, AAC streams that measured 128 kbps reported anything from 114 to 176 kbps.
  - A later check whose sample was too short to measure keeps the earlier measurement of the same stream.
  - For HLS, the bot may open a clearly higher version (*rendition*) of the stream than the one its last check could load: one whose declared bandwidth is more than 15 % above the stored figure. The encoder then follows the rendition that is playing. Declared bandwidth includes a little container overhead, so erring upwards costs a few kbps, never quality;
- the source's sample rate and channel count;
- the voice channel's bitrate setting. This is **for reporting only**. It is never used as a cap.

| Quality mode | Target |
|---|---|
| `maximum` (default) | The source's own bitrate, up to `MAX_OPUS_BITRATE_KBPS`. A 128 kbps MP3 is sent at 128 kbps and a 320 kbps one at 320. If the source's bitrate is unknown, the target is `MAX_OPUS_BITRATE_KBPS` (510 kbps by default, the most libopus allows for stereo). |
| `balanced` | 128 kbps, or the source's bitrate if that is lower, and never above `MAX_OPUS_BITRATE_KBPS`. 128 kbps when the source's bitrate is unknown. Saves upload bandwidth and CPU on high-bitrate stations. |
| `manual` | The admin's value from `/radio config` → Sound and empty channel → **Manual bitrate** (32–510), capped at `MAX_OPUS_BITRATE_KBPS`. It is used as set, even when it is higher than the source's bitrate; a higher value then only costs bandwidth. Until a value is set, `manual` behaves like `maximum`. |

New servers start in the mode set by `DEFAULT_QUALITY_MODE` (default `maximum`). Admins change it in `/radio config` → Sound and empty channel. Choosing **Manual** there with no bitrate set yet asks for one straight away.

Some details:

- **The target is rounded up, never down,** so it is never below the source's rate: a stream that measures 128.1 kbps is encoded at 129.
- **The target is never below 32 kbps,** even for a source with a lower bitrate.
- **The voice channel's bitrate setting is not a cap.** That setting (up to 96 kbps without boosts, then 128, 256 and 384 kbps at boost levels 1–3) applies to members' voices. The bot encodes its stream at its own target. `/radio quality` shows the setting, and when the target is higher the plan says so: "Encoding above the voice channel's N kbps setting; the channel setting does not cap a bot's stream." What bitrate a listener's Discord app actually receives **has not been measured**.
- **Bandwidth follows the station.** Per server that is streaming, before overhead, a 128 kbps station uses about 58 MB per hour, a 320 kbps one about 144 MB, and the 510 kbps limit (reached only by very high-bitrate or unknown-bitrate sources) about 230 MB. On a slow upload connection, lower `MAX_OPUS_BITRATE_KBPS` or use `balanced`.
- **The plan says where its target came from,** for example "The encoder follows the source's 128 kbps (measured).", "The source's bitrate is unknown, so the encoder uses 510 kbps.", or that `balanced` or the installation's limit applies. `/radio quality` shows it.
- **Quality changes apply while playing.** If an admin changes the quality mode or the manual bitrate in `/radio config`, resets the settings there, or imports settings, and the target changes, the bot rebuilds the encoder at the new target. That causes a brief re-buffer on the same source, and the reply to the admin says so ("The station restarts for a moment to use the new quality."). A change to the channel's own bitrate setting doesn't change the target. Asking for the station that is already playing in the same channel doesn't restart it.

Other encoder settings: 48 kHz, 2 channels, `application=audio` (music mode), 20 ms frames, variable bitrate (VBR) on, and `compression_level 10` (the encoder's most thorough setting).

### Mono and sample rate

- **Mono sources** are sent in stereo framing, with the same sound in both channels. No stereo detail is invented. The plan notes it: "Source is mono; it is sent in stereo framing without inventing stereo detail."
- **Sources that aren't 48 kHz** are resampled to 48 kHz because Discord requires it. The plan records the original rate. Resampling adds no detail: a 44.1 kHz MP3 holds nothing above the roughly 16–20 kHz its encoder kept.

## What `/radio quality` shows

`/radio quality` reports the active audio path in three sections. Unknown values are shown as unknown.

**Input (source)**

- The station and the source ID.
- **Transport:** "Direct HTTP stream" or "HLS (delivery protocol)", plus the HLS version chosen and why. HLS is how the audio is delivered; it says nothing about quality.
- **Codec** (for example MP3, AAC-LC or HE-AAC) and container, as found by `ffprobe` when the source was checked.
- **Bitrate,** with its evidence, written as in every other view (for example "≈128 kbps (measured)"):
  - `measured`: audio data divided by audio duration, from the packets of a sample the bot checked;
  - `codec metadata`: the figure `ffprobe` reported for the stream;
  - `manifest, unverified`: the bandwidth an HLS playlist declares;
  - `advertised, unverified`: the station's `icy-br` header;
  - "unknown" when there is no figure at all.
- The **live network rate:** data per second arriving during playback, shown after 5 s. It includes container and metadata overhead and bursts, so it is for information only.
- **Sample rate and channels,** with the channel layout.

**Output (Discord)**

- Opus (libopus, music mode, VBR), 48000 Hz, 2 channels, 20 ms frames.
- The **encoder target** in kbps and the quality mode.
- The **voice channel bitrate setting,** labelled as not limiting the bot's stream.
- The **measured encoder output:** the Ogg Opus data per second leaving FFmpeg, shown after 5 s. It includes the Ogg framing, and because the output uses variable bitrate it moves around the target.
- **Encryption:** "DAVE end-to-end encrypted (privacy code …)" or "Encrypted in transit; DAVE end-to-end encryption not used for this call".

**Processing**

- Transcode: exactly one lossy encode (source codec → Opus), and no second encode in the voice library. For a source that is already Opus, the report says instead that it is decoded and encoded again once for Discord.
- Resampling: none, or for example `44100 Hz → 48000 Hz`.
- Volume, normalisation, EQ and compression: off.
- The plan's notes, which always include: "A higher Opus target cannot restore detail already lost in the source encoding."

**Why this source.** Why this source was chosen. See [station-verification.md](station-verification.md#ranking-sources).

`/radio now` shows a short form of the same information. `/radio stats` (admins only, private) adds the live view:

- the input rate and the Ogg Opus output rate over the last 10 s and 60 s;
- for HLS, how many segments were fetched, failed and skipped;
- packets per second to Discord, which should be about 50 with 20 ms frames;
- late packets: how many left more than 40 ms after the one before since the bot joined, and the longest gap (about 55 ms or more is enough to hear);
- silence the voice player filled in because no audio was ready, for this stream and in the last minute;
- the round trip to the stream's server, the voice connection's WebSocket ping and the gateway ping;
- source failovers, voice reconnects, the encoder's process ID and the last FFmpeg warnings;
- the main thread's event-loop delay, with its garbage-collection pauses, CPU use and (on Linux) host steal over the same minute, memory use and the number of FFmpeg processes;
- with `VOICE_THREAD=worker`, the voice worker's own event-loop delay, longest garbage-collection pause, heap and restarts. The worker's event loop is the one that sends the packets then, so its delay is the one that matters.

## Recovery and continuity

These defaults are in `DEFAULT_TIMINGS` in `src/voice/session.ts`. They are the PRD's engineering targets, not guarantees.

| Situation | What the bot does |
|---|---|
| No audio within 20 s of starting a source | Treated as `STREAM_STALLED` → recovery. |
| No encoder output for 15 s while playing (checked every 5 s) | `STREAM_STALLED` → recovery. The voice player itself would wait up to 25 s without audio, so the bot's own check decides first. |
| FFmpeg exits, the stream ends, the player fails, or an HLS playlist or segments fail | `FFMPEG_EXIT`, `STREAM_EOF`, `HLS_*` and so on → recovery. |
| Recovery, first stage | Reconnect to the **same** source after about 1 s, then 3 s, then 8 s (each ±25 %). This is skipped for errors that retrying can't fix: access denied (HTTP 401/403/451), a URL or address blocked by the safety rules, encrypted HLS, a rejected content type, or the stream naming a different station when it connects. "Not found" (HTTP 404) **is** retried, because an Icecast server answers 404 for a few seconds while the station's own encoder reconnects to it. If the retries fail too, the bot fails over. |
| The bot's own fault (FFmpeg couldn't start, an internal error) | Retried on the **same** source with the same delays, and never counted against the source. If FFmpeg can't start and the retries fail, there is no failover, since another source would fail the same way: the state becomes `ERROR`, a notice is sent, and the bot tries again every 2 min while playback is still wanted. After an internal error the bot fails over to a verified fallback once the retries fail, in case the error came from that source's data. |
| Recovery, second stage | **Fail over.** The failed source is set aside and the next eligible (usable) source of the same station is chosen. The now-playing card says it is playing from a fallback. |
| A source keeps failing for more than a minute (at least 4 failures in a row) | Circuit breaker: the bot rests (*cools down*) the source for 10 min, then 20 and 40 min, up to 2 h, on repeated trips. A cooling source is not eligible, but when nothing else can play, the bot checks it again every 2 min, and a good check ends the cooldown. A short blip that uses up the quick retries within seconds doesn't trip it, and several servers hearing the same blip at the same moment count as one failure. |
| No eligible source at all | `ERROR` (`NO_ELIGIBLE_SOURCE`), a notice is sent, and the bot looks again after 15, 30 and 60 s, then every 2 min while playback is still wanted. |
| Playback more than 45 s behind live | Reopens the same source at the live edge. A gap the HLS reader left when it skipped forward to the live edge doesn't count, because it is already back at live. |
| A better source works again | **Move back.** Once a minute, a steady stream that isn't on its station's best source checks whether that source has worked again since it failed (a background check shows this). If it has, and it is a real step up (a direct stream instead of HLS, clearly better measured quality, or the source an admin chose), the bot moves back to it. That is a brief cut, so it happens at most once every 10 minutes, and never when a listener chose the source that is playing. If the better source fails again before it has played steadily for 30 s, the bot goes straight back to the source that was working, without retrying, and waits twice as long before trying that source again (20 min, then 40 min, up to 4 h). |
| A new check measures the playing source clearly higher | The bot re-encodes at the new rate (more than 5 % higher), at most once every 10 minutes. The playing source isn't checked in the background, so this follows a check an admin starts (**Check sources again**) or one made for another server. |
| 30 s of steady playback | The source's health score goes up and its failure count is reset. |
| Voice connection dropped | The voice library rejoins up to 5 times. If that fails, the bot rebuilds the connection after 2, 5, 10, 30 and 60 s, then says so once and keeps trying every 2 min while playback is still wanted (`/radio stop` ends it). |
| Disconnected by a moderator | The bot remembers it was kicked. It doesn't rejoin and doesn't autostart until someone plays a station again. |

Each source change, stop, leave, server removal and shutdown closes the old pipeline and ends its FFmpeg process (SIGTERM, then SIGKILL after 2 s). `/radio stats` shows how many FFmpeg processes were started, cleaned up and are running, so leaks would show.

## Honest limits

- **The station's own stream is the ceiling.** No Opus target can restore detail the station's encoder removed, which is why `maximum` matches the source's bitrate instead of padding it. Re-encoding is still a second lossy step: Opus is the more efficient codec at the same bitrate, so the added loss is small, but it is not zero. An admin who wants more headroom on a server can choose `manual` with a higher bitrate.
- **Bitrate is not the same as sound quality.** The bot never ranks sources of different codecs by bitrate. AAC at 128 kbps against MP3 at 128 kbps is reported as "not conclusively determined". See [station-verification.md](station-verification.md#ranking-sources).
- **HLS is not "HD", and it is a last resort.** HLS is only a way of delivering audio. Segmented delivery makes live playback start more slowly and recover less smoothly, so the bot plays HLS only when no direct stream of the station is eligible, even if the HLS version measures higher. On the streams of the first library pack (the pack that shipped with the bot up to 1.1.0), measured on 31 October 2026, the direct streams were MP3 at 128 kbps (and AAC-LC at 128 kbps for one station's extra stream), and the HLS versions were AAC-LC at 128 kbps. Each check reports what a source carries.
- **Above-channel bitrates are not verified.** The encoder target is what the bot sends. Whether Discord passes a bot's stream on above the channel's bitrate setting, and what each listener's app actually receives, has **not** been measured.
- **DAVE.** The bot asks for DAVE end-to-end encryption (`@snazzah/davey` is bundled). Whether it is used depends on the call and on Discord's rollout, and `/radio quality` shows which. DAVE was negotiated in the one live test so far, and has **not** been tested on any other call.
- **Start-up and switching time** depend on the station's server. HLS usually takes longer than a direct stream, because the bot starts three segments behind the live edge; that is one reason it is the last resort. No latency benchmarks have been published.
- **CPU use** depends on the FFmpeg and libopus build, the target bitrate, `compression_level 10` and the number of servers playing at once. Measured on a small cloud server, one 128 kbps stream used about 8% of one CPU core in total (see the README's Requirements). Measure it on your own hardware; other set-ups haven't been measured.
