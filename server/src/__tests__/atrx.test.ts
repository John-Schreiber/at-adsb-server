import { describe, it, expect } from "vitest";
import {
  buildAtrxBlob,
  parseAtrxBlob,
  countBeastFrames,
  countUatFrames,
  concatAtrxBlobs,
  splitAtrxBlobs,
  type AtrxMetadata,
} from "../atrx.js";

// --- Test Data Builders ---

function createTestMetadata(
  overrides?: Readonly<Partial<AtrxMetadata>>,
): AtrxMetadata {
  return {
    receiverDid: "did:plc:test123456789abcdefgh",
    windowStart: "2026-05-25T10:00:00.000Z",
    windowEnd: "2026-05-25T10:01:00.000Z",
    clockSource: "gps",
    protocol: "beast-1090",
    demodSoftware: "readsb",
    frameCount: 0,
    ...overrides,
  };
}


// --- AC1: ATRX Envelope Format ---

describe("raw-capture-blob.AC1: ATRX Envelope Format", () => {
  describe("AC1.1: Magic, version, flags, reserved", () => {
    it("should start with ATRX magic at offset 0", () => {
      const metadata = createTestMetadata({ frameCount: 0 });
      const frames = Buffer.alloc(0);
      const blob = buildAtrxBlob(metadata, frames);

      expect(blob.length).toBeGreaterThanOrEqual(8);
      expect(blob.subarray(0, 4).toString("ascii")).toBe("ATRX");
    });

    it("should have version 0x02 at offset 4", () => {
      const metadata = createTestMetadata({ frameCount: 0 });
      const frames = Buffer.alloc(0);
      const blob = buildAtrxBlob(metadata, frames);

      const byte4 = blob[4];
      expect(byte4).toBe(0x02);
    });

    it("should have flags at offset 5", () => {
      const metadata = createTestMetadata({ frameCount: 0 });
      const frames = Buffer.alloc(0);
      const blob = buildAtrxBlob(metadata, frames);

      const byte5 = blob[5];
      expect(byte5).toBe(0x01); // zstd flag
    });

    it("should have reserved bytes 0x00 at offsets 6-7", () => {
      const metadata = createTestMetadata({ frameCount: 0 });
      const frames = Buffer.alloc(0);
      const blob = buildAtrxBlob(metadata, frames);

      const byte6 = blob[6];
      const byte7 = blob[7];
      expect(byte6).toBe(0x00);
      expect(byte7).toBe(0x00);
    });

    it("should have total header size of 8 bytes", () => {
      const metadata = createTestMetadata({ frameCount: 0 });
      const frames = Buffer.alloc(0);
      const blob = buildAtrxBlob(metadata, frames);

      // At least 8 for header + 4 for length + some for CBOR
      expect(blob.length).toBeGreaterThanOrEqual(8 + 4);
    });
  });

  describe("AC1.2: Flags byte - zstd compression indicator", () => {
    it("should have bit 0 set for zstd compression", () => {
      const metadata = createTestMetadata({ frameCount: 0 });
      const frames = Buffer.alloc(0);
      const blob = buildAtrxBlob(metadata, frames);

      const flags = blob[5] ?? 0;
      expect((flags & 0x01) === 0x01).toBe(true);
    });

    it("should have no other bits set (reserved bits must be 0)", () => {
      const metadata = createTestMetadata({ frameCount: 0 });
      const frames = Buffer.alloc(0);
      const blob = buildAtrxBlob(metadata, frames);

      const flags = blob[5] ?? 0;
      // Only bit 0 should be set, so flags & 0xfe should be 0
      expect((flags & 0xfe) === 0).toBe(true);
    });
  });

  describe("AC1.3: Metadata length prefix and CBOR encoding", () => {
    it("should have 4-byte big-endian length at offset 8", () => {
      const metadata = createTestMetadata({ frameCount: 0 });
      const frames = Buffer.alloc(0);
      const blob = buildAtrxBlob(metadata, frames);

      const length = blob.readUInt32BE(8);
      expect(typeof length).toBe("number");
      expect(length).toBeGreaterThan(0);
    });

    it("should decode CBOR metadata from offset 12", () => {
      const metadata = createTestMetadata({ frameCount: 0 });
      const frames = Buffer.alloc(0);
      const blob = buildAtrxBlob(metadata, frames);

      const parsed = parseAtrxBlob(blob);
      expect(parsed.metadata.receiverDid).toBe(metadata.receiverDid);
    });
  });

  describe("AC1.4: Frame payload compression", () => {
    it("should compress frame payload with zstd", () => {
      const frameData = Buffer.from([0x1a, 0x31, 0, 0, 0, 0, 0, 1, 0x80]);
      const metadata = createTestMetadata({ protocol: "beast-1090", frameCount: 1 });
      const blob = buildAtrxBlob(metadata, frameData);

      const parsed = parseAtrxBlob(blob);
      expect(parsed.frames.equals(frameData)).toBe(true);
    });

    it("decompressed frames should match original", () => {
      // Empty frames but protocol requires proper count check
      const originalFrames = Buffer.alloc(0);
      const metadata = createTestMetadata({ frameCount: 0 });
      const blob = buildAtrxBlob(metadata, originalFrames);

      const parsed = parseAtrxBlob(blob);
      expect(parsed.frames.equals(originalFrames)).toBe(true);
    });
  });

  describe("AC1.5: Header and metadata readable without decompression", () => {
    it("should be able to read header and metadata without knowing frames", () => {
      const frameData = Buffer.from([0x1a, 0x31, 0, 0, 0, 0, 0, 1, 0x80]);
      const metadata = createTestMetadata({
        protocol: "beast-1090",
        frameCount: 1,
        demodSoftware: "readsb-test",
      });
      const blob = buildAtrxBlob(metadata, frameData);

      const parsed = parseAtrxBlob(blob);
      expect(parsed.header.magic).toBe("ATRX");
      expect(parsed.header.version).toBe(0x02);
      expect(parsed.header.flags).toBe(0x01);
      expect(parsed.metadata.demodSoftware).toBe("readsb-test");
    });
  });

  describe("Failure cases", () => {
    it("should throw on invalid magic bytes", () => {
      const blob = Buffer.from("BADX" + "01010000");
      expect(() => parseAtrxBlob(blob)).toThrow("invalid ATRX magic");
    });

    it("should throw on non-zero reserved bytes", () => {
      const metadata = createTestMetadata({ frameCount: 0 });
      const frames = Buffer.alloc(0);
      const blob = buildAtrxBlob(metadata, frames);

      // Corrupt reserved byte
      blob[6] = 0x01;
      expect(() => parseAtrxBlob(blob)).toThrow("non-zero reserved bytes");
    });

    it("should throw on buffer too short", () => {
      const blob = Buffer.from("AT");
      expect(() => parseAtrxBlob(blob)).toThrow("buffer too short");
    });

    it("should throw on buffer too short for metadata length", () => {
      const blob = Buffer.alloc(8);
      blob.write("ATRX", 0);
      blob[4] = 0x01;
      blob[5] = 0x01;
      expect(() => parseAtrxBlob(blob)).toThrow("buffer too short");
    });
  });
});

