import { describe, it, expect, beforeEach } from "vitest";
import { AircraftTracker } from "../tracker.js";
import type { NormalizedAircraft } from "../normalized.js";

function mockAircraft(overrides: Partial<NormalizedAircraft> = {}): NormalizedAircraft {
  return {
    icaoHex: "A1B2C3",
    source: "adsb_icao",
    seen: 0,
    rssi: -10,
    messages: 100,
    ...overrides,
  };
}

describe("AircraftTracker", () => {
  let tracker: AircraftTracker;
  const receiverLat = 37.5;
  const receiverLon = -122.5;
  const nowEpoch = 1000; // Unix timestamp in seconds

  beforeEach(() => {
    tracker = new AircraftTracker(receiverLat, receiverLon);
  });

  describe("at-adsb-cmd.AC3.1 — Position count via seen_pos", () => {
    it("increments positionCount when seen_pos decreases (new fix arrived)", () => {
      // Poll 1: aircraft with seen_pos: 5.0 -> positionCount = 1
      const poll1 = tracker.update([mockAircraft({
        icaoHex: "ABC123",
        seenPos: 5.0,
        lat: 37.5,
        lon: -122.5,
      })], nowEpoch);

      const entry1 = tracker.getTracked("ABC123");
      expect(entry1).toBeDefined();
      expect(entry1!.positionCount).toBe(1);
      expect(entry1!.lastSeenPos).toBe(5.0);
      expect(poll1.departed).toHaveLength(0);

      // Poll 2: aircraft with seen_pos: 2.0 (decreased, new fix) -> positionCount = 2
      const poll2 = tracker.update([mockAircraft({
        icaoHex: "ABC123",
        seenPos: 2.0,
        lat: 37.5,
        lon: -122.5,
      })], nowEpoch);

      const entry2 = tracker.getTracked("ABC123");
      expect(entry2).toBeDefined();
      expect(entry2!.positionCount).toBe(2);
      expect(entry2!.lastSeenPos).toBe(2.0);
      expect(poll2.departed).toHaveLength(0);

      // Poll 3: aircraft with seen_pos: 0.5 (decreased again) -> positionCount = 3
      const poll3 = tracker.update([mockAircraft({
        icaoHex: "ABC123",
        seenPos: 0.5,
        lat: 37.5,
        lon: -122.5,
      })], nowEpoch);

      const entry3 = tracker.getTracked("ABC123");
      expect(entry3).toBeDefined();
      expect(entry3!.positionCount).toBe(3);
      expect(entry3!.lastSeenPos).toBe(0.5);
      expect(poll3.departed).toHaveLength(0);
    });
  });

  describe("at-adsb-cmd.AC3.2 — No position fix, zero count", () => {
    it("keeps positionCount at 0 when aircraft has no lat/lon", () => {
      // Poll 1: aircraft with no position data
      tracker.update([mockAircraft({
        icaoHex: "DEF456",
        // no lat, no lon
      })], nowEpoch);

      const entry1 = tracker.getTracked("DEF456");
      expect(entry1).toBeDefined();
      expect(entry1!.positionCount).toBe(0);
      expect(entry1!.lastSeenPos).toBeNull();
      expect(entry1!.track).toHaveLength(0);

      // Poll 2: still no position
      tracker.update([mockAircraft({
        icaoHex: "DEF456",
      })], nowEpoch);

      const entry2 = tracker.getTracked("DEF456");
      expect(entry2!.positionCount).toBe(0);
      expect(entry2!.lastSeenPos).toBeNull();
      expect(entry2!.track).toHaveLength(0);

      // Poll 3: still no position
      tracker.update([mockAircraft({
        icaoHex: "DEF456",
      })], nowEpoch);

      const entry3 = tracker.getTracked("DEF456");
      expect(entry3!.positionCount).toBe(0);
      expect(entry3!.track).toHaveLength(0);
    });

    it("does not increment positionCount when seen_pos defined but no lat/lon", () => {
      // Aircraft with seen_pos but no lat/lon - should NOT increment positionCount
      tracker.update([mockAircraft({
        icaoHex: "JJJ111",
        seenPos: 2.0,
        // no lat, no lon
      })], nowEpoch);

      const entry1 = tracker.getTracked("JJJ111");
      expect(entry1!.positionCount).toBe(0); // Should stay 0
      expect(entry1!.lastSeenPos).toBeNull(); // Not updated
      expect(entry1!.track).toHaveLength(0);

      // Second poll with different seen_pos, still no lat/lon
      tracker.update([mockAircraft({
        icaoHex: "JJJ111",
        seenPos: 1.0,
      })], nowEpoch);

      const entry2 = tracker.getTracked("JJJ111");
      expect(entry2!.positionCount).toBe(0); // Still 0
      expect(entry2!.lastSeenPos).toBeNull(); // Still not updated
      expect(entry2!.track).toHaveLength(0);
    });
  });

  describe("at-adsb-cmd.AC3.3 — Stale position no inflation", () => {
    it("doesn't increment positionCount when seen_pos increases (same stale fix)", () => {
      // Poll 1: aircraft with seen_pos: 2.0 -> positionCount = 1
      tracker.update([mockAircraft({
        icaoHex: "GHI789",
        seenPos: 2.0,
        lat: 37.5,
        lon: -122.5,
      })], nowEpoch);

      const entry1 = tracker.getTracked("GHI789");
      expect(entry1!.positionCount).toBe(1);

      // Poll 2: aircraft with seen_pos: 7.0 (increased, same stale fix) -> positionCount stays 1
      tracker.update([mockAircraft({
        icaoHex: "GHI789",
        seenPos: 7.0,
        lat: 37.5,
        lon: -122.5,
      })], nowEpoch);

      const entry2 = tracker.getTracked("GHI789");
      expect(entry2!.positionCount).toBe(1);
      expect(entry2!.lastSeenPos).toBe(2.0); // Still 2.0, not updated

      // Poll 3: aircraft with seen_pos: 12.0 (still increasing) -> positionCount stays 1
      tracker.update([mockAircraft({
        icaoHex: "GHI789",
        seenPos: 12.0,
        lat: 37.5,
        lon: -122.5,
      })], nowEpoch);

      const entry3 = tracker.getTracked("GHI789");
      expect(entry3!.positionCount).toBe(1);
      expect(entry3!.lastSeenPos).toBe(2.0);
    });
  });

  describe("at-adsb-cmd.AC4.1 — Message delta", () => {
    it("tracks initialMessages and currentMessages for delta calculation", () => {
      // Aircraft appears with messages: 100
      tracker.update([mockAircraft({
        icaoHex: "JKL012",
        messages: 100,
        lat: 37.5,
        lon: -122.5,
      })], nowEpoch);

      let entry = tracker.getTracked("JKL012");
      expect(entry!.initialMessages).toBe(100);
      expect(entry!.currentMessages).toBe(100);

      // Multiple polls, messages increases to 250
      tracker.update([mockAircraft({
        icaoHex: "JKL012",
        messages: 150,
      })], nowEpoch);

      entry = tracker.getTracked("JKL012");
      expect(entry!.initialMessages).toBe(100); // Stays unchanged
      expect(entry!.currentMessages).toBe(150);

      tracker.update([mockAircraft({
        icaoHex: "JKL012",
        messages: 250,
      })], nowEpoch);

      entry = tracker.getTracked("JKL012");
      expect(entry!.initialMessages).toBe(100);
      expect(entry!.currentMessages).toBe(250);

      // Aircraft departs (61s later)
      const result = tracker.update([], nowEpoch + 61);
      expect(result.departed).toHaveLength(1);

      const departedEntry = result.departed[0]!;
      expect(departedEntry.initialMessages).toBe(100);
      expect(departedEntry.currentMessages).toBe(250);
      // Consumer computes: Math.max(0, 250 - 100) = 150
      expect(Math.max(0, departedEntry.currentMessages - departedEntry.initialMessages)).toBe(150);
    });
  });

  describe("at-adsb-cmd.AC4.2 — Message decrease (readsb restart)", () => {
    it("handles message count decrease gracefully", () => {
      // Aircraft appears with messages: 500
      tracker.update([mockAircraft({
        icaoHex: "MNO345",
        messages: 500,
      })], nowEpoch);

      let entry = tracker.getTracked("MNO345");
      expect(entry!.initialMessages).toBe(500);
      expect(entry!.currentMessages).toBe(500);

      // Next poll messages: 10 (readsb restarted)
      tracker.update([mockAircraft({
        icaoHex: "MNO345",
        messages: 10,
      })], nowEpoch);

      entry = tracker.getTracked("MNO345");
      expect(entry!.initialMessages).toBe(500);
      expect(entry!.currentMessages).toBe(10);

      // Aircraft departs (61s later)
      const result = tracker.update([], nowEpoch + 61);
      expect(result.departed).toHaveLength(1);

      const departedEntry = result.departed[0]!;
      expect(departedEntry.currentMessages).toBe(10);
      expect(departedEntry.initialMessages).toBe(500);

      // Consumer computes: Math.max(0, 10 - 500) = 0 (clamped)
      expect(Math.max(0, departedEntry.currentMessages - departedEntry.initialMessages)).toBe(0);
    });
  });

  describe("at-adsb-cmd.AC5.1 — Departure after 60s absence", () => {
    it("does not depart aircraft absent for less than 60 seconds", () => {
      tracker.update([mockAircraft({ icaoHex: "PQR678" })], nowEpoch);

      // 30s later, aircraft absent — not yet departed
      const result = tracker.update([], nowEpoch + 30);
      expect(result.departed).toHaveLength(0);
      expect(tracker.getTracked("PQR678")).toBeDefined();
    });

    it("departs aircraft absent for 60+ seconds", () => {
      tracker.update([mockAircraft({ icaoHex: "PQR678" })], nowEpoch);

      // 61s later, aircraft absent — departed
      const result = tracker.update([], nowEpoch + 61);
      expect(result.departed).toHaveLength(1);
      expect(result.departed[0]!.icaoHex).toBe("PQR678");
      expect(tracker.getTracked("PQR678")).toBeUndefined();
    });
  });

  describe("at-adsb-cmd.AC5.2 — Exactly one departure event", () => {
    it("emits each aircraft as departed exactly once", () => {
      tracker.update([mockAircraft({ icaoHex: "STU901" })], nowEpoch);

      // 61s later, aircraft absent — departed
      const r1 = tracker.update([], nowEpoch + 61);
      expect(r1.departed).toHaveLength(1);
      expect(r1.departed[0]!.icaoHex).toBe("STU901");

      // Subsequent polls don't re-emit it
      const r2 = tracker.update([], nowEpoch + 122);
      expect(r2.departed).toHaveLength(0);

      const r3 = tracker.update([], nowEpoch + 183);
      expect(r3.departed).toHaveLength(0);
    });
  });

  describe("at-adsb-cmd.AC5.3 — Reappearance starts fresh", () => {
    it("creates new entry with fresh firstSeen when aircraft reappears", () => {
      const now1 = 1000;
      const now2 = 1061; // 61s later
      const now3 = 1200;

      tracker.update([mockAircraft({ icaoHex: "VWX234" })], now1);

      const entry1 = tracker.getTracked("VWX234");
      const firstSeen1 = entry1!.firstSeen.getTime();

      const result = tracker.update([], now2);
      expect(result.departed).toHaveLength(1);

      tracker.update([mockAircraft({ icaoHex: "VWX234" })], now3);

      const entry2 = tracker.getTracked("VWX234");
      const firstSeen2 = entry2!.firstSeen.getTime();

      expect(firstSeen2).toBeGreaterThan(firstSeen1);
    });
  });

  describe("at-adsb-cmd.AC10.1 — Range calculation", () => {
    it("calculates maxRangeNm using haversine distance", () => {
      // Known test case: receiver at (37.5, -122.5)
      // Aircraft 1 at (37.6, -122.4) - relatively close
      const distance1 = 7.66; // haversine calculated distance in NM

      tracker.update([mockAircraft({
        icaoHex: "YZ1234",
        seenPos: 5.0,
        lat: 37.6,
        lon: -122.4,
      })], nowEpoch);

      const entry1 = tracker.getTracked("YZ1234");
      expect(entry1!.maxRangeNm).not.toBeNull();
      expect(entry1!.maxRangeNm!).toBeCloseTo(distance1, 1); // Within 0.1 NM tolerance

      // Aircraft at closer position doesn't decrease maxRangeNm
      tracker.update([mockAircraft({
        icaoHex: "YZ1234",
        seenPos: 3.0,
        lat: 37.51,
        lon: -122.49,
      })], nowEpoch);

      const entry2 = tracker.getTracked("YZ1234");
      const maxBefore = entry1!.maxRangeNm!;
      const maxAfter = entry2!.maxRangeNm!;
      expect(maxAfter).toBe(maxBefore); // Unchanged

      // Aircraft at farther position updates maxRangeNm
      tracker.update([mockAircraft({
        icaoHex: "YZ1234",
        seenPos: 1.0,
        lat: 37.8,
        lon: -122.2,
      })], nowEpoch);

      const entry3 = tracker.getTracked("YZ1234");
      expect(entry3!.maxRangeNm!).toBeGreaterThan(maxBefore);
    });
  });

  describe("Position tracking in track array", () => {
    it("includes source field in PositionReport", () => {
      tracker.update([mockAircraft({
        icaoHex: "TEST001",
        source: "mlat",
        seenPos: 5.0,
        lat: 37.5,
        lon: -122.5,
      })], nowEpoch);

      const entry = tracker.getTracked("TEST001");
      expect(entry!.track).toHaveLength(1);

      const report = entry!.track[0]!;
      expect(report.source).toBe("mlat");
    });

    it("accumulates PositionReport objects when new positions detected", () => {
      tracker.update([mockAircraft({
        icaoHex: "AAA111",
        seenPos: 5.0,
        lat: 37.5,
        lon: -122.5,
        altBaro: 5000,
        gs: 250,
        track: 180,
        baroRate: 500,
      })], nowEpoch);

      let entry = tracker.getTracked("AAA111");
      expect(entry!.track).toHaveLength(1);

      const report1 = entry!.track[0]!;
      expect(report1.latitude).toBe("37.5");
      expect(report1.longitude).toBe("-122.5");
      expect(report1.source).toBe("adsb_icao");
      expect(report1.altitudeFt).toBe(5000);
      expect(report1.groundSpeedKts).toBe("250");
      expect(report1.trackDeg).toBe("180");
      expect(report1.verticalRateFpm).toBe(500);

      // Second position (seen_pos decreased)
      tracker.update([mockAircraft({
        icaoHex: "AAA111",
        seenPos: 2.0,
        lat: 37.6,
        lon: -122.4,
        altBaro: 5100,
      })], nowEpoch);

      entry = tracker.getTracked("AAA111");
      expect(entry!.track).toHaveLength(2);
      expect(entry!.track[1]!.latitude).toBe("37.6");
      expect(entry!.track[1]!.longitude).toBe("-122.4");
      expect(entry!.track[1]!.altitudeFt).toBe(5100);
    });

    it("doesn't add position report if seen_pos increases (stale position)", () => {
      tracker.update([mockAircraft({
        icaoHex: "BBB222",
        seenPos: 2.0,
        lat: 37.5,
        lon: -122.5,
      })], nowEpoch);

      let entry = tracker.getTracked("BBB222");
      expect(entry!.track).toHaveLength(1);

      // Stale position (seen_pos increased)
      tracker.update([mockAircraft({
        icaoHex: "BBB222",
        seenPos: 7.0,
        lat: 37.5,
        lon: -122.5,
      })], nowEpoch);

      entry = tracker.getTracked("BBB222");
      expect(entry!.track).toHaveLength(1); // No new report added
    });
  });

  describe("Hex case handling", () => {
    it("normalizes hex to uppercase", () => {
      tracker.update([mockAircraft({
        icaoHex: "ABC123",
      })], nowEpoch);

      // getTracked normalizes to uppercase, so both should find the entry
      expect(tracker.getTracked("ABC123")).toBeDefined();
      expect(tracker.getTracked("abc123")).toBeDefined(); // Found because getTracked normalizes

      const entry = tracker.getTracked("ABC123");
      expect(entry!.icaoHex).toBe("ABC123"); // Entry always stores uppercase hex
    });
  });

  describe("callsign handling", () => {
    it("trims and updates callsign when present", () => {
      tracker.update([mockAircraft({
        icaoHex: "CCC333",
        flight: "  BAW123  ",
      })], nowEpoch);

      let entry = tracker.getTracked("CCC333");
      expect(entry!.callsign).toBe("BAW123");

      // Update with different callsign
      tracker.update([mockAircraft({
        icaoHex: "CCC333",
        flight: "  BAW456  ",
      })], nowEpoch);

      entry = tracker.getTracked("CCC333");
      expect(entry!.callsign).toBe("BAW456");
    });

    it("ignores empty callsign", () => {
      tracker.update([mockAircraft({
        icaoHex: "DDD444",
        flight: "  ",
      })], nowEpoch);

      const entry = tracker.getTracked("DDD444");
      expect(entry!.callsign).toBeUndefined();
    });
  });

  describe("getCurrentMaxRange()", () => {
    it("returns 0 when no aircraft tracked", () => {
      expect(tracker.getCurrentMaxRange()).toBe(0);
    });

    it("returns max range across multiple tracked aircraft", () => {
      // Aircraft 1 at (37.6, -122.4)
      tracker.update([mockAircraft({
        icaoHex: "FFF777",
        lat: 37.6,
        lon: -122.4,
      })], nowEpoch);

      const range1 = tracker.getCurrentMaxRange();
      expect(range1).toBeGreaterThan(0);

      // Aircraft 2 at (37.8, -122.2) - farther away
      tracker.update([mockAircraft({
        icaoHex: "GGG888",
        lat: 37.8,
        lon: -122.2,
      })], nowEpoch);

      const range2 = tracker.getCurrentMaxRange();
      expect(range2).toBeGreaterThan(range1);
    });

    it("ignores aircraft with null maxRangeNm", () => {
      // Aircraft without position data has null maxRangeNm
      tracker.update([
        mockAircraft({
          icaoHex: "KKK111",
          // no lat/lon
        }),
        mockAircraft({
          icaoHex: "LLL222",
          lat: 37.6,
          lon: -122.4,
        }),
      ], nowEpoch);

      const maxRange = tracker.getCurrentMaxRange();
      expect(maxRange).toBeGreaterThan(0);

      // getTracked verifies only the positioned aircraft has a range
      const entry1 = tracker.getTracked("KKK111");
      const entry2 = tracker.getTracked("LLL222");
      expect(entry1).toBeDefined();
      expect(entry2).toBeDefined();
      expect(entry1!.maxRangeNm).toBeNull();
      expect(entry2!.maxRangeNm).not.toBeNull();
    });
  });

  describe("lastSeen timestamp", () => {
    it("updates lastSeen on each poll", () => {
      const now1 = 1000;
      const now2 = 2000;

      tracker.update([mockAircraft({
        icaoHex: "EEE555",
        seen: 0,
      })], now1);

      let entry = tracker.getTracked("EEE555");
      const lastSeen1 = entry!.lastSeen.getTime();

      tracker.update([mockAircraft({
        icaoHex: "EEE555",
        seen: 0,
      })], now2);

      entry = tracker.getTracked("EEE555");
      const lastSeen2 = entry!.lastSeen.getTime();

      expect(lastSeen2).toBeGreaterThan(lastSeen1);
    });
  });

  describe("getAllTrackedHexes()", () => {
    it("returns set of 3 uppercased hex strings after 3 aircraft update", () => {
      tracker.update([
        mockAircraft({ icaoHex: "ABC123" }),
        mockAircraft({ icaoHex: "DEF456" }),
        mockAircraft({ icaoHex: "GHI789" }),
      ], nowEpoch);

      const hexes = tracker.getAllTrackedHexes();
      expect(hexes).toBeInstanceOf(Set);
      expect(hexes.size).toBe(3);
      expect(hexes.has("ABC123")).toBe(true);
      expect(hexes.has("DEF456")).toBe(true);
      expect(hexes.has("GHI789")).toBe(true);
    });

    it("returns empty set after all aircraft depart", () => {
      tracker.update([
        mockAircraft({ icaoHex: "AAA111" }),
        mockAircraft({ icaoHex: "BBB222" }),
        mockAircraft({ icaoHex: "CCC333" }),
      ], nowEpoch);

      let hexes = tracker.getAllTrackedHexes();
      expect(hexes.size).toBe(3);

      // All aircraft absent for 60+ seconds
      const result = tracker.update([], nowEpoch + 61);
      expect(result.departed).toHaveLength(3);

      hexes = tracker.getAllTrackedHexes();
      expect(hexes).toBeInstanceOf(Set);
      expect(hexes.size).toBe(0);
    });
  });
});
