import { describe, expect, it } from 'vitest';
import { ComponentIds } from '../../src/discord/components/custom-id.ts';
import { type AuthContext, authorize } from '../../src/discord/permissions/authorize.ts';
import type { GuildSettings } from '../../src/persistence/repositories/guilds.ts';

const settings = (o: Partial<GuildSettings> = {}): GuildSettings => ({
  guildId: 'g',
  allowedTextChannelIds: [],
  allowedVoiceChannelIds: [],
  djRoleIds: ['dj-role'],
  memberControlMode: 'same_channel',
  defaultStationId: null,
  preferredVoiceChannelId: null,
  voiceLock: false,
  qualityMode: 'maximum',
  manualBitrateKbps: null,
  idleMode: 'leave_when_empty',
  autostart: false,
  resumeOnRestart: false,
  notificationChannelId: null,
  panelChannelId: null,
  panelMessageId: null,
  updatedAt: '',
  ...o,
});

const ctx = (o: Partial<AuthContext> = {}): AuthContext => ({
  guildId: 'g',
  userId: 'u',
  channelId: 'text-1',
  roleIds: [],
  isOwner: false,
  isAdministrator: false,
  userVoiceChannelId: null,
  botVoiceChannelId: null,
  botActive: false,
  ...o,
});

describe('authorisation matrix (§10.1)', () => {
  it('lets everyone read', () => {
    expect(authorize(ctx(), settings(), 'read').ok).toBe(true);
  });

  it('restricts admin commands to the owner and the Discord Administrator permission', () => {
    expect(authorize(ctx(), settings(), 'admin').ok).toBe(false);
    expect(authorize(ctx({ roleIds: ['dj-role'] }), settings(), 'admin').ok).toBe(false);
    expect(authorize(ctx({ isAdministrator: true }), settings(), 'admin').ok).toBe(true);
    expect(authorize(ctx({ isOwner: true }), settings(), 'admin').ok).toBe(true);
  });

  it('lets DJs control from anywhere allowed', () => {
    expect(authorize(ctx({ roleIds: ['dj-role'] }), settings(), 'control', 'voice-9').ok).toBe(true);
  });

  it('same_channel: listeners must be in the voice channel and cannot move the bot', () => {
    const s = settings();
    expect(authorize(ctx(), s, 'control').ok).toBe(false);
    expect(authorize(ctx({ userVoiceChannelId: 'v1' }), s, 'control', 'v1').ok).toBe(true);
    expect(authorize(ctx({ userVoiceChannelId: 'v1' }), s, 'control', 'v2').ok).toBe(false);
    const busy = ctx({ userVoiceChannelId: 'v1', botActive: true, botVoiceChannelId: 'v2' });
    const r = authorize(busy, s, 'control', 'v2');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/in use/);
  });

  it('none: only DJs/admins; any: everyone', () => {
    expect(
      authorize(ctx({ userVoiceChannelId: 'v1' }), settings({ memberControlMode: 'none' }), 'control', 'v1')
        .ok,
    ).toBe(false);
    expect(authorize(ctx(), settings({ memberControlMode: 'any' }), 'control', 'v1').ok).toBe(true);
  });

  it('denies commands in non-approved channels with an actionable message (FR-009 acceptance)', () => {
    const s = settings({ allowedTextChannelIds: ['radio-text'], allowedVoiceChannelIds: ['radio-voice'] });
    const r = authorize(ctx({ channelId: 'general' }), s, 'read');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('<#radio-text>');
    expect(authorize(ctx({ channelId: 'radio-text' }), s, 'read').ok).toBe(true);
    expect(authorize(ctx({ channelId: 'radio-voice' }), s, 'read').ok).toBe(true);
    expect(authorize(ctx({ channelId: 'general', isAdministrator: true }), s, 'admin').ok).toBe(true);
  });

  it('an ordinary member cannot add stations (admin capability)', () => {
    expect(
      authorize(ctx({ userVoiceChannelId: 'v1' }), settings({ memberControlMode: 'any' }), 'admin').ok,
    ).toBe(false);
  });
});

describe('signed component IDs (§6 button rules)', () => {
  let now = 1_800_000_000_000;
  const ids = new ComponentIds('secret-123', () => now);

  it('round-trips station ids and fits Discord limits', () => {
    const id = ids.make('guild-1', 'play', 'fg:fg-amsterdam-dance-event');
    expect(id.length).toBeLessThanOrEqual(100);
    expect(ids.parse('guild-1', id)).toEqual({
      action: 'play',
      arg: 'fg:fg-amsterdam-dance-event',
      expired: false,
    });
  });

  it('rejects other guilds, tampering and forged ids', () => {
    const id = ids.make('guild-1', 'stop');
    expect(ids.parse('guild-2', id)).toBeNull();
    expect(ids.parse('guild-1', id.replace('stop', 'leave'))).toBeNull();
    expect(ids.parse('guild-1', 'rb1:stop::0:AAAAAAAAAAAAAAAA')).toBeNull();
    expect(new ComponentIds('other').parse('guild-1', id)).toBeNull();
  });

  it('expires', () => {
    const id = ids.make('guild-1', 'stop', '', 1000);
    now += 5000;
    expect(ids.parse('guild-1', id)).toEqual({ expired: true });
  });

  it('supports persistent ids', () => {
    const id = ids.make('guild-1', 'next', '', null);
    now += 365 * 86_400_000;
    expect(ids.parse('guild-1', id)).toMatchObject({ action: 'next' });
  });

  it('refuses unsafe args', () => {
    expect(() => ids.make('g', 'play', 'a:b:c')).toThrow();
    expect(() => ids.make('g', 'PLAY')).toThrow();
  });
});
