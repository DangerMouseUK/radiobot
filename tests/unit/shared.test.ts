import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { KeyedSemaphore, linkedSignal, Semaphore } from '../../src/shared/async.ts';
import { backoffDelayMs, cooldownMs } from '../../src/shared/backoff.ts';
import { errorCode, errorMessage, isRadioError, RadioError } from '../../src/shared/errors.ts';
import { projectRoot, rootPath } from '../../src/shared/paths.ts';
import { RateLimiter } from '../../src/shared/rate-limit.ts';
import { redactText, redactUrl, urlHost } from '../../src/shared/redact.ts';
import {
  levenshtein,
  MAX_SLUG_LENGTH,
  normalizeName,
  similarity,
  slugify,
  truncate,
} from '../../src/shared/text.ts';

describe('Semaphore', () => {
  it('grants up to its size at once and serves waiters first-in, first-out', async () => {
    const sem = new Semaphore(2);
    const r1 = await sem.acquire();
    await sem.acquire();
    expect(sem.inUse).toBe(2);
    const order: string[] = [];
    const a = sem.acquire().then((release) => {
      order.push('a');
      return release;
    });
    const b = sem.acquire().then((release) => {
      order.push('b');
      return release;
    });
    expect(sem.waiting).toBe(2);
    r1();
    const ra = await a;
    expect(order).toEqual(['a']);
    ra();
    await b;
    expect(order).toEqual(['a', 'b']);
    expect(sem.waiting).toBe(0);
  });

  it('ignores a second release of the same grant', async () => {
    const sem = new Semaphore(1);
    const release = await sem.acquire();
    release();
    release();
    expect(sem.inUse).toBe(0);
    await sem.acquire();
    expect(sem.inUse).toBe(1);
  });

  it('cancels a waiting acquire on abort and drops it from the queue', async () => {
    const sem = new Semaphore(1);
    const release = await sem.acquire();
    const abort = new AbortController();
    const waiting = sem.acquire(abort.signal);
    expect(sem.waiting).toBe(1);
    abort.abort();
    await expect(waiting).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(sem.waiting).toBe(0);
    release();
    expect(sem.inUse).toBe(0);
  });

  it('rejects at once when the signal is already aborted and no slot is free', async () => {
    const sem = new Semaphore(1);
    await sem.acquire();
    await expect(sem.acquire(AbortSignal.abort())).rejects.toBeInstanceOf(RadioError);
    expect(sem.waiting).toBe(0);
  });

  it('releases the slot when the guarded work throws', async () => {
    const sem = new Semaphore(1);
    await expect(
      sem.run(async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(sem.inUse).toBe(0);
    expect(await sem.run(async () => 42)).toBe(42);
  });
});

describe('KeyedSemaphore', () => {
  it('serialises work per key while other keys run in parallel', async () => {
    const keyed = new KeyedSemaphore(1);
    const log: string[] = [];
    let releaseA!: () => void;
    const gate = new Promise<void>((r) => {
      releaseA = r;
    });
    const a1 = keyed.run('a', async () => {
      log.push('a1 start');
      await gate;
      log.push('a1 end');
    });
    const a2 = keyed.run('a', async () => {
      log.push('a2');
    });
    await keyed.run('b', async () => {
      log.push('b');
    });
    expect(log).toEqual(['a1 start', 'b']);
    releaseA();
    await Promise.all([a1, a2]);
    expect(log).toEqual(['a1 start', 'b', 'a1 end', 'a2']);
  });
});

describe('linkedSignal', () => {
  it('returns a never-aborting signal when nothing is linked', () => {
    expect(linkedSignal(null).aborted).toBe(false);
  });

  it('passes a single signal through unchanged', () => {
    const c = new AbortController();
    expect(linkedSignal(null, undefined, c.signal)).toBe(c.signal);
  });

  it('aborts when any linked signal aborts', () => {
    const a = new AbortController();
    const b = new AbortController();
    const linked = linkedSignal(null, a.signal, b.signal);
    expect(linked.aborted).toBe(false);
    b.abort();
    expect(linked.aborted).toBe(true);
  });

  it('aborts when the timeout elapses', async () => {
    const linked = linkedSignal(5);
    await new Promise((r) => linked.addEventListener('abort', r, { once: true }));
    expect(linked.aborted).toBe(true);
  });
});

describe('errors', () => {
  it('carries a reason code and a user-safe message', () => {
    const cause = new Error('socket hang up');
    const err = new RadioError('HTTP_TIMEOUT', 'The stream did not answer.', { cause });
    expect(err.message).toBe('HTTP_TIMEOUT: The stream did not answer.');
    expect(err.userMessage).toBe('The stream did not answer.');
    expect(err.cause).toBe(cause);
    expect(err.name).toBe('RadioError');
    expect(isRadioError(err)).toBe(true);
    expect(errorCode(err)).toBe('HTTP_TIMEOUT');
  });

  it('maps anything else to INTERNAL and stringifies non-errors', () => {
    expect(isRadioError(new Error('x'))).toBe(false);
    expect(errorCode(new Error('x'))).toBe('INTERNAL');
    expect(errorCode('nope')).toBe('INTERNAL');
    expect(errorMessage(new Error('plain'))).toBe('plain');
    expect(errorMessage(42)).toBe('42');
  });
});

describe('text helpers', () => {
  it('normalises names for matching (case, diacritics, ampersands, apostrophes, punctuation)', () => {
    expect(normalizeName('  FG Chic & Chill ')).toBe('fg chic and chill');
    expect(normalizeName("MAXXIMUM 90's")).toBe('maxximum 90s');
    expect(normalizeName('FG HÏ IBIZA')).toBe('fg hi ibiza');
    expect(normalizeName('R&B / Soul!')).toBe('r and b soul');
    expect(normalizeName('---')).toBe('');
  });

  it('caps slugs at 64 characters', () => {
    expect(slugify('a'.repeat(100))).toHaveLength(MAX_SLUG_LENGTH - 4);
    expect(slugify('FG RnB LEGENDS')).toBe('fg-rnb-legends');
  });

  it('computes edit distance and a normalised similarity', () => {
    expect(levenshtein('kitten', 'sitting')).toBe(3);
    expect(levenshtein('', 'abc')).toBe(3);
    expect(levenshtein('abc', '')).toBe(3);
    expect(levenshtein('same', 'same')).toBe(0);
    expect(similarity('FG Techno', 'fg techno')).toBe(1);
    expect(similarity('', '')).toBe(1);
    expect(similarity('abcd', 'abcx')).toBeCloseTo(0.75);
  });

  it('truncates with an ellipsis and never exceeds the limit', () => {
    expect(truncate('short', 10)).toBe('short');
    expect(truncate('exactly10!', 10)).toBe('exactly10!');
    const t = truncate('a much longer piece of text', 10);
    expect(t).toHaveLength(10);
    expect(t.endsWith('…')).toBe(true);
  });

  it('never cuts an emoji in half', () => {
    expect(truncate(`${'a'.repeat(8)}🎵🎵🎵`, 10)).toBe(`${'a'.repeat(8)}…`);
    expect(truncate(`${'a'.repeat(7)}🎵🎵🎵`, 10)).toBe(`${'a'.repeat(7)}🎵…`);
  });
});

describe('redaction', () => {
  it('collapses sensitive query parameter names and masks every other value', () => {
    expect(redactUrl('https://cdn.example.com/live.mp3?sig=abc&expires=1&listener=7')).toBe(
      'https://cdn.example.com/live.mp3?***&***&listener=***',
    );
  });

  it('keeps plain URLs intact apart from userinfo and fragments', () => {
    expect(redactUrl('https://user:pw@radio.example.org:8443/stream#x')).toBe(
      'https://radio.example.org:8443/stream',
    );
    expect(redactUrl(new URL('https://radio.example.org/a'))).toBe('https://radio.example.org/a');
  });

  it('handles empty and invalid input', () => {
    expect(redactUrl('')).toBe('');
    expect(redactUrl(null)).toBe('');
    expect(redactUrl('not a url')).toBe('[invalid-url]');
    expect(urlHost('https://a.example.com:8000/x?y=1')).toBe('a.example.com:8000');
    expect(urlHost('nope')).toBe('[invalid-url]');
    expect(urlHost(undefined)).toBe('');
  });

  it('scrubs configured secrets of six or more characters only', () => {
    expect(redactText('token hunter2x leaked', ['hunter2x'])).toBe('token [redacted] leaked');
    expect(redactText('id abc stays', ['abc'])).toBe('id abc stays');
    expect(redactText('nothing here', [''])).toBe('nothing here');
  });
});

describe('rate limiter', () => {
  it('keeps keys independent and reports how long to wait', () => {
    let t = 0;
    const l = RateLimiter.perWindow(1, 1024, () => t);
    expect(l.take('a')).toBe(0);
    expect(l.take('b')).toBe(0);
    expect(l.take('a')).toBe(1024);
    t = 256;
    expect(l.take('a')).toBe(768);
  });

  it('sweeps only buckets that have refilled', () => {
    let t = 0;
    const l = RateLimiter.perWindow(2, 1024, () => t);
    l.take('busy');
    l.take('idle');
    expect(l.size).toBe(2);
    t = 512;
    l.take('busy');
    l.sweep();
    expect(l.size).toBe(1);
    t = 1024;
    l.sweep();
    expect(l.size).toBe(0);
  });
});

describe('backoff', () => {
  it('clamps the attempt index to the schedule', () => {
    const mid = () => 0.5;
    expect(backoffDelayMs(-3, undefined, 0.25, mid)).toBe(1000);
    expect(backoffDelayMs(1, undefined, 0.25, mid)).toBe(3000);
    expect(backoffDelayMs(99, undefined, 0.25, mid)).toBe(8000);
    expect(backoffDelayMs(0, [200, 400], 0, Math.random)).toBe(200);
  });

  it('keeps jitter within the ratio and never goes negative', () => {
    expect(backoffDelayMs(0, undefined, 0.25, () => 0)).toBe(750);
    expect(backoffDelayMs(0, undefined, 0.25, () => 1)).toBe(1250);
    expect(backoffDelayMs(0, [100], 2, () => 0)).toBe(0);
  });

  it('doubles the cooldown per trip up to two hours', () => {
    expect(cooldownMs(0)).toBe(600_000);
    expect(cooldownMs(2)).toBe(1_200_000);
    expect(cooldownMs(3)).toBe(2_400_000);
    expect(cooldownMs(4)).toBe(4_800_000);
    expect(cooldownMs(5)).toBe(7_200_000);
  });
});

describe('project paths', () => {
  it('finds the repository root from the source tree', () => {
    const root = projectRoot();
    expect(existsSync(join(root, 'package.json'))).toBe(true);
    expect(existsSync(join(root, 'migrations'))).toBe(true);
    expect(rootPath('catalog', 'packs')).toBe(join(root, 'catalog', 'packs'));
  });
});
