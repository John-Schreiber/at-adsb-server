// pattern: Functional Core
import { encode as cborEncode, decode as cborDecode } from "@ipld/dag-cbor";
import { zstdCompressSync, zstdDecompressSync, constants } from "node:zlib";

// --- Constants ---

const ATRX_MAGIC = Buffer.from("ATRX", "ascii");
// v2 adds a 4-byte big-endian payload length after the metadata block so
// concatenated blobs can be split without scanning payload bytes for magic
// sequences (which can occur inside compressed data). v1 blobs (no payload
// length, payload runs to end of buffer) remain parseable.
const ATRX_VERSION = 0x02;
const ATRX_LEGACY_VERSION = 0x01;
const ATRX_HEADER_SIZE = 8;
const FLAG_ZSTD_COMPRESSED = 0x01;
const ZSTD_LEVEL = 3;

const BEAST_ESCAPE = 0x1a;

// --- Types ---

export type ClockSource = "gps" | "ntp" | "system";

export type Protocol = "beast-1090" | "uat-978";

export type AtrxMetadata = {
  readonly receiverDid: string;
  readonly windowStart: string;
  readonly windowEnd: string;
  readonly clockSource: ClockSource;
  readonly protocol: Protocol;
  readonly demodSoftware: string;
  readonly frameCount: number;
  readonly gainDb?: string;
  readonly sdrHardware?: string;
  readonly sampleRateHz?: number;
  readonly centerFreqHz?: number;
  readonly ntpServer?: string;
};

export type AtrxHeader = {
  readonly magic: string;
  readonly version: number;
  readonly flags: number;
};

export type AtrxBlob = {
  readonly header: AtrxHeader;
  readonly metadata: AtrxMetadata;
  readonly frames: Buffer;
};

// --- Functions ---

export function buildAtrxBlob(
  metadata: Readonly<AtrxMetadata>,
  frames: Buffer,
): Buffer {
  const header = Buffer.alloc(ATRX_HEADER_SIZE);
  ATRX_MAGIC.copy(header, 0);
  header[4] = ATRX_VERSION;
  header[5] = FLAG_ZSTD_COMPRESSED;
  // bytes 6-7 remain 0x00 (reserved)

  const cborBytes = cborEncode(metadata);
  const metadataLengthPrefix = Buffer.alloc(4);
  metadataLengthPrefix.writeUInt32BE(cborBytes.byteLength, 0);

  const compressedFrames = zstdCompressSync(frames, {
    params: { [constants.ZSTD_c_compressionLevel]: ZSTD_LEVEL },
  });

  const payloadLengthPrefix = Buffer.alloc(4);
  payloadLengthPrefix.writeUInt32BE(compressedFrames.byteLength, 0);

  return Buffer.concat([
    header,
    metadataLengthPrefix,
    Buffer.from(cborBytes),
    payloadLengthPrefix,
    compressedFrames,
  ]);
}

