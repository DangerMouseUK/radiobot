import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseEnv } from 'node:util';
import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../../src/config/env.ts';
import { projectRoot } from '../../src/shared/paths.ts';

const TOKEN = `MTA${'x'.repeat(21)}.Gabcde.${'y'.repeat(30)}`;
const ok = { DISCORD_TOKEN: TOKEN, DISCORD_APPLICATION_ID: '123456789012345678' };
const load = (extra: Record<string, string>) => loadConfig({ ...ok, ...extra });

describe('configuration defaults', () => {
  it('applies every documented default', () => {
    const c = loadConfig(ok);
    expect(c).toMatchObject({
      devGuildId: null,
      registerCommandsOnStart: true,
      databasePath: './data/radio-bot.sqlite',
      logLevel: 'info',
      ffmpegPath: 'ffmpeg',
      ffprobePath: 'ffprobe',
      catalogSyncEnabled: true,
      catalogSyncIntervalHours: 24,
      defaultQualityMode: 'maximum',
      defaultIdleMode: 'leave_when_empty',
      presenceMode: 'track',
      maxActiveGuildStreams: 3,
      maxConcurrentProbes: 2,
      maxOpusBitrateKbps: 510,
      streamUserAgent: null,
      maxCustomStationsPerGuild: 25,
      autoResumeDefault: false,
      allowInsecureHttpStreams: true,
      diagnosticsPort: null,
      probeHistoryLimit: 30,
      probeHistoryDays: 30,
      extraPacksDir: null,
      operatorUserIds: [],
    });
    for (const set of [c.disabledPacks, c.enabledPacks, c.disabledSourceIds, c.disabledStationIds]) {
      expect(set.size).toBe(0);
    }
  });

  it('accepts .env.example once the two required values are filled in', () => {
    const example = parseEnv(readFileSync(join(projectRoot(), '.env.example'), 'utf8'));
    const c = loadConfig({ ...example, ...ok });
    const defaults = loadConfig(ok);
    // Apart from the Docker database path, the example documents the built-in defaults.
    expect({ ...c, databasePath: null }).toEqual({ ...defaults, databasePath: null });
  });
});

