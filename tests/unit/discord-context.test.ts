import { ChannelType, type Client, type Guild, PermissionFlagsBits, type VoiceChannel } from 'discord.js';
import { describe, expect, it } from 'vitest';
import { PackRegistry, seedPacks } from '../../src/catalogue/packs.ts';
import { loadConfig } from '../../src/config/env.ts';
import {
  type AppContext,
  chooseVoiceChannel,
  groupName,
  isOperator,
  lockConflict,
  RateLimits,
  visibleStation,
  visibleStations,
} from '../../src/discord/context.ts';
import { accessLevel } from '../../src/discord/permissions/authorize.ts';
import {
  botVoicePermissionProblem,
  channelBitrate,
  countHumanListeners,
  userVoiceChannelId,
} from '../../src/discord/voice-access.ts';
import type { GuildSettings } from '../../src/persistence/repositories/guilds.ts';
import { memoryDb } from '../helpers.ts';

const G1 = '111111111111111111';
const G2 = '222222222222222222';

function setup(
  opts: { disabledPacks?: string[]; session?: { connected: boolean; channelId: string | null } } = {},
) {
  const repos = memoryDb();
  const packs = PackRegistry.load(null, { enabled: new Set(), disabled: new Set(opts.disabledPacks ?? []) });
  seedPacks(repos.stations, packs);
  for (const [guildId, id] of [
    [G1, 'custom:mine'],
    [G2, 'custom:theirs'],
  ] as const) {
    repos.stations.insertCustomStation({
      id,
      guildId,
      slug: id.slice(7),
      displayName: id,
      description: null,
      category: null,
      websiteUrl: null,
      language: null,
      createdById: '1',
    });
  }
  const ctx = {
    config: loadConfig({
      DISCORD_TOKEN: 'x'.repeat(30),
      DISCORD_APPLICATION_ID: G1,
      OPERATOR_USER_IDS: '333333333333333333',
    }),
    client: { application: null },
    stations: repos.stations,
    guilds: repos.guilds,
    packs,
    sessions: { get: () => opts.session ?? null },
  } as unknown as AppContext;
  return { ctx, ...repos };
}

describe('station visibility', () => {
  it('shows enabled packs in pack order and only this server’s custom stations, last', () => {
    const { ctx } = setup();
    const list = visibleStations(ctx, G1);
    expect(list[0]!.id).toBe('fg:fg-dj-radio');
    expect(list.at(-1)!.id).toBe('custom:mine');
    expect(list.some((s) => s.id === 'custom:theirs')).toBe(false);
    expect(visibleStation(ctx, G1, 'custom:theirs')).toBeNull();
    expect(visibleStation(ctx, G2, 'custom:theirs')?.id).toBe('custom:theirs');
  });

  it('hides stations of switched-off packs', () => {
    const { ctx } = setup({ disabledPacks: ['fg'] });
    expect(visibleStations(ctx, G1).map((s) => s.id)).toEqual(['custom:mine']);
    expect(visibleStation(ctx, G1, 'fg:fg-dj-radio')).toBeNull();
  });

  it('names groups after their pack', () => {
    const { ctx } = setup();
    expect(groupName(ctx, 'fg')).toBe('Radio FG / Maison FG');
    expect(groupName(ctx, 'custom')).toBe('Custom (this server)');
    expect(groupName(ctx, 'unknown-pack')).toBe('unknown-pack');
  });
});

describe('voice channel choice', () => {
  const settings = (o: Partial<GuildSettings> = {}) =>
    ({ voiceLock: false, preferredVoiceChannelId: null, ...o }) as GuildSettings;

  it('prefers lock > explicit > bot channel > user channel > preferred channel', () => {
    const idle = setup().ctx;
    const busy = setup({ session: { connected: true, channelId: 'bot' } }).ctx;
    expect(
      chooseVoiceChannel(idle, G1, settings({ voiceLock: true, preferredVoiceChannelId: 'pref' }), 'x', 'u'),
    ).toBe('pref');
    expect(chooseVoiceChannel(busy, G1, settings(), 'explicit', 'u')).toBe('explicit');
    expect(chooseVoiceChannel(busy, G1, settings(), null, 'u')).toBe('bot');
    expect(chooseVoiceChannel(idle, G1, settings({ preferredVoiceChannelId: 'pref' }), null, 'u')).toBe('u');
    expect(chooseVoiceChannel(idle, G1, settings({ preferredVoiceChannelId: 'pref' }), null, null)).toBe(
      'pref',
    );
    expect(chooseVoiceChannel(idle, G1, settings({ voiceLock: true }), null, null)).toBeNull();
  });

  it('refuses an explicit channel that conflicts with the lock (play and join alike)', () => {
    const locked = settings({ voiceLock: true, preferredVoiceChannelId: 'pref' });
    expect(lockConflict(locked, 'other', 'pref')).toBe('The radio is locked to <#pref> on this server.');
    expect(lockConflict(locked, 'pref', 'pref')).toBeNull();
    expect(lockConflict(locked, null, 'pref')).toBeNull();
    expect(lockConflict(settings(), 'other', 'pref')).toBeNull();
  });
});