// --- AC2: Capture Metadata ---

describe("raw-capture-blob.AC2: Capture Metadata", () => {
  describe("AC2.1: Required metadata fields", () => {
    it("should encode and decode all required fields", () => {
      // Build proper frame data to match frameCount
      const frames = Buffer.concat([
        Buffer.from([0x1a, 0x31, 0, 0, 0, 0, 0, 1, 0x80]),
        Buffer.from([0x1a, 0x32, 0, 0, 0, 0, 0, 2, 0x80, 0xff]),
      ]);

      const metadata = createTestMetadata({
        receiverDid: "did:plc:abc123",
        windowStart: "2026-05-25T10:00:00.000Z",
        windowEnd: "2026-05-25T10:01:00.000Z",
        clockSource: "gps",
        protocol: "beast-1090",
        demodSoftware: "readsb-5.0",
        frameCount: 2,
      });

      const blob = buildAtrxBlob(metadata, frames);
      const parsed = parseAtrxBlob(blob);

      expect(parsed.metadata.receiverDid).toBe("did:plc:abc123");
      expect(parsed.metadata.windowStart).toBe("2026-05-25T10:00:00.000Z");
      expect(parsed.metadata.windowEnd).toBe("2026-05-25T10:01:00.000Z");
      expect(parsed.metadata.clockSource).toBe("gps");
      expect(parsed.metadata.protocol).toBe("beast-1090");
      expect(parsed.metadata.demodSoftware).toBe("readsb-5.0");
      expect(parsed.metadata.frameCount).toBe(2);
    });
  });

  describe("AC2.2: Optional metadata fields", () => {
    it("should encode and decode optional fields", () => {
      const metadata = createTestMetadata({
        frameCount: 0,
        gainDb: "49.6",
        sdrHardware: "rtlsdr",
        sampleRateHz: 2000000,
        centerFreqHz: 1090000000,
        ntpServer: "pool.ntp.org",
      });

      const blob = buildAtrxBlob(metadata, Buffer.alloc(0));
      const parsed = parseAtrxBlob(blob);

      expect(parsed.metadata.gainDb).toBe("49.6");
      expect(parsed.metadata.sdrHardware).toBe("rtlsdr");
      expect(parsed.metadata.sampleRateHz).toBe(2000000);
      expect(parsed.metadata.centerFreqHz).toBe(1090000000);
      expect(parsed.metadata.ntpServer).toBe("pool.ntp.org");
    });

    it("should omit optional fields when not provided", () => {
      const metadata = createTestMetadata({ frameCount: 0 });
      const blob = buildAtrxBlob(metadata, Buffer.alloc(0));
      const parsed = parseAtrxBlob(blob);

      expect(parsed.metadata.gainDb).toBeUndefined();
      expect(parsed.metadata.sdrHardware).toBeUndefined();
      expect(parsed.metadata.sampleRateHz).toBeUndefined();
      expect(parsed.metadata.centerFreqHz).toBeUndefined();
      expect(parsed.metadata.ntpServer).toBeUndefined();
    });
  });

  describe("AC2.3: clockSource validation", () => {
    it('should accept "gps" as clockSource', () => {
      const metadata = createTestMetadata({ clockSource: "gps", frameCount: 0 });
      const blob = buildAtrxBlob(metadata, Buffer.alloc(0));
      const parsed = parseAtrxBlob(blob);
      expect(parsed.metadata.clockSource).toBe("gps");
    });

    it('should accept "ntp" as clockSource', () => {
      const metadata = createTestMetadata({ clockSource: "ntp", frameCount: 0 });
      const blob = buildAtrxBlob(metadata, Buffer.alloc(0));
      const parsed = parseAtrxBlob(blob);
      expect(parsed.metadata.clockSource).toBe("ntp");
    });

    it('should accept "system" as clockSource', () => {
      const metadata = createTestMetadata({ clockSource: "system", frameCount: 0 });
      const blob = buildAtrxBlob(metadata, Buffer.alloc(0));
      const parsed = parseAtrxBlob(blob);
      expect(parsed.metadata.clockSource).toBe("system");
    });
  });

  describe("AC2.4: protocol identification", () => {
    it('should support "beast-1090" protocol', () => {
      const metadata = createTestMetadata({ protocol: "beast-1090", frameCount: 0 });
      const blob = buildAtrxBlob(metadata, Buffer.alloc(0));
      const parsed = parseAtrxBlob(blob);
      expect(parsed.metadata.protocol).toBe("beast-1090");
    });

    it('should support "uat-978" protocol', () => {
      const metadata = createTestMetadata({ protocol: "uat-978", frameCount: 0 });
      const blob = buildAtrxBlob(metadata, Buffer.alloc(0));
      const parsed = parseAtrxBlob(blob);
      expect(parsed.metadata.protocol).toBe("uat-978");
    });
  });

  describe("AC2.5: Fractional numbers as strings", () => {
    it("should store gainDb as string", () => {
      const metadata = createTestMetadata({
        frameCount: 0,
        gainDb: "49.6",
      });
      const blob = buildAtrxBlob(metadata, Buffer.alloc(0));
      const parsed = parseAtrxBlob(blob);
      expect(typeof parsed.metadata.gainDb).toBe("string");
      expect(parsed.metadata.gainDb).toBe("49.6");
    });
  });

  describe("AC2.6: ntpServer optional field", () => {
    it("should encode ntpServer", () => {
      const metadata = createTestMetadata({
        frameCount: 0,
        ntpServer: "pool.ntp.org",
      });
      const blob = buildAtrxBlob(metadata, Buffer.alloc(0));
      const parsed = parseAtrxBlob(blob);
      expect(parsed.metadata.ntpServer).toBe("pool.ntp.org");
    });
  });

  describe("frameCount validation", () => {
    it("should validate frameCount matches BEAST frame count", () => {
      // Build a blob with 2 BEAST frames
      const frame1 = Buffer.from([0x1a, 0x31, 0, 0, 0, 0, 0, 1, 0x80]);
      const frame2 = Buffer.from([0x1a, 0x32, 0, 0, 0, 0, 0, 1, 0x80, 0xff]);
      const frames = Buffer.concat([frame1, frame2]);

      const metadata = createTestMetadata({
        protocol: "beast-1090",
        frameCount: 2,
      });

      const blob = buildAtrxBlob(metadata, frames);
      const parsed = parseAtrxBlob(blob);
      expect(parsed.metadata.frameCount).toBe(2);
    });

    it("should throw on BEAST frameCount mismatch", () => {
      const frames = Buffer.from([0x1a, 0x31, 0, 0, 0, 0, 0, 1, 0x80]);
      const metadata = createTestMetadata({
        protocol: "beast-1090",
        frameCount: 5, // Wrong count
      });

      const blob = buildAtrxBlob(metadata, frames);
      expect(() => parseAtrxBlob(blob)).toThrow(
        "frameCount mismatch: metadata says 5, payload contains 1",
      );
    });

    it("should validate frameCount matches UAT line count", () => {
      const uatFrames = Buffer.from("+8D40650D4090D5B8C04853A55C10C\n-500C5603C00000000000000000\n");
      const metadata = createTestMetadata({
        protocol: "uat-978",
        frameCount: 2,
      });

      const blob = buildAtrxBlob(metadata, uatFrames);
      const parsed = parseAtrxBlob(blob);
      expect(parsed.metadata.frameCount).toBe(2);
    });

    it("should throw on UAT frameCount mismatch", () => {
      const uatFrames = Buffer.from("+8D40650D4090D5B8C04853A55C10C\n");
      const metadata = createTestMetadata({
        protocol: "uat-978",
        frameCount: 3, // Wrong count
      });

      const blob = buildAtrxBlob(metadata, uatFrames);
      expect(() => parseAtrxBlob(blob)).toThrow(
        "frameCount mismatch: metadata says 3, payload contains 1",
      );
    });
  });
});

