import { describe, it, expect, beforeAll } from "vitest";
import { zstdDecompressSync } from "node:zlib";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  createBatchWindow,
  addPosition,
  buildBatchRecord,
  collectSources,
  getManifestHexes,
  type TelemetryData,
} from "../batch.js";
import {
  compressTelemetry,
  chunkTelemetry,
  TELEMETRY_BLOB_MAX_BYTES,
  MANIFEST_MAX_ENTRIES,
} from "../blobs.js";
import type { PositionReport } from "../tracker.js";

describe("batch — batch window accumulator and record builder", () => {
  describe("provenance-chain.AC1.1 — batch record structure", () => {
    it("buildBatchRecord produces a record with windowStart, windowEnd, manifest, telemetry blob, sources, and createdAt", () => {
      const windowStart = new Date("2026-05-24T12:00:00Z");
      const windowEnd = new Date("2026-05-24T12:01:00Z");
      const now = new Date("2026-05-24T12:01:00Z");

      const telemetry: TelemetryData = {
        A0BEEF: [
          {
            latitude: "37.5",
            longitude: "-122.5",
            timestamp: "2026-05-24T12:00:05Z",
            source: "adsb_icao",
          },
        ],
      };

      const blobRef = {
        link: "bafytest",
        mimeType: "application/zstd",
        size: 100,
      };

      const record = buildBatchRecord(
        windowStart,
        windowEnd,
        telemetry,
        blobRef as any,
        now,
        ["adsb_icao"]
      );

      expect(record).not.toBeNull();
      expect(record).toHaveProperty("windowStart");
      expect(record).toHaveProperty("windowEnd");
      expect(record).toHaveProperty("manifest");
      expect(record).toHaveProperty("telemetry");
      expect(record).toHaveProperty("sources");
      expect(record).toHaveProperty("createdAt");

      expect(record!["windowStart"]).toBe("2026-05-24T12:00:00.000Z");
      expect(record!["windowEnd"]).toBe("2026-05-24T12:01:00.000Z");
      expect(record!["createdAt"]).toBe("2026-05-24T12:01:00.000Z");
      expect(record!["telemetry"]).toEqual(blobRef);
      expect(record!["sources"]).toEqual(["adsb_icao"]);
    });

    it("manifest is an array of objects with icaoHex field", () => {
      const windowStart = new Date("2026-05-24T12:00:00Z");
      const windowEnd = new Date("2026-05-24T12:01:00Z");
      const now = new Date("2026-05-24T12:01:00Z");

      const telemetry: TelemetryData = {
        A0BEEF: [
          {
            latitude: "37.5",
            longitude: "-122.5",
            timestamp: "2026-05-24T12:00:05Z",
            source: "adsb_icao",
          },
        ],
        B1CAFE: [
          {
            latitude: "37.6",
            longitude: "-122.6",
            timestamp: "2026-05-24T12:00:10Z",
            source: "adsb_icao",
          },
        ],
      };

      const blobRef = { link: "bafytest" } as any;

      const record = buildBatchRecord(
        windowStart,
        windowEnd,
        telemetry,
        blobRef,
        now,
        ["adsb_icao"]
      );

      const manifest = record!["manifest"] as Array<{ icaoHex: string }>;
      expect(manifest).toHaveLength(2);
      expect(manifest).toContainEqual({ icaoHex: "A0BEEF" });
      expect(manifest).toContainEqual({ icaoHex: "B1CAFE" });
    });
  });

  describe("provenance-chain.AC1.3 — telemetry compression and format", () => {
    it("compressTelemetry produces zstd-compressed JSON keyed by ICAO hex", () => {
      const telemetry: TelemetryData = {
        A0BEEF: [
          {
            latitude: "37.5",
            longitude: "-122.5",
            timestamp: "2026-05-24T12:00:05Z",
            source: "adsb_icao",
            altitudeFt: 12500,
          },
        ],
      };

      const compressed = compressTelemetry(telemetry);

      expect(Buffer.isBuffer(compressed)).toBe(true);

      const decompressed = zstdDecompressSync(compressed);
      const json = JSON.parse(decompressed.toString("utf-8"));

      expect(json).toEqual(telemetry);
      expect(json.A0BEEF).toHaveLength(1);
      expect(json.A0BEEF[0].latitude).toBe("37.5");
    });

    it("preserves all position report fields during compression round-trip", () => {
      const telemetry: TelemetryData = {
        A0BEEF: [
          {
            latitude: "37.5",
            longitude: "-122.5",
            timestamp: "2026-05-24T12:00:05Z",
            source: "adsb_icao",
            altitudeFt: 12500,
            groundSpeedKts: "450",
            trackDeg: "270",
            verticalRateFpm: 500,
          },
        ],
      };

      const compressed = compressTelemetry(telemetry);
      const decompressed = zstdDecompressSync(compressed);
      const json = JSON.parse(decompressed.toString("utf-8"));

      const position = json.A0BEEF[0];
      expect(position.latitude).toBe("37.5");
      expect(position.longitude).toBe("-122.5");
      expect(position.timestamp).toBe("2026-05-24T12:00:05Z");
      expect(position.source).toBe("adsb_icao");
      expect(position.altitudeFt).toBe(12500);
      expect(position.groundSpeedKts).toBe("450");
      expect(position.trackDeg).toBe("270");
      expect(position.verticalRateFpm).toBe(500);
    });

    it("handles telemetry with multiple aircraft and multiple positions per aircraft", () => {
      const telemetry: TelemetryData = {
        A0BEEF: [
          {
            latitude: "37.5",
            longitude: "-122.5",
            timestamp: "2026-05-24T12:00:05Z",
            source: "adsb_icao",
          },
          {
            latitude: "37.51",
            longitude: "-122.51",
            timestamp: "2026-05-24T12:00:10Z",
            source: "adsb_icao",
          },
        ],
        B1CAFE: [
          {
            latitude: "37.6",
            longitude: "-122.6",
            timestamp: "2026-05-24T12:00:05Z",
            source: "adsb_icao",
          },
          {
            latitude: "37.61",
            longitude: "-122.61",
            timestamp: "2026-05-24T12:00:10Z",
            source: "adsb_icao",
          },
        ],
      };

      const compressed = compressTelemetry(telemetry);
      const decompressed = zstdDecompressSync(compressed);
      const json = JSON.parse(decompressed.toString("utf-8"));

      expect(json.A0BEEF).toHaveLength(2);
      expect(json.B1CAFE).toHaveLength(2);
      expect(json).toEqual(telemetry);
    });
  });

  describe("provenance-chain.AC1.4 — empty windows", () => {
    it("buildBatchRecord returns null when telemetry is empty", () => {
      const windowStart = new Date("2026-05-24T12:00:00Z");
      const windowEnd = new Date("2026-05-24T12:01:00Z");
      const now = new Date("2026-05-24T12:01:00Z");
      const telemetry: TelemetryData = {};

      const blobRef = { link: "bafytest" } as any;

      const record = buildBatchRecord(
        windowStart,
        windowEnd,
        telemetry,
        blobRef,
        now,
        []
      );

      expect(record).toBeNull();
    });
  });

  describe("batch accumulator — createBatchWindow and addPosition", () => {
    it("createBatchWindow initializes with empty telemetry and windowStart", () => {
      const windowStart = new Date("2026-05-24T12:00:00Z");
      const batch = createBatchWindow(windowStart);

      expect(batch.windowStart).toEqual(windowStart);
      expect(batch.telemetry).toEqual({});
    });

    it("addPosition accumulates a single position for a single ICAO hex", () => {
      const batch = createBatchWindow(new Date());

      const report: PositionReport = {
        latitude: "37.5",
        longitude: "-122.5",
        timestamp: "2026-05-24T12:00:05Z",
        source: "adsb_icao",
      };

      addPosition(batch.telemetry, "A0BEEF", report);

      expect(batch.telemetry["A0BEEF"]).toHaveLength(1);
      expect(batch.telemetry["A0BEEF"]![0]).toEqual(report);
    });

    it("addPosition accumulates multiple reports for the same ICAO hex", () => {
      const batch = createBatchWindow(new Date());

      const report1: PositionReport = {
        latitude: "37.5",
        longitude: "-122.5",
        timestamp: "2026-05-24T12:00:05Z",
        source: "adsb_icao",
      };

      const report2: PositionReport = {
        latitude: "37.51",
        longitude: "-122.51",
        timestamp: "2026-05-24T12:00:10Z",
        source: "adsb_icao",
      };

      addPosition(batch.telemetry, "A0BEEF", report1);
      addPosition(batch.telemetry, "A0BEEF", report2);

      expect(batch.telemetry["A0BEEF"]).toHaveLength(2);
      expect(batch.telemetry["A0BEEF"]![0]).toEqual(report1);
      expect(batch.telemetry["A0BEEF"]![1]).toEqual(report2);
    });

    it("addPosition creates separate entries for different ICAO hexes", () => {
      const batch = createBatchWindow(new Date());

      const report1: PositionReport = {
        latitude: "37.5",
        longitude: "-122.5",
        timestamp: "2026-05-24T12:00:05Z",
        source: "adsb_icao",
      };

      const report2: PositionReport = {
        latitude: "37.6",
        longitude: "-122.6",
        timestamp: "2026-05-24T12:00:05Z",
        source: "adsb_icao",
      };

      addPosition(batch.telemetry, "A0BEEF", report1);
      addPosition(batch.telemetry, "B1CAFE", report2);

      expect(batch.telemetry["A0BEEF"]).toHaveLength(1);
      expect(batch.telemetry["B1CAFE"]).toHaveLength(1);
      expect(batch.telemetry["A0BEEF"]![0]).toEqual(report1);
      expect(batch.telemetry["B1CAFE"]![0]).toEqual(report2);
    });
  });

  describe("getManifestHexes", () => {
    it("returns all ICAO hexes present in telemetry", () => {
      const telemetry: TelemetryData = {
        A0BEEF: [
          {
            latitude: "37.5",
            longitude: "-122.5",
            timestamp: "2026-05-24T12:00:05Z",
            source: "adsb_icao",
          },
        ],
        B1CAFE: [
          {
            latitude: "37.6",
            longitude: "-122.6",
            timestamp: "2026-05-24T12:00:05Z",
            source: "adsb_icao",
          },
        ],
      };

      const hexes = getManifestHexes(telemetry);

      expect(hexes).toHaveLength(2);
      expect(hexes).toContain("A0BEEF");
      expect(hexes).toContain("B1CAFE");
    });

    it("returns empty array for empty telemetry", () => {
      const telemetry: TelemetryData = {};

      const hexes = getManifestHexes(telemetry);

      expect(hexes).toHaveLength(0);
      expect(hexes).toEqual([]);
    });
  });

  describe("manifest consistency — no mismatch between manifest and telemetry", () => {
    it("manifest derived from telemetry keys guarantees consistency", () => {
      const telemetry: TelemetryData = {
        A0BEEF: [
          {
            latitude: "37.5",
            longitude: "-122.5",
            timestamp: "2026-05-24T12:00:05Z",
            source: "adsb_icao",
          },
        ],
        B1CAFE: [
          {
            latitude: "37.6",
            longitude: "-122.6",
            timestamp: "2026-05-24T12:00:05Z",
            source: "adsb_icao",
          },
        ],
      };

      const blobRef = { link: "bafytest" } as any;
      const record = buildBatchRecord(
        new Date(),
        new Date(),
        telemetry,
        blobRef,
        new Date(),
        ["adsb_icao"]
      );

      const manifestHexes = new Set(
        (record!["manifest"] as Array<{ icaoHex: string }>).map((m) => m.icaoHex)
      );
      const telemetryHexes = new Set(Object.keys(telemetry));

      expect(manifestHexes).toEqual(telemetryHexes);
    });
  });

  describe("raw-capture-blob.AC4 — rawCapture blob field support", () => {
    it("raw-capture-blob.AC4.1: buildBatchRecord with rawCaptureBlobRef includes rawCapture field", () => {
      const windowStart = new Date("2026-05-24T12:00:00Z");
      const windowEnd = new Date("2026-05-24T12:01:00Z");
      const now = new Date("2026-05-24T12:01:00Z");

      const telemetry: TelemetryData = {
        A0BEEF: [
          {
            latitude: "37.5",
            longitude: "-122.5",
            timestamp: "2026-05-24T12:00:05Z",
            source: "adsb_icao",
          },
        ],
      };

      const telemetryBlobRef = {
        link: "bafytelemetry",
        mimeType: "application/zstd",
        size: 100,
      };

      const rawCaptureBlobRef = {
        link: "bafyrawcapture",
        mimeType: "application/vnd.at-adsb.raw-capture+zstd",
        size: 500,
      };

      const record = buildBatchRecord(
        windowStart,
        windowEnd,
        telemetry,
        telemetryBlobRef as any,
        now,
        ["adsb_icao"],
        rawCaptureBlobRef as any
      );

      expect(record).not.toBeNull();
      expect(record).toHaveProperty("rawCapture");
      expect(record!["rawCapture"]).toEqual(rawCaptureBlobRef);
    });

    it("raw-capture-blob.AC4.4: buildBatchRecord without rawCaptureBlobRef omits rawCapture field", () => {
      const windowStart = new Date("2026-05-24T12:00:00Z");
      const windowEnd = new Date("2026-05-24T12:01:00Z");
      const now = new Date("2026-05-24T12:01:00Z");

      const telemetry: TelemetryData = {
        A0BEEF: [
          {
            latitude: "37.5",
            longitude: "-122.5",
            timestamp: "2026-05-24T12:00:05Z",
            source: "adsb_icao",
          },
        ],
      };

      const telemetryBlobRef = {
        link: "bafytelemetry",
        mimeType: "application/zstd",
        size: 100,
      };

      const record = buildBatchRecord(
        windowStart,
        windowEnd,
        telemetry,
        telemetryBlobRef as any,
        now,
        ["adsb_icao"]
      );

      expect(record).not.toBeNull();
      expect(record).not.toHaveProperty("rawCapture");
    });

    it("raw-capture-blob.AC4.5: record structure has at most one rawCapture field (not array)", () => {
      const windowStart = new Date("2026-05-24T12:00:00Z");
      const windowEnd = new Date("2026-05-24T12:01:00Z");
      const now = new Date("2026-05-24T12:01:00Z");

      const telemetry: TelemetryData = {
        A0BEEF: [
          {
            latitude: "37.5",
            longitude: "-122.5",
            timestamp: "2026-05-24T12:00:05Z",
            source: "adsb_icao",
          },
        ],
      };

      const telemetryBlobRef = { link: "bafytelemetry" } as any;
      const rawCaptureBlobRef = { link: "bafyrawcapture" } as any;

      const record = buildBatchRecord(
        windowStart,
        windowEnd,
        telemetry,
        telemetryBlobRef,
        now,
        ["adsb_icao"],
        rawCaptureBlobRef
      );

      expect(record).not.toBeNull();

      expect(record).toHaveProperty("rawCapture");
      expect(record!["rawCapture"]).toEqual(rawCaptureBlobRef);
    });
  });

  describe("multi-input-adapters.AC3.4 — collectSources helper", () => {
    it("collectSources with multiple sources returns deduplicated sorted array", () => {
      const telemetry: TelemetryData = {
        A0BEEF: [
          {
            latitude: "37.5",
            longitude: "-122.5",
            timestamp: "2026-05-24T12:00:05Z",
            source: "adsb_icao",
          },
          {
            latitude: "37.51",
            longitude: "-122.51",
            timestamp: "2026-05-24T12:00:10Z",
            source: "mlat",
          },
        ],
        B1CAFE: [
          {
            latitude: "37.6",
            longitude: "-122.6",
            timestamp: "2026-05-24T12:00:05Z",
            source: "adsb_icao",
          },
        ],
      };

      const sources = collectSources(telemetry);

      expect(sources).toEqual(["adsb_icao", "mlat"]);
    });

    it("collectSources with single source returns single-element array", () => {
      const telemetry: TelemetryData = {
        A0BEEF: [
          {
            latitude: "37.5",
            longitude: "-122.5",
            timestamp: "2026-05-24T12:00:05Z",
            source: "adsb_icao",
          },
        ],
      };

      const sources = collectSources(telemetry);

      expect(sources).toEqual(["adsb_icao"]);
    });

    it("collectSources with empty telemetry returns empty array", () => {
      const telemetry: TelemetryData = {};

      const sources = collectSources(telemetry);

      expect(sources).toEqual([]);
    });

    it("collectSources deduplicates sources correctly", () => {
      const telemetry: TelemetryData = {
        A0BEEF: [
          {
            latitude: "37.5",
            longitude: "-122.5",
            timestamp: "2026-05-24T12:00:05Z",
            source: "adsb_icao",
          },
          {
            latitude: "37.51",
            longitude: "-122.51",
            timestamp: "2026-05-24T12:00:10Z",
            source: "adsb_icao",
          },
        ],
      };

      const sources = collectSources(telemetry);

      expect(sources).toEqual(["adsb_icao"]);
      expect(sources).toHaveLength(1);
    });
  });

  describe("chunkTelemetry — blob size and manifest limits (provenance-chain.AC1.6)", () => {
    function makeReport(seq: number): PositionReport {
      return {
        latitude: `37.${seq}`,
        longitude: `-122.${seq}`,
        timestamp: `2026-05-24T12:00:${String(seq % 60).padStart(2, "0")}Z`,
        source: "adsb_icao",
        altitudeFt: 30000 + seq,
        groundSpeedKts: `${400 + seq}`,
      };
    }

    function makeTelemetry(aircraftCount: number, reportsEach: number): TelemetryData {
      const telemetry: TelemetryData = {};
      for (let i = 0; i < aircraftCount; i++) {
        const hex = `A${String(i).padStart(5, "0")}`;
        telemetry[hex] = Array.from({ length: reportsEach }, (_, j) =>
          makeReport(i * reportsEach + j),
        );
      }
      return telemetry;
    }

    it("returns a single chunk when telemetry fits the limits", () => {
      const telemetry = makeTelemetry(3, 5);

      const chunks = chunkTelemetry(telemetry);

      expect(chunks).toHaveLength(1);
      expect(Object.keys(chunks[0]!.telemetry).sort()).toEqual(
        Object.keys(telemetry).sort(),
      );
      expect(chunks[0]!.compressed.byteLength).toBeLessThanOrEqual(
        TELEMETRY_BLOB_MAX_BYTES,
      );
    });

    it("returns no chunks for empty telemetry", () => {
      expect(chunkTelemetry({})).toEqual([]);
    });

    it("splits when the compressed blob exceeds the byte limit", () => {
      const telemetry = makeTelemetry(20, 10);
      const limits = { maxBlobBytes: 400, maxManifestEntries: 1000 };

      const chunks = chunkTelemetry(telemetry, limits);

      expect(chunks.length).toBeGreaterThan(1);
      for (const chunk of chunks) {
        expect(chunk.compressed.byteLength).toBeLessThanOrEqual(limits.maxBlobBytes);
      }
    });

    it("splits when the manifest exceeds the entry limit", () => {
      const telemetry = makeTelemetry(10, 1);
      const limits = { maxBlobBytes: TELEMETRY_BLOB_MAX_BYTES, maxManifestEntries: 4 };

      const chunks = chunkTelemetry(telemetry, limits);

      expect(chunks.length).toBeGreaterThanOrEqual(3);
      for (const chunk of chunks) {
        expect(Object.keys(chunk.telemetry).length).toBeLessThanOrEqual(4);
      }
    });

    it("chunks are disjoint and preserve every aircraft and position", () => {
      const telemetry = makeTelemetry(20, 10);
      const limits = { maxBlobBytes: 400, maxManifestEntries: 1000 };

      const chunks = chunkTelemetry(telemetry, limits);

      const seen = new Set<string>();
      for (const chunk of chunks) {
        for (const [hex, reports] of Object.entries(chunk.telemetry)) {
          expect(seen.has(hex)).toBe(false);
          seen.add(hex);
          expect(reports).toEqual(telemetry[hex]);
        }
      }
      expect(seen.size).toBe(20);
    });

    it("each chunk's compressed buffer round-trips to its telemetry", () => {
      const telemetry = makeTelemetry(20, 10);
      const limits = { maxBlobBytes: 400, maxManifestEntries: 1000 };

      const chunks = chunkTelemetry(telemetry, limits);

      for (const chunk of chunks) {
        const decompressed = JSON.parse(
          zstdDecompressSync(chunk.compressed).toString(),
        );
        expect(decompressed).toEqual(chunk.telemetry);
      }
    });

    it("throws when a single aircraft cannot fit under the byte limit", () => {
      const telemetry = makeTelemetry(1, 50);
      const limits = { maxBlobBytes: 100, maxManifestEntries: 1000 };

      expect(() => chunkTelemetry(telemetry, limits)).toThrow(/cannot be split/);
    });

    it("default limits match the receiver.sighting lexicon", () => {
      const lexiconPath = resolve(
        __dirname,
        "../../../lexicons/at/adsb/receiver/sighting.json",
      );
      const lexicon = JSON.parse(readFileSync(lexiconPath, "utf-8"));
      const props = lexicon.defs.main.record.properties;

      expect(TELEMETRY_BLOB_MAX_BYTES).toBe(props.telemetry.maxSize);
      expect(MANIFEST_MAX_ENTRIES).toBe(props.manifest.maxLength);
    });
  });

  describe("lexicon validation — receiver.sighting schema", () => {
    let lexicon: any;

    beforeAll(() => {
      const lexiconPath = resolve(
        __dirname,
        "../../../lexicons/at/adsb/receiver/sighting.json"
      );
      const content = readFileSync(lexiconPath, "utf-8");
      lexicon = JSON.parse(content);
    });

    it("raw-capture-blob.AC4.1: sighting.json is valid JSON", () => {
      expect(lexicon).toBeDefined();
      expect(lexicon.id).toBe("at.adsb.receiver.sighting");
    });

    it("raw-capture-blob.AC4.2 & AC4.3: rawCapture field has correct type, accept array, and maxSize", () => {
      const rawCaptureField = lexicon.defs.main.record.properties.rawCapture;

      expect(rawCaptureField).toBeDefined();
      expect(rawCaptureField.type).toBe("blob");
      expect(rawCaptureField.accept).toEqual(["application/vnd.at-adsb.raw-capture+zstd"]);
      expect(rawCaptureField.maxSize).toBe(2000000);
    });

    it("raw-capture-blob.AC4.4: rawCapture is NOT in the required array", () => {
      const required = lexicon.defs.main.record.required;

      expect(required).toContain("windowStart");
      expect(required).toContain("windowEnd");
      expect(required).toContain("manifest");
      expect(required).toContain("telemetry");
      expect(required).toContain("createdAt");
      expect(required).not.toContain("rawCapture");
    });

    it("raw-capture-blob.AC4.5: rawCapture field is single blob, not array", () => {
      const rawCaptureField = lexicon.defs.main.record.properties.rawCapture;

      expect(rawCaptureField.type).toBe("blob");
      expect(rawCaptureField.type).not.toBe("array");
    });
  });
});
