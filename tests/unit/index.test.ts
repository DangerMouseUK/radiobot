import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppConfig } from '../../src/config/env.ts';

/**
 * The entry point runs on import. Each test imports it afresh with the app replaced by a fake,
 * and with process.exit, process.on and stderr observed instead of acting on the test runner.
 */
const fake = vi.hoisted(() => ({
  configs: [] as unknown[],
  start: async (): Promise<void> => {},
  stop: async (_reason: string): Promise<void> => {},
  stops: [] as string[],
  reloads: 0,
}));

vi.mock('../../src/app.ts', () => ({
  createApp: (config: unknown) => {
    fake.configs.push(config);
    return {
      ctx: {},
      start: () => fake.start(),
      stop: (reason: string) => {
        fake.stops.push(reason);
        return fake.stop(reason);
      },
      reloadPacks: async () => {
        fake.reloads++;
      },
    };
  },
}));

let exits: number[];
let stderr: string;
let handlers: Map<string, (...args: unknown[]) => void>;

beforeEach(() => {
  exits = [];
  stderr = '';
  handlers = new Map();
  fake.configs.length = 0;
  fake.stops.length = 0;
  fake.reloads = 0;
  fake.start = async () => {};
  fake.stop = async () => {};
  vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    exits.push(code ?? 0);
  }) as never);
  vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: string) => {
    stderr += chunk;
    return true;
  }) as never);
  const on = process.on.bind(process);
  vi.spyOn(process, 'on').mockImplementation(((event: string, fn: (...args: unknown[]) => void) => {
    if (['SIGTERM', 'SIGINT', 'SIGHUP', 'unhandledRejection', 'uncaughtException'].includes(event)) {
      handlers.set(event, fn);
      return process;
    }
    return on(event as never, fn as never);
  }) as never);
  vi.stubEnv('DISCORD_TOKEN', 'replace-with-your-bot-token');
  vi.stubEnv('DISCORD_APPLICATION_ID', '123456789012345678');
  vi.stubEnv('LOG_LEVEL', 'silent');
  vi.stubEnv('TELEMETRY_ENABLED', 'false');
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

async function runMain(): Promise<void> {
  vi.resetModules();
  await import('../../src/index.ts');
  // main() is async: let it run to its first real wait.
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

describe('entry point', () => {
  it('exits with code 78 on invalid configuration, naming the problem but not the secret', async () => {
    vi.stubEnv('DISCORD_TOKEN', 'short');
    await runMain();
    expect(exits[0]).toBe(78);
    expect(stderr).toMatch(/Invalid configuration:/);
    expect(stderr).toMatch(/DISCORD_TOKEN: is missing or not long enough to be a bot token/);
    expect(stderr).toMatch(/See \.env\.example and docs\/install-docker\.md\./);
    expect(stderr).not.toContain('short');
    expect(fake.configs).toEqual([]);
  });

  it('refuses telemetry with code 78', async () => {
    vi.stubEnv('TELEMETRY_ENABLED', 'true');
    await runMain();
    expect(exits[0]).toBe(78);
    expect(stderr).toMatch(/TELEMETRY_ENABLED=true is not supported/);
  });

  it('starts the app with the loaded configuration and installs signal handlers', async () => {
    let started = false;
    fake.start = async () => {
      started = true;
    };
    await runMain();
    expect(started).toBe(true);
    expect((fake.configs[0] as AppConfig).applicationId).toBe('123456789012345678');
    expect([...handlers.keys()].sort()).toEqual([
      'SIGHUP',
      'SIGINT',
      'SIGTERM',
      'uncaughtException',
      'unhandledRejection',
    ]);
    expect(exits).toEqual([]);
  });

  it('stops the app once on SIGTERM and exits cleanly, ignoring a second signal', async () => {
    let finish!: () => void;
    fake.stop = () => new Promise<void>((resolve) => (finish = resolve));
    await runMain();
    handlers.get('SIGTERM')!();
    handlers.get('SIGINT')!();
    expect(fake.stops).toEqual(['SIGTERM']);
    expect(exits).toEqual([]);
    finish();
    await vi.waitFor(() => expect(exits).toEqual([0]));
  });

  it('reloads the installed station packs on SIGHUP, without stopping', async () => {
    await runMain();
    handlers.get('SIGHUP')!();
    expect(fake.reloads).toBe(1);
    expect(fake.stops).toEqual([]);
    expect(exits).toEqual([]);
  });

  it('stops on SIGINT too', async () => {
    await runMain();
    handlers.get('SIGINT')!();
    await vi.waitFor(() => expect(exits).toEqual([0]));
    expect(fake.stops).toEqual(['SIGINT']);
  });

  it('shuts down with code 1 after an uncaught exception', async () => {
    await runMain();
    handlers.get('uncaughtException')!(new Error('boom'));
    await vi.waitFor(() => expect(exits).toEqual([1]));
    expect(fake.stops).toEqual(['uncaughtException']);
  });

  it('forces an exit if shutdown hangs for 10 s', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    fake.stop = () => new Promise<void>(() => {});
    await runMain();
    handlers.get('SIGTERM')!();
    await vi.advanceTimersByTimeAsync(9_999);
    expect(exits).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(exits).toEqual([1]);
  });

  it('logs unhandled rejections without exiting', async () => {
    await runMain();
    expect(() => handlers.get('unhandledRejection')!(new Error('late failure'))).not.toThrow();
    expect(exits).toEqual([]);
  });

  it('reports a failed start as fatal with code 1', async () => {
    fake.start = async () => {
      throw new Error('An invalid token was provided.');
    };
    await runMain();
    await vi.waitFor(() => expect(exits).toEqual([1]));
    expect(stderr).toBe('Fatal: An invalid token was provided.\n');
  });

  it('reports a non-Error failure as fatal too', async () => {
    fake.start = () => Promise.reject('gateway closed');
    await runMain();
    await vi.waitFor(() => expect(exits).toEqual([1]));
    expect(stderr).toBe('Fatal: gateway closed\n');
  });
});
