import { describe, expect, it } from 'vitest';
import { seedPacks } from '../../src/catalogue/packs.ts';
import {
  applyImport,
  EXPORT_SCHEMA,
  EXPORT_VERSION,
  exportGuild,
  type GuildExport,
  parseImport,
  previewImport,
} from '../../src/import-export/config-io.ts';
import { demoRegistry, memoryDb } from '../helpers.ts';

const SRC = '111111111111111111';
const DST = '222222222222222222';
const TEXT = '333333333333333333';
const VOICE = '444444444444444444';
const ROLE = '555555555555555555';
const GONE = '666666666666666666';

function seeded() {
  const repos = memoryDb();
  seedPacks(repos.stations, demoRegistry());
  const custom = (guildId: string, id: string, url: string) => {
    repos.stations.insertCustomStation({
      id,
      guildId,
      slug: id.slice(7),
      displayName: `Custom ${id.slice(7)}`,
      description: 'desc',
      category: 'jazz',
      websiteUrl: 'https://example.org/',
      language: 'en',
      createdById: '1',
    });
    repos.stations.upsertSeedSource({
      id: `src-${id.slice(7)}`,
      stationId: id,
      url,
      label: null,
      priority: 1,
      transportHint: null,
      codecHint: null,
      provenance: 'custom-user',
      provenanceDetail: null,
      rightsStatus: 'unreviewed',
    });
  };
  return { ...repos, custom };
}

function configured() {
  const t = seeded();
  t.custom(SRC, 'custom:plain', 'https://ice.example.org/plain.mp3');
  t.custom(SRC, 'custom:secret', 'https://ice.example.org/live?key=SECRET');
  t.guilds.updateSettings(SRC, {
    allowedTextChannelIds: [TEXT, GONE],
    allowedVoiceChannelIds: [VOICE],
    djRoleIds: [ROLE, GONE],
    memberControlMode: 'none',
    defaultStationId: 'demo:demo-chic',
    preferredVoiceChannelId: VOICE,
    voiceLock: true,
    qualityMode: 'manual',
    manualBitrateKbps: 320,
    idleMode: 'pause_when_empty',
    autostart: true,
    resumeOnRestart: true,
    notificationChannelId: GONE,
  });
  t.guilds.setFavourites(SRC, ['demo:demo-techno', 'custom:plain', 'demo:demo-chic']);
  t.guilds.setPreference(SRC, 'demo:demo-radio', 'pin', 'demo-radio-mp3', '1');
  t.guilds.setPreference(SRC, 'custom:plain', 'prefer', 'src-plain', '1');
  return t;
}

describe('guild settings export', () => {
  it('exports settings, built-in favourites and preferences, but no custom station ids', () => {
    const t = configured();
    const data = exportGuild(SRC, t.guilds, t.stations);
    expect(data.schema).toBe(EXPORT_SCHEMA);
    expect(data.version).toBe(EXPORT_VERSION);
    expect(data.settings).toMatchObject({
      memberControlMode: 'none',
      manualBitrateKbps: 320,
      idleMode: 'pause_when_empty',
    });
    expect(data.favourites).toEqual(['demo:demo-techno', 'demo:demo-chic']);
    expect(data.sourcePreferences).toEqual([
      { stationId: 'demo:demo-radio', mode: 'pin', sourceId: 'demo-radio-mp3' },
    ]);
    const byName = Object.fromEntries(data.customStations.map((c) => [c.name, c]));
    expect(byName['Custom plain']).toMatchObject({
      url: 'https://ice.example.org/plain.mp3',
      urlRedacted: false,
      category: 'jazz',
    });
    expect(byName['Custom secret']).toMatchObject({
      url: 'https://ice.example.org/live?***',
      urlRedacted: true,
    });
  });

  it('never exports a custom default station', () => {
    const t = configured();
    t.guilds.updateSettings(SRC, { defaultStationId: 'custom:plain' });
    expect(exportGuild(SRC, t.guilds, t.stations).settings.defaultStationId).toBeNull();
  });

  it('round-trips losslessly through JSON and the import schema', () => {
    const t = configured();
    const data = exportGuild(SRC, t.guilds, t.stations);
    expect(parseImport(JSON.stringify(data, null, 2))).toEqual(data);
  });

  it('carries the voice channel status setting, and reads older files without it as on', () => {
    const t = configured();
    t.guilds.updateSettings(SRC, { voiceChannelStatus: false });
    const data = exportGuild(SRC, t.guilds, t.stations);
    expect(data.settings.voiceChannelStatus).toBe(false);
    const { voiceChannelStatus: _dropped, ...older } = data.settings;
    expect(parseImport(JSON.stringify({ ...data, settings: older })).settings.voiceChannelStatus).toBe(true);
  });
});

