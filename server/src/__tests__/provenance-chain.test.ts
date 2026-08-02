import { describe, it, expect } from "vitest";
import {
  buildFlightRecord,
  type StrongRef,
} from "../records.js";
import {
  buildBatchRecord,
  collectSources,
  getManifestHexes,
  type TelemetryData,
} from "../batch.js";
import type { TrackedAircraft, PositionReport, AircraftSnapshot } from "../tracker.js";

// Helper to create a mock TrackedAircraft
function createMockTrackedAircraft(overrides?: Partial<TrackedAircraft>): TrackedAircraft {
  return {
    icaoHex: "A1B2C3",
    callsign: "UAL456",
    firstSeen: new Date("2026-05-24T10:00:00Z"),
    lastSeen: new Date("2026-05-24T10:05:00Z"),
    positionCount: 5,
    lastSeenPos: 100,
    initialMessages: 50,
    currentMessages: 150,
    maxRangeNm: 123.456,
    initial: { altitudeFt: 35000, headingDeg: "180", groundSpeedKts: "450", verticalRateFpm: -500 },
    final: { altitudeFt: 30000, headingDeg: "175", groundSpeedKts: "440", verticalRateFpm: -200 },
    track: [
      {
        latitude: "37.5",
        longitude: "-122.5",
        timestamp: "2026-05-24T10:00:00Z",
        source: "adsb_icao",
      },
    ] as ReadonlyArray<PositionReport>,
    ...overrides,
  };
}

// Helper to create a mock batch strongRef
function createMockBatchRef(suffix: string): StrongRef {
  return {
    uri: `at://did:plc:test/at.adsb.receiver.sighting/${suffix}`,
    cid: `bafyrei${suffix}`,
  };
}

// Helper to create a mock blob ref
function createMockBlobRef(suffix: string): any {
  return {
    link: `bafyblob${suffix}`,
    mimeType: "application/zstd",
    size: 256,
  };
}

