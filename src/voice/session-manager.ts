import type { Client, Guild, VoiceState } from 'discord.js';
import type { ProcessRegistry } from '../audio/ffmpeg.ts';
import { AudioPipeline } from '../audio/pipeline.ts';
import type { Station } from '../catalogue/types.ts';
import { channelBitrate, countHumanListeners, resolveVoiceTarget } from '../discord/voice-access.ts';
import type { Logger } from '../observability/logger.ts';
import type { Metrics } from '../observability/metrics.ts';
import type { GuildRepository, GuildSettings, PlaybackIntent } from '../persistence/repositories/guilds.ts';
import type { StationRepository } from '../persistence/repositories/stations.ts';
import { errorCode, RadioError } from '../shared/errors.ts';
import { metadataSignal } from '../streams/identity.ts';
import { openSourceInput } from '../streams/input.ts';
import type { SafeHttpClient } from '../streams/safe-fetch.ts';
import type { SourceService } from '../streams/source-service.ts';
import type { VoiceLinkFactory } from './link.ts';
import { GuildSession, type SessionNotice, type SessionTimings, type StartResult } from './session.ts';

export interface SessionManagerDeps {
  client: Client;
  stations: StationRepository;
  guilds: GuildRepository;
  sources: SourceService;
  http: SafeHttpClient;
  registry: ProcessRegistry;
  ffmpegPath: string;
  linkFactory: VoiceLinkFactory;
  maxActiveStreams: number;
  maxOpusKbps: number;
  brandLabels: (provider: string) => ReadonlySet<string>;
  notify: (notice: SessionNotice) => void;
  logger: Logger;
  metrics: Metrics;
  timings?: Partial<SessionTimings>;
}

/** Decides whether a guild may still play a station (for example, its pack is enabled). */
export type StationFilter = (guildId: string, station: Station) => boolean;

/** Owns one GuildSession per guild (one voice connection per guild, PRD §2.1). */
export class SessionManager {
  readonly #d: SessionManagerDeps;
  readonly #sessions = new Map<string, GuildSession>();
  readonly #log: Logger;
  #stationFilter: StationFilter = () => true;
  #onLeaving: ((guildId: string, channelId: string) => Promise<void> | void) | null = null;

  constructor(deps: SessionManagerDeps) {
    this.#d = deps;
    this.#log = deps.logger.child({ component: 'sessions' });
  }

  /**
   * Restricts which stations boot restore may start: a station whose pack was disabled (say,
   * after a takedown request) must not resume or autostart. Retired stations never do.
   */
  setStationFilter(filter: StationFilter): void {
    this.#stationFilter = filter;
  }

  /** Called just before a session leaves its voice channel (used to clear the channel status). */
  setLeaveHook(fn: (guildId: string, channelId: string) => Promise<void> | void): void {
    this.#onLeaving = fn;
  }

  get(guildId: string): GuildSession | null {
    return this.#sessions.get(guildId) ?? null;
  }

