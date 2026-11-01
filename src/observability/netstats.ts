import { connect } from 'node:net';

/** Rolling byte-rate meter with 1-second buckets (default: last 60 s). */
export class RateMeter {
  readonly #buckets: number[];
  readonly #size: number;
  #second = 0;
  #startSecond = 0;
  readonly #now: () => number;

  constructor(seconds = 60, now: () => number = Date.now) {
    this.#size = seconds;
    this.#buckets = new Array<number>(seconds).fill(0);
    this.#now = now;
    this.#second = Math.floor(now() / 1000);
    this.#startSecond = this.#second;
  }

  #advance(): void {
    const sec = Math.floor(this.#now() / 1000);
    const steps = Math.min(sec - this.#second, this.#size);
    for (let i = 1; i <= steps; i++) this.#buckets[(this.#second + i) % this.#size] = 0;
    if (sec > this.#second) this.#second = sec;
  }

  add(bytes: number): void {
    this.#advance();
    this.#buckets[this.#second % this.#size]! += bytes;
  }

  /** Average kbps over the last `seconds` complete seconds (excludes the current partial second). */
  kbps(seconds: number): number | null {
    this.#advance();
    // Average only over seconds the meter has existed, so a young stream is not under-reported.
    const n = Math.min(seconds, this.#size - 1, this.#second - this.#startSecond);
    let sum = 0;
    for (let i = 1; i <= n; i++) sum += this.#buckets[(this.#second - i + this.#size * 2) % this.#size]!;
    return n > 0 ? Math.round((sum * 8) / n / 100) / 10 : null;
  }
}

/** Bounded series of latency samples with jitter as the mean absolute difference between neighbours. */
export class LatencySeries {
  readonly #samples: number[] = [];
  readonly #max: number;

  constructor(max = 24) {
    this.#max = max;
  }

  add(ms: number | undefined | null): void {
    if (ms === undefined || ms === null || !Number.isFinite(ms) || ms < 0) return;
    this.#samples.push(ms);
    if (this.#samples.length > this.#max) this.#samples.shift();
  }

  summary(): LatencySummary | null {
    return summarise(this.#samples);
  }
}

export interface LatencySummary {
  samples: number;
  lastMs: number;
  minMs: number;
  avgMs: number;
  maxMs: number;
  /** Mean absolute difference between consecutive samples (RFC 3550-style jitter estimate). */
  jitterMs: number | null;
}

export function summarise(samples: number[]): LatencySummary | null {
  if (samples.length === 0) return null;
  const round = (v: number) => Math.round(v * 10) / 10;
  let diff = 0;
  for (let i = 1; i < samples.length; i++) diff += Math.abs(samples[i]! - samples[i - 1]!);
  return {
    samples: samples.length,
    lastMs: round(samples[samples.length - 1]!),
    minMs: round(Math.min(...samples)),
    avgMs: round(samples.reduce((s, v) => s + v, 0) / samples.length),
    maxMs: round(Math.max(...samples)),
    jitterMs: samples.length > 1 ? round(diff / (samples.length - 1)) : null,
  };
}

/**
 * TCP connect round-trip to an already-validated stream server address: opens a socket,
 * times the handshake, closes it. No HTTP request is made, so no listener session is created.
 */
export async function tcpPing(
  ip: string,
  port: number,
  count = 5,
  timeoutMs = 3000,
): Promise<LatencySummary | null> {
  const samples: number[] = [];
  for (let i = 0; i < count; i++) {
    const started = process.hrtime.bigint();
    const ok = await new Promise<boolean>((resolve) => {
      const socket = connect({ host: ip, port });
      const done = (result: boolean) => {
        socket.destroy();
        resolve(result);
      };
      socket.setTimeout(timeoutMs, () => done(false));
      socket.once('connect', () => done(true));
      socket.once('error', () => done(false));
    });
    if (ok) samples.push(Number(process.hrtime.bigint() - started) / 1e6);
    if (i < count - 1) await new Promise((r) => setTimeout(r, 150));
  }
  return summarise(samples);
}

/** IATA-style location codes commonly embedded in CDN and Discord voice host names. */
const LOCATIONS: Record<string, string> = {
  lhr: 'London',
  lon: 'London',
  man: 'Manchester',
  dub: 'Dublin',
  ams: 'Amsterdam',
  rtm: 'Rotterdam',
  fra: 'Frankfurt',
  ber: 'Berlin',
  muc: 'Munich',
  cdg: 'Paris',
  par: 'Paris',
  mrs: 'Marseille',
  mad: 'Madrid',
  bcn: 'Barcelona',
  mxp: 'Milan',
  mil: 'Milan',
  fco: 'Rome',
  zrh: 'Zurich',
  vie: 'Vienna',
  waw: 'Warsaw',
  prg: 'Prague',
  arn: 'Stockholm',
  sto: 'Stockholm',
  hel: 'Helsinki',
  cph: 'Copenhagen',
  osl: 'Oslo',
  bru: 'Brussels',
  lis: 'Lisbon',
  ist: 'Istanbul',
  otp: 'Bucharest',
  iad: 'Ashburn (US East)',
  ewr: 'Newark (US East)',
  nyc: 'New York',
  bos: 'Boston',
  atl: 'Atlanta',
  mia: 'Miami',
  ord: 'Chicago',
  chi: 'Chicago',
  dfw: 'Dallas',
  den: 'Denver',
  lax: 'Los Angeles',
  sjc: 'San Jose',
  sfo: 'San Francisco',
  sea: 'Seattle',
  yyz: 'Toronto',
  yul: 'Montreal',
  gru: 'São Paulo',
  scl: 'Santiago',
  bog: 'Bogotá',
  eze: 'Buenos Aires',
  mex: 'Mexico City',
  syd: 'Sydney',
  mel: 'Melbourne',
  akl: 'Auckland',
  sin: 'Singapore',
  hkg: 'Hong Kong',
  nrt: 'Tokyo',
  hnd: 'Tokyo',
  tyo: 'Tokyo',
  kix: 'Osaka',
  icn: 'Seoul',
  bom: 'Mumbai',
  del: 'Delhi',
  maa: 'Chennai',
  dxb: 'Dubai',
  tlv: 'Tel Aviv',
  jnb: 'Johannesburg',
  cpt: 'Cape Town',
};

const AREAS: Array<[RegExp, string]> = [
  [/(^|[^a-z])(eu|europe|emea)([^a-z]|$)/, 'Europe'],
  [/(^|[^a-z])(us|usa|na|northamerica)([^a-z]|$)/, 'North America'],
  [/(^|[^a-z])(us-?east|useast)/, 'US East'],
  [/(^|[^a-z])(us-?west|uswest)/, 'US West'],
  [/(^|[^a-z])(uk|gb)([^a-z]|$)/, 'United Kingdom'],
  [/(^|[^a-z])(ap|apac|asia)([^a-z]|$)/, 'Asia-Pacific'],
  [/(^|[^a-z])(sa|latam|southamerica)([^a-z]|$)/, 'South America'],
  [/(^|[^a-z])(au|oceania)([^a-z]|$)/, 'Oceania'],
];

/**
 * Best-effort location hint from a host name (e.g. "n04-eu1.rcs.revma.com" → Europe,
 * "c-lhr05-1a2b.discord.media" → London). Host names are a convention, not a guarantee.
 */
export function regionHint(host: string | null | undefined): string | null {
  if (!host) return null;
  const name = host.toLowerCase().replace(/:\d+$/, '');
  const labels = name.split('.');
  for (const label of labels.slice(0, Math.max(1, labels.length - 2))) {
    for (const part of label.split(/[-_]/)) {
      const code = part.replace(/\d+$/, '');
      if (code.length === 3 && LOCATIONS[code]) return LOCATIONS[code]!;
    }
  }
  const head = labels.slice(0, Math.max(1, labels.length - 2)).join('.');
  for (const [re, area] of AREAS.slice().reverse()) if (re.test(head)) return area;
  return null;
}