describe('guild settings import', () => {
  const existingChannels = new Set([TEXT, VOICE]);
  const existingRoles = new Set([ROLE]);

  it('previews changes and warns about everything that will be dropped', () => {
    const t = configured();
    const data = exportGuild(SRC, t.guilds, t.stations);
    data.favourites.push('demo:not-a-station');
    const p = previewImport(DST, data, t.guilds, t.stations, existingChannels, existingRoles);
    expect(p.lines).toEqual(
      expect.arrayContaining([
        '• Who else can control the radio: listeners in the bot’s channel → DJs and admins only',
        // By name, as the settings page shows it.
        `• Default station: none → ${t.stations.getStation('demo:demo-chic')!.displayName}`,
        // Every setting the import changes is listed, the channels and bitrate included.
        `• Preferred voice channel: none → <#${VOICE}>`,
        '• Manual bitrate: none → 320 kbps',
        '• Favourites: the file’s 3 replace this server’s list',
        '• Source preferences: 1 added or updated',
        '• Custom stations to add: 1 (each one is checked again before it is added)',
      ]),
    );
    expect(p.warnings).toEqual([
      '2 channel ID(s) do not exist here and will be dropped.',
      '1 role ID(s) do not exist here and will be dropped.',
      '1 station ID(s) are not in this catalogue and will be skipped.',
      '1 custom station URL(s) were left out of the export and will be skipped. Add them again with /radio add.',
    ]);
  });

  it('applies only what exists on the target server', () => {
    const t = configured();
    const data = exportGuild(SRC, t.guilds, t.stations);
    data.favourites.push('demo:not-a-station');
    data.sourcePreferences.push({
      stationId: 'demo:demo-chic',
      mode: 'prefer',
      sourceId: 'demo-radio-mp3',
    });
    applyImport(DST, data, t.guilds, t.stations, existingChannels, existingRoles, (fn) =>
      t.db.transaction(fn),
    );
    expect(t.guilds.getSettings(DST)).toMatchObject({
      allowedTextChannelIds: [TEXT],
      allowedVoiceChannelIds: [VOICE],
      djRoleIds: [ROLE],
      memberControlMode: 'none',
      defaultStationId: 'demo:demo-chic',
      preferredVoiceChannelId: VOICE,
      voiceLock: true,
      qualityMode: 'manual',
      manualBitrateKbps: 320,
      idleMode: 'pause_when_empty',
      autostart: true,
      resumeOnRestart: true,
      notificationChannelId: null,
    });
    expect(t.guilds.listFavourites(DST)).toEqual(['demo:demo-techno', 'demo:demo-chic']);
    // The mismatched preference (source of another station) is skipped.
    expect(t.guilds.listPreferences(DST).map((p) => [p.stationId, p.mode, p.sourceId])).toEqual([
      ['demo:demo-radio', 'pin', 'demo-radio-mp3'],
    ]);
  });

  it('never imports another server’s custom stations, and tolerates repeated favourites', () => {
    const t = configured();
    const data = exportGuild(SRC, t.guilds, t.stations);
    // A hand-edited file pointing at SRC's custom station, applied to DST.
    data.settings.defaultStationId = 'custom:plain';
    data.favourites = ['demo:demo-chic', 'custom:plain', 'demo:demo-chic'];
    data.sourcePreferences.push({ stationId: 'custom:plain', mode: 'pin', sourceId: 'src-plain' });
    const parsed = parseImport(JSON.stringify(data));
    expect(parsed.favourites).toEqual(['demo:demo-chic', 'custom:plain']);
    const preview = previewImport(DST, parsed, t.guilds, t.stations, existingChannels, existingRoles);
    expect(preview.warnings.join('\n')).toMatch(/2 station ID\(s\) are not in this catalogue/);
    applyImport(DST, parsed, t.guilds, t.stations, existingChannels, existingRoles, (fn) =>
      t.db.transaction(fn),
    );
    expect(t.guilds.getSettings(DST).defaultStationId).toBeNull();
    expect(t.guilds.listFavourites(DST)).toEqual(['demo:demo-chic']);
    expect(t.guilds.listPreferences(DST).map((p) => p.stationId)).not.toContain('custom:plain');
  });

  it('keeps this server’s custom-station favourites and custom default when importing its own export', () => {
    const t = configured();
    t.guilds.updateSettings(SRC, { defaultStationId: 'custom:plain' });
    t.guilds.toggleFavourite(SRC, 'custom:secret');
    const data = parseImport(JSON.stringify(exportGuild(SRC, t.guilds, t.stations)));
    // The export leaves custom stations out, so the file has neither of them.
    expect(data.settings.defaultStationId).toBeNull();
    expect(data.favourites.some((id) => id.startsWith('custom:'))).toBe(false);
    const preview = previewImport(SRC, data, t.guilds, t.stations, existingChannels, existingRoles);
    expect(preview.lines.join('\n')).not.toMatch(/Default station/);
    expect(preview.lines).toContain(
      `• Favourites: the file’s ${data.favourites.length} replace this server’s list (this server’s 2 custom-station favourite(s) are kept)`,
    );
    applyImport(SRC, data, t.guilds, t.stations, existingChannels, existingRoles, (fn) =>
      t.db.transaction(fn),
    );
    expect(t.guilds.getSettings(SRC).defaultStationId).toBe('custom:plain');
    // The file's favourites first, then the custom ones in their order.
    expect(t.guilds.listFavourites(SRC)).toEqual([...data.favourites, 'custom:plain', 'custom:secret']);
  });

  it('is atomic: a failure leaves the target untouched', () => {
    const t = configured();
    const data = exportGuild(SRC, t.guilds, t.stations);
    const before = t.guilds.getSettings(DST);
    expect(() =>
      applyImport(DST, data, t.guilds, t.stations, existingChannels, existingRoles, (fn) =>
        t.db.transaction(() => {
          fn();
          throw new Error('disk full');
        }),
      ),
    ).toThrow('disk full');
    expect(t.guilds.getSettings(DST).memberControlMode).toBe(before.memberControlMode);
    expect(t.guilds.listFavourites(DST)).toEqual([]);
  });

  it.each([
    ['a newer format version', (d: GuildExport) => ({ ...d, version: 2 })],
    [
      'a non-snowflake channel',
      (d: GuildExport) => ({ ...d, settings: { ...d.settings, djRoleIds: ['@everyone'] } }),
    ],
    [
      'an out-of-range bitrate',
      (d: GuildExport) => ({ ...d, settings: { ...d.settings, manualBitrateKbps: 999 } }),
    ],
    ['a malformed station id', (d: GuildExport) => ({ ...d, favourites: ['Demo Chic'] })],
    [
      'an "auto" preference',
      (d: GuildExport) => ({
        ...d,
        sourcePreferences: [{ stationId: 'demo:x', mode: 'auto', sourceId: 'x' }],
      }),
    ],
  ])('rejects %s', (_label, mutate) => {
    const t = configured();
    const data = exportGuild(SRC, t.guilds, t.stations);
    expect(() => parseImport(JSON.stringify(mutate(data)))).toThrow(/not a valid Radio Bot export/);
  });
});