  ensure(guildId: string): GuildSession {
    let s = this.#sessions.get(guildId);
    if (!s) {
      s = new GuildSession({
        guildId,
        sources: this.#d.sources,
        stations: this.#d.stations,
        guilds: this.#d.guilds,
        openInput: async (source, signal) => {
          const input = await openSourceInput(this.#d.http, source.url, { signal });
          const station = this.#d.stations.getStation(source.stationId);
          if (station && source.identityOverride !== 'verified') {
            const meta = metadataSignal(
              station,
              this.#d.stations.listBuiltinStations(),
              input.info.icyName,
              this.#d.brandLabels(station.provider),
            );
            if (meta.verdict === 'contradicts') {
              input.close();
              this.#d.sources.flagIdentityContradiction(source.id, meta.detail);
              throw new RadioError(
                'IDENTITY_MISMATCH',
                `This stream now says it is a different station. ${meta.detail}`,
              );
            }
          }
          return input;
        },
        createPipeline: (input, plan) =>
          new AudioPipeline(input, plan, {
            registry: this.#d.registry,
            ffmpegPath: this.#d.ffmpegPath,
            owner: `session:${guildId}`,
          }),
        connect: async (channelId) => {
          const settings = this.#d.guilds.getSettings(guildId);
          const channel = await resolveVoiceTarget(this.#d.client, guildId, channelId, settings);
          return this.#d.linkFactory(channel);
        },
        channelBitrate: (channelId) => channelBitrate(this.#d.client, channelId),
        countListeners: (channelId) => {
          const guild = this.#d.client.guilds.cache.get(guildId);
          return guild ? countHumanListeners(guild, channelId) : null;
        },
        mayStream: () => this.activeStreams() < this.#d.maxActiveStreams,
        notify: this.#d.notify,
        onLeaving: (channelId) => this.#onLeaving?.(guildId, channelId),
        logger: this.#d.logger,
        metrics: this.#d.metrics,
        timings: this.#d.timings,
        maxOpusKbps: this.#d.maxOpusKbps,
      });
      this.#sessions.set(guildId, s);
    }
    return s;
  }

  activeStreams(): number {
    let n = 0;
    for (const s of this.#sessions.values()) if (s.isStreaming) n++;
    return n;
  }

  all(): GuildSession[] {
    return [...this.#sessions.values()];
  }

  /** Starts/switches playback, enforcing the installation-wide stream budget (NFR-13). */
  async play(
    guildId: string,
    stationId: string,
    channelId: string,
    userId: string | null,
  ): Promise<StartResult> {
    const existing = this.#sessions.get(guildId);
    if (!existing?.isStreaming && this.activeStreams() >= this.#d.maxActiveStreams) {
      throw new RadioError(
        'STREAM_LIMIT',
        `This bot is already playing in ${this.#d.maxActiveStreams} ${this.#d.maxActiveStreams === 1 ? 'server' : 'servers'}, the most its owner allows. Try again later.`,
      );
    }
    const session = this.ensure(guildId);
    return session.play(stationId, channelId, userId);
  }

  // ------------------------------------------------------------------ Discord events

  /** Wires gateway events: moves/kicks, listener counts, bitrate changes, deletions. */
  attach(): void {
    const c = this.#d.client;
    c.on('voiceStateUpdate', (oldState, newState) => this.#onVoiceState(oldState, newState));
    c.on('channelDelete', (ch) => {
      if (!('guildId' in ch) || !ch.guildId) return;
      const s = this.#sessions.get(ch.guildId);
      if (s && s.channelId === ch.id) {
        s.leave('idle', 'channel_deleted');
        this.#d.notify({
          guildId: ch.guildId,
          kind: 'error',
          code: 'VOICE_CHANNEL_GONE',
          message: 'The radio voice channel was deleted, so playback stopped.',
        });
      }
    });
    c.on('guildDelete', (guild) => this.#onGuildRemoved(guild));
  }

  #onVoiceState(oldState: VoiceState, newState: VoiceState): void {
    const guild = newState.guild;
    const session = this.#sessions.get(guild.id);
    if (!session) return;
    const botId = this.#d.client.user?.id;
    if (newState.id === botId) {
      if (oldState.channelId && newState.channelId && oldState.channelId !== newState.channelId) {
        this.#onBotMoved(guild, session, newState.channelId);
      }
      return;
    }
    const ch = session.channelId;
    if (ch && (oldState.channelId === ch || newState.channelId === ch)) {
      session.onListenersChanged(countHumanListeners(guild, ch));
    }
  }

  #onBotMoved(guild: Guild, session: GuildSession, channelId: string): void {
    const settings = this.#d.guilds.getSettings(guild.id);
    const allowed =
      settings.allowedVoiceChannelIds.length === 0 || settings.allowedVoiceChannelIds.includes(channelId);
    if (
      !allowed ||
      (settings.voiceLock &&
        settings.preferredVoiceChannelId &&
        settings.preferredVoiceChannelId !== channelId)
    ) {
      session.leave('idle', 'moved_disallowed');
      this.#d.notify({
        guildId: guild.id,
        kind: 'error',
        code: 'VOICE_PERMISSION',
        message: `I was moved to <#${channelId}>, which is not an approved radio channel, so I left.`,
      });
      return;
    }
    session.onMoved(channelId);
    session.onListenersChanged(countHumanListeners(guild, channelId));
  }

  #onGuildRemoved(guild: Guild): void {
    const s = this.#sessions.get(guild.id);
    if (s) {
      s.destroy();
      this.#sessions.delete(guild.id);
    }
    if (guild.available) {
      // Removed from the server (not an outage): delete operator-held data for it (PRD §15), all
      // or nothing, so a failure part-way never leaves custom stations without their settings.
      this.#d.stations.transaction(() => {
        this.#d.guilds.purgeGuild(guild.id);
        this.#d.stations.deleteGuildCustomStations(guild.id);
      });
      this.#log.info({ guildId: guild.id }, 'removed from guild; session released and guild data purged');
    } else {
      this.#log.info({ guildId: guild.id }, 'guild unavailable (outage); session released');
    }
  }

  // ------------------------------------------------------------------ boot policy

  /**
   * PRD §9.3: resume only where the admin enabled it. An explicit stop/leave/kick is
   * authoritative and suppresses autostart. Never starts unexpected playback after updates.
   */
  async restoreOnBoot(): Promise<void> {
    const intents = new Map(this.#d.guilds.listIntents().map((i) => [i.guildId, i]));
    const guildIds = new Set([...intents.keys(), ...this.#d.guilds.listGuildIdsWithSettings()]);
    for (const guildId of guildIds) {
      if (!this.#d.client.guilds.cache.has(guildId)) continue;
      const settings = this.#d.guilds.getSettings(guildId);
      const intent = intents.get(guildId) ?? null;
      const target = bootDecision(intent, settings);
      if (!target) {
        if (intent?.desiredState === 'playing' || intent?.desiredState === 'paused_empty') {
          // Desired playback without opt-in resume: remain idle and record why.
          this.#d.guilds.setIntent(guildId, { desiredState: 'idle', lastErrorCode: 'RESUME_DISABLED' });
        }
        continue;
      }
      const station = this.#d.stations.getVisibleStation(guildId, target.stationId);
      if (!station) continue;
      if (station.catalogueStatus === 'retired' || !this.#stationFilter(guildId, station)) {
        this.#log.info(
          { guildId, stationId: station.id, why: target.why },
          'not restoring playback: the station is retired or its pack is disabled',
        );
        continue;
      }
      try {
        await resolveVoiceTarget(this.#d.client, guildId, target.channelId, settings);
        this.#log.info({ guildId, stationId: target.stationId, why: target.why }, 'restoring playback');
        const r = await this.play(guildId, target.stationId, target.channelId, null);
        if (!r.ok && r.code !== 'CANCELLED')
          this.#log.warn({ guildId, code: r.code }, 'restore did not start');
      } catch (err) {
        this.#log.warn({ guildId, code: errorCode(err) }, 'could not restore playback');
        this.#d.guilds.setIntent(guildId, {
          desiredState: intent?.desiredState ?? 'idle',
          lastErrorCode: errorCode(err),
        });
      }
    }
  }

  /** Releases every session and child process. Desired state is kept for the next boot. */
  shutdown(): void {
    for (const s of this.#sessions.values()) s.destroy();
    this.#sessions.clear();
    this.#d.registry.killAll();
  }
}

export interface BootTarget {
  stationId: string;
  channelId: string;
  why: 'resume' | 'autostart';
}

/**
 * PRD §9.3 / NFR-09 boot decision. Resume the persisted desired station only when the guild
 * opted into resume; otherwise autostart the default only if no explicit stop/leave/kick is
 * on record. Anything else stays idle.
 */
export function bootDecision(
  intent: PlaybackIntent | null,
  settings: Pick<
    GuildSettings,
    'resumeOnRestart' | 'autostart' | 'defaultStationId' | 'preferredVoiceChannelId'
  >,
): BootTarget | null {
  const explicitStop = intent !== null && ['stopped', 'left', 'kicked'].includes(intent.desiredState);
  if (
    intent &&
    (intent.desiredState === 'playing' || intent.desiredState === 'paused_empty') &&
    settings.resumeOnRestart &&
    intent.desiredStationId &&
    intent.desiredVoiceChannelId
  ) {
    return { stationId: intent.desiredStationId, channelId: intent.desiredVoiceChannelId, why: 'resume' };
  }
  if (!explicitStop && settings.autostart && settings.defaultStationId && settings.preferredVoiceChannelId) {
    return {
      stationId: settings.defaultStationId,
      channelId: settings.preferredVoiceChannelId,
      why: 'autostart',
    };
  }
  return null;
}
