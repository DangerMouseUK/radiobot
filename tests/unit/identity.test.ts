import { describe, expect, it } from 'vitest';
import type { Station } from '../../src/catalogue/types.ts';
import {
  correlateEnvelopes,
  correlationEvidence,
  decideIdentity,
  metadataSignal,
  onsetEnvelope,
} from '../../src/streams/identity.ts';

const station = (id: string, name: string, aliases: string[] = []): Station => ({
  id,
  provider: 'fg',
  guildId: null,
  slug: id.slice(3),
  externalId: null,
  displayName: name,
  aliases,
  description: null,
  tags: [],
  category: null,
  sortOrder: 1,
  websiteUrl: null,
  language: null,
  officialPageUrl: null,
  officialLastSeenAt: null,
  catalogueStatus: 'active',
  createdById: null,
  createdAt: '',
  updatedAt: '',
  retiredAt: null,
});

const djRadio = station('fg:fg-dj-radio', 'FG DJ RADIO', ['Radio FG', 'FG']);
const dance = station('fg:fg-dance', 'FG DANCE');
const chic = station('fg:fg-chic', 'FG CHIC');
const all = [djRadio, dance, chic];

describe('metadata signal', () => {
  it('treats brand labels as inconclusive', () => {
    expect(metadataSignal(dance, all, 'Radio FG').verdict).toBe('inconclusive');
    expect(metadataSignal(chic, all, 'FG').verdict).toBe('inconclusive');
  });
  it('supports when the stream names this station', () => {
    expect(metadataSignal(dance, all, 'FG DANCE - live').verdict).toBe('supports');
  });
  it('contradicts only when it names a different catalogue station', () => {
    expect(metadataSignal(djRadio, all, 'FG DANCE').verdict).toBe('contradicts');
    expect(metadataSignal(djRadio, all, 'Some Icecast Server').verdict).toBe('inconclusive');
  });
});

describe('identity decision (FR-005)', () => {
  const official = { provenance: 'official-player' as const, provenanceDetail: 'x', identityOverride: null };
  const discovered = {
    provenance: 'auto-discovered' as const,
    provenanceDetail: null,
    identityOverride: null,
  };

  it('verifies official mappings with medium confidence', () => {
    const d = decideIdentity(official, { verdict: 'inconclusive', detail: '' }, null);
    expect(d.status).toBe('verified');
    expect(d.confidence).toBe('medium');
  });

  it('never silently verifies an auto-discovered feed (the "HD stream is really FG DANCE" case)', () => {
    expect(decideIdentity(discovered, { verdict: 'inconclusive', detail: '' }, null).status).toBe(
      'unverified',
    );
    expect(decideIdentity(discovered, metadataSignal(djRadio, all, 'FG DANCE'), null).status).toBe(
      'mismatch',
    );
  });

  it('verifies an auto-discovered feed only with a positive audio correlation', () => {
    const ev = correlationEvidence(
      { score: 0.8, lagSeconds: 7, prominence: 12, uniqueness: 3, overlapSeconds: 20 },
      'incumbent',
    );
    expect(decideIdentity(discovered, null, ev).status).toBe('verified');
    expect(decideIdentity(discovered, null, ev).confidence).toBe('high');
  });

  it('does not demote an established source because of a failed correlation', () => {
    const ev = correlationEvidence(
      { score: 0.05, lagSeconds: 0, prominence: 1, uniqueness: 1, overlapSeconds: 20 },
      'incumbent',
    );
    expect(ev.verdict).toBe('inconclusive');
    expect(decideIdentity(official, null, ev).status).toBe('verified');
  });

  it('applies administrator overrides with an evidence record', () => {
    const d = decideIdentity({ ...official, identityOverride: 'mismatch' }, null, null);
    expect(d.status).toBe('mismatch');
    expect(d.evidence.some((e) => e.kind === 'admin-override')).toBe(true);
  });

  it('treats admin-declared custom URLs as verified', () => {
    expect(
      decideIdentity(
        { provenance: 'custom-user', provenanceDetail: null, identityOverride: null },
        null,
        null,
      ).status,
    ).toBe('verified');
  });
});

describe('audio correlation', () => {
  function programme(seed: number, seconds: number, rate = 8000): Int16Array {
    // Deterministic "music": noise bursts with a pseudo-random rhythm.
    // mulberry32: independent streams per seed (a plain LCG gives shifted copies for nearby seeds).
    let x = seed >>> 0;
    const rnd = () => {
      x = (x + 0x6d2b79f5) >>> 0;
      let t = x;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const out = new Int16Array(seconds * rate);
    let amp = 0;
    let next = 0;
    for (let i = 0; i < out.length; i++) {
      // Notes of varying length, like real music (not a sample-exact shared grid).
      if (i >= next) {
        amp = rnd() > 0.5 ? rnd() * 20000 : rnd() * 2000;
        next = i + 800 + Math.floor(rnd() * 2400);
      }
      out[i] = Math.round((rnd() * 2 - 1) * amp);
    }
    return out;
  }

  it('finds the same programme offset by CDN delay', () => {
    const full = programme(42, 50);
    const a = full.subarray(0, 30 * 8000);
    const b = full.subarray(7 * 8000, 37 * 8000);
    const r = correlateEnvelopes(onsetEnvelope(a), onsetEnvelope(b));
    expect(r.score).toBeGreaterThan(0.9);
    expect(Math.abs(Math.abs(r.lagSeconds) - 7)).toBeLessThan(0.1);
    expect(correlationEvidence(r, 'x').verdict).toBe('supports');
  });

  it('does not match a different programme', () => {
    for (const [s1, s2] of [
      [1, 2],
      [3, 4],
      [5, 6],
      [7, 8],
      [9, 10],
    ] as const) {
      const r = correlateEnvelopes(onsetEnvelope(programme(s1, 30)), onsetEnvelope(programme(s2, 30)));
      expect(correlationEvidence(r, 'x').verdict).toBe('inconclusive');
    }
  });

  it('does not match silence or constant tone', () => {
    const silence = new Int16Array(30 * 8000);
    const r = correlateEnvelopes(onsetEnvelope(silence), onsetEnvelope(programme(9, 30)));
    expect(correlationEvidence(r, 'x').verdict).toBe('inconclusive');
  });
});
