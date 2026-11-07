import { getCiphers, randomBytes } from 'node:crypto';

/**
 * The two transport encryption modes Discord's voice servers offer today. `@discordjs/voice` takes
 * the first one in the server's list that it supports: `aead_aes256_gcm_rtpsize` is Discord's
 * preferred mode but "may be absent depending on hardware"; `aead_xchacha20_poly1305_rtpsize` is
 * the one every client must support. The library does AES-256-GCM with node:crypto and needs a
 * separate package for XChaCha20-Poly1305 (we ship `@noble/ciphers`, pure JavaScript). Without it,
 * a voice server that offered only the required mode would make every packet throw.
 */
export interface VoiceEncryptionSupport {
  /** `aead_aes256_gcm_rtpsize`, through node:crypto (OpenSSL). */
  aes256gcm: boolean;
  /** `aead_xchacha20_poly1305_rtpsize`, through `@noble/ciphers`. */
  xchacha20: boolean;
  /** Why XChaCha20-Poly1305 is unavailable, when it is. */
  error?: string;
}

/**
 * Checks both modes: OpenSSL's cipher list, and one XChaCha20-Poly1305 round trip through the
 * module the voice library loads. Run once at start-up (a dynamic import and two 16-byte
 * operations), never per packet.
 */
export async function checkVoiceEncryption(): Promise<VoiceEncryptionSupport> {
  const aes256gcm = getCiphers().includes('aes-256-gcm');
  try {
    const { xchacha20poly1305 } = await import('@noble/ciphers/chacha.js');
    const key = randomBytes(32);
    const nonce = randomBytes(24);
    const aad = randomBytes(12);
    const plain = randomBytes(16);
    const sealed = xchacha20poly1305(key, nonce, aad).encrypt(plain);
    const opened = xchacha20poly1305(key, nonce, aad).decrypt(sealed);
    const xchacha20 = Buffer.from(opened).equals(plain);
    return xchacha20 ? { aes256gcm, xchacha20 } : { aes256gcm, xchacha20, error: 'round trip failed' };
  } catch (err) {
    return { aes256gcm, xchacha20: false, error: err instanceof Error ? err.message : String(err) };
  }
}
