import { EmbedBuilder, escapeMarkdown, TimestampStyles, time } from 'discord.js';
import type { EncoderPlan } from '../../audio/encoder.ts';
import {
  AVAILABILITY_LABEL,
  type SourceProvenance,
  type Station,
  type StationAvailability,
  type StationSource,
  type VerificationState,
} from '../../catalogue/types.ts';
import type { LoopDelaySummary, LoopWindowSummary } from '../../observability/event-loop.ts';
import { redactUrl } from '../../shared/redact.ts';
import { truncate } from '../../shared/text.ts';
import { codecLabel, type ProbeOutcome } from '../../streams/probe.ts';
import {
  CONCLUSION_TEXT,
  checkEligibility,
  effectiveBitrate,
  type SelectionResult,
} from '../../streams/ranking.ts';
import { isPaused, nextAutomaticCheck } from '../../streams/source-service.ts';
import type { LiveQueueStats } from '../../voice/live-queue.ts';
import type { SessionStatus } from '../../voice/session.ts';
import { isAudioActive, type PlaybackState, STATE_LABEL } from '../../voice/state-machine.ts';
import type { VoiceThreadStats } from '../../voice/voice-thread.ts';

/** Stream metadata comes from the station, so it is shown as plain text, never as links or headings. */
const streamText = (text: string) =>
  escapeMarkdown(text, { heading: true, bulletedList: true, numberedList: true, maskedLink: true });

/**
 * One meaning per colour, in every view:
 * ok: done, or playing · neutral: nothing changed, nothing playing, or still in progress ·
 * warn: done or running, but something needs a look (partial, retrying, recovering, a decision) ·
 * error: refused or failed · info: something you asked to see (lists, help, settings, reports).
 *
 * Buttons follow the same idea, one meaning per colour:
 * - Blurple (Primary): the recommended next step, at most one per row (Discord: "Use only one
 *   Primary button per group"), such as Set up on a new server's settings card.
 * - Red (Danger): removes, overwrites or ends something for everyone, and takes more than one
 *   click to get back (Leave, Remove, Apply import, Stop the check). At most one per message.
 * - Green (Success): "on", and nothing else (a settings switch that is on, matching the green
 *   embed strip for playing or done). Never an action, and never in a row with a red button.
 * - Grey (Secondary): everything else, and the default.
 * Every button has a text label, so colour is never the only cue (WCAG 1.4.1).
 */
export const COLOR = {
  ok: 0x2e9e6a,
  warn: 0xd99a1e,
  error: 0xc0392b,
  info: 0x3b6fd1,
  neutral: 0x6b7280,
} as const;

/** A playback state's colour, the same in every view: playing green, a fault red, recovering amber, else grey. */
export function stateColor(state: PlaybackState | null | undefined): number {
  if (state === 'PLAYING') return COLOR.ok;
  if (state === 'ERROR') return COLOR.error;
  if (state === 'RECOVERING' || state === 'FAILING_OVER') return COLOR.warn;
  return COLOR.neutral;
}

export const DISCLAIMER = 'Radio Bot is unofficial and not affiliated with or endorsed by any broadcaster.';

/** A source's check progress in words, for the sources and inspect views. */
const VERIFICATION_LABEL: Record<VerificationState, string> = {
  discovered: 'not checked yet',
  resolved: 'not checked yet',
  transport_healthy: 'connects, audio not checked yet',
  codec_verified: 'audio checked',
  identity_verified: 'audio and station identity checked',
  eligible: 'working',
  unverified: 'working, but not verified as this station',
  degraded: 'working with decode errors',
  blocked_by_policy: 'blocked by the bot’s safety rules',
  cooldown: 'resting after repeated failures',
  offline: 'last check failed',
  retired: 'retired',
};

const PROVENANCE_LABEL: Record<SourceProvenance, string> = {
  'official-player': 'the broadcaster’s own player or website',
  curated: 'a reviewed, curated list',
  'auto-discovered': 'found automatically, not reviewed',
  'custom-user': 'added by a server admin',
};

