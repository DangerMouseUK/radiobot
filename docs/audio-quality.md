# Audio quality

This page covers what happens to the audio between the station and the Discord voice channel, how the bot chooses the output bitrate, and what the numbers in `/radio quality` mean. In short: the bot gets the station's stream into Discord with one Opus encode at the station's own bitrate and no other processing. It cannot make the station's own stream better than it is. Radio Bot is unofficial and is not affiliated with or endorsed by any station named here; see [rights-and-disclaimer.md](rights-and-disclaimer.md).

## The audio path

```text
Station stream (HTTP(S) direct stream or HLS)
   │  fetched by the bot's SafeHttpClient: URL policy on every hop, DNS pinned,
   │  redirects re-validated; PLS/M3U resolved; HLS playlists and segments
   │  fetched by the bot; ICY metadata blocks stripped out
   ▼
FFmpeg, reading stdin only  (-protocol_whitelist pipe -i pipe:0)
   │  decode AAC / MP3 / Opus / … → first audio stream only (-map 0:a:0)
   │  -ac 2 -ar 48000      stereo framing, 48 kHz (Discord requires 48 kHz)
   │  -c:a libopus -b:a <target>k -vbr on -compression_level 10
   │  -application audio -frame_duration 20
   │  -f ogg -page_duration 100000 -flush_packets 1
   ▼
Ogg Opus on stdout
   ▼
@discordjs/voice: createAudioResource(…, { inputType: StreamType.OggOpus, inlineVolume: false })
   │  demuxes Ogg pages into Opus packets; no decode, no re-encode
   ▼
Discord voice connection (self-deafened, DAVE end-to-end encryption where negotiated)
```

The exact arguments are in `buildEncodeArgs()` in `src/audio/encoder.ts`. They do not change at run time except for the target bitrate. User input never reaches them.

What is deliberately **not** in the chain: loudness normalisation, ReplayGain, EQ, dynamic-range compression, limiting, filters and volume scaling. `inlineVolume` is off, so the voice library does not decode the audio to apply volume either. The only conversions are the ones Discord requires: resampling to 48 kHz when the source uses another rate (44.1 kHz is common for internet radio), and stereo framing (see below). Metadata and non-audio streams are dropped (`-map_metadata -1 -vn -sn -dn`), and corrupt packets are discarded (`-fflags +discardcorrupt`) so that a bad frame doesn't kill the stream.

## Why there is no double encode

A common mistake in Discord music bots is to decode the source to PCM and let the voice library encode Opus. That is fine if it happens only once. The problem comes when the source is first transcoded by FFmpeg and then encoded again by the library, which adds a second lossy generation for nothing.

Radio Bot does the encoding inside FFmpeg (`libopus`) and hands the voice library an **Ogg Opus** stream. It tells the library so with `StreamType.OggOpus`. For this input type, `@discordjs/voice` only demuxes the Ogg container into Opus packets and sends them as they are. It does not transcode, and with `inlineVolume: false` it has no reason to decode. A typical AAC or MP3 station therefore goes through exactly one lossy encode by the bot: source codec → Opus.

A source that is already Opus is still decoded and re-encoded at the target bitrate. There is no zero-transcode pass-through in v1. The PRD lists that as a possible later optimisation, and only if framing, DAVE and stability can be guaranteed.

**End-to-end check.** On 31 October 2026, the starter pack flagship's MP3 and HLS sources were run through the safe client, one FFmpeg libopus encode and `@discordjs/voice`, whose only stream edges were the Ogg/Opus demuxer. The output was about 486 kbps of Opus against the 510 kbps target, from one encoder process, with none left afterwards. This was not a Discord call, so what listeners receive is still unverified.

## How the Opus target is chosen

`planEncoder()` (`src/audio/encoder.ts`) takes:

- the server's quality mode, and the manual bitrate if one is set;
- the installation's `MAX_OPUS_BITRATE_KBPS` (default 510, allowed range 32–510);
- the source's own bitrate: its codec metadata, else the measured rate, else the manifest or advertised figure;
- the source's sample rate and channel count;
- the voice channel's configured bitrate (discord.js `channel.bitrate`). This is **for reporting only**. The bot does not use it as a cap.

| Quality mode | Target |
|---|---|
| `maximum` (default) | The source's own bitrate, up to `MAX_OPUS_BITRATE_KBPS` (default 510 kbps, the libopus maximum for stereo). A 128 kbps MP3 is sent at 128 kbps and a 320 kbps one at 320: encoding above the source would cost bandwidth without adding anything. If the source's bitrate is unknown, the target is `MAX_OPUS_BITRATE_KBPS`. |
| `balanced` | `min(MAX_OPUS_BITRATE_KBPS, 128 kbps, the source's bitrate)`. Saves upload bandwidth and CPU on high-bitrate stations. |
| `manual` | The admin's value from `/radio config manual_bitrate:` (32–510), used exactly as set, even above the source's bitrate, and capped at `MAX_OPUS_BITRATE_KBPS`. Until a value is set, `manual` behaves like `maximum`. |

