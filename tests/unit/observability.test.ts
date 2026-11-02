import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Client } from 'discord.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Notifier } from '../../src/discord/notifier.ts';
import {
  checkHeartbeat,
  type HealthSnapshot,
  heartbeatPath,
  startDiagnosticsServer,
  writeHeartbeat,
} from '../../src/observability/health.ts';
import { type Logger, safeErr } from '../../src/observability/logger.ts';
import { Metrics, Ring } from '../../src/observability/metrics.ts';
import { RadioError } from '../../src/shared/errors.ts';
import { memoryDb, silentLogger } from '../helpers.ts';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  vi.useRealTimers();
});
const tempDir = () => {
  const d = mkdtempSync(join(tmpdir(), 'radiobot-health-'));
  dirs.push(d);
  return d;
};

describe('heartbeat file (Docker HEALTHCHECK)', () => {
  const snap = (o: Partial<HealthSnapshot> = {}): HealthSnapshot => ({
    at: new Date().toISOString(),
    pid: 1,
    discordReady: true,
    activeStreams: 0,
    ffmpegProcesses: 0,
    dbOk: true,
    ...o,
  });

  it('lives next to the database and is written atomically', () => {
    const dir = tempDir();
    const path = heartbeatPath(join(dir, 'data', 'radio-bot.sqlite'));
    expect(path).toBe(join(dir, 'data', 'health.json'));
    writeHeartbeat(path, snap());
    expect(checkHeartbeat(path)).toEqual({ healthy: true, reason: 'ok' });
  });

  it('reports stale, unhealthy and missing heartbeats', () => {
    const path = join(tempDir(), 'health.json');
    expect(checkHeartbeat(path)).toEqual({ healthy: false, reason: 'no heartbeat file' });
    writeHeartbeat(path, snap({ at: new Date(Date.now() - 120_000).toISOString() }));
    expect(checkHeartbeat(path).reason).toMatch(/heartbeat is 12\d s old/);
    writeHeartbeat(path, snap({ at: new Date(Date.now() + 60_000).toISOString() }));
    expect(checkHeartbeat(path).healthy).toBe(false);
    writeHeartbeat(path, snap({ dbOk: false }));
    expect(checkHeartbeat(path).reason).toBe('database check failed');
    writeHeartbeat(path, snap({ discordReady: false }));
    expect(checkHeartbeat(path).reason).toBe('not connected to Discord');
    writeHeartbeat(path, snap({ ffmpegOk: false }));
    expect(checkHeartbeat(path)).toEqual({ healthy: false, reason: 'ffmpeg unavailable or missing libopus' });
    // Heartbeats from before the field existed still count as healthy.
    writeHeartbeat(path, snap({ ffmpegOk: undefined }));
    expect(checkHeartbeat(path).healthy).toBe(true);
    writeFileSync(path, '{ not json');
    expect(checkHeartbeat(path).healthy).toBe(false);
  });
});

describe('local diagnostics endpoint', () => {
  let server: Server | null = null;
  afterEach(async () => {
    await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
    server = null;
  });

  it('serves only GET /healthz and /diagnostics on 127.0.0.1', async () => {
    server = startDiagnosticsServer(0, silentLogger(), () => ({ activeStreams: 2 }));
    await new Promise<void>((r) => (server!.listening ? r() : server!.once('listening', () => r())));
    const addr = server.address() as AddressInfo;
    expect(addr.address).toBe('127.0.0.1');
    const base = `http://127.0.0.1:${addr.port}`;
    const health = await fetch(`${base}/healthz`);
    expect(health.status).toBe(200);
    expect(health.headers.get('cache-control')).toBe('no-store');
    expect(await health.json()).toEqual({ ok: true });
    expect(await (await fetch(`${base}/diagnostics`)).json()).toEqual({ activeStreams: 2 });
    expect((await fetch(`${base}/other`)).status).toBe(404);
    expect((await fetch(`${base}/healthz`, { method: 'POST' })).status).toBe(404);
  });

  it('logs a warning and carries on when the port is already in use', async () => {
    const occupier = createServer();
    await new Promise<void>((r) => occupier.listen(0, '127.0.0.1', () => r()));
    try {
      const { port } = occupier.address() as AddressInfo;
      const logger = silentLogger();
      const warned = new Promise<unknown>((r) => vi.spyOn(logger, 'warn').mockImplementation((o) => r(o)));
      server = startDiagnosticsServer(port, logger, () => ({}));
      // Without a listener, the 'error' event would be an uncaught exception and stop the bot.
      expect(server.listenerCount('error')).toBeGreaterThan(0);
      expect(await warned).toMatchObject({ port, err: { code: 'EADDRINUSE' } });
      expect(server.listening).toBe(false);
    } finally {
      await new Promise<void>((r) => occupier.close(() => r()));
    }
  });
});

describe('metrics', () => {
  it('keeps a bounded ring of the newest items', () => {
    const ring = new Ring<number>(3);
    for (const n of [1, 2, 3, 4, 5]) ring.push(n);
    expect(ring.toArray()).toEqual([3, 4, 5]);
    expect(ring.last()).toBe(5);
    expect(new Ring<number>(2).last()).toBeUndefined();
  });

  it('counts, coalesces repeated incidents per guild and code, and filters by guild', () => {
    vi.useFakeTimers({ now: new Date('2026-10-31T12:00:00Z') });
    const m = new Metrics();
    m.inc('plays');
    m.inc('plays', 2);
    expect(m.get('plays')).toBe(3);
    expect(m.get('missing')).toBe(0);
    const first = m.incident('g1', 'STREAM_STALLED', 'upstream', 'first');
    const again = m.incident('g1', 'STREAM_STALLED', 'upstream', 'second');
    expect(again).toBe(first);
    expect(first).toMatchObject({ count: 2, detail: 'second' });
    m.incident('g2', 'STREAM_STALLED', 'upstream', 'other guild');
    vi.advanceTimersByTime(6 * 60_000);
    const later = m.incident('g1', 'STREAM_STALLED', 'upstream', 'later');
    expect(later).not.toBe(first);
    expect(m.recentIncidents('g1').map((i) => i.detail)).toEqual(['later', 'second']);
    expect(m.recentIncidents(null, 1).map((i) => i.detail)).toEqual(['later']);
    expect(m.get('incident.upstream.STREAM_STALLED')).toBe(4);
    expect(Object.keys(m.snapshot())).toEqual(['incident.upstream.STREAM_STALLED', 'plays']);
  });
});