export function availabilityBadge(a: StationAvailability): string {
  const icon: Record<StationAvailability, string> = {
    available: '🟢',
    degraded: '🟡',
    unverified: '⚪',
    unavailable: '🔴',
    no_source: '⚫',
    retired: '⚫',
  };
  return `${icon[a]} ${AVAILABILITY_LABEL[a]}`;
}

const ts = (iso: string | null | undefined) =>
  iso ? time(new Date(iso), TimestampStyles.RelativeTime) : 'never';

export function transportLabel(t: string | null | undefined): string {
  if (t === 'hls') return 'HLS (delivery protocol)';
  if (t === 'http-continuous') return 'Direct HTTP stream';
  return 'Unknown transport';
}

/**
 * "≈128 kbps (measured)": the bitrate with its evidence, written the same way in every view (NFR-12).
 * It takes a stored source or the outcome of a check just made.
 */
export function bitrateText(
  s: Pick<StationSource, 'measuredBitrateKbps' | 'codecBitrateKbps' | 'advertisedBitrateKbps' | 'transport'>,
): string {
  const br = effectiveBitrate(s);
  if (br.kbps === null) return 'bitrate unknown';
  const evidence =
    s.measuredBitrateKbps !== null
      ? 'measured'
      : s.codecBitrateKbps !== null
        ? 'codec metadata'
        : s.transport === 'hls'
          ? 'manifest, unverified'
          : 'advertised, unverified';
  return `≈${Math.round(br.kbps)} kbps (${evidence})`;
}

/** "MP3 · ≈128 kbps (measured) · 44.1 kHz · stereo" with explicit unknowns (NFR-12). */
export function sourceFormat(s: StationSource): string {
  const parts = [
    codecLabel(s.codec, s.profile) === 'unknown'
      ? `codec not measured${s.codecHint ? ` (hint: ${s.codecHint})` : ''}`
      : codecLabel(s.codec, s.profile),
    bitrateText(s),
    s.sampleRateHz ? `${(s.sampleRateHz / 1000).toFixed(1)} kHz` : 'sample rate unknown',
    s.channels
      ? s.channels === 1
        ? 'mono'
        : s.channels === 2
          ? 'stereo'
          : `${s.channels} channels`
      : 'channels unknown',
  ];
  return parts.join(' · ');
}

/** "MP3 · ≈128 kbps (measured) · 44.1 kHz · stereo · Direct HTTP stream": a check just made (NFR-12). */
export function checkedLine(o: ProbeOutcome): string {
  const codec = codecLabel(o.codec, o.profile);
  const rate = o.sampleRateHz ? `${(o.sampleRateHz / 1000).toFixed(1)} kHz` : 'sample rate unknown';
  const ch = o.channels
    ? o.channels === 1
      ? 'mono'
      : o.channels === 2
        ? 'stereo'
        : `${o.channels} channels`
    : 'channels unknown';
  return [
    codec === 'unknown' ? 'codec unknown' : codec,
    bitrateText(o),
    rate,
    ch,
    transportLabel(o.transport),
  ].join(' · ');
}

export function identityLine(s: StationSource): string {
  const label =
    s.identityStatus === 'verified'
      ? `Verified as this station (${s.identityConfidence} confidence)`
      : s.identityStatus === 'mismatch'
        ? 'Plays a different station, so it is not used'
        : 'Not yet verified as this station';
  const why = s.identityEvidence.find((e) => e.verdict !== 'inconclusive')?.detail;
  return why ? `${label}: ${truncate(why, 160)}` : label;
}

export function outputLine(plan: EncoderPlan | null): string {
  if (!plan) return 'Not encoding.';
  return [
    `Opus · ${plan.sampleRateHz / 1000} kHz · stereo · ${plan.frameMs} ms frames`,
    `encoder target ${plan.targetKbps} kbps (${plan.qualityMode} quality)`,
    `voice channel bitrate setting ${plan.channelBitrateKbps !== null ? `${plan.channelBitrateKbps} kbps` : 'unknown'} (does not limit the bot)`,
  ].join(' · ');
}

