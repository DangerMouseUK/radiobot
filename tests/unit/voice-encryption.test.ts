import { generateDependencyReport } from '@discordjs/voice';
import { describe, expect, it } from 'vitest';
import { checkVoiceEncryption } from '../../src/voice/encryption.ts';

describe('voice transport encryption', () => {
  it('supports both modes Discord offers: AES-256-GCM and the required XChaCha20-Poly1305', async () => {
    const support = await checkVoiceEncryption();
    expect(support).toEqual({ aes256gcm: true, xchacha20: true });
  });

  it('ships an XChaCha20-Poly1305 package that the voice library finds', () => {
    // Without one, a voice server that offers only the required mode makes every packet throw.
    expect(generateDependencyReport()).toMatch(/@noble\/ciphers: \d+\.\d+\.\d+/);
  });
});
