import { ChannelType, type Client, type Guild, PermissionFlagsBits, type VoiceChannel } from 'discord.js';
import type { GuildSettings } from '../persistence/repositories/guilds.ts';
import { RadioError } from '../shared/errors.ts';

/**
 * Validates that a channel is a standard voice channel the bot may use: exists, is not a
 * stage channel, is on the guild's allowlist (if any) and the bot has View Channel,
 * Connect and Speak, and the channel is not full (PRD FR-003, FR-009).
 */
export async function resolveVoiceTarget(
  client: Client,
  guildId: string,
  channelId: string,
  settings: Pick<GuildSettings, 'allowedVoiceChannelIds'>,
): Promise<VoiceChannel> {
  const guild = client.guilds.cache.get(guildId) ?? (await client.guilds.fetch(guildId).catch(() => null));
  if (!guild) throw new RadioError('VOICE_CHANNEL_GONE', 'I am not in that server any more.');
  const channel =
    guild.channels.cache.get(channelId) ?? (await guild.channels.fetch(channelId).catch(() => null));
  if (!channel) throw new RadioError('VOICE_CHANNEL_GONE', 'That voice channel no longer exists.');
  if (channel.type !== ChannelType.GuildVoice) {
    throw new RadioError(
      'VOICE_PERMISSION',
      'I can only play in standard voice channels (not stage or text channels).',
    );
  }
  if (settings.allowedVoiceChannelIds.length > 0 && !settings.allowedVoiceChannelIds.includes(channel.id)) {
    throw new RadioError(
      'VOICE_PERMISSION',
      `<#${channel.id}> is not one of the voice channels the radio may use on this server.`,
    );
  }
  const problem = botVoicePermissionProblem(guild, channel);
  if (problem) throw new RadioError('VOICE_PERMISSION', problem);
  return channel;
}

export function botVoicePermissionProblem(guild: Guild, channel: VoiceChannel): string | null {
  const me = guild.members.me;
  if (!me) return 'I could not check my permissions in this server.';
  const perms = channel.permissionsFor(me);
  const missing: string[] = [];
  if (!perms?.has(PermissionFlagsBits.ViewChannel)) missing.push('View Channel');
  if (!perms?.has(PermissionFlagsBits.Connect)) missing.push('Connect');
  if (!perms?.has(PermissionFlagsBits.Speak)) missing.push('Speak');
  if (missing.length > 0) return `I need these permissions in <#${channel.id}>: ${missing.join(', ')}.`;
  if (!channel.joinable) return `<#${channel.id}> is full or I cannot join it.`;
  return null;
}

/** Counts non-bot members in a voice channel using cached voice states (no member intent needed). */
export function countHumanListeners(guild: Guild, channelId: string): number {
  let n = 0;
  for (const vs of guild.voiceStates.cache.values()) {
    if (vs.channelId !== channelId) continue;
    if (vs.id === guild.client.user?.id) continue;
    if (vs.member?.user.bot) continue;
    n++;
  }
  return n;
}

export function channelBitrate(client: Client, channelId: string): number | null {
  const ch = client.channels.cache.get(channelId);
  if (ch && (ch.type === ChannelType.GuildVoice || ch.type === ChannelType.GuildStageVoice))
    return ch.bitrate;
  return null;
}

/** The voice channel a user is currently in, from the voice-state cache. */
export function userVoiceChannelId(guild: Guild, userId: string): string | null {
  return guild.voiceStates.cache.get(userId)?.channelId ?? null;
}