export function stationLine(st: Station, a: StationAvailability, current = false): string {
  return `${current ? '▶ ' : ''}**${st.displayName}** — ${availabilityBadge(a)}${st.provider === 'custom' ? ' · custom' : ''}`;
}

/** "Direct MP3 · ≈128 kbps (measured)": what the station sends, at a glance (the rest is in Sources). */
function streamSummary(s: StationSource): string {
  const how = s.transport === 'hls' ? 'HLS' : s.transport === 'http-continuous' ? 'Direct' : '';
  return [`${how} ${codecLabel(s.codec, s.profile)}`.trim(), bitrateText(s)].join(' · ');
}

/** Why this source plays, in one plain sentence (the full reasoning is under Sources). */
const CHOICE_TEXT: Record<SelectionResult['conclusion'], string> = {
  'higher-quality-verified': 'The best measured quality of this station’s sources.',
  'no-higher-quality-source-verified':
    'Its sources carry the same audio. Sources shows how this one was chosen.',
  'not-conclusively-determined':
    'Which source sounds better was not conclusively determined. Sources shows how this one was chosen.',
  'higher-quality-source-ranked-lower':
    'Another source measures higher but comes later, because of how it is delivered, its reliability or an admin’s choice.',
  'single-source': 'The only usable source right now.',
  'no-eligible-source': 'No usable source right now.',
};

/**
 * What's playing, laid out to scan: the song first, then three short facts side by side, then
 * one line on why this source plays. Every detail behind these is a button away (Sources, Inspect).
 */
export function nowEmbed(
  st: Station | null,
  status: SessionStatus | null,
  voiceChannelId: string | null,
): EmbedBuilder {
  const e = new EmbedBuilder().setColor(COLOR.info).setFooter({ text: DISCLAIMER });
  if (!st || !status || status.state === 'IDLE' || !status.stationId) {
    return e
      .setTitle('Radio is idle')
      .setDescription('Nothing is playing. Use `/radio play` or `/radio browse` to pick a station.')
      .setColor(COLOR.neutral);
  }
  const playing = status.state === 'PLAYING';
  const active = isAudioActive(status.state);
  // In the channel but not streaming: say whether a listener stopped it or it is waiting for one.
  const resting = status.state === 'CONNECTED' ? status.desiredState : null;
  const label =
    resting === 'stopped' ? 'Stopped' : resting === 'paused_empty' ? 'Paused' : STATE_LABEL[status.state];
  // The state is in words as well as in the colour and the ▶, so it never relies on either alone.
  e.setTitle(`${playing ? '▶ ' : ''}${label}: ${st.displayName}`).setColor(stateColor(status.state));
  const lines: string[] = [];
  if (status.nowPlaying) {
    lines.push(`🎵 **${streamText(truncate(status.nowPlaying.title, 200))}**`);
    lines.push(`-# From the station’s stream, updated ${ts(status.nowPlaying.receivedAt)}`);
  } else if (active) {
    lines.push('-# The station isn’t sending a song or show title right now.');
  } else if (resting === 'stopped') {
    lines.push('Nothing is playing. Press **Browse** or use `/radio play` to start again.');
  } else if (resting === 'paused_empty') {
    lines.push('Paused while nobody is in the voice channel. It plays again when someone joins.');
  }
  // Only while the bot is still meant to play: after Stop, an old error is no longer news.
  if (!playing && status.desiredState === 'playing' && status.lastError)
    lines.push(`⚠️ ${status.lastError.message}`);
  if (active && status.selection?.degraded)
    lines.push('⚠️ Playing from a fallback: the usual source isn’t working.');
  // discord.js rejects an empty description, and a card with nothing to say has none.
  if (lines.length > 0) e.setDescription(lines.join('\n'));
  if (!active) {
    // Nothing is streaming, so the stream and output facts would only be dashes.
    if (voiceChannelId) e.addFields({ name: 'Channel', value: `<#${voiceChannelId}>`, inline: true });
    return e;
  }
  const s = status.source;
  // One full-width field: in three side-by-side columns a phone wrapped the stream onto 5 lines.
  e.addFields({
    name: 'Stream',
    value: [
      s ? streamSummary(s) : '—',
      `To Discord: ${status.plan ? `Opus · ${status.plan.targetKbps} kbps` : '—'}${voiceChannelId ? ` · in <#${voiceChannelId}>` : ''}`,
    ].join('\n'),
  });
  if (s) {
    const verified =
      s.identityStatus === 'verified' ? '✅ Verified as this station' : '❔ Not yet verified as this station';
    const choice =
      status.manualSourceId === s.id
        ? 'Chosen by a listener for this play.'
        : status.selection
          ? CHOICE_TEXT[status.selection.conclusion]
          : null;
    const fallback = status.selection?.fallback;
    e.addFields({
      name: 'Source',
      value: truncate(
        [
          `${verified} · checked ${ts(s.lastProbeAt)}`,
          choice,
          fallback ? `Fallback: ${streamSummary(fallback)}` : null,
        ]
          .filter(Boolean)
          .join('\n'),
        1024,
      ),
    });
  }
  return e;
}

