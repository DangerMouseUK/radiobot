import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildEncodeArgs, planEncoder, sourceBitrate } from '../../src/audio/encoder.ts';
import type { StationSource } from '../../src/catalogue/types.ts';
import { ConfigError, loadConfig } from '../../src/config/env.ts';
import { applyImport, exportGuild, parseImport, previewImport } from '../../src/import-export/config-io.ts';
import { writeHeartbeat } from '../../src/observability/health.ts';
import { backoffDelayMs, cooldownMs } from '../../src/shared/backoff.ts';
import { RateLimiter } from '../../src/shared/rate-limit.ts';
import { redactText, redactUrl } from '../../src/shared/redact.ts';
import { slugify } from '../../src/shared/text.ts';
import { codecLabel, parseFfprobeOutput, wholePacketsEnd } from '../../src/streams/probe.ts';
import { canTransition } from '../../src/voice/state-machine.ts';
import { makeSource, memoryDb } from '../helpers.ts';

describe('encoder policy (§8.3, FR-007)', () => {
  const base = {
    qualityMode: 'maximum' as const,
    manualBitrateKbps: null,
    sourceSampleRateHz: 44_100,
    sourceChannels: 2,
  };

  it('is not capped by the voice channel bitrate setting', () => {
    expect(planEncoder({ ...base, channelBitrateBps: 64_000 }).targetKbps).toBe(510);
    expect(planEncoder({ ...base, channelBitrateBps: 384_000 }).targetKbps).toBe(510);
    expect(planEncoder({ ...base, channelBitrateBps: null }).targetKbps).toBe(510);
    const p = planEncoder({ ...base, channelBitrateBps: 96_000 });
    expect(p.channelBitrateKbps).toBe(96);
    expect(p.notes.join(' ')).toMatch(/does not cap/);
  });

  it('caps manual mode at the installation ceiling', () => {
    expect(
      planEncoder({
        ...base,
        qualityMode: 'manual',
        manualBitrateKbps: 400,
        maxKbps: 256,
        channelBitrateBps: 96_000,
      }).targetKbps,
    ).toBe(256);
  });

  it('honours the installation ceiling, balanced and manual modes', () => {
    expect(planEncoder({ ...base, maxKbps: 320, channelBitrateBps: 64_000 }).targetKbps).toBe(320);
    expect(planEncoder({ ...base, qualityMode: 'balanced', channelBitrateBps: 64_000 }).targetKbps).toBe(128);
    expect(
      planEncoder({ ...base, qualityMode: 'manual', manualBitrateKbps: 320, channelBitrateBps: 96_000 })
        .targetKbps,
    ).toBe(320);
    expect(
      planEncoder({ ...base, qualityMode: 'manual', manualBitrateKbps: 999, channelBitrateBps: 96_000 })
        .targetKbps,
    ).toBe(510);
  });

  it('follows the source bitrate in maximum mode, up to the ceiling', () => {
    const at = (kbps: number, maxKbps?: number) =>
      planEncoder({
        ...base,
        channelBitrateBps: 64_000,
        maxKbps,
        sourceBitrate: { kbps, evidence: 'codec metadata' },
      });
    expect(at(128).targetKbps).toBe(128);
    expect(at(192).targetKbps).toBe(192);
    expect(at(320).targetKbps).toBe(320);
    expect(at(900).targetKbps).toBe(510);
    expect(at(320, 256).targetKbps).toBe(256);
    expect(at(16).targetKbps).toBe(32);
    expect(at(128).notes.join(' ')).toContain("follows the source's 128 kbps (codec metadata)");
    expect(at(900).notes.join(' ')).toContain("this installation's limit is 510 kbps");
    expect(
      planEncoder({ ...base, channelBitrateBps: 64_000, sourceBitrate: null }).notes.join(' '),
    ).toContain("The source's bitrate is unknown");
  });

  it('never encodes balanced above the source, and leaves manual exactly as set', () => {
    const source = { kbps: 96, evidence: 'measured' as const };
    expect(
      planEncoder({ ...base, qualityMode: 'balanced', channelBitrateBps: null, sourceBitrate: source })
        .targetKbps,
    ).toBe(96);
    const loud = planEncoder({
      ...base,
      qualityMode: 'balanced',
      channelBitrateBps: null,
      sourceBitrate: { kbps: 320, evidence: 'codec metadata' },
    });
    expect(loud.targetKbps).toBe(128);
    expect(loud.notes.join(' ')).toContain('balanced quality uses 128 kbps');
    expect(
      planEncoder({
        ...base,
        qualityMode: 'manual',
        manualBitrateKbps: 256,
        channelBitrateBps: null,
        sourceBitrate: source,
      }).targetKbps,
    ).toBe(256);
  });

  it('makes manual mode with no bitrate set behave like maximum', () => {
    const p = planEncoder({
      ...base,
      qualityMode: 'manual',
      manualBitrateKbps: null,
      channelBitrateBps: null,
      sourceBitrate: { kbps: 128, evidence: 'codec metadata' },
    });
    expect(p.targetKbps).toBe(128);
    expect(p.notes.join(' ')).toContain("follows the source's 128 kbps");
  });

  it('takes the source bitrate from the strongest evidence', () => {
    const src = (o: Partial<StationSource>) =>
      sourceBitrate(
        makeSource({ codecBitrateKbps: null, measuredBitrateKbps: null, advertisedBitrateKbps: null, ...o }),
      );
    expect(src({ codecBitrateKbps: 128, measuredBitrateKbps: 131, advertisedBitrateKbps: 192 })).toEqual({
      kbps: 128,
      evidence: 'codec metadata',
    });
    expect(src({ measuredBitrateKbps: 131, advertisedBitrateKbps: 192 })).toEqual({
      kbps: 131,
      evidence: 'measured',
    });
    expect(src({ advertisedBitrateKbps: 192 })).toEqual({ kbps: 192, evidence: 'advertised' });
    expect(src({ advertisedBitrateKbps: 136, bitrateConfidence: 'manifest' })).toEqual({
      kbps: 136,
      evidence: 'manifest',
    });
    expect(src({})).toBeNull();
  });

  it('reports resampling and mono honestly', () => {
    const p = planEncoder({ ...base, channelBitrateBps: 96_000, sourceChannels: 1 });
    expect(p.resampled).toBe(true);
    expect(p.monoUpmixed).toBe(true);
    expect(planEncoder({ ...base, sourceSampleRateHz: 48_000, channelBitrateBps: 96_000 }).resampled).toBe(
      false,
    );
  });

  it('builds a single libopus encode reading only stdin, with no filters', () => {
    const args = buildEncodeArgs(planEncoder({ ...base, channelBitrateBps: 256_000 }));
    const joined = args.join(' ');
    expect(joined).toContain('-protocol_whitelist pipe');
    expect(joined).toContain('-i pipe:0');
    expect(joined).toContain('-c:a libopus');
    expect(joined).toContain('-b:a 510k');
    expect(joined).toContain('-application audio');
    expect(joined).toContain('-frame_duration 20');
    expect(joined).toContain('-ar 48000');
    expect(joined).toContain('-f ogg');
    expect(args.filter((a) => a === '-i')).toHaveLength(1);
    expect(args.filter((a) => a === '-c:a')).toHaveLength(1);
    for (const f of ['-af', '-filter:a', 'loudnorm', 'dynaudnorm', 'volume', 'acompressor', 'equalizer']) {
      expect(args).not.toContain(f);
    }
  });
});

