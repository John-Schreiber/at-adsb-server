import { describe, it, expect } from "vitest";
import { buildAircraftUpdate } from "../stream-payload.js";
import type { NormalizedAircraft } from "../normalized.js";

function createMockNormalizedAircraft(
  overrides: Partial<NormalizedAircraft> = {},
): NormalizedAircraft {
  return {
    icaoHex: "A1B2C3",
    source: "adsb_icao",
    seen: 0.5,
    rssi: -10.5,
    messages: 100,
    ...overrides,
  };
}

describe("buildAircraftUpdate", () => {
  describe("aircraft with no position data", () => {
    it("produces payload without position when aircraft has no lat/lon", () => {
      const ac = createMockNormalizedAircraft({ icaoHex: "ABC123" });

      const payload = buildAircraftUpdate(ac);

      expect(payload.position).toBeUndefined();
      expect(payload.icaoHex).toBe("ABC123");
    });

    it("omits position when only lat is present (no lon)", () => {
      const ac = createMockNormalizedAircraft({ lat: 40.0 });
      expect(buildAircraftUpdate(ac).position).toBeUndefined();
    });

    it("omits position when only lon is present (no lat)", () => {
      const ac = createMockNormalizedAircraft({ lon: -120.0 });
      expect(buildAircraftUpdate(ac).position).toBeUndefined();
    });
  });

  describe("empty aircraft array", () => {
    it("maps empty array to empty result", () => {
      const emptyAircraft: NormalizedAircraft[] = [];
      const payloads = emptyAircraft.map((ac) => buildAircraftUpdate(ac));
      expect(payloads).toHaveLength(0);
    });
  });

  describe("field mapping and transformation", () => {
    it("uses ICAO hex from NormalizedAircraft (already uppercased)", () => {
      const ac = createMockNormalizedAircraft({ icaoHex: "ABC123" });
      const payload = buildAircraftUpdate(ac);
      expect(payload.icaoHex).toBe("ABC123");
    });

    it("trims and omits empty callsign", () => {
      const ac1 = createMockNormalizedAircraft({ flight: "  DAL123  " });
      expect(buildAircraftUpdate(ac1).callsign).toBe("DAL123");

      const ac2 = createMockNormalizedAircraft({ flight: "   " });
      expect(buildAircraftUpdate(ac2).callsign).toBeUndefined();

      const ac3 = createMockNormalizedAircraft({});
      expect(buildAircraftUpdate(ac3).callsign).toBeUndefined();
    });

    it("includes nic and rc from NormalizedAircraft to top-level fields", () => {
      const ac = createMockNormalizedAircraft({
        nic: 8,
        rc: 100,
      });

      const payload = buildAircraftUpdate(ac);

      expect(payload.nic).toBe(8);
      expect(payload.rc).toBe(100);
    });

    it("omits nic and rc when absent", () => {
      const ac = createMockNormalizedAircraft({});
      const payload = buildAircraftUpdate(ac);

      expect(payload.nic).toBeUndefined();
      expect(payload.rc).toBeUndefined();
    });

    it("skips non-numeric altBaro (e.g. 'ground')", () => {
      const ac = createMockNormalizedAircraft({ lat: 40.0, lon: -120.0, altBaro: "ground" });
      const payload = buildAircraftUpdate(ac);
      expect(payload.position).toBeDefined();
      expect(payload.position!.altitudeFt).toBeUndefined();
    });

    it("includes numeric altBaro as integer in position", () => {
      const ac = createMockNormalizedAircraft({ lat: 40.0, lon: -120.0, altBaro: 35000 });
      const payload = buildAircraftUpdate(ac);
      expect(payload.position!.altitudeFt).toBe(35000);
    });

    it("includes squawk when present", () => {
      const ac = createMockNormalizedAircraft({ squawk: "1234" });
      expect(buildAircraftUpdate(ac).squawk).toBe("1234");
    });

    it("includes messageCount from messages field", () => {
      const ac = createMockNormalizedAircraft({ messages: 42 });
      expect(buildAircraftUpdate(ac).messageCount).toBe(42);
    });

    it("omits optional fields when undefined in normalized data", () => {
      const ac = createMockNormalizedAircraft({
        icaoHex: "ABC123",
        flight: undefined,
        squawk: undefined,
        lat: undefined,
        lon: undefined,
        altBaro: undefined,
        gs: undefined,
        track: undefined,
        baroRate: undefined,
        seenPos: undefined,
        nic: undefined,
        rc: undefined,
      });

      const payload = buildAircraftUpdate(ac);

      expect(payload.callsign).toBeUndefined();
      expect(payload.squawk).toBeUndefined();
      expect(payload.position).toBeUndefined();
      expect(payload.nic).toBeUndefined();
      expect(payload.rc).toBeUndefined();
      expect(payload.seenPos).toBeUndefined();
    });

    it("always includes required fields", () => {
      const ac = createMockNormalizedAircraft({ icaoHex: "ABC123" });
      const payload = buildAircraftUpdate(ac);

      expect(payload.icaoHex).toBe("ABC123");
      expect(payload.rssi).toBe("-10.5");
      expect(payload.seen).toBe("0.5");
    });

    it("embeds gs, track, baroRate inside position object", () => {
      const ac = createMockNormalizedAircraft({
        lat: 40.0,
        lon: -120.0,
        gs: 450.5,
        track: 180.0,
        baroRate: 1000,
      });
      const payload = buildAircraftUpdate(ac);

      expect(payload.position).toBeDefined();
      expect(payload.position!.groundSpeedKts).toBe("450.5");
      expect(payload.position!.trackDeg).toBe("180");
      expect(payload.position!.verticalRateFpm).toBe(1000);
    });

    it("converts seenPos to string", () => {
      const ac = createMockNormalizedAircraft({ seenPos: 3.5 });
      expect(buildAircraftUpdate(ac).seenPos).toBe("3.5");
    });

    it("includes latitude and longitude as strings in position", () => {
      const ac = createMockNormalizedAircraft({ lat: 38.8977, lon: -77.0365 });
      const payload = buildAircraftUpdate(ac);

      expect(payload.position).toBeDefined();
      expect(payload.position!.latitude).toBe("38.8977");
      expect(payload.position!.longitude).toBe("-77.0365");
    });

    it("includes timestamp in position", () => {
      const ac = createMockNormalizedAircraft({ lat: 40.0, lon: -120.0 });
      const payload = buildAircraftUpdate(ac);

      expect(payload.position!.timestamp).toBeDefined();
      expect(() => new Date(payload.position!.timestamp)).not.toThrow();
    });

    it("includes source in position when lat/lon present", () => {
      const ac = createMockNormalizedAircraft({ lat: 40.0, lon: -120.0, source: "mlat" });
      const payload = buildAircraftUpdate(ac);

      expect(payload.position).toBeDefined();
      expect(payload.position!.source).toBe("mlat");
    });

    it("flows source through from aircraft to position", () => {
      const sources = ["adsb_icao", "mlat", "adsb_surface"];
      for (const source of sources) {
        const ac = createMockNormalizedAircraft({ lat: 40.0, lon: -120.0, source });
        const payload = buildAircraftUpdate(ac);
        expect(payload.position!.source).toBe(source);
      }
    });
  });
});
