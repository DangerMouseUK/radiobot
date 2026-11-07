/**
 * Messages between the main thread (`VoiceThread`, src/voice/voice-thread.ts) and the voice
 * worker (`VoiceHost`, host.ts). Every link message carries the link's ID, and every audio message
 * the stream's ID, so anything still in flight for a link or stream that has gone is dropped.
 */
import { RadioError, type ReasonCode } from '../../shared/errors.ts';
import type { VoiceInterruption, VoiceLinkStats, VoiceRestore } from '../link.ts';

export interface SerializedError {
  name: string;
  message: string;
  /** A RadioError's reason code and user message, so the main thread can rebuild it. */
  code?: string;
  userMessage?: string;
}

/** What the main thread knows of a link between messages: its getters are served from this. */
export interface LinkSnapshot {
  channelId: string;
  ready: boolean;
  playerStatus: string;
  /** Audio sent for the current resource, ms. */
  playbackMs: number;
  /** The stream the two figures above belong to (0 when none is playing). */
  streamId: number;
  encryption: string;
  stats: VoiceLinkStats;
}

export interface WorkerLoopDelay {
  meanMs: number;
  p99Ms: number;
  maxMs: number;
  windowSec: number;
}

export interface WorkerGcSummary {
  count: number;
  major: number;
  maxMs: number;
  totalMs: number;
}

/** The worker's own health: its event loop sends the voice packets. */
export interface WorkerTelemetry {
  /** Event-loop delay over the window in progress and the last complete one. */
  loopDelay: { current: WorkerLoopDelay | null; lastWindow: WorkerLoopDelay | null };
  /** Garbage collection pauses in the worker's heap, same windows. */
  gc: { current: WorkerGcSummary; lastWindow: WorkerGcSummary | null };
  heapUsedMb: number;
  heapTotalMb: number;
  externalMb: number;
  arrayBuffersMb: number;
  links: number;
  /** Worker clock when taken (`Date.now()`). */
  at: number;
}

export interface SelfTestResult {
  ok: boolean;
  /** The DAVE protocol version the native library reports (a session was created with it). */
  daveProtocolVersion: number | null;
  heapUsedMb: number;
  error: string | null;
}

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export type ToWorker =
  | { t: 'join'; linkId: number; guildId: string; channelId: string; timeoutMs: number }
  | { t: 'play'; linkId: number; streamId: number }
  | { t: 'audio'; linkId: number; streamId: number; chunk: Uint8Array }
  | { t: 'audioEnd'; linkId: number; streamId: number; how: 'end' | 'error' | 'close'; message?: string }
  | { t: 'stopAudio'; linkId: number }
  | { t: 'detach'; linkId: number }
  | { t: 'destroy'; linkId: number }
  | { t: 'gateway'; adapterId: number; kind: 'server' | 'state'; data: unknown }
  | { t: 'adapterDestroy'; adapterId: number }
  | { t: 'sendFailed'; adapterId: number }
  | { t: 'gatewayReady'; ready: boolean }
  | { t: 'selfTest' }
  | { t: 'shutdown' };

export type FromWorker =
  | { t: 'ready' }
  | { t: 'joined'; linkId: number; snapshot: LinkSnapshot }
  | { t: 'joinFailed'; linkId: number; error: SerializedError }
  | { t: 'snapshot'; linkId: number; snapshot: LinkSnapshot }
  | { t: 'snapshots'; links: Array<[number, LinkSnapshot]> }
  | { t: 'lost'; linkId: number; reason: 'kicked' | 'destroyed' | 'reconnect_failed' }
  | { t: 'audioEnded'; linkId: number; streamId: number; error: SerializedError | null }
  | { t: 'reconnected'; linkId: number }
  | { t: 'connectionError'; linkId: number; error: SerializedError }
  | { t: 'interrupted'; linkId: number; info: VoiceInterruption }
  | { t: 'restored'; linkId: number; info: VoiceRestore }
  | { t: 'flow'; linkId: number; streamId: number; paused: boolean }
  | { t: 'adapterOpen'; adapterId: number; guildId: string }
  | { t: 'send'; adapterId: number; payload: unknown }
  | { t: 'adapterClose'; adapterId: number }
  /** `rotated`: sent as a window closes, so `lastWindow` is new. */
  | { t: 'telemetry'; telemetry: WorkerTelemetry; rotated?: boolean }
  | { t: 'log'; level: LogLevel; msg: string; data?: Record<string, unknown> }
  | { t: 'selfTest'; result: SelfTestResult }
  | { t: 'bye' };

export function serializeError(err: unknown): SerializedError {
  if (err instanceof RadioError) {
    return { name: err.name, message: err.message, code: err.code, userMessage: err.userMessage };
  }
  if (err instanceof Error) return { name: err.name, message: err.message };
  return { name: 'Error', message: String(err) };
}

/** Rebuilds an error sent by the worker; a RadioError comes back as one, with its code. */
export function deserializeError(e: SerializedError): Error {
  if (e.code !== undefined && e.userMessage !== undefined) {
    return new RadioError(e.code as ReasonCode, e.userMessage);
  }
  const err = new Error(e.message);
  err.name = e.name;
  return err;
}
