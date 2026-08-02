import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createServer, Server, Socket } from "node:net";
import { EventEmitter } from "node:events";
import type { ReadsbAircraft, ReadsbStats } from "../readsb.js";
import {
  mapReadsbToNormalized,
  buildStatsMessage,
  calculateBackoffDelay,
} from "../adapters/readsb-mapping.js";
import type { NormalizedAircraft } from "../normalized.js";

describe("multi-input-adapters.AC8.1 — readsb type mapping", () => {
  describe("maps all known readsb types correctly", () => {
    it("maps type: 'adsb_icao' to source: 'adsb_icao'", () => {
      const aircraft: ReadsbAircraft = {
        hex: "a1b2c3",
        type: "adsb_icao",
        seen: 1.5,
        rssi: -25.5,
        messages: 150,
      };

      const result = mapReadsbToNormalized(aircraft);

      expect(result.source).toBe("adsb_icao");
    });

    it("maps type: 'adsb_icao_nt' to source: 'adsb_icao_nt'", () => {
      const aircraft: ReadsbAircraft = {
        hex: "a1b2c3",
        type: "adsb_icao_nt",
        seen: 1.5,
        rssi: -25.5,
        messages: 150,
      };

      const result = mapReadsbToNormalized(aircraft);

      expect(result.source).toBe("adsb_icao_nt");
    });

    it("maps type: 'adsr_icao' to source: 'adsr_icao'", () => {
      const aircraft: ReadsbAircraft = {
        hex: "a1b2c3",
        type: "adsr_icao",
        seen: 1.5,
        rssi: -25.5,
        messages: 150,
      };

      const result = mapReadsbToNormalized(aircraft);

      expect(result.source).toBe("adsr_icao");
    });

    it("maps type: 'tisb_icao' to source: 'tisb_icao'", () => {
      const aircraft: ReadsbAircraft = {
        hex: "a1b2c3",
        type: "tisb_icao",
        seen: 1.5,
        rssi: -25.5,
        messages: 150,
      };

      const result = mapReadsbToNormalized(aircraft);

      expect(result.source).toBe("tisb_icao");
    });

    it("maps type: 'adsc' to source: 'adsc'", () => {
      const aircraft: ReadsbAircraft = {
        hex: "a1b2c3",
        type: "adsc",
        seen: 1.5,
        rssi: -25.5,
        messages: 150,
      };

      const result = mapReadsbToNormalized(aircraft);

      expect(result.source).toBe("adsc");
    });

    it("maps type: 'mlat' to source: 'mlat'", () => {
      const aircraft: ReadsbAircraft = {
        hex: "a1b2c3",
        type: "mlat",
        seen: 1.5,
        rssi: -25.5,
        messages: 150,
      };

      const result = mapReadsbToNormalized(aircraft);

      expect(result.source).toBe("mlat");
    });

    it("defaults to source: 'mode_s' when type is undefined", () => {
      const aircraft: ReadsbAircraft = {
        hex: "a1b2c3",
        seen: 1.5,
        rssi: -25.5,
        messages: 150,
      };

      const result = mapReadsbToNormalized(aircraft);

      expect(result.source).toBe("mode_s");
    });
  });

  describe("sourceOverride forces the source tag regardless of the poll target's own type field", () => {
    it("uses sourceOverride instead of type when both are present", () => {
      const aircraft: ReadsbAircraft = {
        hex: "a1b2c3",
        type: "adsb_icao",
        seen: 1.5,
        rssi: -25.5,
        messages: 150,
      };

      const result = mapReadsbToNormalized(aircraft, "uat");

      expect(result.source).toBe("uat");
    });

    it("uses sourceOverride when type is undefined", () => {
      const aircraft: ReadsbAircraft = {
        hex: "a1b2c3",
        seen: 1.5,
        rssi: -25.5,
        messages: 150,
      };

      const result = mapReadsbToNormalized(aircraft, "uat");

      expect(result.source).toBe("uat");
    });

    it("falls back to type when sourceOverride is not provided", () => {
      const aircraft: ReadsbAircraft = {
        hex: "a1b2c3",
        type: "tisb_icao",
        seen: 1.5,
        rssi: -25.5,
        messages: 150,
      };

      const result = mapReadsbToNormalized(aircraft);

      expect(result.source).toBe("tisb_icao");
    });
  });

  describe("uppercases ICAO hex", () => {
    it("converts lowercase hex to uppercase", () => {
      const aircraft: ReadsbAircraft = {
        hex: "a1b2c3",
        seen: 1.5,
        rssi: -25.5,
        messages: 150,
      };

      const result = mapReadsbToNormalized(aircraft);

      expect(result.icaoHex).toBe("A1B2C3");
    });

    it("preserves already-uppercase hex", () => {
      const aircraft: ReadsbAircraft = {
        hex: "A1B2C3",
        seen: 1.5,
        rssi: -25.5,
        messages: 150,
      };

      const result = mapReadsbToNormalized(aircraft);

      expect(result.icaoHex).toBe("A1B2C3");
    });
  });

  describe("maps alt_baro correctly", () => {
    it("maps numeric alt_baro to altBaro", () => {
      const aircraft: ReadsbAircraft = {
        hex: "a1b2c3",
        alt_baro: 35000,
        seen: 1.5,
        rssi: -25.5,
        messages: 150,
      };

      const result = mapReadsbToNormalized(aircraft);

      expect(result.altBaro).toBe(35000);
    });

    it("maps string 'ground' alt_baro to altBaro: 'ground'", () => {
      const aircraft: ReadsbAircraft = {
        hex: "a1b2c3",
        alt_baro: "ground",
        seen: 1.5,
        rssi: -25.5,
        messages: 150,
      };

      const result = mapReadsbToNormalized(aircraft);

      expect(result.altBaro).toBe("ground");
    });

    it("omits altBaro when undefined", () => {
      const aircraft: ReadsbAircraft = {
        hex: "a1b2c3",
        seen: 1.5,
        rssi: -25.5,
        messages: 150,
      };

      const result = mapReadsbToNormalized(aircraft);

      expect(result.altBaro).toBeUndefined();
    });
  });

  describe("flattens lastPosition", () => {
    it("promotes nic and rc from lastPosition to top-level", () => {
      const aircraft: ReadsbAircraft = {
        hex: "a1b2c3",
        seen: 1.5,
        rssi: -25.5,
        messages: 150,
        lastPosition: {
          lat: 37.5,
          lon: -122.5,
          nic: 8,
          rc: 186,
          seen_pos: 2.1,
        },
      };

      const result = mapReadsbToNormalized(aircraft);

      expect(result.nic).toBe(8);
      expect(result.rc).toBe(186);
    });

    it("omits nic and rc when lastPosition is undefined", () => {
      const aircraft: ReadsbAircraft = {
        hex: "a1b2c3",
        seen: 1.5,
        rssi: -25.5,
        messages: 150,
      };

      const result = mapReadsbToNormalized(aircraft);

      expect(result.nic).toBeUndefined();
      expect(result.rc).toBeUndefined();
    });
  });

  describe("passes through all optional fields", () => {
    it("includes all optional fields when present", () => {
      const aircraft: ReadsbAircraft = {
        hex: "a1b2c3",
        type: "adsb_icao",
        flight: "UAL456",
        alt_baro: 35000,
        alt_geom: 35050,
        gs: 450,
        track: 180,
        baro_rate: -500,
        squawk: "1234",
        category: "A3",
        nav_qnh: 1013.25,
        lat: 37.5,
        lon: -122.5,
        seen_pos: 2.1,
        seen: 1.5,
        rssi: -25.5,
        messages: 150,
        lastPosition: {
          lat: 37.5,
          lon: -122.5,
          nic: 8,
          rc: 186,
          seen_pos: 2.1,
        },
      };

      const result = mapReadsbToNormalized(aircraft);

      expect(result.flight).toBe("UAL456");
      expect(result.altBaro).toBe(35000);
      expect(result.altGeom).toBe(35050);
      expect(result.gs).toBe(450);
      expect(result.track).toBe(180);
      expect(result.baroRate).toBe(-500);
      expect(result.squawk).toBe("1234");
      expect(result.category).toBe("A3");
      expect(result.navQnh).toBe(1013.25);
      expect(result.lat).toBe(37.5);
      expect(result.lon).toBe(-122.5);
      expect(result.seenPos).toBe(2.1);
      expect(result.nic).toBe(8);
      expect(result.rc).toBe(186);
    });

    it("omits all optional fields when absent", () => {
      const aircraft: ReadsbAircraft = {
        hex: "a1b2c3",
        seen: 1.5,
        rssi: -25.5,
        messages: 150,
      };

      const result = mapReadsbToNormalized(aircraft);

      expect(result.flight).toBeUndefined();
      expect(result.altBaro).toBeUndefined();
      expect(result.altGeom).toBeUndefined();
      expect(result.gs).toBeUndefined();
      expect(result.track).toBeUndefined();
      expect(result.baroRate).toBeUndefined();
      expect(result.squawk).toBeUndefined();
      expect(result.category).toBeUndefined();
      expect(result.navQnh).toBeUndefined();
      expect(result.lat).toBeUndefined();
      expect(result.lon).toBeUndefined();
      expect(result.seenPos).toBeUndefined();
      expect(result.nic).toBeUndefined();
      expect(result.rc).toBeUndefined();
    });
  });

  describe("preserves required fields", () => {
    it("preserves seen, rssi, messages", () => {
      const aircraft: ReadsbAircraft = {
        hex: "a1b2c3",
        seen: 1.5,
        rssi: -25.5,
        messages: 150,
      };

      const result = mapReadsbToNormalized(aircraft);

      expect(result.seen).toBe(1.5);
      expect(result.rssi).toBe(-25.5);
      expect(result.messages).toBe(150);
    });
  });
});

