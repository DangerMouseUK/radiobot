import { randomBytes } from 'node:crypto';
import type { Server } from 'node:http';
import { generateDependencyReport } from '@discordjs/voice';
import {
  ActivityType,
  Client,
  Events,
  GatewayIntentBits,
  Options,
  Partials,
  PermissionFlagsBits,
} from 'discord.js';
import { checkFfmpeg, ProcessRegistry } from './audio/ffmpeg.ts';
import { CustomStationService } from './catalogue/custom-provider.ts';
import { PackRegistry, seedPacks } from './catalogue/packs.ts';
import { CatalogueSync } from './catalogue/sync.ts';
import { scheduleCatalogueSyncs } from './catalogue/sync-schedule.ts';
import type { AppConfig } from './config/env.ts';
import { ComponentIds } from './discord/components/custom-id.ts';
import { type AppContext, isVisible, RateLimits } from './discord/context.ts';
import { RadioController } from './discord/controller.ts';
import { Notifier } from './discord/notifier.ts';
import { PresenceUpdater, presenceEntries } from './discord/presence.ts';
import { registerGuildCommands } from './discord/register.ts';
import { VoiceStatusUpdater } from './discord/voice-status.ts';
import { EventLoopMonitor } from './observability/event-loop.ts';
import { HeartbeatWriter, heartbeatPath, startDiagnosticsServer } from './observability/health.ts';
import { createLogger, type Logger, safeErr } from './observability/logger.ts';
import { Metrics } from './observability/metrics.ts';
import { WalCheckpointer } from './persistence/checkpoint.ts';
import { Db } from './persistence/db.ts';
import { GuildRepository, MetaRepository } from './persistence/repositories/guilds.ts';
import { StationRepository } from './persistence/repositories/stations.ts';
import { SafeHttpClient } from './streams/safe-fetch.ts';
import { SourceService } from './streams/source-service.ts';
import { UrlPolicy } from './streams/url-policy.ts';
import { discordVoiceLinkFactory } from './voice/link.ts';
import { SessionManager } from './voice/session-manager.ts';

export interface RadioApp {
  ctx: AppContext;
  start(): Promise<void>;
  stop(reason: string): Promise<void>;
}

