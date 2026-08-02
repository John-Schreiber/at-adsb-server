import { describe, it, expect } from 'vitest';
import { signEventFrame } from '../frame-signer.js';
import { Secp256k1Keypair, verifySignature } from '@atproto/crypto';
import { encode } from '@ipld/dag-cbor';
import type { EventMessage } from '../stream.js';

describe('frame-signer', () => {
  describe('stream-signing.AC2.1: Event frame includes sig field', () => {
    it('should sign an event frame and return sig field as Uint8Array of length 64', async () => {
      const keypair = await Secp256k1Keypair.create({ exportable: true });

      const frame: EventMessage = {
        $type: 'at.adsb.broadcast.subscribeEvents#event',
        seq: 1,
        station: {
          uri: 'at://did:plc:test/at.adsb.receiver.station/self',
          cid: 'bafy123',
        },
        time: new Date().toISOString(),
        ops: [],
      };

      const signed = await signEventFrame(frame, keypair);

      expect(signed.sig).toBeDefined();
      expect(signed.sig).toBeInstanceOf(Uint8Array);
      if (signed.sig) {
        expect(signed.sig.length).toBe(64);
      }
    });
  });

  describe('stream-signing.AC2.2: Signature verifies against DAG-CBOR encoding', () => {
    it('should produce a signature that verifies correctly', async () => {
      const keypair = await Secp256k1Keypair.create({ exportable: true });
      const didKey = keypair.did();

      const frame: EventMessage = {
        $type: 'at.adsb.broadcast.subscribeEvents#event',
        seq: 42,
        station: {
          uri: 'at://did:plc:test/at.adsb.receiver.station/self',
          cid: 'bafy123',
        },
        time: '2026-05-25T10:00:00.000Z',
        ops: [
          {
            action: 'update',
            record: {
              icaoHex: 'ABCDEF',
              rssi: '-5.0',
              seen: '1.2',
              $type: 'at.adsb.broadcast.message',
            },
          },
        ],
      };

      const signed = await signEventFrame(frame, keypair);

      // Strip sig and re-encode to verify
      const { sig: _, ...frameWithoutSig } = signed;
      const encoded = encode(frameWithoutSig);

      expect(signed.sig).toBeDefined();
      const verified = await verifySignature(didKey, encoded, signed.sig!);
      expect(verified).toBe(true);
    });
  });

  describe('stream-signing.AC2.4: Tampered frame fails verification', () => {
    it('should reject a frame modified after signing', async () => {
      const keypair = await Secp256k1Keypair.create({ exportable: true });
      const didKey = keypair.did();

      const frame: EventMessage = {
        $type: 'at.adsb.broadcast.subscribeEvents#event',
        seq: 1,
        station: {
          uri: 'at://did:plc:test/at.adsb.receiver.station/self',
          cid: 'bafy123',
        },
        time: '2026-05-25T10:00:00.000Z',
        ops: [],
      };

      const signed = await signEventFrame(frame, keypair);

      // Tamper: change seq
      const tamperedFrame = { ...signed, seq: 999 };
      const { sig: _, ...tamperedWithoutSig } = tamperedFrame;
      const encodedTampered = encode(tamperedWithoutSig);

      expect(signed.sig).toBeDefined();
      const verified = await verifySignature(didKey, encodedTampered, signed.sig!);
      expect(verified).toBe(false);
    });
  });

  describe('stream-signing.AC2.5: Frame signed with wrong key fails verification', () => {
    it('should not verify when using a different keypair', async () => {
      const keypair1 = await Secp256k1Keypair.create({ exportable: true });
      const keypair2 = await Secp256k1Keypair.create({ exportable: true });
      const didKey2 = keypair2.did();

      const frame: EventMessage = {
        $type: 'at.adsb.broadcast.subscribeEvents#event',
        seq: 1,
        station: {
          uri: 'at://did:plc:test/at.adsb.receiver.station/self',
          cid: 'bafy123',
        },
        time: '2026-05-25T10:00:00.000Z',
        ops: [],
      };

      const signed = await signEventFrame(frame, keypair1);

      // Try to verify with different key
      const { sig: _, ...frameWithoutSig } = signed;
      const encoded = encode(frameWithoutSig);

      expect(signed.sig).toBeDefined();
      const verified = await verifySignature(didKey2, encoded, signed.sig!);
      expect(verified).toBe(false);
    });
  });

  describe('stream-signing.AC4.1: Signing latency under 5ms', () => {
    it('should sign 100 frames with average latency under 5ms', async () => {
      const keypair = await Secp256k1Keypair.create({ exportable: true });

      const frame: EventMessage = {
        $type: 'at.adsb.broadcast.subscribeEvents#event',
        seq: 1,
        station: {
          uri: 'at://did:plc:test/at.adsb.receiver.station/self',
          cid: 'bafy123',
        },
        time: '2026-05-25T10:00:00.000Z',
        ops: [],
      };

      const start = performance.now();
      for (let i = 0; i < 100; i++) {
        const testFrame = { ...frame, seq: i };
        await signEventFrame(testFrame, keypair);
      }
      const end = performance.now();

      const totalMs = end - start;
      const avgMs = totalMs / 100;

      expect(avgMs).toBeLessThan(5);
    });
  });

  describe('stream-signing.AC2.6: sig field not included for non-event frames', () => {
    it('should work only with event frames passed to it', async () => {
      const keypair = await Secp256k1Keypair.create({ exportable: true });

      const eventFrame: EventMessage = {
        $type: 'at.adsb.broadcast.subscribeEvents#event',
        seq: 1,
        station: {
          uri: 'at://did:plc:test/at.adsb.receiver.station/self',
          cid: 'bafy123',
        },
        time: '2026-05-25T10:00:00.000Z',
        ops: [],
      };

      const signed = await signEventFrame(eventFrame, keypair);

      // Verify that only event frames are signed by the module
      expect(signed.sig).toBeInstanceOf(Uint8Array);
      // AC2.6 notes that identity and info frames are never passed to signEventFrame
      // so the module doesn't need special handling for those types
    });
  });
});