// --- AC3: Frame Payload ---

describe("raw-capture-blob.AC3: Frame Payload", () => {
  describe("AC3.2: BEAST frame format and counting", () => {
    it("should count BEAST mode-S long frames (0x33)", () => {
      const frame = Buffer.from([0x1a, 0x33, 0, 0, 0, 0, 0, 1, 0x80]);
      const count = countBeastFrames(frame);
      expect(count).toBe(1);
    });

    it("should count BEAST mode-S short frames (0x32)", () => {
      const frame = Buffer.from([0x1a, 0x32, 0, 0, 0, 0, 0, 1, 0x80]);
      const count = countBeastFrames(frame);
      expect(count).toBe(1);
    });

    it("should count BEAST mode-A/C frames (0x31)", () => {
      const frame = Buffer.from([0x1a, 0x31, 0, 0, 0, 0, 0, 1, 0x80]);
      const count = countBeastFrames(frame);
      expect(count).toBe(1);
    });

    it("should handle escaped 0x1a bytes (not counted)", () => {
      // 0x1a 0x1a is an escaped literal 0x1a, should not be counted as frame start
      const payload = Buffer.from([0x1a, 0x1a, 0x1a, 0x31, 0, 0, 0, 0, 0, 1, 0x80]);
      const count = countBeastFrames(payload);
      expect(count).toBe(1); // Only the 0x1a 0x31 frame
    });

    it("should skip receiver ID frames (0x1a 0xe3)", () => {
      const payload = Buffer.from([0x1a, 0xe3, 0, 0, 0, 0, 0, 0, 0x1a, 0x31, 0, 0, 0, 0, 0, 1, 0x80]);
      const count = countBeastFrames(payload);
      expect(count).toBe(1); // Receiver ID not counted, only the frame
    });

    it("should count multiple BEAST frames", () => {
      const payload = Buffer.concat([
        Buffer.from([0x1a, 0x31, 0, 0, 0, 0, 0, 1, 0x80]),
        Buffer.from([0x1a, 0x32, 0, 0, 0, 0, 0, 1, 0x80, 0xff]),
        Buffer.from([0x1a, 0x33, 0, 0, 0, 0, 0, 1, 0x80, 0xff, 0xff, 0xff]),
      ]);
      const count = countBeastFrames(payload);
      expect(count).toBe(3);
    });

    it("should not double-count when 0x1a appears in timestamp/signal/message data", () => {
      // BEAST frame with 0x1a byte in the timestamp field, properly escaped as 0x1a 0x1a
      // 0x1a = escape, 0x31 = type (mode-A/C), 0x1a 0x1a = escaped 0x1a in timestamp, etc.
      const payload = Buffer.from([
        0x1a, 0x31,           // Frame escape + type
        0x1a, 0x1a,           // Escaped 0x1a in timestamp (first byte)
        0x00, 0x00, 0x00, 0x01, // Rest of timestamp
        0x1a, 0x1a,           // Escaped 0x1a in signal field
        0x00,                 // Message (1 byte for mode-A/C)
      ]);
      const count = countBeastFrames(payload);
      expect(count).toBe(1); // Should count as 1 frame, not 2
    });
  });

  describe("AC3.3: UAT AVR format", () => {
    it("should count UAT AVR lines starting with +", () => {
      const payload = Buffer.from("+8D40650D4090D5B8C04853A55C10C");
      const count = countUatFrames(payload);
      expect(count).toBe(1);
    });

    it("should count UAT AVR lines starting with -", () => {
      const payload = Buffer.from("-500C5603C00000000000000000");
      const count = countUatFrames(payload);
      expect(count).toBe(1);
    });

    it("should handle newline-delimited UAT frames", () => {
      const payload = Buffer.from(
        "+8D40650D4090D5B8C04853A55C10C\n-500C5603C00000000000000000\n",
      );
      const count = countUatFrames(payload);
      expect(count).toBe(2);
    });

    it("should not count empty lines", () => {
      const payload = Buffer.from("+8D40650D4090D5B8C04853A55C10C\n\n-500C5603C00000000000000000\n");
      const count = countUatFrames(payload);
      expect(count).toBe(2);
    });

    it("should not count lines without +/- prefix", () => {
      const payload = Buffer.from("junk\n+8D40650D4090D5B8C04853A55C10C\n");
      const count = countUatFrames(payload);
      expect(count).toBe(1);
    });
  });

  describe("AC3.4: UAT frames with timestamp extension", () => {
    it("should count UAT frames with ;t= timestamp extension", () => {
      const payload = Buffer.from("+8D40650D4090D5B8C04853A55C10C;t=1716555600.123\n");
      const count = countUatFrames(payload);
      expect(count).toBe(1);
    });

    it("should survive round-trip with timestamp extension", () => {
      const originalFrames = Buffer.from("+8D40650D4090D5B8C04853A55C10C;t=1716555600.123\n");
      const metadata = createTestMetadata({
        protocol: "uat-978",
        frameCount: 1,
      });

      const blob = buildAtrxBlob(metadata, originalFrames);
      const parsed = parseAtrxBlob(blob);
      expect(parsed.frames.toString()).toBe(originalFrames.toString());
    });
  });

  describe("AC3.5: Frame order preservation", () => {
    it("should preserve BEAST frame order", () => {
      const frame1 = Buffer.from([0x1a, 0x31, 0x00, 0x00, 0x00, 0x00, 0x00, 0x01, 0x80]);
      const frame2 = Buffer.from([0x1a, 0x32, 0x00, 0x00, 0x00, 0x00, 0x00, 0x02, 0x80]);
      const frame3 = Buffer.from([0x1a, 0x33, 0x00, 0x00, 0x00, 0x00, 0x00, 0x03, 0x80]);
      const frames = Buffer.concat([frame1, frame2, frame3]);

      const metadata = createTestMetadata({
        protocol: "beast-1090",
        frameCount: 3,
      });

      const blob = buildAtrxBlob(metadata, frames);
      const parsed = parseAtrxBlob(blob);
      expect(parsed.frames.equals(frames)).toBe(true);
    });

    it("should preserve UAT frame order", () => {
      const originalFrames = Buffer.from(
        "+AAAAAA\n+BBBBBB\n+CCCCCC\n",
      );

      const metadata = createTestMetadata({
        protocol: "uat-978",
        frameCount: 3,
      });

      const blob = buildAtrxBlob(metadata, originalFrames);
      const parsed = parseAtrxBlob(blob);
      expect(parsed.frames.toString()).toBe(originalFrames.toString());
    });
  });

  describe("AC3.7: zstd compression level 3", () => {
    it("should compress with zstd and decompress successfully", () => {
      const originalFrames = Buffer.from("x".repeat(1000));
      const metadata = createTestMetadata({ frameCount: 0 });

      const blob = buildAtrxBlob(metadata, originalFrames);
      // v2 layout: header(8) + metaLen(4) + metadata + payloadLen(4) + payload
      const compressed = blob.subarray(8 + 4 + blob.readUInt32BE(8) + 4);
      expect(compressed.length).toBeLessThan(originalFrames.length);

      const parsed = parseAtrxBlob(blob);
      expect(parsed.frames.equals(originalFrames)).toBe(true);
    });

    it("should use zstd compression (frames compressed after metadata)", () => {
      const originalFrames = Buffer.from("repetitive data ".repeat(100));
      const metadata = createTestMetadata({ frameCount: 0 });

      const blob = buildAtrxBlob(metadata, originalFrames);
      const metadataLen = blob.readUInt32BE(8);
      // v2 layout: header(8) + metaLen(4) + metadata + payloadLen(4) + payload
      const totalHeaderAndMeta = 8 + 4 + metadataLen + 4;
      const compressedPayload = blob.subarray(totalHeaderAndMeta);

      // Verify it's actually compressed (should be significantly smaller)
      expect(compressedPayload.length).toBeLessThan(originalFrames.length / 2);

      // And verify it decompresses correctly
      const parsed = parseAtrxBlob(blob);
      expect(parsed.frames.equals(originalFrames)).toBe(true);
    });
  });

  describe("Failure cases", () => {
    it("should reject frames that don't match protocol", () => {
      // Beast frames in a UAT blob
      const beastFrames = Buffer.from([0x1a, 0x31, 0, 0, 0, 0, 0, 1, 0x80]);
      const metadata = createTestMetadata({
        protocol: "uat-978",
        frameCount: 1,
      });

      const blob = buildAtrxBlob(metadata, beastFrames);
      expect(() => parseAtrxBlob(blob)).toThrow("frameCount mismatch");
    });
  });
});