export function parseAtrxBlob(buffer: Buffer): AtrxBlob {
  if (buffer.length < ATRX_HEADER_SIZE + 4) {
    throw new Error("buffer too short for ATRX envelope");
  }

  const magic = buffer.subarray(0, 4).toString("ascii");
  if (magic !== "ATRX") {
    throw new Error(`invalid ATRX magic: expected "ATRX", got "${magic}"`);
  }

  const version = buffer[4] ?? 0;
  const flags = buffer[5] ?? 0;
  const reserved0 = buffer[6] ?? 0;
  const reserved1 = buffer[7] ?? 0;

  if (reserved0 !== 0 || reserved1 !== 0) {
    throw new Error("non-zero reserved bytes in ATRX header");
  }

  if (version !== ATRX_VERSION && version !== ATRX_LEGACY_VERSION) {
    throw new Error(`unsupported ATRX version: ${version}`);
  }

  const metadataLength = buffer.readUInt32BE(ATRX_HEADER_SIZE);
  const metadataEnd = ATRX_HEADER_SIZE + 4 + metadataLength;

  if (buffer.length < metadataEnd) {
    throw new Error("buffer too short for declared metadata length");
  }

  const metadata = cborDecode(
    buffer.subarray(ATRX_HEADER_SIZE + 4, metadataEnd),
  ) as unknown as AtrxMetadata;

  let payloadBytes: Buffer;
  if (version === ATRX_LEGACY_VERSION) {
    // v1 has no payload length; the payload runs to the end of the buffer.
    payloadBytes = buffer.subarray(metadataEnd);
  } else {
    if (buffer.length < metadataEnd + 4) {
      throw new Error("buffer too short for declared payload length");
    }
    const payloadLength = buffer.readUInt32BE(metadataEnd);
    const payloadEnd = metadataEnd + 4 + payloadLength;
    if (buffer.length < payloadEnd) {
      throw new Error("buffer too short for declared payload length");
    }
    if (buffer.length > payloadEnd) {
      throw new Error("trailing data after ATRX payload");
    }
    payloadBytes = buffer.subarray(metadataEnd + 4, payloadEnd);
  }
  const frames = (flags & FLAG_ZSTD_COMPRESSED) !== 0
    ? zstdDecompressSync(payloadBytes)
    : Buffer.from(payloadBytes);

  const actualCount = metadata.protocol === "beast-1090"
    ? countBeastFrames(frames)
    : countUatFrames(frames);

  if (actualCount !== metadata.frameCount) {
    throw new Error(
      `frameCount mismatch: metadata says ${metadata.frameCount}, payload contains ${actualCount}`,
    );
  }

  return {
    header: { magic, version, flags },
    metadata,
    frames,
  };
}

export function countBeastFrames(payload: Buffer): number {
  let count = 0;
  let i = 0;
  while (i < payload.length) {
    if (payload[i] === BEAST_ESCAPE) {
      const next = payload[i + 1];
      if (next === BEAST_ESCAPE) {
        i += 2;
        continue;
      }
      if (next === 0x31 || next === 0x32 || next === 0x33) {
        count++;
      }
      // 0xe3 (receiver ID) and other types are skipped without counting
      i += 2;
      continue;
    }
    i++;
  }
  return count;
}

export function countUatFrames(payload: Buffer): number {
  const text = payload.toString("utf-8");
  const lines = text.split("\n");
  let count = 0;
  for (const line of lines) {
    if (line.length > 0 && (line[0] === "+" || line[0] === "-")) {
      count++;
    }
  }
  return count;
}

export function concatAtrxBlobs(blobs: ReadonlyArray<Buffer>): Buffer {
  return Buffer.concat(blobs);
}

export function splitAtrxBlobs(concatenated: Buffer): Array<Buffer> {
  const sections: Array<Buffer> = [];
  let offset = 0;

  while (offset < concatenated.length) {
    if (offset + ATRX_HEADER_SIZE + 4 > concatenated.length) {
      throw new Error(`truncated ATRX section at offset ${offset}`);
    }
    if (concatenated.subarray(offset, offset + 4).compare(ATRX_MAGIC) !== 0) {
      throw new Error(`invalid ATRX magic at offset ${offset}`);
    }

    const version = concatenated[offset + 4] ?? 0;
    const metadataLength = concatenated.readUInt32BE(offset + ATRX_HEADER_SIZE);
    const metadataEnd = offset + ATRX_HEADER_SIZE + 4 + metadataLength;

    if (version === ATRX_LEGACY_VERSION) {
      // v1 sections have no payload length, so the payload can only be
      // delimited by the end of the buffer. A v1 section is therefore only
      // valid as the final (or sole) section.
      sections.push(concatenated.subarray(offset));
      return sections;
    }
    if (version !== ATRX_VERSION) {
      throw new Error(`unsupported ATRX version ${version} at offset ${offset}`);
    }

    if (metadataEnd + 4 > concatenated.length) {
      throw new Error(`truncated ATRX section at offset ${offset}`);
    }
    const payloadLength = concatenated.readUInt32BE(metadataEnd);
    const sectionEnd = metadataEnd + 4 + payloadLength;
    if (sectionEnd > concatenated.length) {
      throw new Error(`truncated ATRX section at offset ${offset}`);
    }

    sections.push(concatenated.subarray(offset, sectionEnd));
    offset = sectionEnd;
  }

  return sections;
}