export function qualityEmbed(st: Station | null, status: SessionStatus | null): EmbedBuilder {
  const e = new EmbedBuilder()
    .setTitle('Audio quality report')
    .setColor(COLOR.info)
    .setFooter({ text: DISCLAIMER });
  if (!status?.source || !status.plan || !st) {
    return e
      .setDescription('Nothing is playing, so there is no active audio path to report.')
      .setColor(COLOR.neutral);
  }
  const s = status.source;
  const p = status.plan;
  const br = effectiveBitrate(s);
  e.addFields(
    {
      name: 'Input (source)',
      value: [
        `Station: **${st.displayName}** · source \`${s.id}\``,
        `Transport: ${transportLabel(status.inputTransport ?? s.transport)}${status.hls?.chosen ? ` — rendition: ${status.hls.chosen.reason}` : ''}`,
        `Codec: ${codecLabel(s.codec, s.profile)} · container ${s.container ?? 'unknown'}`,
        `Bitrate: ${br.kbps !== null ? bitrateText(s) : 'unknown'}${status.observedInputKbps !== null ? ` · live network rate ≈${status.observedInputKbps} kbps` : ''}`,
        `Sample rate: ${s.sampleRateHz ? `${s.sampleRateHz} Hz` : 'unknown'} · Channels: ${s.channels ?? 'unknown'}${s.channelLayout ? ` (${s.channelLayout})` : ''}`,
      ].join('\n'),
    },
    {
      name: 'Output (Discord)',
      value: [
        `Codec: Opus (libopus, music mode, VBR) · ${p.sampleRateHz} Hz · ${p.channels} channels · ${p.frameMs} ms`,
        `Encoder target: **${p.targetKbps} kbps** (${p.qualityMode} quality)`,
        `Voice channel bitrate setting: ${p.channelBitrateKbps !== null ? `${p.channelBitrateKbps} kbps` : 'unknown'} (it does not limit the bot’s stream)`,
        `Measured encoder output: ${status.observedOutputKbps !== null ? `≈${status.observedOutputKbps} kbps (Ogg, including framing)` : 'not measured yet'}`,
        `Encryption: ${status.encryption ?? 'unknown'}`,
      ].join('\n'),
    },
    {
      name: 'Processing',
      value: [
        s.codec === 'opus'
          ? 'Transcode: yes. The Opus source is decoded and encoded again once for Discord (the bot never passes a stream through unchanged). The voice library adds no second encode.'
          : `Transcode: yes, exactly one lossy encode (${codecLabel(s.codec, s.profile)} → Opus). The voice library adds no second encode.`,
        `Resampling: ${p.resampled ? `${s.sampleRateHz} Hz → 48000 Hz (required by Discord)` : 'none'}`,
        'Volume/normalisation/EQ/compression: off',
        ...p.notes.map((n) => `• ${n}`),
      ].join('\n'),
    },
  );
  if (status.selection) {
    e.addFields({
      name: 'Why this source',
      value: truncate(
        [CONCLUSION_TEXT[status.selection.conclusion], ...status.selection.explanation].join('\n'),
        1024,
      ),
    });
  }
  return e;
}