// --- Round-trip integration tests ---

describe("Round-trip integration tests", () => {
  it("should encode and decode BEAST blob with multiple frames", () => {
    const frames = Buffer.concat([
      Buffer.from([0x1a, 0x31, 0, 0, 0, 0, 0, 1, 0x80]),
      Buffer.from([0x1a, 0x32, 0, 0, 0, 0, 0, 2, 0x80, 0xff]),
    ]);

    const metadata = createTestMetadata({
      receiverDid: "did:plc:test123",
      windowStart: "2026-05-25T10:00:00Z",
      windowEnd: "2026-05-25T10:01:00Z",
      clockSource: "ntp",
      protocol: "beast-1090",
      demodSoftware: "readsb-5.0",
      frameCount: 2,
      gainDb: "40.0",
      sdrHardware: "rtlsdr",
    });

    const blob = buildAtrxBlob(metadata, frames);
    const parsed = parseAtrxBlob(blob);

    expect(parsed.header.magic).toBe("ATRX");
    expect(parsed.header.version).toBe(0x02);
    expect(parsed.header.flags).toBe(0x01);
    expect(parsed.metadata.receiverDid).toBe("did:plc:test123");
    expect(parsed.metadata.frameCount).toBe(2);
    expect(parsed.frames.equals(frames)).toBe(true);
  });

  it("should encode and decode UAT blob with timestamp extensions", () => {
    const frames = Buffer.from(
      "+8D40650D4090D5B8C04853A55C10C;t=1716555600.123\n-500C5603C00000000000000000;t=1716555600.124\n",
    );

    const metadata = createTestMetadata({
      protocol: "uat-978",
      frameCount: 2,
      centerFreqHz: 978000000,
      sampleRateHz: 960000,
    });

    const blob = buildAtrxBlob(metadata, frames);
    const parsed = parseAtrxBlob(blob);

    expect(parsed.metadata.protocol).toBe("uat-978");
    expect(parsed.metadata.frameCount).toBe(2);
    expect(parsed.frames.toString()).toBe(frames.toString());
  });
});

