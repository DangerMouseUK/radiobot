import { type Client, PermissionFlagsBits } from 'discord.js';
import { pino } from 'pino';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Notifier } from '../../src/discord/notifier.ts';
import { type DelayHistogram, EventLoopMonitor } from '../../src/observability/event-loop.ts';
import { createLogger, type Logger, safeErr } from '../../src/observability/logger.ts';
import { backoffDelayMs, cooldownMs } from '../../src/shared/backoff.ts';
import { redactText, redactUrl, urlHost } from '../../src/shared/redact.ts';
import { memoryDb } from '../helpers.ts';

afterEach(() => {
  vi.useRealTimers();
});

/** Captures what a logger made by createLogger writes, one parsed JSON object per line. */
function capture(logger: Logger): Array<Record<string, unknown>> {
  const lines: Array<Record<string, unknown>> = [];
  const stream = (logger as unknown as Record<symbol, { write: (s: string) => boolean }>)[
    pino.symbols.streamSym
  ]!;
  vi.spyOn(stream, 'write').mockImplementation((s: string) => {
    lines.push(JSON.parse(s) as Record<string, unknown>);
    return true;
  });
  return lines;
}

describe('createLogger', () => {
  it('writes JSON with a level label, ISO time and the app name, at the configured level', () => {
    const log = createLogger('info');
    const lines = capture(log);
    log.debug('hidden');
    log.info({ guildId: '123456789012345678' }, 'started');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      level: 'info',
      app: 'radio-bot',
      guildId: '123456789012345678',
      msg: 'started',
    });
    expect(new Date(lines[0]!.time as string).toISOString()).toBe(lines[0]!.time);
    expect(log.isLevelEnabled('debug')).toBe(false);
  });

  it('redacts secret-bearing fields and scrubs secrets and URLs from messages', () => {
    const log = createLogger('debug', ['my-very-secret-value']);
    const lines = capture(log);
    log.warn(
      {
        token: 't',
        discordToken: 'd',
        url: 'https://radio.example.org/live?sig=1',
        source: { streamUrl: 'https://radio.example.org/x', url: 'u', token: 'x' },
        headers: { authorization: 'Bearer x', cookie: 'c=1', accept: '*/*' },
      },
      'failed with my-very-secret-value at https://radio.example.org/live?key=abc',
    );
    const line = lines[0]!;
    expect(line).toMatchObject({
      token: '[redacted]',
      discordToken: '[redacted]',
      url: '[redacted]',
      source: { streamUrl: '[redacted]', url: '[redacted]', token: '[redacted]' },
      headers: { authorization: '[redacted]', cookie: '[redacted]', accept: '*/*' },
    });
    expect(line.msg).toBe('failed with [redacted] at https://radio.example.org/live?***');
    // Non-string arguments pass through untouched.
    log.info({ n: 1 }, 'count %d', 42);
    expect(lines[1]).toMatchObject({ n: 1, msg: 'count 42' });
  });
});

describe('safeErr', () => {
  it('omits a non-string code and a missing stack', () => {
    const err = Object.assign(new Error('boom'), { code: 42 });
    err.stack = undefined;
    expect(safeErr(err)).toEqual({ type: 'Error', message: 'boom' });
    const coded = Object.assign(new TypeError('bad'), { code: 'ERR_BAD' });
    expect(safeErr(coded)).toMatchObject({ type: 'TypeError', code: 'ERR_BAD', message: 'bad' });
    expect(safeErr(null)).toEqual({ message: 'null' });
  });
});

describe('shared helpers: remaining branches', () => {
  it('falls back to a one-second base for an empty backoff schedule', () => {
    expect(backoffDelayMs(3, [], 0)).toBe(1_000);
    expect(cooldownMs(0)).toBe(10 * 60_000);
    expect(cooldownMs(50)).toBe(2 * 60 * 60_000);
  });

  it('reads the host of a URL object and redacts URL objects', () => {
    expect(urlHost(new URL('https://radio.example.org:8443/a'))).toBe('radio.example.org:8443');
    expect(redactUrl(new URL('https://u:p@radio.example.org/a?x=1&x=2#frag'))).toBe(
      'https://radio.example.org/a?x=***',
    );
    expect(redactUrl('::nope')).toBe('[invalid-url]');
    expect(redactText('short secret', ['short', ''])).toBe('short secret');
  });
});