Some details:

- **The target is never below 32 kbps.**
- **The voice channel's bitrate setting is not a cap.** Discord's per-channel setting goes up to 96 kbps unboosted, then 128, 256 and 384 kbps at boost levels 1–3. The bot reports the setting, and when the target is above it, the plan adds a note: "Encoding above the voice channel's N kbps setting; the channel setting does not cap a bot's stream." The statement that Discord delivers a bot's stream above the channel setting comes from the project owner. In the one live test so far, the bot sent 128 kbps into a 96 kbps channel and it sounded right, but the bitrate a listener's client receives **has not been measured**.
- **Bandwidth follows the station.** A 128 kbps station costs about 58 MB per hour per streaming server before overhead, a 320 kbps one about 144 MB, and the 510 kbps limit (reached only by very high-bitrate or unknown-bitrate sources) about 230 MB. Lower `MAX_OPUS_BITRATE_KBPS`, or use `balanced`, on constrained uplinks.
- **The plan says where its target came from,** for example "The encoder follows the source's 128 kbps (codec metadata)", or that the source's bitrate is unknown, or that the installation limit applies. `/radio quality` shows it.
- **Quality changes are picked up while playing.** If an admin changes the quality mode in the `/radio config` settings menu, or sets a new `/radio config manual_bitrate:`, and the target changes, the session rebuilds the encoder at the new target (`refreshEncoder`). That causes a brief re-buffer on the same source. A change to the channel's own bitrate setting does not change the target.

Other encoder settings: 48 kHz, 2 channels, `application=audio` (music mode), 20 ms frames, VBR on, `compression_level 10` (the highest-quality encoder search).

### Mono and sample rate

- **Mono sources** are sent in stereo framing, with the same signal in both channels. No stereo detail is invented, and the plan notes it ("Source is mono; it is sent in stereo framing without inventing stereo detail").
- **Sources that aren't 48 kHz** are resampled to 48 kHz because Discord requires it. The plan records `resampled: true` and the original rate. Resampling does not add bandwidth: a 44.1 kHz MP3 has no content above the ~16–20 kHz its encoder kept.

## What `/radio quality` shows

`/radio quality` reports the active audio path in three sections, with unknown values shown as unknown.

**Input (source)**