// --- v2 envelope: payload length framing ---

// v1 layout is the v2 layout without the 4-byte payload length prefix.
function buildLegacyV1Blob(metadata: AtrxMetadata, frames: Buffer): Buffer {
  const v2 = buildAtrxBlob(metadata, frames);
  const metadataEnd = 8 + 4 + v2.readUInt32BE(8);
  const legacy = Buffer.concat([
    v2.subarray(0, metadataEnd),
    v2.subarray(metadataEnd + 4),
  ]);
  legacy[4] = 0x01;
  return legacy;
}

// Deterministic high-entropy bytes; zstd stores these as raw literals, so
// sequences embedded in the frames survive into the compressed payload.
function pseudoRandomBytes(length: number, seed: number): Buffer {
  const out = Buffer.alloc(length);
  let state = seed;
  for (let i = 0; i < length; i++) {
    state = (state * 1664525 + 1013904223) >>> 0;
    out[i] = state >>> 24;
  }
  return out;
}

describe("ATRX v2 payload length framing", () => {
  it("encodes the payload length after the metadata block", () => {
    const frames = Buffer.from([0x1a, 0x31, 0, 0, 0, 0, 0, 1, 0x80]);
    const metadata = createTestMetadata({ protocol: "beast-1090", frameCount: 1 });

    const blob = buildAtrxBlob(metadata, frames);
    const metadataEnd = 8 + 4 + blob.readUInt32BE(8);
    const payloadLength = blob.readUInt32BE(metadataEnd);

    expect(payloadLength).toBe(blob.length - metadataEnd - 4);
  });

  it("rejects trailing data after the declared payload", () => {
    const blob = buildAtrxBlob(createTestMetadata({ frameCount: 0 }), Buffer.alloc(0));

    const padded = Buffer.concat([blob, Buffer.from([0x00, 0x01])]);

    expect(() => parseAtrxBlob(padded)).toThrow("trailing data");
  });

  it("rejects a truncated payload", () => {
    const blob = buildAtrxBlob(createTestMetadata({ frameCount: 0 }), Buffer.alloc(0));

    const truncated = blob.subarray(0, blob.length - 1);

    expect(() => parseAtrxBlob(truncated)).toThrow("buffer too short for declared payload length");
  });

  it("rejects unsupported versions", () => {
    const blob = buildAtrxBlob(createTestMetadata({ frameCount: 0 }), Buffer.alloc(0));
    blob[4] = 0x03;

    expect(() => parseAtrxBlob(blob)).toThrow("unsupported ATRX version");
  });

  it("still parses legacy v1 blobs (payload runs to end of buffer)", () => {
    const frames = Buffer.from([0x1a, 0x31, 0, 0, 0, 0, 0, 1, 0x80]);
    const legacy = buildLegacyV1Blob(
      createTestMetadata({ protocol: "beast-1090", frameCount: 1 }),
      frames,
    );

    const parsed = parseAtrxBlob(legacy);

    expect(parsed.header.version).toBe(0x01);
    expect(parsed.frames.equals(frames)).toBe(true);
  });

  it("splits a sole legacy v1 blob as a single section", () => {
    const legacy = buildLegacyV1Blob(createTestMetadata({ frameCount: 0 }), Buffer.alloc(0));

    const sections = splitAtrxBlobs(legacy);

    expect(sections).toHaveLength(1);
    expect(sections[0]!.equals(legacy)).toBe(true);
  });

  it("splits correctly when a compressed payload contains the ATRX magic bytes", () => {
    // Regression: the previous splitter scanned payload bytes for the next
    // magic sequence, so magic bytes occurring inside a compressed payload
    // produced a corrupt split.
    const noise = pseudoRandomBytes(4096, 42);
    const frames1 = Buffer.concat([
      Buffer.from("ATRX"),
      noise,
      Buffer.from("ATRX"),
    ]);
    const blob1 = buildAtrxBlob(
      createTestMetadata({
        protocol: "beast-1090",
        frameCount: countBeastFrames(frames1),
      }),
      frames1,
    );
    const blob2 = buildAtrxBlob(
      createTestMetadata({ protocol: "uat-978", frameCount: 1 }),
      Buffer.from("+AABBCC\n"),
    );

    const concatenated = concatAtrxBlobs([blob1, blob2]);

    // Sanity: a spurious magic sequence really is present inside the first
    // section, before the second section's true header.
    const spurious = concatenated.indexOf(Buffer.from("ATRX"), 4);
    expect(spurious).toBeGreaterThan(0);
    expect(spurious).toBeLessThan(blob1.length);

    const sections = splitAtrxBlobs(concatenated);

    expect(sections).toHaveLength(2);
    expect(sections[0]!.equals(blob1)).toBe(true);
    expect(sections[1]!.equals(blob2)).toBe(true);
    expect(parseAtrxBlob(sections[0]!).frames.equals(frames1)).toBe(true);
    expect(parseAtrxBlob(sections[1]!).metadata.protocol).toBe("uat-978");
  });
});

