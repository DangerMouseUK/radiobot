import { randomBytes } from 'node:crypto';
import type { Server } from 'node:http';
import { generateDependencyReport } from '@discordjs/voice';
import { ActivityType, Client, Events, GatewayIntentBits, Options, Partials } from 'discord.js';
import { checkFfmpeg, ProcessRegistry } from './audio/ffmpeg.ts';
import { CustomStationService } from './catalogue/custom-provider.ts';
import { PackRegistry, seedPacks } from './catalogue/packs.ts';
import { CatalogueSync } from './catalogue/sync.ts';
import type { AppConfig } from './config/env.ts';
import { ComponentIds } from './discord/components/custom-id.ts';
import { type AppContext, isVisible, RateLimits } from './discord/context.ts';
import { RadioController } from './discord/controller.ts';
import { Notifier } from './discord/notifier.ts';
import { PresenceUpdater, presenceEntries } from './discord/presence.ts';
import { registerGuildCommands } from './discord/register.ts';
import { heartbeatPath, startDiagnosticsServer, writeHeartbeat } from './observability/health.ts';
import { createLogger, type Logger, safeErr } from './observability/logger.ts';
import { Metrics } from './observability/metrics.ts';
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
  const timers: NodeJS.Timeout[] = [];
  let diagnostics: Server | null = null;
  const hbPath = heartbeatPath(config.databasePath);

  const heartbeat = () => {
    let dbOk = true;
    try {
      db.get('SELECT 1 AS ok');
    } catch {
      dbOk = false;
    }
    try {
      writeHeartbeat(hbPath, {
        at: new Date().toISOString(),
        pid: process.pid,
        discordReady: client.isReady(),
        activeStreams: sessions.activeStreams(),
        ffmpegProcesses: registry.active,
        dbOk,
        ffmpegOk: ctx.ffmpegInfo?.libopus === true,
      });
    } catch (err) {
      logger.warn({ err: safeErr(err) }, 'could not write heartbeat');
    }
  };

  const scheduleSync = () => {
    if (!config.catalogSyncEnabled) return;
    const interval = config.catalogSyncIntervalHours * 3_600_000;
    // One independent, jittered schedule per pack that declares an official list.
    for (const pack of catalogueSync.syncablePacks()) {
      const packId = pack.meta.id;
      const last = catalogueSync.lastSync(packId).at;
      const due = last ? Math.max(0, Date.parse(last) + interval - Date.now()) : 10 * 60_000;
      const jitter = Math.round(Math.random() * 15 * 60_000);
      const t = setTimeout(async function run() {
        try {
          await catalogueSync.sync(packId, 'scheduled');
        } finally {
          const next = setTimeout(run, interval + Math.round(Math.random() * 15 * 60_000));
          next.unref?.();
          timers.push(next);
        }
      }, Math.max(due, 60_000) + jitter);
      t.unref?.();
      timers.push(t);
    }
  };

  async function start(): Promise<void> {
    // Replace any heartbeat left by a previous run, so health checks wait for this process.
    heartbeat();
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
      heartbeat();
      await sessions
        .restoreOnBoot()
        .catch((err: unknown) => logger.error({ err: safeErr(err) }, 'restore failed'));
      presence.update();
      for (const g of c.guilds.cache.keys()) void controller.refreshPanel(g);
    });

    timers.push(setInterval(heartbeat, 30_000));
    // Every 20 s, and only on a change: well within Discord's limit on status updates.
    timers.push(setInterval(() => presence.update(), 20_000));
    timers.push(
      setInterval(() => {
        ctx.limits.sweep();
        try {
          stations.pruneProbeResults(config.probeHistoryLimit, config.probeHistoryDays);
        } catch (err) {
          logger.warn({ err: safeErr(err) }, 'probe history pruning failed');
        }
      }, 60 * 60_000),
    );
    // Panels reflect live state without spamming edits.
    timers.push(
      setInterval(() => {
        for (const s of sessions.all()) void controller.refreshPanel(s.guildId);
      }, 5 * 60_000),
    );
    for (const t of timers) t.unref?.();
    scheduleSync();
    if (config.diagnosticsPort) {
      diagnostics = startDiagnosticsServer(config.diagnosticsPort, () => ({
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
    for (const t of timers) clearTimeout(t);
    diagnostics?.close();
    sessions.shutdown();
    notifier.close();
    await client.destroy().catch(() => {});
    heartbeat();
    registry.killAll();
    db.close();
  }

  return { ctx, start, stop };
}