describe('EventLoopMonitor windows', () => {
  class Hist implements DelayHistogram {
    count = 10;
    mean = 12e6;
    max = 30e6;
    enables = 0;
    percentile(): number {
      return 20e6;
    }
    reset(): void {
      this.count = 0;
    }
    enable(): boolean {
      this.enables++;
      return true;
    }
    disable(): boolean {
      return true;
    }
  }

  it('hands each completed window to the callback and skips empty ones', () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const h = new Hist();
    const created: Hist[] = [];
    const m = new EventLoopMonitor(() => {
      created.push(h);
      return h;
    });
    const windows: number[] = [];
    m.start(1_000, (s) => windows.push(s.maxMs));
    m.start(1_000, () => windows.push(-1)); // already running: ignored
    expect(created).toHaveLength(1);
    expect(h.enables).toBe(1);
    vi.advanceTimersByTime(1_000);
    expect(windows).toEqual([20]);
    expect(m.lastWindow()).toEqual({ meanMs: 2, p99Ms: 10, maxMs: 20, windowSec: 1 });
    // The histogram was reset, so the next window is empty and not reported.
    vi.advanceTimersByTime(1_000);
    expect(windows).toEqual([20]);
    m.stop();
    m.stop();
    vi.advanceTimersByTime(5_000);
    expect(windows).toEqual([20]);
  });

  it('runs without a callback, and rotate() before start() reports nothing', () => {
    vi.useFakeTimers();
    const m = new EventLoopMonitor(() => new Hist());
    expect(m.rotate()).toBeNull();
    m.start();
    vi.advanceTimersByTime(60_000);
    expect(m.lastWindow()?.p99Ms).toBe(10);
    m.stop();
  });

  it('uses Node’s own histogram by default', () => {
    const m = new EventLoopMonitor();
    m.start(60_000);
    expect(() => m.current()).not.toThrow();
    m.stop();
  });
});

describe('Notifier: permissions, failures and many servers', () => {
  const GUILD = '123456789012345678';
  const CHANNEL = '223456789012345678';

  function setup(o: { canSend?: boolean; me?: boolean; fail?: boolean; level?: string } = {}) {
    const { guilds } = memoryDb();
    const sent: string[] = [];
    const fetch = vi.fn(async () => {
      if (o.fail) throw new Error('Missing Access at https://discord.example.com/x?token=abc');
      return {
        isSendable: () => true,
        guild: { id: GUILD, members: { me: o.me === false ? null : { id: 'me' } } },
        permissionsFor: () => ({
          has: (flag: bigint) => flag !== PermissionFlagsBits.SendMessages || o.canSend !== false,
        }),
        send: async (m: { content: string }) => {
          sent.push(m.content);
        },
      };
    });
    const debug = vi.fn();
    // The notifier logs through a child logger; this one records debug calls.
    const child = { debug, isLevelEnabled: (l: string) => l === 'debug' && o.level === 'debug' };
    const logger = { child: () => child } as unknown as Logger;
    const notifier = new Notifier({ channels: { fetch } } as unknown as Client, guilds, logger);
    guilds.updateSettings(GUILD, { notificationChannelId: CHANNEL });
    return { guilds, sent, fetch, notifier, debug };
  }
  const notice = (message: string, guildId = GUILD) =>
    ({ guildId, kind: 'failover', code: null, message }) as const;
  const settle = () => new Promise((r) => setImmediate(r));

  it('checks Send Messages when it can see its own member, and sends without that check otherwise', async () => {
    const blocked = setup({ canSend: false });
    blocked.notifier.notify(notice('x'));
    await settle();
    expect(blocked.fetch).toHaveBeenCalledOnce();
    expect(blocked.sent).toEqual([]);
    const allowed = setup();
    allowed.notifier.notify(notice('Switched.'));
    await settle();
    expect(allowed.sent).toEqual(['📻 Switched.']);
    const unknownMember = setup({ me: false, canSend: false });
    unknownMember.notifier.notify(notice('Anyway.'));
    await settle();
    expect(unknownMember.sent).toEqual(['📻 Anyway.']);
  });

  it('logs an undelivered notice only when debug logging is on, without the URL’s secrets', async () => {
    const quiet = setup({ fail: true, level: 'info' });
    quiet.notifier.notify(notice('x'));
    await settle();
    expect(quiet.debug).not.toHaveBeenCalled();
    const verbose = setup({ fail: true, level: 'debug' });
    verbose.notifier.notify(notice('x'));
    await settle();
    expect(verbose.debug).toHaveBeenCalledOnce();
    const [fields, msg] = verbose.debug.mock.calls[0] as [
      { guildId: string; err: { message: string } },
      string,
    ];
    expect(msg).toBe('notice not delivered');
    expect(fields.guildId).toBe(GUILD);
    expect(fields.err.message).not.toContain('token=abc');
  });

  it('still coalesces repeats after sweeping old entries for many servers', async () => {
    vi.useFakeTimers();
    const t = setup();
    for (let i = 0; i < 1001; i++) t.notifier.notify(notice('old', `9${String(i).padStart(17, '0')}`));
    vi.setSystemTime(Date.now() + 6 * 60_000);
    t.notifier.notify(notice('First.'));
    t.notifier.notify(notice('Repeat.'));
    await vi.advanceTimersByTimeAsync(0);
    expect(t.sent).toEqual(['📻 First.']);
    t.notifier.close();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(t.sent).toEqual(['📻 First.']);
  });
});
