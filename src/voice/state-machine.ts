/** Runtime playback states (PRD §9.1). Desired state is persisted separately. */
export type PlaybackState =
  | 'IDLE'
  | 'JOINING'
  | 'CONNECTED'
  | 'BUFFERING'
  | 'PLAYING'
  | 'SWITCHING'
  | 'RECOVERING'
  | 'FAILING_OVER'
  | 'STOPPING'
  | 'LEAVING'
  | 'ERROR';

const ACTIVE: PlaybackState[] = ['BUFFERING', 'PLAYING', 'SWITCHING', 'RECOVERING', 'FAILING_OVER'];

const TRANSITIONS: Record<PlaybackState, readonly PlaybackState[]> = {
  IDLE: ['JOINING'],
  JOINING: ['CONNECTED', 'ERROR', 'LEAVING'],
  CONNECTED: ['BUFFERING', 'SWITCHING', 'JOINING', 'STOPPING', 'LEAVING', 'ERROR'],
  BUFFERING: [
    'PLAYING',
    'RECOVERING',
    'FAILING_OVER',
    'SWITCHING',
    'JOINING',
    'STOPPING',
    'LEAVING',
    'ERROR',
  ],
  PLAYING: ['SWITCHING', 'RECOVERING', 'FAILING_OVER', 'JOINING', 'STOPPING', 'LEAVING', 'ERROR'],
  SWITCHING: ['BUFFERING', 'JOINING', 'STOPPING', 'LEAVING', 'ERROR'],
  RECOVERING: ['BUFFERING', 'FAILING_OVER', 'SWITCHING', 'JOINING', 'STOPPING', 'LEAVING', 'ERROR'],
  FAILING_OVER: ['BUFFERING', 'SWITCHING', 'JOINING', 'STOPPING', 'LEAVING', 'ERROR'],
  STOPPING: ['CONNECTED', 'IDLE'],
  LEAVING: ['IDLE'],
  ERROR: ['JOINING', 'CONNECTED', 'BUFFERING', 'SWITCHING', 'RECOVERING', 'STOPPING', 'LEAVING'],
};

/** Every state may fall to IDLE when the voice connection is destroyed underneath us. */
export function canTransition(from: PlaybackState, to: PlaybackState): boolean {
  if (from === to) return true;
  if (to === 'IDLE') return true;
  return TRANSITIONS[from].includes(to);
}

export function isAudioActive(state: PlaybackState): boolean {
  return ACTIVE.includes(state);
}

export const STATE_LABEL: Record<PlaybackState, string> = {
  IDLE: 'Idle',
  JOINING: 'Joining the voice channel',
  CONNECTED: 'In the voice channel, not playing',
  BUFFERING: 'Starting the stream',
  PLAYING: 'Playing',
  SWITCHING: 'Switching station',
  RECOVERING: 'Reconnecting to the stream',
  FAILING_OVER: 'Switching to a fallback source',
  STOPPING: 'Stopping',
  LEAVING: 'Leaving',
  ERROR: 'Stopped by a problem',
};
