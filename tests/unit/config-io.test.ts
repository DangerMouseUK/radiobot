import { describe, expect, it } from 'vitest';
import { PackRegistry, seedPacks } from '../../src/catalogue/packs.ts';
import {
  applyImport,
  EXPORT_SCHEMA,
  EXPORT_VERSION,
  exportGuild,
  type GuildExport,
  parseImport,
  previewImport,
} from '../../src/import-export/config-io.ts';
import { memoryDb } from '../helpers.ts';

const SRC = '111111111111111111';
const DST = '222222222222222222';
const TEXT = '333333333333333333';
const VOICE = '444444444444444444';
const ROLE = '555555555555555555';
const GONE = '666666666666666666';

function seeded() {
  const repos = memoryDb();
  seedPacks(repos.stations, PackRegistry.load(null));
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
    defaultStationId: 'fg:fg-chic',
    preferredVoiceChannelId: VOICE,
    voiceLock: true,
    qualityMode: 'manual',
    manualBitrateKbps: 320,
    idleMode: 'pause_when_empty',
    autostart: true,
    resumeOnRestart: true,
    notificationChannelId: GONE,
  });
  t.guilds.setFavourites(SRC, ['fg:fg-techno', 'custom:plain', 'fg:fg-chic']);
  t.guilds.setPreference(SRC, 'fg:fg-dj-radio', 'pin', 'fg-dj-radio-mp3-wknqhm4yuchvv', '1');
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
    expect(data.favourites).toEqual(['fg:fg-techno', 'fg:fg-chic']);
    expect(data.sourcePreferences).toEqual([
      { stationId: 'fg:fg-dj-radio', mode: 'pin', sourceId: 'fg-dj-radio-mp3-wknqhm4yuchvv' },
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
    data.favourites.push('fg:not-a-station');
    const p = previewImport(DST, data, t.guilds, t.stations, existingChannels, existingRoles);
    expect(p.lines).toEqual(
      expect.arrayContaining([
        '• Who else can control the radio: listeners in the bot’s channel → DJs and admins only',
        '• Default station: none → fg:fg-chic',
        '• Favourites: 3',
        '• Source preferences: 1',
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
    data.favourites.push('fg:not-a-station');
    data.sourcePreferences.push({
      stationId: 'fg:fg-chic',
      mode: 'prefer',
      sourceId: 'fg-dj-radio-mp3-wknqhm4yuchvv',
    });
    applyImport(DST, data, t.guilds, t.stations, existingChannels, existingRoles, (fn) =>
      t.db.transaction(fn),
    );
    expect(t.guilds.getSettings(DST)).toMatchObject({
      allowedTextChannelIds: [TEXT],
      allowedVoiceChannelIds: [VOICE],
      djRoleIds: [ROLE],
      memberControlMode: 'none',
      defaultStationId: 'fg:fg-chic',
      preferredVoiceChannelId: VOICE,
      voiceLock: true,
      qualityMode: 'manual',
      manualBitrateKbps: 320,
      idleMode: 'pause_when_empty',
      autostart: true,
      resumeOnRestart: true,
      notificationChannelId: null,
    });
    expect(t.guilds.listFavourites(DST)).toEqual(['fg:fg-techno', 'fg:fg-chic']);
    // The mismatched preference (source of another station) is skipped.
    expect(t.guilds.listPreferences(DST).map((p) => [p.stationId, p.mode, p.sourceId])).toEqual([
      ['fg:fg-dj-radio', 'pin', 'fg-dj-radio-mp3-wknqhm4yuchvv'],
    ]);
  });

  it('never imports another server’s custom stations, and tolerates repeated favourites', () => {
    const t = configured();
    const data = exportGuild(SRC, t.guilds, t.stations);
    // A hand-edited file pointing at SRC's custom station, applied to DST.
    data.settings.defaultStationId = 'custom:plain';
    data.favourites = ['fg:fg-chic', 'custom:plain', 'fg:fg-chic'];
    data.sourcePreferences.push({ stationId: 'custom:plain', mode: 'pin', sourceId: 'src-plain' });
    const parsed = parseImport(JSON.stringify(data));
    expect(parsed.favourites).toEqual(['fg:fg-chic', 'custom:plain']);
    const preview = previewImport(DST, parsed, t.guilds, t.stations, existingChannels, existingRoles);
    expect(preview.warnings.join('\n')).toMatch(/2 station ID\(s\) are not in this catalogue/);
    applyImport(DST, parsed, t.guilds, t.stations, existingChannels, existingRoles, (fn) =>
      t.db.transaction(fn),
    );
    expect(t.guilds.getSettings(DST).defaultStationId).toBeNull();
    expect(t.guilds.listFavourites(DST)).toEqual(['fg:fg-chic']);
    expect(t.guilds.listPreferences(DST).map((p) => p.stationId)).not.toContain('custom:plain');
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
    ['a malformed station id', (d: GuildExport) => ({ ...d, favourites: ['FG CHIC'] })],
    [
      'an "auto" preference',
      (d: GuildExport) => ({ ...d, sourcePreferences: [{ stationId: 'fg:x', mode: 'auto', sourceId: 'x' }] }),
    ],
  ])('rejects %s', (_label, mutate) => {
    const t = configured();
    const data = exportGuild(SRC, t.guilds, t.stations);
    expect(() => parseImport(JSON.stringify(mutate(data)))).toThrow(/not a valid Radio Bot export/);
  });
});
