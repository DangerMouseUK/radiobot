import type { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { type Readable, Transform } from 'node:stream';
import { RateMeter } from '../observability/netstats.ts';
import { isRadioError, RadioError } from '../shared/errors.ts';
import type { NowPlayingMeta, SourceInput } from '../streams/input.ts';
import { buildEncodeArgs, type EncoderPlan } from './encoder.ts';
import { type ProcessRegistry, StderrTail, spawnTracked, terminate } from './ffmpeg.ts';

export interface PipelineStats {
  startedAt: number;
  firstOutputAt: number | null;
  lastOutputAt: number | null;
  outputBytes: number;
  inputBytes: number;
  pid: number | null;
  /** Rolling byte-rate meters (live kbps over recent seconds). */
  inputRate?: RateMeter;
  outputRate?: RateMeter;
}

export interface PipelineEvents {
  failed: [RadioError];
  metadata: [NowPlayingMeta | null];
  firstAudio: [];
}

/**
 * One authoritative FFmpeg process per active guild session: source bytes in on stdin,
 * Ogg Opus out on stdout (exactly one lossy encode). Emits `failed` once on any fault.
 */
export class AudioPipeline extends EventEmitter<PipelineEvents> {
  readonly input: SourceInput;
  readonly plan: EncoderPlan;
  readonly output: Readable;
  readonly stats: PipelineStats;
  readonly #child: ChildProcess;
  readonly #stderr = new StderrTail();
  #stopped = false;
  #failed = false;

  constructor(
    input: SourceInput,
    plan: EncoderPlan,
    deps: { registry: ProcessRegistry; ffmpegPath: string; owner: string },
  ) {
    super();
    this.input = input;
    this.plan = plan;
    this.stats = {
      startedAt: Date.now(),
      firstOutputAt: null,
      lastOutputAt: null,
      outputBytes: 0,
      inputBytes: 0,
      pid: null,
      inputRate: new RateMeter(60),
      outputRate: new RateMeter(60),
    };
    this.#child = spawnTracked(deps.registry, deps.ffmpegPath, buildEncodeArgs(plan), deps.owner, 'encoder');
    this.stats.pid = this.#child.pid ?? null;

    // Observes encoder output (progress watchdog) while passing it through untouched.
    const counter = new Transform({
      highWaterMark: 64 * 1024,
      transform: (chunk: Buffer, _enc, cb) => {
        const now = Date.now();
        this.stats.outputBytes += chunk.length;
        this.stats.outputRate?.add(chunk.length);
        this.stats.lastOutputAt = now;
        if (this.stats.firstOutputAt === null) {
          this.stats.firstOutputAt = now;
          this.emit('firstAudio');
        }
        cb(null, chunk);
      },
    });
    this.output = counter;

    this.#child.stdout!.pipe(counter);
    this.#child.stderr!.on('data', (c: Buffer) => this.#stderr.push(c));
    this.#child.stdin!.on('error', () => {
      /* EPIPE on teardown is expected */
    });
    this.#child.on('error', (err) =>
      this.#fail(new RadioError('FFMPEG_SPAWN', 'FFmpeg could not be started.', { cause: err })),
    );
    this.#child.on('exit', (code, signal) => {
      if (this.#stopped) return;
      if (code === 0) this.#fail(new RadioError('STREAM_EOF', 'The station stream ended.'));
      else {
        const tail = this.#stderr.lines().slice(-3).join(' | ');
        this.#fail(
          new RadioError(
            'FFMPEG_EXIT',
            `The audio encoder stopped (${signal ?? `exit ${code}`}).${tail ? ` ${tail}` : ''}`,
          ),
        );
      }
    });

    input.stream.on('data', (c: Buffer) => {
      this.stats.inputBytes += c.length;
      this.stats.inputRate?.add(c.length);
    });
    input.stream.on('error', (err) => {
      this.#fail(
        isRadioError(err)
          ? err
          : new RadioError('HTTP_ERROR', 'The station connection failed.', { cause: err }),
      );
    });
    input.stream.on('end', () => {
      // Live radio should never end; an end is an upstream EOF.
      if (!this.#stopped) this.#child.stdin?.end();
    });
    input.on('metadata', (m) => this.emit('metadata', m));
    input.stream.pipe(this.#child.stdin!);
  }

  get stderrTail(): string[] {
    return this.#stderr.lines().slice(-10);
  }

  #fail(err: RadioError): void {
    if (this.#failed || this.#stopped) return;
    this.#failed = true;
    this.emit('failed', err);
  }

  /** Idempotent teardown: closes the network input, the pipes, and reaps FFmpeg. */
  stop(): void {
    if (this.#stopped) return;
    this.#stopped = true;
    this.input.close();
    this.#child.stdin?.destroy();
    this.#child.stdout?.unpipe();
    this.output.destroy();
    terminate(this.#child);
    this.removeAllListeners();
  }

  get stopped(): boolean {
    return this.#stopped;
  }
}
