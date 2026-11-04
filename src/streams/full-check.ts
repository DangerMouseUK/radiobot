import type { Station, StationSource } from '../catalogue/types.ts';
import type { Logger } from '../observability/logger.ts';
import type { StationRepository } from '../persistence/repositories/stations.ts';
import { timeSlicer } from '../shared/async.ts';
import { errorCode } from '../shared/errors.ts';
import { checkEligibility } from './ranking.ts';
import type { ProbeReport } from './source-service.ts';

/** How a full re-check stands: running, or how the last one ended. */
export interface FullCheckState {
  status: 'running' | 'finished' | 'stopped';
  /** ms since the epoch. */
  startedAt: number;
  finishedAt: number | null;
  /** Sources to check, and how many have had their turn so far. */
  total: number;
  done: number;
  /** Can be used now, after their check. */
  usable: number;
  /** …of which could not be used before it. */
  newlyUsable: number;
  /** Their check failed (their back-off and pause carry on). */
  failed: number;
  /** Played, but can't be used yet (their identity isn't confirmed, say). */
  unconfirmed: number;
  /** Playing somewhere, so left alone: steady playback already shows they work. */
  playing: number;
  /** Not checked: removed or switched off during the run, or a play kept needing their host. */
  skipped: number;
}

export interface FullCheckDeps {
  stations: StationRepository;
  sources: {
    sourcesFor(stationId: string): StationSource[];
    checkable(s: StationSource): boolean;
    checkInBackground(
      sourceId: string,
      signal: AbortSignal,
      want: (s: StationSource) => boolean,
    ): Promise<{ before: StationSource; report: ProbeReport } | null>;
  };
  /** Whether a station's pack is loaded and switched on (custom stations are never included). */
  packEnabled: (provider: string) => boolean;
  /** Whether a source is playing in any server right now. */
  playing: (sourceId: string) => boolean;
  logger: Logger;
  now?: () => number;
}

/** A check that gave way to a play this many times is skipped, so one busy host can't stall the run. */
const MAX_GAVE_WAY = 3;

/**
 * "Check all sources again" (the bot owner's, for the whole installation): every enabled source of
 * every switched-on station pack is checked once more, ignoring its back-off, hold and pause. Each
 * check goes through the source service's background queue, so it runs one at a time at the lowest
 * priority and waits while any stream starts. Only one runs at a time; `stop()` ends it cleanly.
 * Sources a pack ships switched off, the owner's kill switches and custom stations are left out.
 */
export class FullSourceCheck {
  readonly #d: FullCheckDeps;
  readonly #log: Logger;
  #state: FullCheckState | null = null;
  #abort: AbortController | null = null;
  #run: Promise<void> | null = null;

  constructor(deps: FullCheckDeps) {
    this.#d = deps;
    this.#log = deps.logger.child({ component: 'full-check' });
  }

  #now(): number {
    return this.#d.now?.() ?? Date.now();
  }

  /** The run in progress, or the last one (null if none since start-up). A copy. */
  get state(): FullCheckState | null {
    return this.#state ? { ...this.#state } : null;
  }

  get running(): boolean {
    return this.#run !== null;
  }

  /**
   * Starts a full re-check, or returns null if one is already running. `onProgress` hears after
   * each source has had its turn, and once more at the end.
   */
  start(onProgress?: (s: FullCheckState) => void): FullCheckState | null {
    if (this.#run) return null;
    const abort = new AbortController();
    const state: FullCheckState = {
      status: 'running',
      startedAt: this.#now(),
      finishedAt: null,
      total: 0,
      done: 0,
      usable: 0,
      newlyUsable: 0,
      failed: 0,
      unconfirmed: 0,
      playing: 0,
      skipped: 0,
    };
    this.#state = state;
    this.#abort = abort;
    const notify = () => {
      try {
        onProgress?.({ ...state });
      } catch {
        /* a listener's problem never stops the run */
      }
    };
    this.#run = this.#execute(state, abort.signal, notify)
      .catch((err: unknown) => this.#log.warn({ code: errorCode(err) }, 'full source check failed'))
      .finally(() => {
        state.status = abort.signal.aborted ? 'stopped' : 'finished';
        state.finishedAt = this.#now();
        this.#run = null;
        this.#abort = null;
        this.#log.info({ ...state }, 'full source check ended');
        notify();
      });
    return { ...state };
  }

  /** Stops the run (Stop button, shutdown) and waits for it to end. Nothing half-done is recorded. */
  async stop(): Promise<void> {
    this.#abort?.abort();
    await this.#run;
  }

  /** Source IDs to check, gathered in slices so the main thread is never held for long. */
  async #targets(signal: AbortSignal): Promise<string[]> {
    // Short slices: on a 1-vCPU host the same work takes several times as long as on a desktop.
    const slice = timeSlicer(2);
    const ids: string[] = [];
    for (const st of this.#d.stations.listBuiltinStations()) {
      await slice();
      if (signal.aborted) break;
      if (!this.#included(st)) continue;
      for (const s of this.#d.sources.sourcesFor(st.id)) if (this.#d.sources.checkable(s)) ids.push(s.id);
    }
    return ids;
  }

  #included(st: Station | null): boolean {
    return (
      st !== null &&
      st.provider !== 'custom' &&
      st.catalogueStatus !== 'retired' &&
      this.#d.packEnabled(st.provider)
    );
  }

  async #execute(state: FullCheckState, signal: AbortSignal, notify: () => void): Promise<void> {
    const ids = await this.#targets(signal);
    state.total = ids.length;
    this.#log.info({ sources: ids.length }, 'full source check started');
    notify();
    for (const id of ids) {
      const r = signal.aborted ? null : await this.#checkOne(id, signal);
      if (r === null) return;
      this.#count(state, r);
      state.done++;
      notify();
    }
  }

  async #checkOne(
    id: string,
    signal: AbortSignal,
  ): Promise<{ before: StationSource; report: ProbeReport } | 'playing' | 'skipped' | null> {
    for (let attempt = 0; attempt < MAX_GAVE_WAY; attempt++) {
      let playing = false;
      try {
        const r = await this.#d.sources.checkInBackground(id, signal, (s) => {
          if (!this.#included(this.#d.stations.getStation(s.stationId))) return false;
          // A second connection to a stream that plays proves nothing, and some stations refuse it.
          playing = this.#d.playing(s.id);
          return !playing;
        });
        return r ?? (playing ? 'playing' : 'skipped');
      } catch (err) {
        if (signal.aborted) return null;
        // CANCELLED: it gave way to a play on the same host; try it again at its next turn.
        if (errorCode(err) !== 'CANCELLED') {
          this.#log.debug({ sourceId: id, code: errorCode(err) }, 'full check of a source failed');
          return 'skipped';
        }
      }
    }
    return 'skipped';
  }

  #count(
    state: FullCheckState,
    r: { before: StationSource; report: ProbeReport } | 'playing' | 'skipped' | null,
  ): void {
    if (r === null) return;
    if (r === 'playing') state.playing++;
    else if (r === 'skipped') state.skipped++;
    else if (!r.report.outcome.success) state.failed++;
    else {
      const now = this.#now();
      if (checkEligibility(r.report.source, now).eligible) {
        state.usable++;
        if (!checkEligibility(r.before, now).eligible) state.newlyUsable++;
      } else state.unconfirmed++;
    }
  }
}