/** A failing source in plain words: failures in a row, the last one, and the next automatic check. */
export function failingLine(s: StationSource, nextCheck: number): string {
  const n = Math.max(1, s.consecutiveFailures);
  const last = s.lastFailureAt ? `, the last one ${ts(s.lastFailureAt)}` : '';
  const code = s.lastFailureCode ? ` (${s.lastFailureCode})` : '';
  const next =
    nextCheck <= Date.now() ? 'next time the station plays' : ts(new Date(nextCheck).toISOString());
  return `Not working: ${n} failed check${n === 1 ? '' : 's'} in a row${last}${code}. Next automatic check: ${next}.`;
}

/** A paused source: why it stopped being checked, and how to test it again. */
export function pausedLine(s: StationSource): string {
  const code = s.lastFailureCode ? `, last ${s.lastFailureCode}` : '';
  return `Paused: no successful check for over a week (${s.consecutiveFailures} failed in a row${code}). It is no longer checked automatically; an admin can test it with **Check sources again**.`;
}

export function sourcesEmbed(
  st: Station,
  sources: StationSource[],
  selection: SelectionResult,
  detailed: boolean,
  live: { playingId: string | null; manualId: string | null } = { playingId: null, manualId: null },
): EmbedBuilder {
  const e = new EmbedBuilder()
    .setTitle(`${detailed ? 'Inspection' : 'Sources'}: ${st.displayName}`)
    .setColor(selection.selected ? COLOR.info : COLOR.warn)
    .setFooter({
      text: `${DISCLAIMER} Figures come from the bot’s own checks of each stream. HLS is a way of delivering audio, not a codec.`,
    });
  const now = Date.now();
  if (sources.length === 0) {
    return e.setDescription(
      'No stream is known for this station yet, so it can’t be played. It is listed so the catalogue is complete.',
    );
  }
  const description = truncate(
    [`**${CONCLUSION_TEXT[selection.conclusion]}**`, ...selection.explanation].join('\n'),
    2000,
  );
  // Discord rejects an embed whose title, description, fields and footer exceed 6000 characters
  // in total, so detailed views of stations with many sources stop adding fields before that. The
  // margin leaves room for what callers add: the "On this server" field (up to about 400
  // characters) and a re-check summary, which fits itself into what is left.
  let budget = 5400 - (e.data.title?.length ?? 0) - (e.data.footer?.text.length ?? 0) - description.length;
  // Usable sources first, in the order the bot ranks them; then the rest, which can't be used.
  const rank = new Map(selection.ordered.map((s, i) => [s.id, i + 1]));
  const ranked = [
    ...selection.ordered.map((o) => sources.find((s) => s.id === o.id) ?? o),
    ...sources.filter((s) => !rank.has(s.id)),
  ];
  const shown = ranked.slice(0, 10);
  let omitted = ranked.length - shown.length;
  for (const [index, s] of shown.entries()) {
    const elig = checkEligibility(s, now);
    const marks = [
      live.playingId === s.id ? '▶ playing now' : null,
      live.manualId === s.id ? 'chosen by a listener for this play' : null,
      selection.selected?.id === s.id
        ? '**best choice**'
        : selection.fallback?.id === s.id
          ? 'fallback'
          : null,
    ].filter(Boolean);
    const role = marks.length ? ` — ${marks.join(' · ')}` : '';
    const place = rank.has(s.id) ? `#${rank.get(s.id)} ` : '';
    const lines = [
      `${transportLabel(s.transport === 'unknown' ? s.transportHint : s.transport)} · ${sourceFormat(s)}`,
      // The same marker in Sources and Inspect, so the two views scan alike.
      `${s.identityStatus === 'verified' ? '✅' : s.identityStatus === 'mismatch' ? '❌' : '❔'} ${
        detailed
          ? identityLine(s)
          : s.identityStatus === 'verified'
            ? 'Verified as this station'
            : s.identityStatus === 'mismatch'
              ? 'Plays a different station'
              : 'Not yet verified as this station'
      }`,
      elig.eligible
        ? `✅ Can be used · ${VERIFICATION_LABEL[s.verificationState]}`
        : `❌ Can’t be used: ${truncate(elig.reasons.join('; '), 200)}`,
    ];
    const nextCheck = nextAutomaticCheck(s);
    if (isPaused(s)) lines.push(pausedLine(s));
    else if (nextCheck !== null) lines.push(failingLine(s, nextCheck));
    if (detailed) {
      lines.push(
        `ID: \`${s.id}\``,
        `Stream URL: \`${truncate(redactUrl(s.url), 120)}\`${s.effectiveHost ? ` → ${s.effectiveHost}` : ''}`,
        `Bitrates: advertised ${s.advertisedBitrateKbps ?? '—'} · codec ${s.codecBitrateKbps ?? '—'} · measured ${s.measuredBitrateKbps ?? '—'} kbps`,
        `Last checked ${ts(s.lastProbeAt)} · last worked ${ts(s.lastSuccessAt)} · last failed ${ts(s.lastFailureAt)}${s.lastFailureCode ? ` (${s.lastFailureCode})` : ''}`,
        `Health ${Math.round(s.healthScore)}/100 · start-up ${s.startupMs !== null ? `${s.startupMs} ms` : '—'}${s.icyName ? ` · stream name "${truncate(s.icyName, 60)}"` : ''}`,
        `Where it came from: ${PROVENANCE_LABEL[s.provenance]}${s.rightsStatus !== 'unreviewed' ? ` · rights: ${s.rightsStatus}` : ''}`,
      );
    }
    // No ID in the heading: a long code span overflows on a phone. Inspect shows it in the details.
    const name = truncate(`${place}${s.label ?? s.id}${role}`, 256);
    const value = truncate(lines.join('\n'), 1024);
    if (name.length + value.length > budget - 80) {
      omitted += shown.length - index;
      break;
    }
    budget -= name.length + value.length;
    e.addFields({ name, value });
  }
  if (omitted > 0) {
    e.addFields({
      name: `${omitted} more ${omitted === 1 ? 'source' : 'sources'} not shown`,
      value: 'Discord limits how much one message can hold.',
    });
  }
  e.setDescription(description);
  return e;
}