describe('log-safe errors', () => {
  it('redacts URLs, tokens and configured secrets from messages and stacks', () => {
    const err = new RadioError('HTTP_ERROR', 'failed https://s.example.com/live?key=SECRET with hunter22');
    const out = safeErr(err, ['hunter22']);
    expect(out).toMatchObject({ type: 'RadioError', code: 'HTTP_ERROR' });
    expect(JSON.stringify(out)).not.toMatch(/SECRET|hunter22/);
    expect(safeErr('plain https://x.example.com/?sig=abc')).toEqual({
      message: 'plain https://x.example.com/?***',
    });
  });
});

describe('notification channel notices (FR-008)', () => {
  const GUILD = '123456789012345678';

  function setup(channelGuild = GUILD) {
    const { guilds } = memoryDb();
    const sent: string[] = [];
    const fetch = vi.fn(async () => ({
      isSendable: () => true,
      guild: { id: channelGuild, members: { me: null } },
      send: async (m: { content: string; allowedMentions: unknown }) => {
        expect(m.allowedMentions).toEqual({ parse: [] });
        sent.push(m.content);
      },
    }));
    const client = { channels: { fetch } } as unknown as Client;
    const notifier = new Notifier(client, guilds, silentLogger());
    return { guilds, sent, fetch, notifier };
  }
  const notice = (kind: 'failover' | 'degraded', message: string) =>
    ({ guildId: GUILD, kind, code: null, message }) as const;

  it('sends the first notice of a kind and summarises repeats after five minutes', async () => {
    vi.useFakeTimers();
    const t = setup();
    t.guilds.updateSettings(GUILD, { notificationChannelId: '223456789012345678' });
    t.notifier.notify(notice('failover', 'Switched to the fallback source.'));
    t.notifier.notify(notice('failover', 'Switched again.'));
    t.notifier.notify(notice('failover', 'And again.'));
    t.notifier.notify(notice('degraded', 'Degraded.'));
    await vi.advanceTimersByTimeAsync(0);
    expect(t.sent).toEqual(['📻 Switched to the fallback source.', '📻 Degraded.']);
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(t.sent[2]).toBe('📻 And again. _(2 similar notices in the last 5 minutes)_');
    t.notifier.notify(notice('failover', 'Fresh window.'));
    await vi.advanceTimersByTimeAsync(0);
    expect(t.sent.at(-1)).toBe('📻 Fresh window.');
    t.notifier.close();
  });

  it('still sends the summary, and leaves no timer behind, when the clock jumps past the window', async () => {
    vi.useFakeTimers();
    const t = setup();
    t.guilds.updateSettings(GUILD, { notificationChannelId: '223456789012345678' });
    t.notifier.notify(notice('failover', 'First.'));
    t.notifier.notify(notice('failover', 'Repeat.'));
    // The wall clock moves on (a suspended host, a clock correction) before the summary timer runs.
    vi.setSystemTime(Date.now() + 6 * 60_000);
    t.notifier.notify(notice('failover', 'Next window.'));
    await vi.advanceTimersByTimeAsync(0);
    expect(t.sent).toEqual([
      '📻 First.',
      '📻 Repeat. _(1 similar notice in the last 5 minutes)_',
      '📻 Next window.',
    ]);
    t.notifier.close();
    expect(vi.getTimerCount()).toBe(0);
    vi.useRealTimers();
  });

  it('redacts URLs with tokens when logging a notice it could not deliver', async () => {
    const { guilds } = memoryDb();
    guilds.updateSettings(GUILD, { notificationChannelId: '223456789012345678' });
    const client = {
      channels: {
        fetch: async () => {
          throw new Error('request to https://discord.example.com/api?token=SECRET123 failed');
        },
      },
    } as unknown as Client;
    const debug = vi.fn();
    const logger = { child: () => ({ debug, isLevelEnabled: () => true }) } as unknown as Logger;
    const notifier = new Notifier(client, guilds, logger);
    notifier.notify(notice('failover', 'x'));
    await vi.waitFor(() => expect(debug).toHaveBeenCalledOnce());
    expect(JSON.stringify(debug.mock.calls)).not.toContain('SECRET123');
    notifier.close();
  });

  it('stays silent without a notification channel or when the channel belongs to another server', async () => {
    const quiet = setup();
    quiet.notifier.notify(notice('failover', 'x'));
    await new Promise((r) => setImmediate(r));
    expect(quiet.fetch).not.toHaveBeenCalled();
    const foreign = setup('999999999999999999');
    foreign.guilds.updateSettings(GUILD, { notificationChannelId: '223456789012345678' });
    foreign.notifier.notify(notice('failover', 'x'));
    await new Promise((r) => setImmediate(r));
    expect(foreign.fetch).toHaveBeenCalledOnce();
    expect(foreign.sent).toEqual([]);
  });
});