describe('ffprobe interpretation', () => {
  it('measures bitrate from packet payload, not network timing', () => {
    const packets = Array.from({ length: 300 }, () => ({ size: '418', duration_time: '0.026122' }));
    const r = parseFfprobeOutput({
      streams: [
        {
          codec_type: 'audio',
          codec_name: 'mp3',
          sample_rate: '44100',
          channels: 2,
          channel_layout: 'stereo',
          bit_rate: '128000',
        },
      ],
      format: { format_name: 'mp3' },
      packets,
    });
    expect(r.codec).toBe('mp3');
    expect(r.measuredBitrateKbps).toBeCloseTo(128, 0);
    expect(r.codecBitrateKbps).toBe(128);
  });

  it('labels AAC profiles and leaves unknowns unknown', () => {
    expect(codecLabel('aac', 'LC')).toBe('AAC-LC');
    expect(codecLabel('aac', 'HE-AAC')).toBe('HE-AAC');
    expect(codecLabel(null, null)).toBe('unknown');
    expect(
      parseFfprobeOutput({ streams: [{ codec_type: 'audio', codec_name: 'aac' }] }).measuredBitrateKbps,
    ).toBeNull();
  });

  it('stops the decode check before the cut-off frame at the end of the sample', () => {
    const packets = [{ pos: '0' }, { pos: '418' }, { pos: '836' }, { pos: '1254' }];
    expect(wholePacketsEnd({ packets }, 1400)).toBe(1254);
    // No positions, or an implausible one, means the whole sample is decoded as before.
    expect(wholePacketsEnd({ packets: [{ size: '418' }] }, 1400)).toBe(1400);
    expect(wholePacketsEnd({ packets: [{ pos: '100' }] }, 1400)).toBe(1400);
    expect(wholePacketsEnd({ packets: [{ pos: '9999' }] }, 1400)).toBe(1400);
    expect(wholePacketsEnd({}, 1400)).toBe(1400);
  });
});

describe('redaction (NFR-11)', () => {
  it('removes credentials and query values from URLs', () => {
    expect(redactUrl('https://u:p@x.example.com/a?token=abc&id=1#f')).toBe(
      'https://x.example.com/a?***&id=***',
    );
  });
  it('scrubs Discord tokens and URLs from free text', () => {
    const token = `MTA${'x'.repeat(21)}.Gabcde.${'y'.repeat(30)}`;
    const text = redactText(`failed ${token} at https://s.example.com/live?sig=SECRET`, []);
    expect(text).not.toContain('SECRET');
    expect(text).not.toContain(token);
  });
});

