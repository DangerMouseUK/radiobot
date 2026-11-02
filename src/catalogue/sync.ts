import type { Logger } from '../observability/logger.ts';
import type { MetaRepository } from '../persistence/repositories/guilds.ts';
import type { StationRepository } from '../persistence/repositories/stations.ts';
import { Semaphore, timeSlicer, yieldToEventLoop } from '../shared/async.ts';
import { errorMessage, RadioError } from '../shared/errors.ts';
import { redactText } from '../shared/redact.ts';
import { normalizedSimilarity, normalizeName, slugify } from '../shared/text.ts';
import { ownBuffer, runWorker, siblingModule } from '../shared/workers.ts';
import type { SafeHttpClient } from '../streams/safe-fetch.ts';
import type { PackRegistry, StationPack } from './packs.ts';
import { type OfficialEntry, type ParseReply, type ParseRequest, SYNC_ADAPTERS } from './sync-adapters.ts';
import type { Station } from './types.ts';

export interface SyncReport {
  packId: string;
  packName: string;
  ok: boolean;
  checkedAt: string;
  error: string | null;
  officialCount: number;
  added: string[];
  renamed: Array<{ from: string; to: string }>;
  missing: string[];
  returned: string[];
  unchanged: number;
  needsSourceMapping: string[];
  /** Stations whose every enabled source failed its last probe (from local evidence). */
  unreachable: string[];
}

/** The largest official list page fetched. */
const MAX_LIST_BYTES = 6 * 1024 * 1024;
/** A list with more names than this is not a station group's list; it is refused. */
export const MAX_OFFICIAL_ENTRIES = 5000;
/**
 * Longest stretch of synchronous work in a sync before the event loop gets a turn. Small, because a
 * slice overruns by up to one step plus a commit; a sync takes no longer for it.
 */
const SLICE_MS = 2;
/**
 * Most changes written in one transaction (about 2 ms of writes here). A day's changes to a
 * station group's list are a handful, so a sync is normally written all or nothing.
 */
const WRITE_BATCH = 50;

/** Turns the fetched bytes of an official list into names and IDs, off the main thread. */
export type OfficialListParser = (
  adapter: string,
  bytes: Uint8Array,
  signal?: AbortSignal,
) => Promise<OfficialEntry[]>;

/**
 * Runs the pack's adapter on a worker thread. A list page can be megabytes of HTML and JSON:
 * decoding and parsing it takes tens of milliseconds, which on the main thread would delay voice
 * packets. The bytes are handed over to the worker (a large buffer is moved, not copied, so it
 * can't be used afterwards) and only the names and IDs come back.
 */
export const parseOfficialListInWorker: OfficialListParser = async (adapter, bytes, signal) => {
  const reply = await runWorker<ParseReply>(
    siblingModule(import.meta.url, 'sync-parse-worker'),
    { adapter, bytes, maxEntries: MAX_OFFICIAL_ENTRIES } satisfies ParseRequest,
    {
      timeoutMs: 20_000,
      signal,
      // Parsing 6 MB of JSON needs a few tens of MB; the worker is gone as soon as it answers.
      resourceLimits: { maxOldGenerationSizeMb: 128, stackSizeMb: 4 },
      transfer: ownBuffer(bytes),
    },
  );
  if (!reply.ok) throw new Error(reply.error);
  return reply.entries;
};

export interface CatalogueSyncOptions {
  parse?: OfficialListParser;
  /** The clock that decides when a long stretch of work gives the event loop a turn. */
  now?: () => number;
  sliceMs?: number;
  /** Most changes written in one transaction. */
  batchSize?: number;
}

/** One change a sync makes: `write` runs inside a transaction, `record` once that has committed. */
interface SyncStep {
  write(): void;
  record(report: SyncReport): void;
}

/**
 * Reconciles packs that declare an official list (`sync` in pack.json) with that list
 * (FR-002). Generic: the only pack-specific part is the adapter that reads the list.
 * Conservative: a failed or implausible fetch changes nothing.
 *
 * Kind to the voice thread: the list is fetched through `SafeHttpClient` and parsed on a worker
 * thread; matching it against the catalogue runs in short slices; and the changes are written in
 * one short transaction (several only for a very large change). One sync runs at a time.
 */
export class CatalogueSync {
  readonly #repo: StationRepository;
  readonly #meta: MetaRepository;
  readonly #http: SafeHttpClient;
  readonly #packs: PackRegistry;
  readonly #log: Logger;
  readonly #parse: OfficialListParser;
  readonly #now: () => number;
  readonly #sliceMs: number;
  readonly #batchSize: number;
  readonly #oneAtATime = new Semaphore(1);

  constructor(
    repo: StationRepository,
    meta: MetaRepository,
    http: SafeHttpClient,
    packs: PackRegistry,
    logger: Logger,
    opts: CatalogueSyncOptions = {},
  ) {
    this.#repo = repo;
    this.#meta = meta;
    this.#http = http;
    this.#packs = packs;
    this.#log = logger.child({ component: 'catalogue-sync' });
    this.#parse = opts.parse ?? parseOfficialListInWorker;
    this.#now = opts.now ?? (() => performance.now());
    this.#sliceMs = opts.sliceMs ?? SLICE_MS;
    this.#batchSize = Math.max(1, opts.batchSize ?? WRITE_BATCH);
  }

