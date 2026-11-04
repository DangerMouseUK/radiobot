import {
  type DiscordGatewayAdapterCreator,
  type DiscordGatewayAdapterLibraryMethods,
  getVoiceConnection,
  type VoiceConnection,
  VoiceConnectionDisconnectReason,
  type VoiceConnectionState,
  VoiceConnectionStatus,
} from '@discordjs/voice';
import type { FromWorker } from './protocol.ts';

/**
 * The worker's side of the gateway adapter. @discordjs/voice talks to Discord's main gateway only
 * through an adapter: it sends join payloads with `sendPayload` and is handed the voice server and
 * voice state updates. The gateway lives on the main thread, so each adapter here relays both ways
 * by message, under an ID of its own (a guild's next connection gets a new adapter).
 *
 * `sendPayload` must answer at once. It answers from the gateway state the main thread last
 * pushed; if the main thread then finds the payload could not be sent, `sendFailed` does what the
 * library does with a `false`: the connection becomes Disconnected (adapter unavailable), and the
 * link's reconnect loop takes it from there.
 */
export class AdapterRelay {
  readonly #post: (msg: FromWorker) => void;
  readonly #markUnavailable: (guildId: string) => void;
  readonly #adapters = new Map<number, { guildId: string; methods: DiscordGatewayAdapterLibraryMethods }>();
  #nextId = 0;
  #gatewayReady = true;

  constructor(
    post: (msg: FromWorker) => void,
    markUnavailable: (guildId: string) => void = markAdapterUnavailable,
  ) {
    this.#post = post;
    this.#markUnavailable = markUnavailable;
  }

  get size(): number {
    return this.#adapters.size;
  }

  creatorFor(guildId: string): DiscordGatewayAdapterCreator {
    return (methods) => {
      const adapterId = ++this.#nextId;
      this.#adapters.set(adapterId, { guildId, methods });
      this.#post({ t: 'adapterOpen', adapterId, guildId });
      return {
        sendPayload: (payload: unknown) => {
          if (!this.#gatewayReady || !this.#adapters.has(adapterId)) return false;
          this.#post({ t: 'send', adapterId, payload });
          return true;
        },
        destroy: () => {
          if (this.#adapters.delete(adapterId)) this.#post({ t: 'adapterClose', adapterId });
        },
      };
    };
  }

  setGatewayReady(ready: boolean): void {
    this.#gatewayReady = ready;
  }

  gateway(adapterId: number, kind: 'server' | 'state', data: unknown): void {
    const a = this.#adapters.get(adapterId);
    if (!a) return;
    if (kind === 'server') a.methods.onVoiceServerUpdate(data as never);
    else a.methods.onVoiceStateUpdate(data as never);
  }

  /** The main gateway let go of the adapter (a shard disconnected, say): the library destroys the connection. */
  destroyed(adapterId: number): void {
    this.#adapters.get(adapterId)?.methods.destroy();
  }

  sendFailed(adapterId: number): void {
    const a = this.#adapters.get(adapterId);
    if (a) this.#markUnavailable(a.guildId);
  }
}

/** What @discordjs/voice does itself when `sendPayload` returns false. */
export function markAdapterUnavailable(
  guildId: string,
  lookup: (guildId: string) => VoiceConnection | undefined = getVoiceConnection,
): void {
  const connection = lookup(guildId);
  if (!connection || connection.state.status === VoiceConnectionStatus.Destroyed) return;
  connection.state = {
    ...connection.state,
    status: VoiceConnectionStatus.Disconnected,
    reason: VoiceConnectionDisconnectReason.AdapterUnavailable,
  } as VoiceConnectionState;
}