describe('configuration parsing', () => {
  it.each([
    ['1', true],
    ['true', true],
    [' YES ', true],
    ['on', true],
    ['0', false],
    ['false', false],
    ['No', false],
    ['off', false],
    ['', false],
  ])('reads boolean %j as %s', (raw, value) => {
    expect(load({ CATALOG_SYNC_ENABLED: raw }).catalogSyncEnabled).toBe(value);
  });

  it('rejects unrecognised booleans and names the variable', () => {
    expect(() => load({ AUTO_RESUME_DEFAULT: 'maybe' })).toThrow(
      /AUTO_RESUME_DEFAULT: must be true or false/,
    );
  });

  it.each([
    ['MAX_OPUS_BITRATE_KBPS', '31', '32', '510', '511'],
    ['CATALOG_SYNC_INTERVAL_HOURS', '5', '6', '720', '721'],
    ['MAX_ACTIVE_GUILD_STREAMS', '0', '1', '1000', '1001'],
    ['MAX_CONCURRENT_PROBES', '0', '1', '16', '17'],
    ['MAX_CUSTOM_STATIONS_PER_GUILD', '-1', '0', '500', '501'],
    ['PROBE_HISTORY_LIMIT', '0', '1', '1000', '1001'],
    ['PROBE_HISTORY_DAYS', '0', '1', '365', '366'],
  ])('enforces the range of %s', (key, below, min, max, above) => {
    expect(() => load({ [key]: below })).toThrow(ConfigError);
    expect(() => load({ [key]: min })).not.toThrow();
    expect(() => load({ [key]: max })).not.toThrow();
    expect(() => load({ [key]: above })).toThrow(new RegExp(key));
  });

  it('rejects non-integers', () => {
    expect(() => load({ MAX_OPUS_BITRATE_KBPS: '128.5' })).toThrow(ConfigError);
    expect(() => load({ MAX_ACTIVE_GUILD_STREAMS: 'lots' })).toThrow(ConfigError);
  });

  it('treats an empty diagnostics port as off and validates a set one', () => {
    expect(load({ DIAGNOSTICS_PORT: '' }).diagnosticsPort).toBeNull();
    expect(load({ DIAGNOSTICS_PORT: '9090' }).diagnosticsPort).toBe(9090);
    expect(() => load({ DIAGNOSTICS_PORT: '0' })).toThrow(ConfigError);
    expect(() => load({ DIAGNOSTICS_PORT: '70000' })).toThrow(ConfigError);
  });

  it('validates Discord IDs and treats an empty dev guild as unset', () => {
    expect(load({ DISCORD_DEV_GUILD_ID: '' }).devGuildId).toBeNull();
    expect(load({ DISCORD_DEV_GUILD_ID: '223456789012345678' }).devGuildId).toBe('223456789012345678');
    expect(() => load({ DISCORD_DEV_GUILD_ID: 'my-server' })).toThrow(/Discord ID/);
    expect(() => load({ DISCORD_APPLICATION_ID: 'replace-with-your-application-id' })).toThrow(
      /DISCORD_APPLICATION_ID/,
    );
  });

  it('restricts enumerations', () => {
    expect(
      load({ DEFAULT_QUALITY_MODE: 'balanced', DEFAULT_IDLE_MODE: '24x7', PRESENCE_MODE: 'off' }),
    ).toMatchObject({
      defaultQualityMode: 'balanced',
      defaultIdleMode: '24x7',
      presenceMode: 'off',
    });
    expect(() => load({ DEFAULT_QUALITY_MODE: 'ultra' })).toThrow(/DEFAULT_QUALITY_MODE/);
    expect(() => load({ DEFAULT_IDLE_MODE: 'forever' })).toThrow(/DEFAULT_IDLE_MODE/);
    expect(() => load({ LOG_LEVEL: 'verbose' })).toThrow(/LOG_LEVEL/);
    expect(() => load({ PRESENCE_MODE: 'song' })).toThrow(/PRESENCE_MODE/);
  });

  it('sends voice from the main thread unless VOICE_THREAD=worker', () => {
    expect(load({}).voiceThread).toBe('main');
    expect(load({ VOICE_THREAD: 'worker' }).voiceThread).toBe('worker');
    expect(() => load({ VOICE_THREAD: 'thread' })).toThrow(/VOICE_THREAD/);
  });

  it('splits lists on commas and whitespace', () => {
    const c = load({
      DISABLED_PACKS: 'demo, other',
      ENABLED_PACKS: 'optin\nextra',
      DISABLED_STATION_IDS: ' demo:demo-hits ,, demo:demo-yoga ',
    });
    expect([...c.disabledPacks]).toEqual(['demo', 'other']);
    expect([...c.enabledPacks]).toEqual(['optin', 'extra']);
    expect([...c.disabledStationIds]).toEqual(['demo:demo-hits', 'demo:demo-yoga']);
  });

  it('trims optional strings and treats blank as unset', () => {
    expect(load({ STREAM_USER_AGENT: '   ', EXTRA_PACKS_DIR: '  ' })).toMatchObject({
      streamUserAgent: null,
      extraPacksDir: null,
    });
    expect(load({ STREAM_USER_AGENT: ' VLC/3.0.21 ', EXTRA_PACKS_DIR: ' /data/packs ' })).toMatchObject({
      streamUserAgent: 'VLC/3.0.21',
      extraPacksDir: '/data/packs',
    });
    expect(() => load({ STREAM_USER_AGENT: 'x'.repeat(301) })).toThrow(/STREAM_USER_AGENT/);
  });
});

describe('configuration errors', () => {
  it('lists every problem without echoing secret values', () => {
    let message = '';
    try {
      loadConfig({ DISCORD_TOKEN: 'short-secret', DISCORD_APPLICATION_ID: 'x', LOG_LEVEL: 'loud' });
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      message = (err as Error).message;
    }
    expect(message).toMatch(/DISCORD_TOKEN/);
    expect(message).toMatch(/DISCORD_APPLICATION_ID/);
    expect(message).toMatch(/LOG_LEVEL/);
    expect(message).not.toContain('short-secret');
  });

  it('refuses telemetry in every spelling', () => {
    for (const v of ['1', 'yes', 'on', 'TRUE']) {
      expect(() => load({ TELEMETRY_ENABLED: v })).toThrow(/no telemetry/);
    }
  });
});
