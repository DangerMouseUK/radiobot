/** Reason codes used across logs, diagnostics and user-facing messages. */
export type ReasonCode =
  | 'URL_INVALID'
  | 'URL_SCHEME_NOT_ALLOWED'
  | 'URL_CREDENTIALS_NOT_ALLOWED'
  | 'URL_PORT_NOT_ALLOWED'
  | 'URL_HOST_NOT_ALLOWED'
  | 'URL_TOO_LONG'
  | 'DNS_FAILED'
  | 'ADDRESS_BLOCKED'
  | 'REDIRECT_LIMIT'
  | 'HTTP_STATUS'
  | 'NOT_FOUND'
  | 'ACCESS_DENIED'
  | 'HTTP_TIMEOUT'
  | 'HTTP_ERROR'
  | 'BODY_TOO_LARGE'
  | 'CONTENT_TYPE_REJECTED'
  | 'PLAYLIST_INVALID'
  | 'HLS_ENCRYPTED'
  | 'HLS_NO_AUDIO'
  | 'HLS_SEGMENT_FAILED'
  | 'HLS_PLAYLIST_FAILED'
  | 'PROBE_FAILED'
  | 'PROBE_TIMEOUT'
  | 'NO_AUDIO_STREAM'
  | 'DECODE_FAILED'
  | 'FFMPEG_EXIT'
  | 'FFMPEG_SPAWN'
  | 'STREAM_EOF'
  | 'STREAM_STALLED'
  | 'IDENTITY_MISMATCH'
  | 'NO_ELIGIBLE_SOURCE'
  | 'VOICE_PERMISSION'
  | 'VOICE_CHANNEL_GONE'
  | 'VOICE_DISCONNECTED'
  | 'VOICE_KICKED'
  | 'VOICE_CONNECT_TIMEOUT'
  | 'STREAM_LIMIT'
  | 'RATE_LIMITED'
  | 'CUSTOM_STATION_LIMIT'
  | 'CANCELLED'
  | 'INTERNAL';

export class RadioError extends Error {
  override name = 'RadioError';
  readonly code: ReasonCode;
  /** Safe to show to Discord users (never contains secrets). */
  readonly userMessage: string;

  constructor(code: ReasonCode, userMessage: string, options?: { cause?: unknown }) {
    super(`${code}: ${userMessage}`, options);
    this.code = code;
    this.userMessage = userMessage;
  }
}

export function isRadioError(err: unknown): err is RadioError {
  return err instanceof RadioError;
}

export function errorCode(err: unknown): ReasonCode {
  return isRadioError(err) ? err.code : 'INTERNAL';
}

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