describe("buildStatsMessage — one stats message per readsb last1min window", () => {
  function makeStats(overrides?: Partial<ReadsbStats["last1min"]>): ReadsbStats {
    return {
      now: 1716652860,
      gain_db: 43.9,
      aircraft_with_pos: 42,
      aircraft_without_pos: 7,
      last1min: {
        start: 1716652800,
        end: 1716652860,
        local: {
          signal: -21.5,
          noise: -35.2,
          peak_signal: -3.1,
          strong_signals: 120,
        },
        messages_valid: 9500,
        position_count_total: 3100,
        ...overrides,
      },
    };
  }

  it("builds a stats message when no window has been sent yet", () => {
    const message = buildStatsMessage(makeStats(), null);

    expect(message).toEqual({
      type: "stats",
      protocol: "adsb",
      messagesReceived: 9500,
      positionsDecoded: 3100,
      signal: {
        meanDbfs: -21.5,
        noiseDbfs: -35.2,
        strongCount: 120,
      },
    });
  });

  it("returns null when the window start matches the last sent window", () => {
    const stats = makeStats();

    const message = buildStatsMessage(stats, stats.last1min.start);

    expect(message).toBeNull();
  });

  it("builds a stats message when the window has rolled to a new start", () => {
    const message = buildStatsMessage(
      makeStats({ start: 1716652860 }),
      1716652800,
    );

    expect(message?.messagesReceived).toBe(9500);
  });

  it("uses the window position count, not the aircraft_with_pos gauge", () => {
    const message = buildStatsMessage(makeStats(), null);

    expect(message?.positionsDecoded).toBe(3100);
    expect(message?.positionsDecoded).not.toBe(42);
  });

  it("repeated polls within one window produce exactly one message", () => {
    const stats = makeStats();
    let lastSent: number | null = null;
    let sent = 0;

    for (let poll = 0; poll < 12; poll++) {
      const message = buildStatsMessage(stats, lastSent);
      if (message) {
        sent++;
        lastSent = stats.last1min.start;
      }
    }

    expect(sent).toBe(1);
  });
});

describe("multi-input-adapters.AC8.4 — reconnection with exponential backoff", () => {
  it("doubles the delay on each backoff call", () => {
    const result = calculateBackoffDelay(1000, 60000);
    expect(result).toBe(2000);
  });

  it("caps backoff delay at max", () => {
    const result = calculateBackoffDelay(30000, 60000);
    expect(result).toBe(60000);
  });

  it("respects max delay when doubling would exceed it", () => {
    const result = calculateBackoffDelay(40000, 60000);
    expect(result).toBe(60000);
  });

  it("correctly sequences exponential backoff", () => {
    let delay = 1000;
    const maxDelay = 60000;

    const delays: Array<number> = [];
    for (let i = 0; i < 6; i++) {
      delays.push(delay);
      delay = calculateBackoffDelay(delay, maxDelay);
    }

    // Verify exponential backoff: 1s, 2s, 4s, 8s, 16s, 32s, then next would cap at 60s
    expect(delays[0]).toBe(1000);
    expect(delays[1]).toBe(2000);
    expect(delays[2]).toBe(4000);
    expect(delays[3]).toBe(8000);
    expect(delays[4]).toBe(16000);
    expect(delays[5]).toBe(32000);
  });
});