describe("provenance-chain.AC3.3 — chain walkability", () => {
  it("flight record → batch sightings → manifest contains aircraft", () => {
    const now = new Date("2026-05-24T12:00:00Z");
    const aircraftIcao = "A1B2C3";

    // 1. Create tracked aircraft with known ICAO hex
    const aircraft = createMockTrackedAircraft({
      icaoHex: aircraftIcao,
    });

    const aircraftRef: StrongRef = {
      uri: `at://did:plc:test/at.adsb.aircraft.identity/${aircraftIcao}`,
      cid: `bafyidentity${aircraftIcao}`,
    };

    // 2. Create 3 batch windows, each containing the aircraft
    const batch1Telemetry: TelemetryData = {
      [aircraftIcao]: [
        {
          latitude: "37.5",
          longitude: "-122.5",
          timestamp: "2026-05-24T12:00:05Z",
          source: "adsb_icao",
        },
      ],
    };

    const batch2Telemetry: TelemetryData = {
      [aircraftIcao]: [
        {
          latitude: "37.6",
          longitude: "-122.6",
          timestamp: "2026-05-24T12:00:35Z",
          source: "adsb_icao",
        },
      ],
    };

    const batch3Telemetry: TelemetryData = {
      [aircraftIcao]: [
        {
          latitude: "37.7",
          longitude: "-122.7",
          timestamp: "2026-05-24T12:01:05Z",
          source: "adsb_icao",
        },
      ],
    };

    // Use buildBatchRecord to produce batch records
    const batchRecord1 = buildBatchRecord(
      new Date("2026-05-24T12:00:00Z"),
      new Date("2026-05-24T12:01:00Z"),
      batch1Telemetry,
      createMockBlobRef("1"),
      now,
      collectSources(batch1Telemetry)
    );

    const batchRecord2 = buildBatchRecord(
      new Date("2026-05-24T12:01:00Z"),
      new Date("2026-05-24T12:02:00Z"),
      batch2Telemetry,
      createMockBlobRef("2"),
      now,
      collectSources(batch2Telemetry)
    );

    const batchRecord3 = buildBatchRecord(
      new Date("2026-05-24T12:02:00Z"),
      new Date("2026-05-24T12:03:00Z"),
      batch3Telemetry,
      createMockBlobRef("3"),
      now,
      collectSources(batch3Telemetry)
    );

    expect(batchRecord1).not.toBeNull();
    expect(batchRecord2).not.toBeNull();
    expect(batchRecord3).not.toBeNull();

    // Assign mock strongRefs to each
    const batch1Ref = createMockBatchRef("batch1");
    const batch2Ref = createMockBatchRef("batch2");
    const batch3Ref = createMockBatchRef("batch3");

    // Create a map from URI to batch record for walking the chain
    const batchRecordsByUri: Record<string, Record<string, unknown>> = {
      [batch1Ref.uri]: batchRecord1!,
      [batch2Ref.uri]: batchRecord2!,
      [batch3Ref.uri]: batchRecord3!,
    };

    // 3. Build flight record with the batch refs
    const flightRecord = buildFlightRecord(
      aircraft,
      aircraftRef,
      [batch1Ref, batch2Ref, batch3Ref],
      now
    );

    expect(flightRecord).not.toBeNull();

    // 4. Walk the chain: For each batchRef in flightRecord.batches
    const batches = flightRecord!["batches"] as StrongRef[];
    expect(batches).toHaveLength(3);

    for (const batchRef of batches) {
      // Find the corresponding batch record by matching uri
      const batch = batchRecordsByUri[batchRef.uri];
      expect(batch).toBeDefined();

      if (!batch) {
        throw new Error(`Batch not found for URI: ${batchRef.uri}`);
      }

      // Verify the aircraft's ICAO hex appears in batch.manifest
      const manifest = batch["manifest"] as Array<{ icaoHex: string }>;
      expect(manifest).toBeDefined();
      expect(manifest.some((m) => m.icaoHex === aircraftIcao)).toBe(true);
    }

    // 5. Verify aircraft strongRef in flight record matches the identity ref
    const recordAircraftRef = flightRecord!["aircraft"] as StrongRef;
    expect(recordAircraftRef).toEqual(aircraftRef);
  });

  it("batch manifest is consistent with telemetry keys", () => {
    const now = new Date("2026-05-24T12:00:00Z");

    // 1. Create telemetry data with known ICAO hexes
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
      C2DEAD: [
        {
          latitude: "37.7",
          longitude: "-122.7",
          timestamp: "2026-05-24T12:00:15Z",
          source: "adsb_icao",
        },
      ],
    };

    // 2. Build batch record
    const batchRecord = buildBatchRecord(
      new Date("2026-05-24T12:00:00Z"),
      new Date("2026-05-24T12:01:00Z"),
      telemetry,
      createMockBlobRef("test"),
      now,
      collectSources(telemetry)
    );

    expect(batchRecord).not.toBeNull();

    // 3. Verify every manifest entry has a corresponding key in telemetry
    const manifest = batchRecord!["manifest"] as Array<{ icaoHex: string }>;
    const telemetryKeys = Object.keys(telemetry);

    for (const entry of manifest) {
      expect(telemetryKeys).toContain(entry.icaoHex);
    }

    // 4. Verify every telemetry key has a corresponding manifest entry
    const manifestHexes = manifest.map((m) => m.icaoHex);
    for (const key of telemetryKeys) {
      expect(manifestHexes).toContain(key);
    }

    // Also verify using getManifestHexes pure function
    const hexesFromHelper = getManifestHexes(telemetry);
    expect([...hexesFromHelper].sort()).toEqual([...manifestHexes].sort());
  });

  it("flight record with no batches is rejected", () => {
    const now = new Date("2026-05-24T12:00:00Z");

    const aircraft = createMockTrackedAircraft();

    const aircraftRef: StrongRef = {
      uri: "at://did:plc:test/at.adsb.aircraft.identity/test",
      cid: "bafytest",
    };

    // Build flight record with empty batches array
    const flightRecord = buildFlightRecord(aircraft, aircraftRef, [], now);

    // Verify buildFlightRecord returns null
    expect(flightRecord).toBeNull();
  });
});
