import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pino } from 'pino';
import {
  discoverPackDirs,
  loadPack,
  PackRegistry,
  type PackSelection,
  type StationPack,
} from '../src/catalogue/packs.ts';
import type { StationSource } from '../src/catalogue/types.ts';
import type { Logger } from '../src/observability/logger.ts';
import { Db } from '../src/persistence/db.ts';
import { GuildRepository, MetaRepository } from '../src/persistence/repositories/guilds.ts';
import { StationRepository } from '../src/persistence/repositories/stations.ts';

export const silentLogger = (): Logger => pino({ level: 'silent' });

/** Folder of made-up station packs for the tests (`demo`); no test depends on catalog/packs. */
export const FIXTURE_PACKS_DIR = fileURLToPath(new URL('./fixtures/packs/', import.meta.url));
export const DEMO_PACK_DIR = join(FIXTURE_PACKS_DIR, 'demo');

/** The made-up `demo` pack, loaded as an operator's extra pack. */
export const demoPack = (): StationPack => loadPack(DEMO_PACK_DIR, 'extra');

/**
 * The `demo` fixture pack plus any packs in `extraDir`, checked together as `PackRegistry.load`
 * would, but without reading the packs shipped in catalog/packs.
 */
export function demoRegistry(extraDir: string | null = null, selection?: PackSelection): PackRegistry {
  const extra = extraDir ? discoverPackDirs(extraDir).map((d) => loadPack(d, 'extra')) : [];
  return new PackRegistry([demoPack(), ...extra], selection);
}

export function memoryDb() {
  const db = new Db(':memory:');
  db.migrate();
  return {
    db,
    stations: new StationRepository(db),
    guilds: new GuildRepository(db, {
      qualityMode: 'maximum',
      idleMode: 'leave_when_empty',
      resumeOnRestart: false,
    }),
    meta: new MetaRepository(db),
  };
}

export function makeSource(overrides: Partial<StationSource> = {}): StationSource {
  const now = new Date().toISOString();
  return {
    id: 'src-a',
    stationId: 'demo:demo-radio',
    url: 'https://stream.example.com/a',
    label: 'Direct',
    priority: 10,
    transportHint: 'http-continuous',
    codecHint: 'mp3',
    transport: 'http-continuous',
    container: 'mp3',
    codec: 'mp3',
    profile: null,
    sampleRateHz: 44_100,
    channels: 2,
    channelLayout: 'stereo',
    advertisedBitrateKbps: 128,
    codecBitrateKbps: 128,
    measuredBitrateKbps: 128,
    bitrateConfidence: 'measured',
    identityStatus: 'verified',
    identityConfidence: 'medium',
    identityEvidence: [],
    identityOverride: null,
    qualityConfidence: 'measured',
    rightsStatus: 'unreviewed',
    provenance: 'official-player',
    provenanceDetail: null,
    enabled: true,
    disabledReason: null,
    verificationState: 'eligible',
    icyName: null,
    effectiveHost: 'stream.example.com',
    startupMs: 500,
    lastProbeAt: now,
    lastSuccessAt: now,
    lastFailureAt: null,
    lastFailureCode: null,
    healthScore: 60,
    cooldownUntil: null,
    failureCount: 0,
    consecutiveFailures: 0,
    cooldownTrips: 0,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}