- The station and source ID.
- **Transport**: "Direct HTTP stream" or "HLS (delivery protocol)", plus the chosen HLS rendition and why it was chosen. HLS is how the audio is delivered; it says nothing about quality.
- **Codec** (for example MP3, AAC-LC or HE-AAC) and container, as measured by `ffprobe` when the source was probed.
- **Bitrate**, with its evidence: `measured` (payload bits ÷ audio duration from the probe's packet table), `codec-metadata` (as `ffprobe` reported it), `manifest` (HLS declared bandwidth, unverified) or `advertised` (the `icy-br` header, unverified).
- The **live network rate**: bytes per second arriving during playback. It includes container and ICY overhead and connection bursts, so it is informational only.
- **Sample rate and channels**, with channel layout.

**Output (Discord)**

- Opus (libopus, music mode, VBR), 48000 Hz, 2 channels, 20 ms frames.
- The **encoder target** in kbps and the quality mode.
- The **voice-channel bitrate setting**, labelled "does not cap the bot's stream".
- **Observed encoder output**: the Ogg Opus bytes per second leaving FFmpeg, shown after 5 s. It includes Ogg framing, and because the output is VBR it will move around the target.
- **Encryption**: "DAVE end-to-end encrypted (privacy code …)" or "Transport-encrypted; DAVE not negotiated for this call".

**Processing**

- Transcode: exactly one lossy encode (source codec → Opus), and no second encode in the voice library. For a source that is already Opus, the report says instead that the Opus source is decoded and re-encoded once for Discord, because there is no zero-transcode pass-through in v1.
- Resampling: none, or for example `44100 Hz → 48000 Hz`.
- Volume, normalisation, EQ and compression: off.
- The plan's notes, which always include: "A higher Opus target cannot restore detail already lost in the source encoding."

**Source decision.** The ranking conclusion and explanation. See [station-verification.md](station-verification.md#ranking-sources).

`/radio now` shows a condensed form of the same information. `/radio stats` (Administrators, private) adds the live view:

- the input and Ogg Opus output rates over 10 s and 60 s;
- packets per second to Discord, which should be about 50 at 20 ms frames;
- the stream host and endpoint round trip;
- the voice connection's WebSocket ping;
- the encoder PID and the last FFmpeg warnings.

## Recovery and continuity

These defaults are in `DEFAULT_TIMINGS` in `src/voice/session.ts`. They are the PRD's engineering targets, not guarantees.

| Situation | Behaviour |
|---|---|
| No first audio within 20 s of starting a source | Treated as `STREAM_STALLED` → recovery. |
| No encoder output for 15 s while playing (the watchdog checks every 5 s) | `STREAM_STALLED` → recovery. The voice player itself tolerates up to 25 s without frames, so the watchdog, not the player, decides. |
| FFmpeg exits, the stream ends, the player errors, or an HLS playlist or segments fail | `FFMPEG_EXIT`, `STREAM_EOF`, `HLS_*` and so on → recovery. |
| Recovery, first stage | Reconnect to the **same** source after about 1 s, then 3 s, then 8 s (±25 % jitter), unless the error can't be fixed by retrying: access denied (HTTP 401/403/451), a URL or address blocked by policy, encrypted HLS, a rejected content type, or an identity mismatch on connection. If the source fails a fourth time in a row, the circuit breaker below trips and the bot fails over. |
| Recovery, second stage | **Fail over.** The failed source is excluded and the next eligible source is chosen. Playback is marked "Degraded: playing from a fallback source". |
| 4 consecutive failures on a source (the first plus all three retries) | Circuit breaker: the source cools down for 10 min, then 20, 40, up to 2 h on repeated trips. A cooling source is not eligible. |
| No eligible source at all | `ERROR` (`NO_ELIGIBLE_SOURCE`), a notice is sent, and the bot retries every 2 min while playback is still desired. |
| Playback drifted more than 45 s behind live | Reopens the same source at the live edge (resync). |
| 30 s of stable playback | The source's health goes up and its failure streak is reset. |
| Voice connection dropped | The library rejoins up to 5 times. If that fails, the session rebuilds the connection after 2, 5, 10, 30 and 60 s, then gives up with `VOICE_DISCONNECTED`. |
| Disconnected by a moderator | Desired state becomes `kicked`. The bot doesn't rejoin and doesn't autostart. |

Each source change, stop, leave, guild removal and shutdown tears down the old pipeline and reaps its FFmpeg process (SIGTERM, then SIGKILL after 2 s). `/radio stats` shows how many FFmpeg processes were spawned and reaped and how many are active, so you can check for leaks.

## Honest limits

- **Source fidelity is the ceiling.** No Opus target can restore detail the station's encoder removed, which is why `maximum` matches the source's bitrate instead of padding it. Re-encoding is still a second lossy step: at the same nominal bitrate Opus is the more efficient codec, so the added loss is small, but it is not zero. An admin who wants more headroom for a particular server can choose `manual` with a higher bitrate.
- **Bitrate is not fidelity.** The bot never ranks sources of different codecs by bitrate. AAC at 128 kbps and MP3 at 128 kbps are reported as "not conclusively determined". See [station-verification.md](station-verification.md#ranking-sources).
- **HLS is not "HD", and it is a last resort.** HLS is a delivery protocol. Because segmented delivery makes live playback start more slowly and recover less smoothly, the bot only plays HLS when no direct stream of the station is eligible, even if the HLS rendition measures higher. On the starter pack's mounts, measured on 31 October 2026, the direct streams were MP3 at 128 kbps (and AAC-LC at 128 kbps for the flagship station's extra mount), and the HLS renditions were AAC-LC at 128 kbps. The probe reports what each one carries.
- **Above-channel bitrates are not verified.** The encoder target is what the bot sends. In the one live test so far (1 November 2026), a 128 kbps stream into a 96 kbps channel sounded right. Whether Discord forwards a bot's stream above the channel's bitrate setting, and what each listener's client actually receives, has **not** been measured.
- **DAVE.** The bot requests DAVE end-to-end encryption (`@snazzah/davey` is bundled). Whether it is negotiated depends on the call and Discord's rollout, and `/radio quality` shows which. DAVE was negotiated in the one live test so far, and has **not** been tested on any other call.
- **Startup and switching time** depend on the station host. HLS usually takes longer than a direct stream because the bot starts three segments behind the live edge, which is one reason it is a last-resort tier. No latency benchmarks have been published yet.
- **CPU cost** depends on the FFmpeg and libopus build, the target bitrate, `compression_level 10` and the number of concurrent servers. Benchmark it on your own hardware. No figures are published.
