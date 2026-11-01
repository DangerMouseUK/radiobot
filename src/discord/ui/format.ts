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
import type { LoopDelaySummary } from '../../observability/event-loop.ts';
import { redactUrl } from '../../shared/redact.ts';
import { truncate } from '../../shared/text.ts';
import { codecLabel } from '../../streams/probe.ts';
import {
  CONCLUSION_TEXT,
  checkEligibility,
  effectiveBitrate,
  type SelectionResult,
} from '../../streams/ranking.ts';
import { nextAutomaticCheck } from '../../streams/source-service.ts';
import type { SessionStatus } from '../../voice/session.ts';
import { STATE_LABEL } from '../../voice/state-machine.ts';

/** Stream metadata comes from the station, so it is shown as plain text, never as links or headings. */
const streamText = (text: string) =>
  escapeMarkdown(text, { heading: true, bulletedList: true, numberedList: true, maskedLink: true });

export const COLOR = {
  ok: 0x2e9e6a,
  warn: 0xd99a1e,
  error: 0xc0392b,
  info: 0x3b6fd1,
  neutral: 0x6b7280,
} as const;

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
  blocked_by_policy: 'blocked by the URL safety rules',
  cooldown: 'paused after repeated failures',
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

/** "MP3 · ≈128 kbps (measured) · 44.1 kHz · stereo" with explicit unknowns (NFR-12). */
export function sourceFormat(s: StationSource): string {
  const br = effectiveBitrate(s);
  const evidence =
    s.measuredBitrateKbps !== null
      ? 'measured'
      : s.codecBitrateKbps !== null
        ? 'codec metadata'
        : s.advertisedBitrateKbps !== null
          ? s.transport === 'hls'
            ? 'manifest, unverified'
            : 'advertised, unverified'
          : '';
  const parts = [
    codecLabel(s.codec, s.profile) === 'unknown'
      ? `codec not measured${s.codecHint ? ` (hint: ${s.codecHint})` : ''}`
      : codecLabel(s.codec, s.profile),
    br.kbps !== null ? `≈${Math.round(br.kbps)} kbps (${evidence})` : 'bitrate unknown',
    s.sampleRateHz ? `${(s.sampleRateHz / 1000).toFixed(1)} kHz` : 'sample rate unknown',
    s.channels
      ? s.channels === 1
        ? 'mono'
        : s.channels === 2
          ? 'stereo'
          : `${s.channels} ch`
      : 'channels unknown',
  ];
  return parts.join(' · ');
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
  e.setTitle(`${playing ? 'Now playing' : STATE_LABEL[status.state]}: ${st.displayName}`).setColor(
    playing ? COLOR.ok : status.state === 'ERROR' ? COLOR.error : COLOR.warn,
  );
  const lines: string[] = [];
  lines.push(`**Station:** ${st.displayName}${voiceChannelId ? ` in <#${voiceChannelId}>` : ''}`);
  lines.push(
    `**State:** ${STATE_LABEL[status.state]}${status.state !== 'PLAYING' && status.lastError ? ` — ${status.lastError.message}` : ''}`,
  );
  if (status.source) {
    lines.push(`**Source:** ${transportLabel(status.source.transport)} · ${sourceFormat(status.source)}`);
    lines.push(
      `**Verification:** ${identityLine(status.source)} · last checked ${ts(status.source.lastProbeAt)}`,
    );
  }
  lines.push(`**Discord output:** ${outputLine(status.plan)}`);
  if (status.selection?.degraded) lines.push('**Degraded: playing from a fallback source.**');
  if (status.nowPlaying) {
    lines.push(
      `**On air:** ${streamText(truncate(status.nowPlaying.title, 200))} _(stream metadata, received ${ts(status.nowPlaying.receivedAt)})_`,
    );
  } else {
    lines.push('**On air:** no song or show title from the stream right now.');
  }
  e.setDescription(lines.join('\n'));
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
        `Bitrate: ${br.kbps !== null ? `≈${Math.round(br.kbps)} kbps` : 'unknown'} (evidence: ${s.bitrateConfidence.replace('-', ' ')})${status.observedInputKbps !== null ? ` · live network rate ≈${status.observedInputKbps} kbps` : ''}`,
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
          ? 'Transcode: yes. The Opus source is decoded and encoded again once for Discord (zero-transcode passthrough is not used in v1). The voice library adds no second encode.'
          : `Transcode: yes, exactly one lossy encode (${codecLabel(s.codec, s.profile)} → Opus). The voice library adds no second encode.`,
        `Resampling: ${p.resampled ? `${s.sampleRateHz} Hz → 48000 Hz (required by Discord)` : 'none'}`,
        'Volume/normalisation/EQ/compression: off',
        ...p.notes.map((n) => `• ${n}`),
      ].join('\n'),
    },
  );
  if (status.selection) {
    e.addFields({
      name: 'Source decision',
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

export function sourcesEmbed(
  st: Station,
  sources: StationSource[],
  selection: SelectionResult,
  detailed: boolean,
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
  // in total, so detailed views of stations with many sources stop adding fields before that.
  let budget = 5900 - (e.data.title?.length ?? 0) - (e.data.footer?.text.length ?? 0) - description.length;
  const shown = sources.slice(0, 10);
  let omitted = sources.length - shown.length;
  for (const [index, s] of shown.entries()) {
    const elig = checkEligibility(s, now);
    const role =
      selection.selected?.id === s.id
        ? ' — **selected**'
        : selection.fallback?.id === s.id
          ? ' — fallback'
          : '';
    const lines = [
      `${transportLabel(s.transport === 'unknown' ? s.transportHint : s.transport)} · ${sourceFormat(s)}`,
      identityLine(s),
      `Check result: ${VERIFICATION_LABEL[s.verificationState]}${elig.eligible ? ' · can be used' : ` · can’t be used: ${truncate(elig.reasons.join('; '), 200)}`}`,
    ];
    const nextCheck = nextAutomaticCheck(s);
    if (nextCheck !== null) lines.push(failingLine(s, nextCheck));
    if (detailed) {
      lines.push(
        `Endpoint: \`${truncate(redactUrl(s.url), 120)}\`${s.effectiveHost ? ` → ${s.effectiveHost}` : ''}`,
        `Bitrates: advertised ${s.advertisedBitrateKbps ?? '—'} · codec ${s.codecBitrateKbps ?? '—'} · measured ${s.measuredBitrateKbps ?? '—'} kbps`,
        `Last checked ${ts(s.lastProbeAt)} · last worked ${ts(s.lastSuccessAt)} · last failed ${ts(s.lastFailureAt)}${s.lastFailureCode ? ` (${s.lastFailureCode})` : ''}`,
        `Health ${Math.round(s.healthScore)}/100 · start-up ${s.startupMs !== null ? `${s.startupMs} ms` : '—'}${s.icyName ? ` · stream name "${truncate(s.icyName, 60)}"` : ''}`,
        `Where it came from: ${PROVENANCE_LABEL[s.provenance]}${s.rightsStatus !== 'unreviewed' ? ` · rights: ${s.rightsStatus}` : ''}`,
      );
    }
    const name = truncate(`${s.label ?? 'Source'} \`${s.id}\`${role}`, 256);
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
      name: `${omitted} more source(s) not shown`,
      value: 'Discord limits how much one message can hold.',
    });
  }
  e.setDescription(description);
  return e;
}

export function errorEmbed(message: string): EmbedBuilder {
  return new EmbedBuilder().setColor(COLOR.error).setDescription(truncate(message, 2000));
}

export function infoEmbed(title: string, message: string, color: number = COLOR.info): EmbedBuilder {
  return new EmbedBuilder()
    .setColor(color)
    .setTitle(truncate(title, 256))
    .setDescription(truncate(message, 4000));
}

/** One stats line for the event-loop delay. Voice packets go out every 20 ms from that loop. */
export function loopDelayLine(s: LoopDelaySummary | null): string {
  if (!s) return 'Event-loop delay: not measured yet';
  const verdict = s.maxMs >= 20 ? ' (high enough to send voice packets late)' : '';
  return `Event-loop delay (last ${s.windowSec} s): typical ${s.meanMs} ms · 99% under ${s.p99Ms} ms · worst ${s.maxMs} ms${verdict}`;
}