describe('installation operators', () => {
  it('trusts configured operators, the application owner and owning team members', () => {
    const { ctx } = setup();
    expect(isOperator(ctx, '333333333333333333')).toBe(true);
    expect(isOperator(ctx, '444444444444444444')).toBe(false);
    const withOwner = {
      ...ctx,
      client: { application: { owner: { id: '444444444444444444' } } },
    } as unknown as AppContext;
    expect(isOperator(withOwner, '444444444444444444')).toBe(true);
    const withTeam = {
      ...ctx,
      client: { application: { owner: { members: new Map([['555555555555555555', {}]]) } } },
    } as unknown as AppContext;
    expect(isOperator(withTeam, '555555555555555555')).toBe(true);
    expect(isOperator(withTeam, '444444444444444444')).toBe(false);
  });
});

describe('access levels', () => {
  const s = { djRoleIds: ['dj'] } as unknown as GuildSettings;
  const ctx = (o: object) =>
    ({ isOwner: false, isAdministrator: false, roleIds: [], ...o }) as unknown as Parameters<
      typeof accessLevel
    >[0];

  it('maps owner/Administrator to admin, DJ roles to dj, everyone else to member', () => {
    expect(accessLevel(ctx({ isOwner: true }), s)).toBe('admin');
    expect(accessLevel(ctx({ isAdministrator: true, roleIds: ['dj'] }), s)).toBe('admin');
    expect(accessLevel(ctx({ roleIds: ['other', 'dj'] }), s)).toBe('dj');
    expect(accessLevel(ctx({ roleIds: ['other'] }), s)).toBe('member');
  });
});

describe('rate limits', () => {
  it('limits plays per user and sweeps without error', () => {
    const limits = new RateLimits();
    for (let i = 0; i < 6; i++) expect(limits.playUser.take('u')).toBe(0);
    expect(limits.playUser.take('u')).toBeGreaterThan(0);
    expect(() => limits.sweep()).not.toThrow();
  });
});

describe('voice access helpers', () => {
  const state = (id: string, channelId: string | null, bot = false) => ({
    id,
    channelId,
    member: { user: { bot } },
  });
  const guild = (states: ReturnType<typeof state>[], me: unknown = { id: 'me' }) =>
    ({
      client: { user: { id: 'me' } },
      members: { me },
      voiceStates: { cache: new Map(states.map((s) => [s.id, s])) },
    }) as unknown as Guild;

  it('counts only human listeners in the channel, never the bot itself', () => {
    const g = guild([
      state('me', 'v1'),
      state('a', 'v1'),
      state('b', 'v1', true),
      state('c', 'v2'),
      state('d', 'v1'),
    ]);
    expect(countHumanListeners(g, 'v1')).toBe(2);
    expect(countHumanListeners(g, 'v3')).toBe(0);
    expect(userVoiceChannelId(g, 'c')).toBe('v2');
    expect(userVoiceChannelId(g, 'zz')).toBeNull();
  });

  it('names every missing voice permission and detects full channels', () => {
    const channel = (granted: bigint[], joinable = true) =>
      ({
        id: 'v1',
        joinable,
        permissionsFor: () => ({ has: (flag: bigint) => granted.includes(flag) }),
      }) as unknown as VoiceChannel;
    const all = [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect, PermissionFlagsBits.Speak];
    expect(botVoicePermissionProblem(guild([]), channel(all))).toBeNull();
    expect(botVoicePermissionProblem(guild([]), channel([PermissionFlagsBits.ViewChannel]))).toBe(
      'I am missing Connect, Speak in <#v1>.',
    );
    expect(botVoicePermissionProblem(guild([]), channel(all, false))).toMatch(/full/);
    expect(botVoicePermissionProblem(guild([], null), channel(all))).toMatch(/could not check/);
  });

  it('reads the bitrate of voice and stage channels only', () => {
    const client = {
      channels: {
        cache: new Map<string, unknown>([
          ['voice', { type: ChannelType.GuildVoice, bitrate: 96_000 }],
          ['stage', { type: ChannelType.GuildStageVoice, bitrate: 64_000 }],
          ['text', { type: ChannelType.GuildText }],
        ]),
      },
    } as unknown as Client;
    expect(channelBitrate(client, 'voice')).toBe(96_000);
    expect(channelBitrate(client, 'stage')).toBe(64_000);
    expect(channelBitrate(client, 'text')).toBeNull();
    expect(channelBitrate(client, 'gone')).toBeNull();
  });
});
