import {describe, it, expect} from 'vitest';
import {
  generateSigningKey,
  importSigningKey,
  getSigningKeyDid,
  exportSigningKeyHex,
} from '../keys.js';
import {parseDidKey} from '@atproto/crypto';

describe('keys', () => {
  describe('AC1.3: Roundtrip and DID encoding', () => {
    it('should generate a keypair, export hex, re-import, and match DIDs', async () => {
      const keypair1 = await generateSigningKey();
      const hex = await exportSigningKeyHex(keypair1);
      const keypair2 = await importSigningKey(hex);

      const did1 = getSigningKeyDid(keypair1);
      const did2 = getSigningKeyDid(keypair2);

      expect(did1).toBe(did2);
      expect(did1).toMatch(/^did:key:z/);
    });

    it('should import hex, get did:key, and parse it without error', async () => {
      const keypair = await generateSigningKey();
      const hex = await exportSigningKeyHex(keypair);
      const keypairFromHex = await importSigningKey(hex);

      const didKey = getSigningKeyDid(keypairFromHex);
      const parsed = parseDidKey(didKey);

      // parseDidKey successfully extracts the public key from the DID
      // keyBytes is the uncompressed secp256k1 public key (65 bytes)
      expect(parsed.keyBytes).toBeInstanceOf(Uint8Array);
      expect(parsed.keyBytes.length).toBe(65);
      expect(parsed.jwtAlg).toBe('ES256K');
    });
  });

  describe('AC1.5: Invalid input validation', () => {
    it('should reject empty string', async () => {
      await expect(importSigningKey('')).rejects.toThrow(
        'invalid signing key: expected 64-character hex string'
      );
    });

    it('should reject non-hex characters', async () => {
      await expect(importSigningKey('not-hex-at-all-'.padEnd(64, 'x'))).rejects.toThrow(
        'invalid signing key: expected 64-character hex string'
      );
    });

    it('should reject wrong length (too short)', async () => {
      await expect(importSigningKey('ab')).rejects.toThrow(
        'invalid signing key: expected 64-character hex string'
      );
    });

    it('should reject non-hex characters zz', async () => {
      await expect(importSigningKey('zz'.repeat(32))).rejects.toThrow(
        'invalid signing key: expected 64-character hex string'
      );
    });
  });

  describe('getSigningKeyDid', () => {
    it('should return a did:key string starting with did:key:z', async () => {
      const keypair = await generateSigningKey();
      const did = getSigningKeyDid(keypair);

      expect(did).toMatch(/^did:key:z/);
    });
  });

  describe('exportSigningKeyHex', () => {
    it('should export hex as 64-character hex string', async () => {
      const keypair = await generateSigningKey();
      const hex = await exportSigningKeyHex(keypair);

      expect(hex).toMatch(/^[0-9a-f]{64}$/);
    });
  });

  describe('AC4.2: Sole cryptographic dependency', () => {
    it('should have @atproto/crypto as sole crypto library in dependencies', async () => {
      const packageJsonPath = new URL('../../package.json', import.meta.url);
      const packageJsonText = await import('node:fs').then((fs) =>
        fs.promises.readFile(packageJsonPath, 'utf8'),
      );
      const packageJson = JSON.parse(packageJsonText) as {
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
      };

      const knownCryptoLibs = [
        'node-forge',
        'tweetnacl',
        'noble-secp256k1',
        'elliptic',
        'crypto-js',
        'sodium',
        'libsodium',
      ];

      const allDeps = {
        ...packageJson.dependencies,
        ...packageJson.devDependencies,
      };
      const depNames = Object.keys(allDeps);

      for (const cryptoLib of knownCryptoLibs) {
        expect(depNames).not.toContain(cryptoLib);
      }

      expect(depNames).toContain('@atproto/crypto');
    });
  });
});