export function errorEmbed(message: string, title = 'Couldn’t do that'): EmbedBuilder {
  return (
    new EmbedBuilder()
      .setColor(COLOR.error)
      // No ⚠️ here: red and the title say it is an error, and ⚠️ means "a warning" everywhere else.
      .setTitle(title)
      .setDescription(truncate(message, 2000))
  );
}

export function infoEmbed(title: string, message: string, color: number = COLOR.info): EmbedBuilder {
  return new EmbedBuilder()
    .setColor(color)
    .setTitle(truncate(title, 256))
    .setDescription(truncate(message, 4000));
}

/** One stats line for the event-loop delay. Voice packets go out every 20 ms from that loop. */
/** `sendsVoice`: false when voice packets leave from the voice worker, not from this event loop. */
export function loopDelayLine(s: LoopDelaySummary | null, sendsVoice = true): string {
  const label = sendsVoice ? 'Event-loop delay' : 'Main event-loop delay';
  if (!s) return `${label}: not measured yet`;
  const verdict = sendsVoice && s.maxMs >= 20 ? ' (high enough to send voice packets late)' : '';
  return `${label} (last ${s.windowSec} s): typical ${s.meanMs} ms · 99% under ${s.p99Ms} ms · worst ${s.maxMs} ms${verdict}`;
}

/**
 * One stats line for what can explain an event-loop delay in the same window: garbage collection
 * (a long pause stops the loop), CPU used, how often the system took the core away, and on Linux
 * the CPU time the host gave to other machines.
 */
