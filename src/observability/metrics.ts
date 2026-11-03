import type { ReasonCode } from '../shared/errors.ts';
import { compareText } from '../shared/text.ts';

/** Who is at fault, so "uptime" is never attributed to the wrong component (PRD §16). */
export type FaultDomain = 'upstream' | 'discord' | 'bot' | 'operator' | 'user';

export interface IncidentRecord {
  at: string;
  guildId: string | null;
  code: ReasonCode;
  domain: FaultDomain;
  detail: string;
  count: number;
}

/** Bounded ring buffer. */
export class Ring<T> {
  readonly #items: T[] = [];
  readonly capacity: number;

  constructor(capacity: number) {
    this.capacity = capacity;
  }

  push(item: T): void {
    this.#items.push(item);
    if (this.#items.length > this.capacity) this.#items.shift();
  }

  last(): T | undefined {
    return this.#items[this.#items.length - 1];
  }

  toArray(): T[] {
    return [...this.#items];
  }
}

/** In-process counters and recent incidents. Nothing leaves the host. */
export class Metrics {
  readonly counters = new Map<string, number>();
  readonly incidents = new Ring<IncidentRecord>(200);
  readonly startedAt = new Date();

  inc(name: string, by = 1): void {
    this.counters.set(name, (this.counters.get(name) ?? 0) + by);
  }

  get(name: string): number {
    return this.counters.get(name) ?? 0;
  }

  /** Records an incident, coalescing repeats of the same code within 5 minutes. */
  incident(guildId: string | null, code: ReasonCode, domain: FaultDomain, detail: string): IncidentRecord {
    this.inc(`incident.${domain}.${code}`);
    const prev = this.incidents
      .toArray()
      .reverse()
      .find((i) => i.guildId === guildId && i.code === code);
    if (prev && Date.now() - Date.parse(prev.at) < 5 * 60_000) {
      prev.count++;
      prev.detail = detail;
      return prev;
    }
    const rec: IncidentRecord = { at: new Date().toISOString(), guildId, code, domain, detail, count: 1 };
    this.incidents.push(rec);
    return rec;
  }

  recentIncidents(guildId: string | null, limit = 10): IncidentRecord[] {
    return this.incidents
      .toArray()
      .filter((i) => guildId === null || i.guildId === guildId)
      .slice(-limit)
      .reverse();
  }

  snapshot(): Record<string, number> {
    return Object.fromEntries([...this.counters.entries()].sort(([a], [b]) => compareText(a, b)));
  }
}
