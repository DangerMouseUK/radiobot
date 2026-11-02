import { ChannelType, type Client, PermissionFlagsBits, type VoiceChannel } from 'discord.js';
import { describe, expect, it, vi } from 'vitest';
import { botVoicePermissionProblem, resolveVoiceTarget } from '../../src/discord/voice-access.ts';

const GUILD = '123456789012345678';
const VOICE = '223456789012345678';
const ALL = [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect, PermissionFlagsBits.Speak];

function voice(o: { id?: string; type?: ChannelType; granted?: bigint[] | null; joinable?: boolean } = {}) {
  return {
    id: o.id ?? VOICE,
    type: o.type ?? ChannelType.GuildVoice,
    joinable: o.joinable ?? true,
    permissionsFor: () =>
      o.granted === null ? null : { has: (flag: bigint) => (o.granted ?? ALL).includes(flag) },
  };
}

function world(o: {
  cachedGuild?: boolean;
  fetchGuild?: 'ok' | 'reject';
  cachedChannel?: ReturnType<typeof voice> | null;
  fetchedChannel?: ReturnType<typeof voice> | 'reject' | null;
}) {
  const channelFetch = vi.fn(async () => {
    if (o.fetchedChannel === 'reject') throw new Error('Unknown Channel');
    return o.fetchedChannel ?? null;
  });
  const guild = {
    id: GUILD,
    members: { me: { id: 'me' } },
    channels: {
      cache: new Map(o.cachedChannel ? [[o.cachedChannel.id, o.cachedChannel]] : []),
      fetch: channelFetch,
    },
  };
  const guildFetch = vi.fn(async () => {
    if (o.fetchGuild === 'reject') throw new Error('Unknown Guild');
    return guild;
  });
  const client = {
    guilds: { cache: new Map(o.cachedGuild === false ? [] : [[GUILD, guild]]), fetch: guildFetch },
  } as unknown as Client;
  return { client, guildFetch, channelFetch };
}

const open = { allowedVoiceChannelIds: [] as string[] };

async function code(p: Promise<unknown>) {
  try {
    await p;
    return null;
  } catch (e) {
    return [(e as { code: string }).code, (e as Error).message] as const;
  }
}

describe('resolveVoiceTarget', () => {
  it('returns a cached voice channel the bot may use', async () => {
    const ch = voice();
    const w = world({ cachedChannel: ch });
    expect(await resolveVoiceTarget(w.client, GUILD, VOICE, open)).toBe(ch);
    expect(w.guildFetch).not.toHaveBeenCalled();
    expect(w.channelFetch).not.toHaveBeenCalled();
  });

  it('fetches a guild and channel that are not cached', async () => {
    const ch = voice();
    const w = world({ cachedGuild: false, fetchGuild: 'ok', fetchedChannel: ch });
    expect(await resolveVoiceTarget(w.client, GUILD, VOICE, { allowedVoiceChannelIds: [VOICE] })).toBe(ch);
    expect(w.guildFetch).toHaveBeenCalledWith(GUILD);
    expect(w.channelFetch).toHaveBeenCalledWith(VOICE);
  });

  it('says the server or channel is gone when Discord cannot find them', async () => {
    const noGuild = world({ cachedGuild: false, fetchGuild: 'reject' });
    expect((await code(resolveVoiceTarget(noGuild.client, GUILD, VOICE, open)))?.[0]).toBe(
      'VOICE_CHANNEL_GONE',
    );
    const noChannel = world({ fetchedChannel: 'reject' });
    const r = await code(resolveVoiceTarget(noChannel.client, GUILD, VOICE, open));
    expect(r?.[0]).toBe('VOICE_CHANNEL_GONE');
    expect(r?.[1]).toMatch(/That voice channel no longer exists/);
    const nullChannel = world({ fetchedChannel: null });
    expect((await code(resolveVoiceTarget(nullChannel.client, GUILD, VOICE, open)))?.[0]).toBe(
      'VOICE_CHANNEL_GONE',
    );
  });

  it('refuses stage and text channels', async () => {
    for (const type of [ChannelType.GuildStageVoice, ChannelType.GuildText]) {
      const w = world({ cachedChannel: voice({ type }) });
      const r = await code(resolveVoiceTarget(w.client, GUILD, VOICE, open));
      expect(r).toEqual(['VOICE_PERMISSION', expect.stringMatching(/only play in standard voice channels/)]);
    }
  });

  it('enforces the server’s voice channel allowlist', async () => {
    const w = world({ cachedChannel: voice() });
    const r = await code(
      resolveVoiceTarget(w.client, GUILD, VOICE, { allowedVoiceChannelIds: ['999999999999999999'] }),
    );
    expect(r).toEqual([
      'VOICE_PERMISSION',
      expect.stringContaining(`<#${VOICE}> is not one of the voice channels`),
    ]);
  });

  it('names missing permissions and full channels', async () => {
    const missing = world({ cachedChannel: voice({ granted: [PermissionFlagsBits.ViewChannel] }) });
    expect(await code(resolveVoiceTarget(missing.client, GUILD, VOICE, open))).toEqual([
      'VOICE_PERMISSION',
      expect.stringContaining('I need these permissions in <#223456789012345678>: Connect, Speak.'),
    ]);
    const full = world({ cachedChannel: voice({ joinable: false }) });
    expect((await code(resolveVoiceTarget(full.client, GUILD, VOICE, open)))?.[1]).toMatch(/is full/);
  });
});

describe('botVoicePermissionProblem', () => {
  it('reports every permission missing when Discord returns no permissions', () => {
    const guild = { members: { me: { id: 'me' } } } as unknown as Parameters<
      typeof botVoicePermissionProblem
    >[0];
    expect(botVoicePermissionProblem(guild, voice({ granted: null }) as unknown as VoiceChannel)).toBe(
      `I need these permissions in <#${VOICE}>: View Channel, Connect, Speak.`,
    );
  });
});
