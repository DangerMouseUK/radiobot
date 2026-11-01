import { type ChatInputCommandInteraction, type Client, GuildMember, PermissionFlagsBits } from 'discord.js';
import type { ProcessRegistry } from '../audio/ffmpeg.ts';
import type { CustomStationService } from '../catalogue/custom-provider.ts';
import type { PackRegistry } from '../catalogue/packs.ts';
import type { CatalogueSync } from '../catalogue/sync.ts';
import type { Station } from '../catalogue/types.ts';
import type { AppConfig } from '../config/env.ts';
import type { EventLoopMonitor } from '../observability/event-loop.ts';
import type { Logger } from '../observability/logger.ts';
import type { Metrics } from '../observability/metrics.ts';
import type { Db } from '../persistence/db.ts';
import type { GuildRepository, GuildSettings, MetaRepository } from '../persistence/repositories/guilds.ts';
import type { StationRepository } from '../persistence/repositories/stations.ts';
import { RateLimiter } from '../shared/rate-limit.ts';
import type { SafeHttpClient } from '../streams/safe-fetch.ts';
import type { SourceService } from '../streams/source-service.ts';
import type { UrlPolicy } from '../streams/url-policy.ts';
import type { SessionManager } from '../voice/session-manager.ts';
import type { ComponentIds } from './components/custom-id.ts';
import type { Notifier } from './notifier.ts';
import type { AuthContext } from './permissions/authorize.ts';

export interface AppContext {
  config: AppConfig;
  client: Client;
  logger: Logger;
  metrics: Metrics;
  db: Db;
  stations: StationRepository;
  guilds: GuildRepository;
  meta: MetaRepository;
  http: SafeHttpClient;
  policy: UrlPolicy;
  registry: ProcessRegistry;
  sources: SourceService;
  sessions: SessionManager;
  packs: PackRegistry;
  catalogueSync: CatalogueSync;
  custom: CustomStationService;
  ids: ComponentIds;
  notifier: Notifier;
  limits: RateLimits;
  /** How late the event loop runs timers; voice packets are sent from it. */
  eventLoop: EventLoopMonitor;
  startedAt: Date;
  ffmpegInfo: {
    ffmpegVersion: string;
    ffprobeVersion: string;
    libopus: boolean;
    libavformat: string | null;
  } | null;
}

/** PRD §10.3 abuse limits. Windows are deliberately conservative defaults. */
export class RateLimits {
  readonly playUser = RateLimiter.perWindow(6, 30_000);
  readonly playGuild = RateLimiter.perWindow(12, 30_000);
  readonly probeGuild = RateLimiter.perWindow(3, 10 * 60_000);
  readonly addGuild = RateLimiter.perWindow(5, 60 * 60_000);
  readonly syncGuild = RateLimiter.perWindow(2, 60 * 60_000);
  readonly syncGlobal = RateLimiter.perWindow(1, 10 * 60_000);
  readonly componentUser = RateLimiter.perWindow(20, 20_000);

  sweep(): void {
    for (const l of [
      this.playUser,
      this.playGuild,
      this.probeGuild,
      this.addGuild,
      this.syncGuild,
      this.syncGlobal,
      this.componentUser,
    ]) {
      l.sweep();
    }
  }
}

type GuildInteraction = Pick<
  ChatInputCommandInteraction<'cached'>,
  'guildId' | 'user' | 'member' | 'channelId' | 'guild' | 'memberPermissions'
>;

/** Builds the authorisation context from the interaction itself (no member intent needed). */
export function authContext(ctx: AppContext, i: GuildInteraction): AuthContext {
  const member = i.member;
  const roleIds = member instanceof GuildMember ? [...member.roles.cache.keys()] : [];
  const session = ctx.sessions.get(i.guildId);
  return {
    guildId: i.guildId,
    userId: i.user.id,
    channelId: i.channelId,
    roleIds,
    isOwner: i.guild?.ownerId === i.user.id,
    isAdministrator: Boolean(i.memberPermissions?.has(PermissionFlagsBits.Administrator)),
    userVoiceChannelId: i.guild?.voiceStates.cache.get(i.user.id)?.channelId ?? null,
    botVoiceChannelId: session?.connected ? session.channelId : null,
    botActive: Boolean(session?.connected),
  };
}

/** Stations a guild may see: every enabled pack (in pack order) plus its own custom stations. */
export function visibleStations(ctx: AppContext, guildId: string): Station[] {
  return ctx.stations
    .listStations(guildId)
    .filter((s) => isVisible(ctx, guildId, s))
    .sort((a, b) => ctx.packs.orderOf(a.provider) - ctx.packs.orderOf(b.provider));
}

/** Whether a guild may use a station: its pack is enabled, or it is that guild's own custom station. */
export function isVisible(ctx: AppContext, guildId: string, s: Station): boolean {
  return s.provider === 'custom' ? s.guildId === guildId : ctx.packs.isEnabled(s.provider);
}

export function visibleStation(ctx: AppContext, guildId: string, id: string): Station | null {
  const s = ctx.stations.getVisibleStation(guildId, id);
  return s && isVisible(ctx, guildId, s) ? s : null;
}

/** Display name of a station's group: its pack's name, or "Custom (this server)". */
export function groupName(ctx: AppContext, provider: string): string {
  return provider === 'custom' ? 'Custom (this server)' : (ctx.packs.get(provider)?.meta.name ?? provider);
}

/**
 * Where playback should happen: configured lock > explicit choice > the bot's current
 * channel > the requester's channel > the configured preferred channel.
 */
export function chooseVoiceChannel(
  ctx: AppContext,
  guildId: string,
  settings: GuildSettings,
  explicit: string | null,
  userVoice: string | null,
): string | null {
  if (settings.voiceLock && settings.preferredVoiceChannelId) return settings.preferredVoiceChannelId;
  if (explicit) return explicit;
  const session = ctx.sessions.get(guildId);
  if (session?.connected && session.channelId) return session.channelId;
  return userVoice ?? settings.preferredVoiceChannelId;
}

/** Refusal text when an explicit channel choice conflicts with the channel lock, else null. */
export function lockConflict(
  settings: GuildSettings,
  explicit: string | null,
  target: string | null,
): string | null {
  if (!settings.voiceLock || !explicit || !target || explicit === target) return null;
  return `The radio is locked to <#${target}> on this server.`;
}

export function isOperator(ctx: AppContext, userId: string): boolean {
  if (ctx.config.operatorUserIds.includes(userId)) return true;
  const owner = ctx.client.application?.owner;
  if (!owner) return false;
  if ('members' in owner) return owner.members.has(userId);
  return owner.id === userId;
}
