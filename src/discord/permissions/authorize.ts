import type { GuildSettings } from '../../persistence/repositories/guilds.ts';

/** Command classes (PRD FR-009): read-only, playback control, administration. */
export type Capability = 'read' | 'control' | 'admin';
export type AccessLevel = 'admin' | 'dj' | 'member';

export interface AuthContext {
  guildId: string;
  userId: string;
  /** Channel the interaction was issued from (text channel or a voice channel's text chat). */
  channelId: string | null;
  roleIds: readonly string[];
  isOwner: boolean;
  /** Has Discord's Administrator permission in this server. */
  isAdministrator: boolean;
  userVoiceChannelId: string | null;
  botVoiceChannelId: string | null;
  /** The bot is currently connected or playing in this guild. */
  botActive: boolean;
}

export type AuthResult = { ok: true; level: AccessLevel } | { ok: false; level: AccessLevel; reason: string };

export function accessLevel(ctx: AuthContext, settings: GuildSettings): AccessLevel {
  // Bot administration is deliberately simple: the server owner or Discord's Administrator permission.
  if (ctx.isOwner || ctx.isAdministrator) return 'admin';
  if (ctx.roleIds.some((r) => settings.djRoleIds.includes(r))) return 'dj';
  return 'member';
}

function channelAllowed(ctx: AuthContext, settings: GuildSettings): boolean {
  if (settings.allowedTextChannelIds.length === 0) return true;
  if (!ctx.channelId) return false;
  return (
    settings.allowedTextChannelIds.includes(ctx.channelId) ||
    // Text chat inside an approved voice channel counts as an approved command channel.
    settings.allowedVoiceChannelIds.includes(ctx.channelId)
  );
}

/**
 * Server-side authorisation, repeated for every slash command, button and select
 * interaction — Discord's client-side command visibility is never trusted alone.
 *
 * @param targetVoiceChannelId the voice channel the action would play in, if any
 */
export function authorize(
  ctx: AuthContext,
  settings: GuildSettings,
  capability: Capability,
  targetVoiceChannelId: string | null = null,
): AuthResult {
  const level = accessLevel(ctx, settings);
  if (level !== 'admin' && !channelAllowed(ctx, settings)) {
    const list = settings.allowedTextChannelIds.map((id) => `<#${id}>`).join(', ');
    return { ok: false, level, reason: `Radio commands are only allowed in ${list}. Try there instead.` };
  }
  if (capability === 'read') return { ok: true, level };
  if (capability === 'admin') {
    return level === 'admin'
      ? { ok: true, level }
      : {
          ok: false,
          level,
          reason: 'Only the server owner and members with the Administrator permission can do that.',
        };
  }
  if (level === 'admin' || level === 'dj') return { ok: true, level };
  switch (settings.memberControlMode) {
    case 'any':
      return { ok: true, level };
    case 'none':
      return {
        ok: false,
        level,
        reason: 'Only DJs and administrators can control the radio on this server.',
      };
    default: {
      if (!ctx.userVoiceChannelId) {
        return {
          ok: false,
          level,
          reason:
            'Join a voice channel first. Listeners can only control the radio from the channel they are in.',
        };
      }
      if (ctx.botActive && ctx.botVoiceChannelId && ctx.botVoiceChannelId !== ctx.userVoiceChannelId) {
        return {
          ok: false,
          level,
          reason: `The radio is in use in <#${ctx.botVoiceChannelId}>. Join that channel to control it, or ask a DJ.`,
        };
      }
      if (targetVoiceChannelId && targetVoiceChannelId !== ctx.userVoiceChannelId) {
        return {
          ok: false,
          level,
          reason: 'Listeners can only bring the radio to the voice channel they are in.',
        };
      }
      return { ok: true, level };
    }
  }
}