export function processLoadLine(s: LoopWindowSummary | null): string {
  if (!s) return 'Memory clean-up and CPU: not measured yet';
  const gc = s.gc.count
    ? `${s.gc.count} pauses, longest ${s.gc.maxMs} ms${s.gc.maxKind ? ` (${s.gc.maxKind})` : ''}`
    : 'no pauses';
  const pct = s.windowSec > 0 ? Math.round((s.cpu.userMs + s.cpu.systemMs) / (s.windowSec * 10)) : null;
  const steal = s.cpu.stealPct !== null ? ` · host steal ${s.cpu.stealPct}%` : '';
  return `Memory clean-up (last ${s.windowSec} s): ${gc} · CPU ${pct ?? '—'}% of one core, preempted ${s.cpu.involuntarySwitches}×${steal}`;
}

/** One stats line for the voice worker (`VOICE_THREAD=worker`), whose event loop sends the packets. */
export function voiceThreadLine(s: VoiceThreadStats | null): string | null {
  if (!s) return null;
  const d = s.loopDelay.lastWindow ?? s.loopDelay.current;
  const gc = s.gc.lastWindow ?? s.gc.current;
  const delay = d
    ? `delay worst ${d.maxMs} ms, 99% under ${d.p99Ms} ms (last ${d.windowSec} s)${d.maxMs >= 20 ? ' (high enough to send voice packets late)' : ''}`
    : 'delay not measured yet';
  const state = s.alive ? '' : ' · not running';
  const restarts = s.restarts ? ` · restarted ${s.restarts}×` : '';
  return `Voice thread: ${delay} · memory clean-up longest ${gc.maxMs} ms · heap ${s.heapUsedMb} MB${restarts}${state}`;
}

/** One stats line for silence the voice player filled in because no audio was ready (an underrun). */
export function silenceLine(total: number | null | undefined, recent: number | null | undefined): string {
  if (total == null) return 'Silence filled in: —';
  const last = recent != null ? ` · ${recent} ms in the last minute` : '';
  return `Silence filled in (no audio ready): ${total} ms this stream${last}`;
}

/**
 * One stats line for the live queue: how much audio waits to be sent (how far playback is behind
 * the newest audio received), the cushion it keeps, the audio dropped to stay live (the connect
 * burst at the start, then any catch-ups), network gaps, and how fast the station's clock runs
 * against ours, once measured.
 */
export function liveDelayLine(live: LiveQueueStats | null | undefined): string {
  if (!live) return 'Live delay: —';
  const s = (ms: number) => `${(ms / 1000).toFixed(1)} s`;
  const since = live.catchUps
    ? `${s(live.caughtUpMs)} since in ${live.catchUps} catch-up${live.catchUps === 1 ? '' : 's'}`
    : 'none since';
  const gaps = `${live.gaps} network gap${live.gaps === 1 ? '' : 's'}`;
  const ppm = live.driftPpm;
  const clock =
    ppm === null
      ? ''
      : ppm === 0
        ? ' · station clock in step'
        : ` · station clock ${Math.abs(ppm)} ppm ${ppm > 0 ? 'fast' : 'slow'}`;
  return `Live delay: ${s(live.depthMs)} waiting (cushion ${s(live.cushionMs)}) · dropped to stay live: ${s(live.startDroppedMs)} at the start, ${since} · ${gaps}${clock}`;
}

/** One stats line for voice packets that went out late (more than 40 ms after the one before). */
export function latePacketsLine(late: number | undefined, worstGapMs: number | null | undefined): string {
  if (late === undefined) return 'Late packets: —';
  const worst = worstGapMs != null ? ` · longest gap ${worstGapMs} ms` : '';
  // Listeners start to hear gaps from about 55 ms as a small cut, with a slow-down and speed-up.
  const verdict = worstGapMs != null && worstGapMs >= 55 ? ' (long enough to be heard)' : '';
  return `Late packets (over 40 ms apart) since joining: ${late}${worst}${verdict}`;
}