// --- AC6: ATRX Concatenation and Splitting ---

describe("multi-input-adapters.AC6: ATRX Concatenation", () => {
  describe("AC6.1: Single blob concatenation (identity)", () => {
    it("should preserve single blob byte-identically through concat", () => {
      const frames = Buffer.from([0x1a, 0x31, 0, 0, 0, 0, 0, 1, 0x80]);
      const metadata = createTestMetadata({
        protocol: "beast-1090",
        frameCount: 1,
      });
      const blob = buildAtrxBlob(metadata, frames);

      const concatenated = concatAtrxBlobs([blob]);

      expect(concatenated.equals(blob)).toBe(true);
      const parsed = parseAtrxBlob(concatenated);
      expect(parsed.metadata.frameCount).toBe(1);
    });

    it("should be parseable after concat", () => {
      const frames = Buffer.concat([
        Buffer.from([0x1a, 0x31, 0, 0, 0, 0, 0, 1, 0x80]),
        Buffer.from([0x1a, 0x32, 0, 0, 0, 0, 0, 2, 0x80, 0xff]),
      ]);
      const metadata = createTestMetadata({
        protocol: "beast-1090",
        frameCount: 2,
      });
      const blob = buildAtrxBlob(metadata, frames);

      const concatenated = concatAtrxBlobs([blob]);
      const parsed = parseAtrxBlob(concatenated);

      expect(parsed.metadata.frameCount).toBe(2);
      expect(parsed.frames.equals(frames)).toBe(true);
    });
  });

  describe("AC6.2: Multi-blob concatenation", () => {
    it("should concatenate two blobs with different protocols", () => {
      const blob1 = buildAtrxBlob(
        createTestMetadata({
          protocol: "beast-1090",
          frameCount: 1,
          demodSoftware: "readsb",
        }),
        Buffer.from([0x1a, 0x31, 0, 0, 0, 0, 0, 1, 0x80]),
      );

      const blob2 = buildAtrxBlob(
        createTestMetadata({
          protocol: "uat-978",
          frameCount: 1,
          demodSoftware: "dump978",
        }),
        Buffer.from("+8D40650D4090D5B8C04853A55C10C\n"),
      );

      const concatenated = concatAtrxBlobs([blob1, blob2]);

      // Should be bigger than either individual blob
      expect(concatenated.length).toBe(blob1.length + blob2.length);

      // Should be splittable into two sections
      const sections = splitAtrxBlobs(concatenated);
      expect(sections).toHaveLength(2);

      // Each section should be parseable
      const section0 = sections[0];
      const section1 = sections[1];
      if (!section0 || !section1) {
        throw new Error("Expected 2 sections");
      }
      const parsed1 = parseAtrxBlob(section0);
      const parsed2 = parseAtrxBlob(section1);

      expect(parsed1.metadata.protocol).toBe("beast-1090");
      expect(parsed1.metadata.demodSoftware).toBe("readsb");
      expect(parsed2.metadata.protocol).toBe("uat-978");
      expect(parsed2.metadata.demodSoftware).toBe("dump978");
    });

    it("should preserve metadata when splitting concatenated blobs", () => {
      const blob1 = buildAtrxBlob(
        createTestMetadata({
          protocol: "beast-1090",
          frameCount: 2,
          sdrHardware: "rtlsdr",
        }),
        Buffer.concat([
          Buffer.from([0x1a, 0x31, 0, 0, 0, 0, 0, 1, 0x80]),
          Buffer.from([0x1a, 0x32, 0, 0, 0, 0, 0, 2, 0x80, 0xff]),
        ]),
      );

      const blob2 = buildAtrxBlob(
        createTestMetadata({
          protocol: "beast-1090",
          frameCount: 1,
          sdrHardware: "airspy",
        }),
        Buffer.from([0x1a, 0x33, 0, 0, 0, 0, 0, 1, 0x80]),
      );

      const concatenated = concatAtrxBlobs([blob1, blob2]);
      const sections = splitAtrxBlobs(concatenated);

      expect(sections).toHaveLength(2);
      const section0 = sections[0];
      const section1 = sections[1];
      if (!section0 || !section1) {
        throw new Error("Expected 2 sections");
      }
      const parsed1 = parseAtrxBlob(section0);
      const parsed2 = parseAtrxBlob(section1);

      expect(parsed1.metadata.sdrHardware).toBe("rtlsdr");
      expect(parsed1.metadata.frameCount).toBe(2);
      expect(parsed2.metadata.sdrHardware).toBe("airspy");
      expect(parsed2.metadata.frameCount).toBe(1);
    });
  });

  describe("AC6.3: Empty input", () => {
    it("should return empty buffer when concatenating empty list", () => {
      const concatenated = concatAtrxBlobs([]);
      expect(concatenated.length).toBe(0);
    });
  });

  describe("AC6.4: Three-blob round-trip", () => {
    it("should split three concatenated blobs independently", () => {
      const blob1 = buildAtrxBlob(
        createTestMetadata({
          protocol: "beast-1090",
          frameCount: 1,
        }),
        Buffer.from([0x1a, 0x31, 0, 0, 0, 0, 0, 1, 0x80]),
      );

      const blob2 = buildAtrxBlob(
        createTestMetadata({
          protocol: "uat-978",
          frameCount: 1,
        }),
        Buffer.from("+AABBCCDD\n"),
      );

      const blob3 = buildAtrxBlob(
        createTestMetadata({
          protocol: "beast-1090",
          frameCount: 2,
        }),
        Buffer.concat([
          Buffer.from([0x1a, 0x32, 0, 0, 0, 0, 0, 1, 0x80]),
          Buffer.from([0x1a, 0x33, 0, 0, 0, 0, 0, 2, 0x80, 0xff]),
        ]),
      );

      const concatenated = concatAtrxBlobs([blob1, blob2, blob3]);
      const sections = splitAtrxBlobs(concatenated);

      expect(sections).toHaveLength(3);

      const section0 = sections[0];
      const section1 = sections[1];
      const section2 = sections[2];
      if (!section0 || !section1 || !section2) {
        throw new Error("Expected 3 sections");
      }
      const parsed1 = parseAtrxBlob(section0);
      const parsed2 = parseAtrxBlob(section1);
      const parsed3 = parseAtrxBlob(section2);

      expect(parsed1.metadata.protocol).toBe("beast-1090");
      expect(parsed1.metadata.frameCount).toBe(1);

      expect(parsed2.metadata.protocol).toBe("uat-978");
      expect(parsed2.metadata.frameCount).toBe(1);

      expect(parsed3.metadata.protocol).toBe("beast-1090");
      expect(parsed3.metadata.frameCount).toBe(2);
    });
  });

  describe("splitAtrxBlobs with valid concatenated blobs", () => {
    it("should correctly identify section boundaries by reading metadata length", () => {
      // Create two blobs with distinctly different frame sizes
      const smallBlob = buildAtrxBlob(
        createTestMetadata({
          protocol: "beast-1090",
          frameCount: 1,
        }),
        Buffer.from([0x1a, 0x31, 0, 0, 0, 0, 0, 1, 0x80]),
      );

      const largeBlob = buildAtrxBlob(
        createTestMetadata({
          protocol: "beast-1090",
          frameCount: 10,
        }),
        Buffer.concat(
          Array.from({length: 10}, () => Buffer.from([0x1a, 0x31, 0, 0, 0, 0, 0, 1, 0x80])),
        ),
      );

      const concatenated = concatAtrxBlobs([smallBlob, largeBlob]);
      const sections = splitAtrxBlobs(concatenated);

      expect(sections).toHaveLength(2);

      // Verify each section is independently valid
      const sec0 = sections[0];
      const sec1 = sections[1];
      if (!sec0 || !sec1) throw new Error("Missing sections");

      const p0 = parseAtrxBlob(sec0);
      const p1 = parseAtrxBlob(sec1);

      expect(p0.metadata.frameCount).toBe(1);
      expect(p1.metadata.frameCount).toBe(10);
    });
  });
});