  /** Enabled packs that have an official list to reconcile with. */
  syncablePacks(): StationPack[] {
    return this.#packs.enabledPacks().filter((p) => p.meta.sync !== null);
  }

  lastSync(packId: string): { at: string | null; ok: boolean } {
    const at = this.#repo.lastSuccessfulSync(packId);
    const last = this.#repo.lastSyncReport(packId);
    return { at, ok: last?.success ?? false };
  }

  /** True when the last successful sync is older than 3× the interval. */
  isStale(packId: string, intervalHours: number): boolean {
    const at = this.#repo.lastSuccessfulSync(packId);
    if (!at) return true;
    return Date.now() - Date.parse(at) > 3 * intervalHours * 3_600_000;
  }

  async syncAll(trigger: 'scheduled' | 'admin' | 'startup', signal?: AbortSignal): Promise<SyncReport[]> {
    const reports: SyncReport[] = [];
    for (const pack of this.syncablePacks()) reports.push(await this.sync(pack.meta.id, trigger, signal));
    return reports;
  }

  /** Syncs one pack; a sync already running (for any pack) finishes first. */
  sync(
    packId: string,
    trigger: 'scheduled' | 'admin' | 'startup',
    signal?: AbortSignal,
  ): Promise<SyncReport> {
    return this.#oneAtATime.run(() => this.#sync(packId, trigger, signal));
  }