describe('configuration', () => {
  const ok = { DISCORD_TOKEN: 'x'.repeat(30), DISCORD_APPLICATION_ID: '123456789012345678' };
  it('applies defaults', () => {
    const c = loadConfig(ok);
    expect(c.defaultIdleMode).toBe('leave_when_empty');
    expect(c.maxActiveGuildStreams).toBe(3);
    expect(c.disabledPacks.size).toBe(0);
  });
  it('rejects missing tokens without echoing secrets', () => {
    expect(() => loadConfig({})).toThrow(ConfigError);
  });
  it('refuses telemetry', () => {
    expect(() => loadConfig({ ...ok, TELEMETRY_ENABLED: 'true' })).toThrow(/telemetry/);
  });
  it('parses lists', () => {
    const c = loadConfig({ ...ok, DISABLED_SOURCE_IDS: 'a, b', OPERATOR_USER_IDS: '123456789012345678,bad' });
    expect([...c.disabledSourceIds]).toEqual(['a', 'b']);
    expect(c.operatorUserIds).toEqual(['123456789012345678']);
  });
});

describe('import/export', () => {
  it('exports without secrets and round-trips through validation', () => {
    const { db, stations, guilds } = memoryDb();
    const g = '123456789012345678';
    stations.insertCustomStation({
      id: 'custom:abc',
      guildId: g,
      slug: 'mine',
      displayName: 'Mine',
      description: null,
      category: null,
      websiteUrl: null,
      language: null,
      createdById: '1',
    });
    stations.upsertSeedSource({
      id: 'src-abc',
      stationId: 'custom:abc',
      url: 'https://ice.example.com/live?key=SECRET',
      label: null,
      priority: 1,
      transportHint: null,
      codecHint: null,
      provenance: 'custom-user',
      provenanceDetail: null,
      rightsStatus: 'unreviewed',
    });
    guilds.updateSettings(g, { djRoleIds: ['223456789012345678'], idleMode: '24x7' });
    const data = exportGuild(g, guilds, stations);
    const text = JSON.stringify(data);
    expect(text).not.toContain('SECRET');
    expect(data.customStations[0]!.urlRedacted).toBe(true);
    const parsed = parseImport(text);
    const other = '323456789012345678';
    const preview = previewImport(
      other,
      parsed,
      guilds,
      stations,
      new Set(),
      new Set(['223456789012345678']),
    );
    expect(preview.warnings.join(' ')).toMatch(/left out of the export/);
    applyImport(other, parsed, guilds, stations, new Set(), new Set(['223456789012345678']), (fn) =>
      db.transaction(fn),
    );
    expect(guilds.getSettings(other).idleMode).toBe('24x7');
    expect(guilds.getSettings(other).djRoleIds).toEqual(['223456789012345678']);
  });

  it('rejects malformed imports', () => {
    expect(() => parseImport('{}')).toThrow(/not a valid Radio Bot export/);
    expect(() => parseImport('nope')).toThrow(/not valid JSON/);
  });
});

describe('small utilities', () => {
  it('slugifies diacritics', () => {
    expect(slugify('FG USHUAÏA IBIZA')).toBe('fg-ushuaia-ibiza');
    expect(slugify('FG CHIC & CHILL')).toBe('fg-chic-and-chill');
  });
  it('backoff follows ~1/3/8 s with jitter and cooldown grows to 2 h', () => {
    expect(backoffDelayMs(0, undefined, 0.25, () => 0.5)).toBe(1000);
    expect(backoffDelayMs(2, undefined, 0.25, () => 0.5)).toBe(8000);
    expect(cooldownMs(1)).toBe(600_000);
    expect(cooldownMs(10)).toBe(7_200_000);
  });
  it('rate limiter refills', () => {
    let t = 0;
    const l = RateLimiter.perWindow(2, 1000, () => t);
    expect(l.take('a')).toBe(0);
    expect(l.take('a')).toBe(0);
    expect(l.take('a')).toBeGreaterThan(0);
    t = 1000;
    expect(l.take('a')).toBe(0);
  });
  it('state machine allows documented transitions only', () => {
    expect(canTransition('IDLE', 'JOINING')).toBe(true);
    expect(canTransition('PLAYING', 'SWITCHING')).toBe(true);
    expect(canTransition('PLAYING', 'RECOVERING')).toBe(true);
    expect(canTransition('STOPPING', 'PLAYING')).toBe(false);
    expect(canTransition('IDLE', 'PLAYING')).toBe(false);
    expect(canTransition('PLAYING', 'IDLE')).toBe(true);
  });
});

describe('heartbeat file', () => {
  it('keeps the form radio-bot update reads the number of playing servers from', () => {
    const dir = mkdtempSync(join(tmpdir(), 'radio-bot-hb-'));
    try {
      const path = join(dir, 'health.json');
      writeHeartbeat(path, {
        at: new Date().toISOString(),
        pid: 1,
        discordReady: true,
        activeStreams: 12,
        ffmpegProcesses: 12,
        dbOk: true,
      });
      // scripts/radio-bot.sh: grep -oE '"activeStreams":[0-9]+'
      expect(readFileSync(path, 'utf8').match(/"activeStreams":[0-9]+/)?.[0]).toBe('"activeStreams":12');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
