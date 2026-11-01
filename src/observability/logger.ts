import { type Logger, pino } from 'pino';
import { redactText } from '../shared/redact.ts';

export type { Logger };

/**
 * Structured JSON logger with redaction of known secret-bearing fields. Free-text
 * messages are additionally scrubbed by `safeErr` before being attached.
 */
export function createLogger(level: string, secrets: readonly string[] = []): Logger {
  return pino({
    level,
    base: { app: 'radio-bot' },
    timestamp: pino.stdTimeFunctions.isoTime,
    redact: {
      paths: [
        'token',
        '*.token',
        'discordToken',
        '*.discordToken',
        'url',
        '*.url',
        'streamUrl',
        '*.streamUrl',
        'headers.authorization',
        '*.headers.authorization',
        'headers.cookie',
        '*.headers.cookie',
      ],
      censor: '[redacted]',
    },
    formatters: {
      level: (label) => ({ level: label }),
    },
    hooks: {
      logMethod(args, method) {
        const scrubbed = args.map((a) => (typeof a === 'string' ? redactText(a, secrets) : a));
        method.apply(this, scrubbed as Parameters<typeof method>);
      },
    },
  });
}

/** Serialises an error for logs without leaking URLs or tokens in its message/stack. */
export function safeErr(err: unknown, secrets: readonly string[] = []): Record<string, unknown> {
  if (err instanceof Error) {
    const out: Record<string, unknown> = {
      type: err.name,
      message: redactText(err.message, secrets),
    };
    if ('code' in err && typeof (err as { code: unknown }).code === 'string') {
      out.code = (err as { code: string }).code;
    }
    if (err.stack) out.stack = redactText(err.stack, secrets);
    return out;
  }
  return { message: redactText(String(err), secrets) };
}
