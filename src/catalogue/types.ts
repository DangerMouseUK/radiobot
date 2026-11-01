/** A station pack id (e.g. "mypack") or "custom" for a server's own stations. */
export type Provider = string;
export type CatalogueStatus = 'active' | 'missing_from_official' | 'retired';
export type Transport = 'http-continuous' | 'hls' | 'unknown';
export type IdentityStatus = 'verified' | 'unverified' | 'mismatch';
export type Confidence = 'none' | 'low' | 'medium' | 'high';
export type BitrateEvidence = 'measured' | 'manifest' | 'codec-metadata' | 'advertised' | 'unknown';
export type SourceProvenance = 'official-player' | 'curated' | 'auto-discovered' | 'custom-user';
export type RightsStatus = 'unreviewed' | 'permitted' | 'blocked';
export type QualityConfidence = 'unknown' | 'not-conclusive' | 'measured';

/** PRD §7.2 candidate state machine plus exceptional states. */
export type VerificationState =
  | 'discovered'
  | 'resolved'
  | 'transport_healthy'
  | 'codec_verified'
  | 'identity_verified'
  | 'eligible'
  | 'unverified'
  | 'degraded'
  | 'blocked_by_policy'
  | 'cooldown'
  | 'offline'
  | 'retired';

export interface Station {
  id: string;
  provider: Provider;
  guildId: string | null;
  slug: string;
  /** Stable identifier used by the official provider list, when known. */
  externalId: string | null;
  displayName: string;
  aliases: string[];
  description: string | null;
  tags: string[];
  category: string | null;
  sortOrder: number;
  websiteUrl: string | null;
  language: string | null;
  officialPageUrl: string | null;
  officialLastSeenAt: string | null;
  catalogueStatus: CatalogueStatus;
  createdById: string | null;
  createdAt: string;
  updatedAt: string;
  retiredAt: string | null;
}

export interface IdentityEvidence {
  kind: 'provenance' | 'metadata' | 'correlation' | 'admin-override' | 'declared';
  verdict: 'supports' | 'contradicts' | 'inconclusive';
  detail: string;
  at: string;
  score?: number;
}

export interface StationSource {
  id: string;
  stationId: string;
  url: string;
  label: string | null;
  priority: number;
  transportHint: Transport | null;
  codecHint: string | null;
  transport: Transport;
  container: string | null;
  codec: string | null;
  profile: string | null;
  sampleRateHz: number | null;
  channels: number | null;
  channelLayout: string | null;
  advertisedBitrateKbps: number | null;
  codecBitrateKbps: number | null;
  measuredBitrateKbps: number | null;
  bitrateConfidence: BitrateEvidence;
  identityStatus: IdentityStatus;
  identityConfidence: Confidence;
  identityEvidence: IdentityEvidence[];
  identityOverride: 'verified' | 'mismatch' | null;
  qualityConfidence: QualityConfidence;
  rightsStatus: RightsStatus;
  provenance: SourceProvenance;
  provenanceDetail: string | null;
  enabled: boolean;
  disabledReason: string | null;
  verificationState: VerificationState;
  icyName: string | null;
  effectiveHost: string | null;
  startupMs: number | null;
  lastProbeAt: string | null;
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  lastFailureCode: string | null;
  healthScore: number;
  cooldownUntil: string | null;
  failureCount: number;
  consecutiveFailures: number;
  cooldownTrips: number;
  createdAt: string;
  updatedAt: string;
}

/** User-facing station availability (FR-001). */
export type StationAvailability =
  | 'available'
  | 'degraded'
  | 'unverified'
  | 'unavailable'
  | 'no_source'
  | 'retired';

export const AVAILABILITY_LABEL: Record<StationAvailability, string> = {
  available: 'Available',
  degraded: 'Degraded',
  unverified: 'Unverified',
  unavailable: 'Temporarily unavailable',
  no_source: 'No stream source known',
  retired: 'Retired',
};

export interface StationWithSources {
  station: Station;
  sources: StationSource[];
}