  async #sync(
    packId: string,
    trigger: 'scheduled' | 'admin' | 'startup',
    signal?: AbortSignal,
  ): Promise<SyncReport> {
    const pack = this.#packs.get(packId);
    const startedAt = new Date().toISOString();
    const report: SyncReport = {
      packId,
      packName: pack?.meta.name ?? packId,
      ok: false,
      checkedAt: startedAt,
      error: null,
      officialCount: 0,
      added: [],
      renamed: [],
      missing: [],
      returned: [],
      unchanged: 0,
      needsSourceMapping: [],
      unreachable: [],
    };
    try {
      if (!pack?.meta.sync) throw new RadioError('INTERNAL', 'This pack has no official list to sync with.');
      if (!SYNC_ADAPTERS[pack.meta.sync.adapter])
        throw new RadioError('INTERNAL', `Unknown sync adapter "${pack.meta.sync.adapter}".`);
      const { bytes } = await this.#http.fetchBytes(pack.meta.sync.url, {
        maxBytes: MAX_LIST_BYTES,
        totalTimeoutMs: 20_000,
        signal,
        headers: { accept: 'text/html,application/json' },
      });
      const entries = await this.#parse(pack.meta.sync.adapter, bytes, signal);
      // A list that suddenly shrinks to a handful of names is far more likely a broken page than
      // a real change; refuse to apply it. One that runs to thousands isn't a station list either.
      const floor = Math.min(10, Math.max(1, Math.floor(pack.stations.length / 2)));
      if (entries.length < floor || entries.length > MAX_OFFICIAL_ENTRIES) {
        throw new RadioError(
          'PLAYLIST_INVALID',
          `The official list did not look right (it had ${entries.length > MAX_OFFICIAL_ENTRIES ? 'too many' : entries.length} names), so nothing was changed.`,
        );
      }
      report.officialCount = entries.length;
      const slice = timeSlicer(this.#sliceMs, this.#now);
      const steps = await this.#plan(packId, entries, slice, signal);
      await this.#write(steps, report, signal);
      const unreachable: string[] = [];
      for (const st of this.#repo.listProviderStations(packId)) {
        await slice();
        const probed = this.#repo.listSources(st.id).filter((s) => s.enabled && s.lastProbeAt !== null);
        if (probed.length > 0 && probed.every((s) => s.verificationState === 'offline'))
          unreachable.push(st.displayName);
      }
      report.unreachable = unreachable;
      report.ok = true;
      this.#log.info(
        {
          packId,
          added: report.added.length,
          renamed: report.renamed.length,
          missing: report.missing.length,
        },
        'catalogue synced',
      );
    } catch (err) {
      // Redacted before it is logged or stored: an error can quote a URL with a token in it.
      report.error = redactText(err instanceof RadioError ? err.userMessage : errorMessage(err));
      this.#log.warn({ packId, error: report.error }, 'catalogue sync failed; keeping existing entries');
    }
    this.#repo.insertSyncReport({
      provider: packId,
      startedAt,
      finishedAt: new Date().toISOString(),
      success: report.ok,
      trigger,
      summary: report,
    });
    this.#meta.set(`catalogue.${packId}.lastSyncAttempt`, startedAt);
    return report;
  }

  /**
   * Works out the changes without writing anything, giving the event loop a turn every few
   * milliseconds: comparing new names with missing ones grows with both lists.
   */
  async #plan(
    packId: string,
    entries: OfficialEntry[],
    slice: () => Promise<void>,
    signal?: AbortSignal,
  ): Promise<SyncStep[]> {
    const repo = this.#repo;
    const today = new Date().toISOString().slice(0, 10);
    const existing = repo.listProviderStations(packId);
    const byExternal = new Map<string, Station>();
    const byName = new Map<string, Station>();
    for (const s of existing) {
      await slice();
      if (s.externalId) byExternal.set(s.externalId, s);
      byName.set(normalizeName(s.displayName), s);
    }
    // Stations on the list are marked active and seen today in a single statement, the first step:
    // the daily sync of an unchanged list is that one write.
    const seenToday: string[] = [];
    const returned: string[] = [];
    let unchanged = 0;
    const steps: SyncStep[] = [
      {
        write: () => repo.markSeen(seenToday, today),
        record: (r) => {
          r.returned.push(...returned);
          r.unchanged += unchanged;
        },
      },
    ];
    const seen = new Set<string>();
    const unmatched: Array<{ e: OfficialEntry; index: number }> = [];
    for (const [index, e] of entries.entries()) {
      await slice();
      const match = (e.externalId && byExternal.get(e.externalId)) || byName.get(normalizeName(e.name));
      if (!match) {
        unmatched.push({ e, index });
        continue;
      }
      seen.add(match.id);
      if (
        match.catalogueStatus !== 'retired' &&
        (match.catalogueStatus !== 'active' || match.officialLastSeenAt?.slice(0, 10) !== today)
      )
        seenToday.push(match.id);
      if (match.catalogueStatus === 'missing_from_official') returned.push(e.name);
      if (match.displayName === e.name) unchanged++;
      if (match.displayName !== e.name && normalizeName(match.displayName) !== normalizeName(e.name)) {
        steps.push({
          write: () => repo.renameStation(match.id, e.name, true),
          record: (r) => r.renamed.push({ from: match.displayName, to: e.name }),
        });
      }
    }
    const missingNow = existing.filter((s) => !seen.has(s.id) && s.catalogueStatus === 'active');
    // Normalised once: comparing every new name with every missing one would otherwise
    // normalise both names again for each pair.
    const missingNames = new Map(missingNow.map((s) => [s, normalizeName(s.displayName)]));
    for (const { e, index } of unmatched) {
      if (signal?.aborted) throw new RadioError('CANCELLED', 'The sync was cancelled.');
      // Name changed and no stable ID: accept a rename only for one clearly similar missing entry.
      const name = normalizeName(e.name);
      const similar: Array<{ s: Station; sim: number }> = [];
      for (const s of missingNow) {
        await slice();
        const sim = normalizedSimilarity(missingNames.get(s)!, name);
        if (sim >= 0.8) similar.push({ s, sim });
      }
      similar.sort((a, b) => b.sim - a.sim);
      if (similar.length === 1 || (similar.length > 1 && similar[0]!.sim - similar[1]!.sim > 0.1)) {
        const target = similar[0]!.s;
        seen.add(target.id);
        seenToday.push(target.id);
        missingNow.splice(missingNow.indexOf(target), 1);
        steps.push({
          write: () => repo.renameStation(target.id, e.name, true),
          record: (r) => r.renamed.push({ from: target.displayName, to: e.name }),
        });
        continue;
      }
      steps.push({
        write: () => {
          const base = slugify(e.name) || 'station';
          let slug = base;
          let n = 2;
          while (repo.getStation(`${packId}:${slug}`)) slug = `${base}-${n++}`;
          repo.upsertProviderStation({
            id: `${packId}:${slug}`,
            provider: packId,
            slug,
            externalId: e.externalId,
            displayName: e.name,
            aliases: [],
            tags: [],
            category: null,
            sortOrder: 5000 + index,
            officialPageUrl: null,
            officialLastSeenAt: today,
            catalogueStatus: 'active',
            description: null,
          });
        },
        record: (r) => {
          r.added.push(e.name);
          r.needsSourceMapping.push(e.name);
        },
      });
    }
    for (const s of missingNow) {
      steps.push({
        write: () => repo.setCatalogueStatus(s.id, 'missing_from_official'),
        record: (r) => r.missing.push(s.displayName),
      });
    }
    return steps;
  }

  /**
   * Writes the changes in one transaction, all or nothing. Only a list with more than
   * `batchSize` changes at once (hundreds of new stations, say) is written in several, giving the
   * event loop a turn in between; each is all or nothing, and the report lists only what was
   * written: if one fails, the changes before it stay and the next sync does the rest.
   */
  async #write(steps: SyncStep[], report: SyncReport, signal?: AbortSignal): Promise<void> {
    for (let from = 0; from < steps.length; from += this.#batchSize) {
      if (from > 0) await yieldToEventLoop();
      if (signal?.aborted) throw new RadioError('CANCELLED', 'The sync was cancelled.');
      const batch = steps.slice(from, from + this.#batchSize);
      this.#repo.transaction(() => {
        for (const step of batch) step.write();
      });
      for (const step of batch) step.record(report);
    }
  }
}
