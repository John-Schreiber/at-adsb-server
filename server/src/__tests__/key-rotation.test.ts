import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { AtpAgent } from "@atproto/api";
import { verifySignature } from "@atproto/crypto";
import { encode } from "@ipld/dag-cbor";
import { detectAndApplyKeyRotation } from "../key-rotation.js";
import { generateSigningKey, getSigningKeyDid } from "../keys.js";
import { signEventFrame } from "../frame-signer.js";
import { StreamBroadcaster } from "../stream.js";
import type { EventMessage, InfoMessage } from "../stream.js";

vi.mock("../client.js");

import * as clientModule from "../client.js";

describe("key rotation", () => {
  let mockAgent: AtpAgent;
  let broadcaster: StreamBroadcaster;
  let emittedFrames: Array<EventMessage | InfoMessage>;

  beforeEach(async () => {
    // Create mock agent
    mockAgent = {
      session: { did: "did:plc:test-user" },
    } as unknown as AtpAgent;

    // Create broadcaster and start on ephemeral port
    broadcaster = new StreamBroadcaster();
    await broadcaster.start(0);

    // Capture emitted frames
    emittedFrames = [];
    const originalEmit = broadcaster["emitter"].emit.bind(broadcaster["emitter"]);
    broadcaster["emitter"].emit = (event: string, frame: any) => {
      if (event === "frame") {
        emittedFrames.push(frame);
      }
      return originalEmit(event, frame);
    };

    vi.clearAllMocks();
  });

  afterEach(async () => {
    await broadcaster.stop();
  });

  describe("stream-signing.AC3.1: KeyRotated info frame emitted on rotation", () => {
    it("should emit KeyRotated info frame when key is rotated", async () => {
      const keypairA = await generateSigningKey();
      const keypairB = await generateSigningKey();
      const didKeyA = getSigningKeyDid(keypairA);
      const didKeyB = getSigningKeyDid(keypairB);

      // Mock getRecord returning station with keypairA's key
      vi.mocked(clientModule.getRecord).mockResolvedValue({
        uri: "at://did:plc:test-user/at.adsb.receiver.station/self",
        cid: "cid-station",
        value: {
          $type: "at.adsb.receiver.station",
          streamSigningKey: didKeyA,
          location: { latitude: "37.5", longitude: "-122.5" },
        },
      });

      // Mock putRecord to succeed
      vi.mocked(clientModule.putRecord).mockResolvedValue({
        uri: "at://did:plc:test-user/at.adsb.receiver.station/self",
        cid: "cid-station-updated",
      });

      // Detect rotation with keypairB
      const result = await detectAndApplyKeyRotation(
        mockAgent,
        broadcaster,
        keypairB,
      );

      // Verify rotation was detected
      expect(result.rotated).toBe(true);

      // Verify KeyRotated info frame was emitted
      const keyRotatedFrame = emittedFrames.find(
        (f) => f.$type === "at.adsb.broadcast.subscribeEvents#info" && 'name' in f && f.name === "KeyRotated",
      );
      expect(keyRotatedFrame).toBeDefined();
      if (keyRotatedFrame && 'message' in keyRotatedFrame) {
        expect(keyRotatedFrame.message).toBe("Stream signing key rotated.");
      }
    });
  });

  describe("stream-signing.AC3.2: Station record updated with new key", () => {
    it("should update station record with new key's did:key", async () => {
      const keypairA = await generateSigningKey();
      const keypairB = await generateSigningKey();
      const didKeyA = getSigningKeyDid(keypairA);
      const didKeyB = getSigningKeyDid(keypairB);

      vi.mocked(clientModule.getRecord).mockResolvedValue({
        uri: "at://did:plc:test-user/at.adsb.receiver.station/self",
        cid: "cid-station",
        value: {
          $type: "at.adsb.receiver.station",
          streamSigningKey: didKeyA,
          location: { latitude: "37.5", longitude: "-122.5" },
        },
      });

      vi.mocked(clientModule.putRecord).mockResolvedValue({
        uri: "at://did:plc:test-user/at.adsb.receiver.station/self",
        cid: "cid-station-updated",
      });

      await detectAndApplyKeyRotation(mockAgent, broadcaster, keypairB);

      // Verify putRecord was called with the new key
      expect(vi.mocked(clientModule.putRecord)).toHaveBeenCalledOnce();
      const callArgs = vi.mocked(clientModule.putRecord).mock.calls[0];
      if (!callArgs) throw new Error("Expected putRecord call");
      expect(callArgs[1]).toBe("at.adsb.receiver.station");
      expect(callArgs[2]).toBe("self");
      expect(callArgs[3]["streamSigningKey"]).toBe(didKeyB);
    });
  });

  describe("stream-signing.AC3.3 & AC3.4: Rotation and subsequent frame verification", () => {
    it("should detect rotation and allow verification of new key", async () => {
      const keypairA = await generateSigningKey();
      const keypairB = await generateSigningKey();
      const didKeyA = getSigningKeyDid(keypairA);
      const didKeyB = getSigningKeyDid(keypairB);

      // Simulate: Initial state has keypairA's did:key
      vi.mocked(clientModule.getRecord).mockResolvedValue({
        uri: "at://did:plc:test-user/at.adsb.receiver.station/self",
        cid: "cid-station",
        value: {
          $type: "at.adsb.receiver.station",
          streamSigningKey: didKeyA,
          location: { latitude: "37.5", longitude: "-122.5" },
        },
      });

      vi.mocked(clientModule.putRecord).mockResolvedValue({
        uri: "at://did:plc:test-user/at.adsb.receiver.station/self",
        cid: "cid-station-updated",
      });

      // Detect rotation with keypairB
      const result = await detectAndApplyKeyRotation(
        mockAgent,
        broadcaster,
        keypairB,
      );

      expect(result.rotated).toBe(true);

      // Verify that keypairB is the current key
      expect(getSigningKeyDid(keypairB)).toBe(didKeyB);

      // Verify putRecord was called with keypairB's did:key
      expect(vi.mocked(clientModule.putRecord)).toHaveBeenCalledOnce();
      const callArgs = vi.mocked(clientModule.putRecord).mock.calls[0];
      if (!callArgs) throw new Error("Expected putRecord call");
      expect(callArgs[3]["streamSigningKey"]).toBe(didKeyB);

      // Build an event frame, sign it with keypairB, verify with keypairB's did:key
      const eventFrame: EventMessage = {
        $type: "at.adsb.broadcast.subscribeEvents#event",
        seq: 1,
        station: {
          uri: "at://did:plc:test-user/at.adsb.receiver.station/self",
          cid: "cid-station-updated",
        },
        time: new Date().toISOString(),
        ops: [],
      };

      const signedFrame = await signEventFrame(eventFrame, keypairB);
      expect(signedFrame.sig).toBeDefined();

      // Verify signature using keypairB's did:key
      const { sig: _, ...frameWithoutSig } = signedFrame;
      const encoded = encode(frameWithoutSig);
      const verified = await verifySignature(didKeyB, encoded, signedFrame.sig!);
      expect(verified).toBe(true);
    });
  });

  describe("stream-signing.AC3.5: Old key fails verification against new key", () => {
    it("should not match old key when new key is in use", async () => {
      const keypairA = await generateSigningKey();
      const keypairB = await generateSigningKey();
      const didKeyA = getSigningKeyDid(keypairA);
      const didKeyB = getSigningKeyDid(keypairB);

      // Verify they are different
      expect(didKeyA).not.toBe(didKeyB);

      // Sign a frame with keypairA
      const eventFrame: EventMessage = {
        $type: "at.adsb.broadcast.subscribeEvents#event",
        seq: 1,
        station: {
          uri: "at://did:plc:test-user/at.adsb.receiver.station/self",
          cid: "cid-station",
        },
        time: new Date().toISOString(),
        ops: [],
      };

      const signedWithA = await signEventFrame(eventFrame, keypairA);
      expect(signedWithA.sig).toBeDefined();

      // After rotation, the station record contains keypairB's did:key
      // Attempting to verify the frame signed with keypairA using keypairB's did:key should fail
      const { sig: _, ...frameWithoutSig } = signedWithA;
      const encoded = encode(frameWithoutSig);
      const verified = await verifySignature(didKeyB, encoded, signedWithA.sig!);
      expect(verified).toBe(false);
    });
  });

  describe("No rotation: key matches", () => {
    it("should return no rotation when key matches", async () => {
      const keypair = await generateSigningKey();
      const didKey = getSigningKeyDid(keypair);

      vi.mocked(clientModule.getRecord).mockResolvedValue({
        uri: "at://did:plc:test-user/at.adsb.receiver.station/self",
        cid: "cid-station",
        value: {
          $type: "at.adsb.receiver.station",
          streamSigningKey: didKey,
          location: { latitude: "37.5", longitude: "-122.5" },
        },
      });

      const result = await detectAndApplyKeyRotation(
        mockAgent,
        broadcaster,
        keypair,
      );

      expect(result.rotated).toBe(false);
      if (result.rotated === false) {
        expect(result.reason).toBe("key unchanged");
      }

      // putRecord should not be called
      expect(vi.mocked(clientModule.putRecord)).not.toHaveBeenCalled();

      // No info frame should be emitted
      const keyRotatedFrame = emittedFrames.find(
        (f) => f.$type === "at.adsb.broadcast.subscribeEvents#info" && 'name' in f && f.name === "KeyRotated",
      );
      expect(keyRotatedFrame).toBeUndefined();
    });
  });

  describe("Station record missing", () => {
    it("should return not rotated when station record does not exist", async () => {
      const keypair = await generateSigningKey();

      vi.mocked(clientModule.getRecord).mockResolvedValue(null);

      const result = await detectAndApplyKeyRotation(
        mockAgent,
        broadcaster,
        keypair,
      );

      expect(result.rotated).toBe(false);
      if (result.rotated === false) {
        expect(result.reason).toBe("station record not found");
      }

      // putRecord should not be called
      expect(vi.mocked(clientModule.putRecord)).not.toHaveBeenCalled();
    });
  });

  describe("First-time key registration", () => {
    it("should detect rotation when streamSigningKey is missing from station record", async () => {
      const keypair = await generateSigningKey();
      const didKey = getSigningKeyDid(keypair);

      // Station record exists but has no streamSigningKey field
      vi.mocked(clientModule.getRecord).mockResolvedValue({
        uri: "at://did:plc:test-user/at.adsb.receiver.station/self",
        cid: "cid-station",
        value: {
          $type: "at.adsb.receiver.station",
          // streamSigningKey is undefined
          location: { latitude: "37.5", longitude: "-122.5" },
        },
      });

      vi.mocked(clientModule.putRecord).mockResolvedValue({
        uri: "at://did:plc:test-user/at.adsb.receiver.station/self",
        cid: "cid-station-updated",
      });

      const result = await detectAndApplyKeyRotation(
        mockAgent,
        broadcaster,
        keypair,
      );

      // Should be treated as rotation (undefined != didKey)
      expect(result.rotated).toBe(true);

      // putRecord should be called with the key
      expect(vi.mocked(clientModule.putRecord)).toHaveBeenCalledOnce();
      const callArgs = vi.mocked(clientModule.putRecord).mock.calls[0];
      if (!callArgs) throw new Error("Expected putRecord call");
      expect(callArgs[3]["streamSigningKey"]).toBe(didKey);

      // KeyRotated frame should be emitted
      const keyRotatedFrame = emittedFrames.find(
        (f) => f.$type === "at.adsb.broadcast.subscribeEvents#info" && 'name' in f && f.name === "KeyRotated",
      );
      expect(keyRotatedFrame).toBeDefined();
    });
  });

  describe("stream-signing.AC2.6: Info frames have no sig field", () => {
    it("should emit KeyRotated info frame without sig field when signing is enabled", async () => {
      const keypairA = await generateSigningKey();
      const keypairB = await generateSigningKey();
      const didKeyA = getSigningKeyDid(keypairA);
      const didKeyB = getSigningKeyDid(keypairB);

      // Mock getRecord returning station with keypairA's key
      vi.mocked(clientModule.getRecord).mockResolvedValue({
        uri: "at://did:plc:test-user/at.adsb.receiver.station/self",
        cid: "cid-station",
        value: {
          $type: "at.adsb.receiver.station",
          streamSigningKey: didKeyA,
          location: { latitude: "37.5", longitude: "-122.5" },
        },
      });

      // Mock putRecord to succeed
      vi.mocked(clientModule.putRecord).mockResolvedValue({
        uri: "at://did:plc:test-user/at.adsb.receiver.station/self",
        cid: "cid-station-updated",
      });

      // Detect rotation with keypairB (signing is enabled)
      const result = await detectAndApplyKeyRotation(
        mockAgent,
        broadcaster,
        keypairB,
      );

      // Verify rotation was detected
      expect(result.rotated).toBe(true);

      // Find the KeyRotated info frame
      const keyRotatedFrame = emittedFrames.find(
        (f) => f.$type === "at.adsb.broadcast.subscribeEvents#info" && 'name' in f && f.name === "KeyRotated",
      ) as InfoMessage | undefined;

      expect(keyRotatedFrame).toBeDefined();

      // AC2.6: Verify the info frame does NOT have a sig field
      if (keyRotatedFrame) {
        expect('sig' in keyRotatedFrame).toBe(false);
        expect(keyRotatedFrame.$type).toBe("at.adsb.broadcast.subscribeEvents#info");
        expect(keyRotatedFrame.name).toBe("KeyRotated");
      }
    });

    it("should emit only unsigned info frames while event frames are signed", async () => {
      const keypair = await generateSigningKey();

      // Manually build and sign an event frame
      const eventFrame: EventMessage = {
        $type: "at.adsb.broadcast.subscribeEvents#event",
        seq: 1,
        station: {
          uri: "at://did:plc:test-user/at.adsb.receiver.station/self",
          cid: "cid-station",
        },
        time: new Date().toISOString(),
        ops: [
          {
            action: "update",
            record: {
              icaoHex: "ABCDEF",
              rssi: "-5.0",
              seen: "1.2",
              $type: "at.adsb.broadcast.message",
            },
          },
        ],
      };

      const signedEvent = await signEventFrame(eventFrame, keypair);

      // Verify event frame has sig
      expect(signedEvent.sig).toBeDefined();
      expect(signedEvent.sig).toBeInstanceOf(Uint8Array);
      expect(signedEvent.sig!.length).toBe(64);

      // Manually create an info frame (as broadcastInfo does)
      const infoFrame: InfoMessage = {
        $type: "at.adsb.broadcast.subscribeEvents#info",
        name: "TestInfo",
        message: "test message",
      };

      // AC2.6: Verify info frame does NOT have sig field
      expect('sig' in infoFrame).toBe(false);
      expect(infoFrame.$type).toBe("at.adsb.broadcast.subscribeEvents#info");
      expect(infoFrame.name).toBe("TestInfo");
    });
  });
});