export function createApp(
  config: AppConfig,
  logger: Logger = createLogger(config.logLevel, [config.discordToken]),
): RadioApp {
  const db = new Db(config.databasePath);
  const migration = db.migrate();
  if (migration.applied.length > 0) {
    logger.info({ applied: migration.applied, backup: migration.backupPath }, 'database migrated');
  }
  const metrics = new Metrics();
  const stations = new StationRepository(db);
  const guilds = new GuildRepository(db, {
    qualityMode: config.defaultQualityMode,
    idleMode: config.defaultIdleMode,
    resumeOnRestart: config.autoResumeDefault,
  });
  const meta = new MetaRepository(db);
  const packs = PackRegistry.load(config.extraPacksDir, {
    enabled: config.enabledPacks,
    disabled: config.disabledPacks,
  });
  const seed = db.transaction(() => seedPacks(stations, packs));
  logger.info(
    {
      ...seed,
      enabled: packs.enabledPacks().map((p) => p.meta.id),
      loaded: packs.packs.map((p) => p.meta.id),
    },
    'station packs loaded',
  );

  const policy = new UrlPolicy({ allowInsecureHttp: config.allowInsecureHttpStreams });
  const http = new SafeHttpClient(policy, undefined, config.streamUserAgent ?? undefined);
  const registry = new ProcessRegistry();
  const sources = new SourceService({
    stations,
    guilds,
    client: http,
    registry,
    ffmpegPath: config.ffmpegPath,
    ffprobePath: config.ffprobePath,
    maxConcurrentProbes: config.maxConcurrentProbes,
    logger,
    metrics,
    disabledSourceIds: config.disabledSourceIds,
    brandLabels: (provider) => packs.brandLabels(provider),
    disabledStationIds: config.disabledStationIds,
    probeHistoryLimit: config.probeHistoryLimit,
  });

  // Least privilege: Guilds + GuildVoiceStates only. No message content, members or presence intents.
  const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
    partials: [Partials.Channel],
    makeCache: Options.cacheWithLimits({
      ...Options.DefaultMakeCacheSettings,
      MessageManager: 0,
      PresenceManager: 0,
      ReactionManager: 0,
      GuildMemberManager: { maxSize: 200, keepOverLimit: (m) => m.id === m.client.user.id },
      UserManager: { maxSize: 200, keepOverLimit: (u) => u.id === u.client.user.id },
    }),
    allowedMentions: { parse: [] },
  });

  const notifier = new Notifier(client, guilds, logger);
  const sessions = new SessionManager({
    client,
    stations,
    guilds,
    sources,
    http,
    registry,
    ffmpegPath: config.ffmpegPath,
    linkFactory: discordVoiceLinkFactory,
    maxActiveStreams: config.maxActiveGuildStreams,
    maxOpusKbps: config.maxOpusBitrateKbps,
    brandLabels: (provider) => packs.brandLabels(provider),
    notify: notifier.notify,
    logger,
    metrics,
  });
  const catalogueSync = new CatalogueSync(stations, meta, http, packs, logger);
  const custom = new CustomStationService(stations, sources, policy, config.maxCustomStationsPerGuild);
  // Persistent secret so control-panel buttons keep verifying after restarts.
  const ids = new ComponentIds(
    meta.getOrCreate('components.secret', () => randomBytes(32).toString('base64url')),
  );

  const ctx: AppContext = {
    config,
    client,
    logger,
    metrics,
    db,
    stations,
    guilds,
    meta,
    http,
    policy,
    registry,
    sources,
    sessions,
    packs,
    catalogueSync,
    custom,
    ids,
    notifier,
    limits: new RateLimits(),
    eventLoop: new EventLoopMonitor(),
    startedAt: new Date(),
    ffmpegInfo: null,
  };
  const controller = new RadioController(ctx);
  // Boot resume and autostart obey the same visibility as commands (e.g. DISABLED_PACKS after a takedown).
  sessions.setStationFilter((guildId, station) => isVisible(ctx, guildId, station));
  // One "Listening to …" status for the whole bot; custom stations stay private to their server.
  const presence = new PresenceUpdater({
    mode: config.presenceMode,
    entries: () =>
      presenceEntries(
        sessions.all().map((s) => s.status()),
        (id) => stations.getStation(id),
      ),
    apply: (text) => {
      if (!client.isReady()) return false;
      client.user.setPresence({ activities: text ? [{ name: text, type: ActivityType.Listening }] : [] });
      return true;
    },
    logger,
  });
  // Each server's voice channel status shows its own station and title (optional permission).
  const voiceStatus = new VoiceStatusUpdater({
    sessions: () => sessions.all().map((s) => s.status()),
    station: (id) => stations.getStation(id),
    enabled: (guildId) => guilds.getSettings(guildId).voiceChannelStatus,
    allowed: (guildId, channelId) => {
      const guild = client.guilds.cache.get(guildId);
      const channel = guild?.channels.cache.get(channelId);
      const me = guild?.members.me;
      return Boolean(me && channel?.permissionsFor(me)?.has(PermissionFlagsBits.SetVoiceChannelStatus));
    },
    // Discord documents the permission but discord.js has no helper for this route.
    send: async (channelId, status) => {
      await client.rest.put(`/channels/${channelId}/voice-status`, { body: { status } });
    },
    logger,
  });
  // The session keeps its voice connection open until the clear finishes (bounded).
  sessions.setLeaveHook((guildId, channelId) => voiceStatus.clear(guildId, channelId));
  const timers: NodeJS.Timeout[] = [];
  let stopping = false;
  let diagnostics: Server | null = null;
  const hbPath = heartbeatPath(config.databasePath);

  // Written asynchronously and one at a time, so a slow disk never holds up voice packets.
  const heartbeats = new HeartbeatWriter(hbPath, (err) =>
    logger.warn({ err: safeErr(err) }, 'could not write heartbeat'),
  );
  const heartbeat = (): Promise<void> => {
    let dbOk = true;
    try {
      db.get('SELECT 1 AS ok');
    } catch {
      dbOk = false;
    }
    return heartbeats.write({
      at: new Date().toISOString(),
      pid: process.pid,
      discordReady: client.isReady(),
      activeStreams: sessions.activeStreams(),
      ffmpegProcesses: registry.active,
      dbOk,
      ffmpegOk: ctx.ffmpegInfo?.libopus === true,
    });
  };
  // Copies the database's write-ahead log back into the file on a worker thread, not inside commits.
  const checkpointer = new WalCheckpointer({ db, logger });
  // Aborted at shutdown, so a scheduled sync that is still running stops writing.
  const shutdownSignal = new AbortController();

  let syncSchedule: { stop(): void } | null = null;
  const scheduleSync = () => {
    if (!config.catalogSyncEnabled) return;
    syncSchedule = scheduleCatalogueSyncs({
      packIds: catalogueSync.syncablePacks().map((p) => p.meta.id),
      intervalMs: config.catalogSyncIntervalHours * 3_600_000,
      lastSync: (packId) => catalogueSync.lastSync(packId).at,
      // Background work: one at a time with source checks, and never while a stream is starting.
      sync: (packId) =>
        sources.runInBackground(() => catalogueSync.sync(packId, 'scheduled', shutdownSignal.signal)),
    });
  };

  async function start(): Promise<void> {
    // Replace any heartbeat left by a previous run, so health checks wait for this process.
    await heartbeat();
    await checkpointer.start();
    try {
      ctx.ffmpegInfo = await checkFfmpeg(registry, {
        ffmpeg: config.ffmpegPath,
        ffprobe: config.ffprobePath,
      });
      if (!ctx.ffmpegInfo.libopus)
        logger.error('FFmpeg was found but has no libopus encoder; playback will fail.');
      if (!config.streamUserAgent && ctx.ffmpegInfo.libavformat) http.userAgent = ctx.ffmpegInfo.libavformat;
      logger.info({ ...ctx.ffmpegInfo, streamUserAgent: http.userAgent }, 'ffmpeg detected');
    } catch (err) {
      logger.error(
        { err: safeErr(err) },
        'FFmpeg/FFprobe not available — install FFmpeg or set FFMPEG_PATH/FFPROBE_PATH',
      );
    }
    logger.debug({ report: generateDependencyReport() }, 'voice dependency report');

    client.on(Events.InteractionCreate, (i) => void controller.handle(i));
    client.on(Events.Error, (err) => logger.error({ err: safeErr(err) }, 'discord client error'));
    client.on(Events.ShardDisconnect, (_e, shard) => {
      metrics.incident(null, 'VOICE_DISCONNECTED', 'discord', `gateway shard ${shard} disconnected`);
    });
    client.on(Events.GuildCreate, (guild) => {
      if (config.registerCommandsOnStart && (!config.devGuildId || config.devGuildId === guild.id)) {
        // Forced: a server that removed and re-invited the bot has lost its commands.
        void registerGuildCommands(config.discordToken, config.applicationId, [guild.id], meta, logger, true);
      }
    });
    // A new gateway session (not a resume) starts without the status, so send it again.
    client.on(Events.ShardReady, () => {
      presence.invalidate();
      presence.update();
    });
    sessions.attach();

    client.once(Events.ClientReady, async (c) => {
      logger.info({ user: c.user.tag, guilds: c.guilds.cache.size }, 'connected to Discord');
      await c.application.fetch().catch(() => {});
      if (config.registerCommandsOnStart) {
        const targets = config.devGuildId ? [config.devGuildId] : [...c.guilds.cache.keys()];
        await registerGuildCommands(config.discordToken, config.applicationId, targets, meta, logger);
      }
      // Taken now, written in the background: restoring playback doesn't wait for the disk.
      void heartbeat();
      await sessions
        .restoreOnBoot()
        .catch((err: unknown) => logger.error({ err: safeErr(err) }, 'restore failed'));
      presence.update();
      // Only servers that have a control panel, one after another: asking every server for its
      // settings would also create a settings row for each one that never used the bot.
      for (const g of guilds.guildsWithPanel()) {
        if (stopping) break;
        if (c.guilds.cache.has(g)) await controller.refreshPanel(g);
      }
    });

    timers.push(setInterval(() => void heartbeat(), 30_000));
    // A blocked event loop sends voice packets late: listeners hear a drop, then a catch-up.
    ctx.eventLoop.start(60_000, (s) => {
      if (s.maxMs >= 50)
        logger.warn({ eventLoopDelay: s }, 'event loop was delayed; voice packets may have been late');
      else logger.debug({ eventLoopDelay: s }, 'event loop delay');
    });
    // Every 20 s, and only on a change: well within Discord's limit on status updates.
    timers.push(
      setInterval(() => {
        presence.update();
        void voiceStatus.update();
      }, 20_000),
    );
    // The first clean-up also applies PROBE_HISTORY_LIMIT to every source; later ones only age out old results.
    let trimEverySource = true;
    timers.push(
      setInterval(() => {
        ctx.limits.sweep();
        try {
          stations.pruneProbeResults(config.probeHistoryLimit, config.probeHistoryDays, trimEverySource);
          trimEverySource = false;
        } catch (err) {
          logger.warn({ err: safeErr(err) }, 'probe history pruning failed');
        }
      }, 60 * 60_000),
    );
    // Panels reflect live state without spamming edits. One server at a time, giving the event
    // loop back in between: building every panel in one go held up voice packets with many streams.
    let refreshingPanels = false;
    timers.push(
      setInterval(async () => {
        if (refreshingPanels) return;
        refreshingPanels = true;
        try {
          for (const s of sessions.all()) {
            if (stopping) break;
            await controller.refreshPanel(s.guildId);
            await new Promise<void>((resolve) => setImmediate(resolve));
          }
        } finally {
          refreshingPanels = false;
        }
      }, 5 * 60_000),
    );
    for (const t of timers) t.unref?.();
    scheduleSync();
    if (config.diagnosticsPort) {
      diagnostics = startDiagnosticsServer(config.diagnosticsPort, logger, () => ({
        startedAt: ctx.startedAt.toISOString(),
        discordReady: client.isReady(),
        activeStreams: sessions.activeStreams(),
        ffmpeg: {
          active: registry.active,
          spawned: registry.spawned,
          reaped: registry.reaped,
          byKind: registry.activeByKind(),
        },
        counters: metrics.snapshot(),
        eventLoopDelay: { current: ctx.eventLoop.current(), lastMinute: ctx.eventLoop.lastWindow() },
        incidents: metrics.recentIncidents(null, 20),
        sessions: sessions.all().map((s) => {
          const st = s.status();
          return {
            guildId: st.guildId,
            state: st.state,
            desired: st.desiredState,
            stationId: st.stationId,
            sourceId: st.source?.id ?? null,
            failovers: st.failovers,
          };
        }),
      }));
      logger.info({ port: config.diagnosticsPort }, 'local diagnostics endpoint on 127.0.0.1');
    }
    await client.login(config.discordToken);
  }

  async function stop(reason: string): Promise<void> {
    logger.info({ reason }, 'shutting down');
    stopping = true;
    for (const t of timers) clearTimeout(t);
    syncSchedule?.stop();
    shutdownSignal.abort();
    // Clear channel statuses while the bot is still connected (bounded, so shutdown never hangs).
    await Promise.race([voiceStatus.clearAll(), new Promise((r) => setTimeout(r, 2_000))]);
    ctx.eventLoop.stop();
    diagnostics?.close();
    sessions.shutdown();
    notifier.close();
    await client.destroy().catch(() => {});
    await heartbeat();
    registry.killAll();
    await checkpointer.stop();
    // A final checkpoint while nothing plays leaves the whole database in its main file.
    try {
      db.checkpoint('TRUNCATE');
    } catch (err) {
      logger.warn({ err: safeErr(err) }, 'final database checkpoint failed');
    }
    db.close();
  }

  return { ctx, start, stop };
}
