// pattern: Functional Core

import { zstdCompressSync } from "node:zlib";
import type { TelemetryData } from "./batch.js";

// Mirror the receiver.sighting lexicon limits: telemetry blob maxSize and
// manifest maxLength.
export const TELEMETRY_BLOB_MAX_BYTES = 2_000_000;
export const MANIFEST_MAX_ENTRIES = 1000;

export type TelemetryChunk = {
  readonly telemetry: TelemetryData;
  readonly compressed: Buffer;
};

export type ChunkLimits = {
  readonly maxBlobBytes: number;
  readonly maxManifestEntries: number;
};

const LEXICON_LIMITS: ChunkLimits = {
  maxBlobBytes: TELEMETRY_BLOB_MAX_BYTES,
  maxManifestEntries: MANIFEST_MAX_ENTRIES,
};

export function compressTelemetry(telemetry: Readonly<TelemetryData>): Buffer {
  const json = JSON.stringify(telemetry);
  return zstdCompressSync(Buffer.from(json));
}

// Splits a batch window's telemetry into chunks whose compressed blobs and
// manifests fit the lexicon limits. Chunks have disjoint aircraft sets, so
// each aircraft's positions land in exactly one sighting record and the
// flight record provenance chain stays intact.
export function chunkTelemetry(
  telemetry: Readonly<TelemetryData>,
  limits: ChunkLimits = LEXICON_LIMITS,
): Array<TelemetryChunk> {
  const hexes = Object.keys(telemetry);
  if (hexes.length === 0) {
    return [];
  }

  const compressed = compressTelemetry(telemetry);
  if (
    compressed.byteLength <= limits.maxBlobBytes &&
    hexes.length <= limits.maxManifestEntries
  ) {
    return [{ telemetry: { ...telemetry }, compressed }];
  }

  if (hexes.length === 1) {
    throw new Error(
      `telemetry for ${hexes[0]} exceeds ${limits.maxBlobBytes} bytes compressed and cannot be split further`,
    );
  }

  const mid = Math.ceil(hexes.length / 2);
  const firstHalf: TelemetryData = {};
  const secondHalf: TelemetryData = {};
  hexes.forEach((hex, index) => {
    const reports = telemetry[hex];
    if (reports !== undefined) {
      const target = index < mid ? firstHalf : secondHalf;
      target[hex] = reports;
    }
  });

  return [
    ...chunkTelemetry(firstHalf, limits),
    ...chunkTelemetry(secondHalf, limits),
  ];
}
