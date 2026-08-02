import { describe, it, expect } from "vitest";
import {
  validateNormalizedAircraft,
  validateAdapterMessage,
  type NormalizedAircraft,
  type AdapterMessage,
} from "../normalized.js";

describe("multi-input-adapters.AC2.1 — normalized aircraft with all optional fields", () => {
  it("accepts fully-populated NormalizedAircraft with all optional fields", () => {
    const aircraft: unknown = {
      icaoHex: "A1B2C3",
      source: "adsb_icao",
      seen: 1.5,
      rssi: -25.5,
      messages: 150,
      lat: 37.5,
      lon: -122.5,
      seenPos: 2.1,
      altBaro: 35000,
      altGeom: 35050,
      gs: 450,
      track: 180,
      baroRate: -500,
      flight: "UAL456",
      squawk: "1234",
      category: "A3",
      navQnh: 1013.25,
      nic: 8,
      rc: 186,
    };

    const result = validateNormalizedAircraft(aircraft);
    expect(result).not.toBeNull();
    expect(result?.icaoHex).toBe("A1B2C3");
    expect(result?.source).toBe("adsb_icao");
    expect(result?.lat).toBe(37.5);
    expect(result?.flight).toBe("UAL456");
  });
});

describe("multi-input-adapters.AC2.2 — minimal valid NormalizedAircraft", () => {
  it("accepts minimal valid NormalizedAircraft with required fields only", () => {
    const aircraft: unknown = {
      icaoHex: "A1B2C3",
      source: "adsb_icao",
      seen: 1.5,
      rssi: -25.5,
      messages: 150,
    };

    const result = validateNormalizedAircraft(aircraft);
    expect(result).not.toBeNull();
    expect(result?.icaoHex).toBe("A1B2C3");
    expect(result?.source).toBe("adsb_icao");
    expect(result?.seen).toBe(1.5);
    expect(result?.rssi).toBe(-25.5);
    expect(result?.messages).toBe(150);
    expect(result?.lat).toBeUndefined();
    expect(result?.flight).toBeUndefined();
  });
});

describe("multi-input-adapters.AC2.3 — required source field validation", () => {
  it("rejects NormalizedAircraft missing source field", () => {
    const aircraft: unknown = {
      icaoHex: "A1B2C3",
      seen: 1.5,
      rssi: -25.5,
      messages: 150,
    };

    const result = validateNormalizedAircraft(aircraft);
    expect(result).toBeNull();
  });

  it("rejects NormalizedAircraft with empty source", () => {
    const aircraft: unknown = {
      icaoHex: "A1B2C3",
      source: "",
      seen: 1.5,
      rssi: -25.5,
      messages: 150,
    };

    const result = validateNormalizedAircraft(aircraft);
    expect(result).toBeNull();
  });

  it("rejects NormalizedAircraft with source exceeding maxLength 32", () => {
    const aircraft: unknown = {
      icaoHex: "A1B2C3",
      source: "a".repeat(33),
      seen: 1.5,
      rssi: -25.5,
      messages: 150,
    };

    const result = validateNormalizedAircraft(aircraft);
    expect(result).toBeNull();
  });

  it("rejects NormalizedAircraft missing icaoHex", () => {
    const aircraft: unknown = {
      source: "adsb_icao",
      seen: 1.5,
      rssi: -25.5,
      messages: 150,
    };

    const result = validateNormalizedAircraft(aircraft);
    expect(result).toBeNull();
  });

  it("rejects NormalizedAircraft with non-string icaoHex", () => {
    const aircraft: unknown = {
      icaoHex: 123,
      source: "adsb_icao",
      seen: 1.5,
      rssi: -25.5,
      messages: 150,
    };

    const result = validateNormalizedAircraft(aircraft);
    expect(result).toBeNull();
  });

  it("rejects NormalizedAircraft missing seen", () => {
    const aircraft: unknown = {
      icaoHex: "A1B2C3",
      source: "adsb_icao",
      rssi: -25.5,
      messages: 150,
    };

    const result = validateNormalizedAircraft(aircraft);
    expect(result).toBeNull();
  });

  it("rejects NormalizedAircraft with non-number seen", () => {
    const aircraft: unknown = {
      icaoHex: "A1B2C3",
      source: "adsb_icao",
      seen: "1.5",
      rssi: -25.5,
      messages: 150,
    };

    const result = validateNormalizedAircraft(aircraft);
    expect(result).toBeNull();
  });

  it("rejects NormalizedAircraft missing rssi", () => {
    const aircraft: unknown = {
      icaoHex: "A1B2C3",
      source: "adsb_icao",
      seen: 1.5,
      messages: 150,
    };

    const result = validateNormalizedAircraft(aircraft);
    expect(result).toBeNull();
  });

  it("rejects NormalizedAircraft with non-number rssi", () => {
    const aircraft: unknown = {
      icaoHex: "A1B2C3",
      source: "adsb_icao",
      seen: 1.5,
      rssi: "-25.5",
      messages: 150,
    };

    const result = validateNormalizedAircraft(aircraft);
    expect(result).toBeNull();
  });

  it("rejects NormalizedAircraft missing messages", () => {
    const aircraft: unknown = {
      icaoHex: "A1B2C3",
      source: "adsb_icao",
      seen: 1.5,
      rssi: -25.5,
    };

    const result = validateNormalizedAircraft(aircraft);
    expect(result).toBeNull();
  });

  it("rejects NormalizedAircraft with non-number messages", () => {
    const aircraft: unknown = {
      icaoHex: "A1B2C3",
      source: "adsb_icao",
      seen: 1.5,
      rssi: -25.5,
      messages: "150",
    };

    const result = validateNormalizedAircraft(aircraft);
    expect(result).toBeNull();
  });

  it("accepts valid source with maxLength exactly 32", () => {
    const aircraft: unknown = {
      icaoHex: "A1B2C3",
      source: "a".repeat(32),
      seen: 1.5,
      rssi: -25.5,
      messages: 150,
    };

    const result = validateNormalizedAircraft(aircraft);
    expect(result).not.toBeNull();
    expect(result?.source).toBe("a".repeat(32));
  });
});

describe("multi-input-adapters.AC1.3 — adapter message validation", () => {
  describe("valid handshake message", () => {
    it("parses valid handshake with version 1", () => {
      const message: unknown = {
        type: "handshake",
        sourceId: "receiver-1",
        protocol: "adsb",
        version: 1,
      };

      const result = validateAdapterMessage(message);
      expect(result).not.toBeNull();
      expect(result?.type).toBe("handshake");
      if (result?.type === "handshake") {
        expect(result.sourceId).toBe("receiver-1");
        expect(result.protocol).toBe("adsb");
        expect(result.version).toBe(1);
      }
    });
  });

  describe("valid aircraft message", () => {
    it("parses valid aircraft message with array of NormalizedAircraft", () => {
      const message: unknown = {
        type: "aircraft",
        timestamp: 1234567890,
        aircraft: [
          {
            icaoHex: "A1B2C3",
            source: "adsb_icao",
            seen: 1.5,
            rssi: -25.5,
            messages: 150,
          },
          {
            icaoHex: "D4E5F6",
            source: "mlat",
            seen: 2.0,
            rssi: -30.0,
            messages: 200,
            flight: "UAL456",
          },
        ],
      };

      const result = validateAdapterMessage(message);
      expect(result).not.toBeNull();
      expect(result?.type).toBe("aircraft");
      if (result && result.type === "aircraft") {
        expect(result.timestamp).toBe(1234567890);
        expect(result.aircraft).toHaveLength(2);
        expect(result.aircraft[0]?.icaoHex).toBe("A1B2C3");
        expect(result.aircraft[1]?.flight).toBe("UAL456");
      }
    });

    it("parses valid aircraft message with empty array", () => {
      const message: unknown = {
        type: "aircraft",
        timestamp: 1234567890,
        aircraft: [],
      };

      const result = validateAdapterMessage(message);
      expect(result).not.toBeNull();
      expect(result?.type).toBe("aircraft");
      if (result?.type === "aircraft") {
        expect(result.aircraft).toHaveLength(0);
      }
    });
  });

  describe("valid stats message", () => {
    it("parses valid stats message with required fields only", () => {
      const message: unknown = {
        type: "stats",
        protocol: "adsb",
        messagesReceived: 5000,
        positionsDecoded: 250,
      };

      const result = validateAdapterMessage(message);
      expect(result).not.toBeNull();
      expect(result?.type).toBe("stats");
      if (result?.type === "stats") {
        expect(result.protocol).toBe("adsb");
        expect(result.messagesReceived).toBe(5000);
        expect(result.positionsDecoded).toBe(250);
        expect(result.signal).toBeUndefined();
      }
    });

    it("parses valid stats message with optional signal field", () => {
      const message: unknown = {
        type: "stats",
        protocol: "adsb",
        messagesReceived: 5000,
        positionsDecoded: 250,
        signal: {
          meanDbfs: -25.5,
          noiseDbfs: -45.0,
          strongCount: 150,
        },
      };

      const result = validateAdapterMessage(message);
      expect(result).not.toBeNull();
      expect(result?.type).toBe("stats");
      if (result?.type === "stats") {
        expect(result.signal).toBeDefined();
        expect(result.signal?.meanDbfs).toBe(-25.5);
        expect(result.signal?.noiseDbfs).toBe(-45.0);
        expect(result.signal?.strongCount).toBe(150);
      }
    });
  });

  describe("valid rawCapture message", () => {
    it("parses valid rawCapture message", () => {
      const message: unknown = {
        type: "rawCapture",
        filePath: "/tmp/capture-20260526.atrx",
        windowStart: "2026-05-26T10:00:00Z",
        windowEnd: "2026-05-26T10:01:00Z",
      };

      const result = validateAdapterMessage(message);
      expect(result).not.toBeNull();
      expect(result?.type).toBe("rawCapture");
      if (result?.type === "rawCapture") {
        expect(result.filePath).toBe("/tmp/capture-20260526.atrx");
        expect(result.windowStart).toBe("2026-05-26T10:00:00Z");
        expect(result.windowEnd).toBe("2026-05-26T10:01:00Z");
      }
    });
  });

  describe("invalid adapter messages", () => {
    it("rejects message with unknown type field", () => {
      const message: unknown = {
        type: "unknown",
        data: "something",
      };

      const result = validateAdapterMessage(message);
      expect(result).toBeNull();
    });

    it("rejects message missing type field", () => {
      const message: unknown = {
        sourceId: "receiver-1",
        protocol: "adsb",
        version: 1,
      };

      const result = validateAdapterMessage(message);
      expect(result).toBeNull();
    });

    it("rejects handshake with version !== 1", () => {
      const message: unknown = {
        type: "handshake",
        sourceId: "receiver-1",
        protocol: "adsb",
        version: 2,
      };

      const result = validateAdapterMessage(message);
      expect(result).toBeNull();
    });

    it("rejects handshake with missing sourceId", () => {
      const message: unknown = {
        type: "handshake",
        protocol: "adsb",
        version: 1,
      };

      const result = validateAdapterMessage(message);
      expect(result).toBeNull();
    });

    it("rejects handshake with empty sourceId", () => {
      const message: unknown = {
        type: "handshake",
        sourceId: "",
        protocol: "adsb",
        version: 1,
      };

      const result = validateAdapterMessage(message);
      expect(result).toBeNull();
    });

    it("rejects handshake with missing protocol", () => {
      const message: unknown = {
        type: "handshake",
        sourceId: "receiver-1",
        version: 1,
      };

      const result = validateAdapterMessage(message);
      expect(result).toBeNull();
    });

    it("rejects handshake with empty protocol", () => {
      const message: unknown = {
        type: "handshake",
        sourceId: "receiver-1",
        protocol: "",
        version: 1,
      };

      const result = validateAdapterMessage(message);
      expect(result).toBeNull();
    });

    it("rejects aircraft message with invalid aircraft in array", () => {
      const message: unknown = {
        type: "aircraft",
        timestamp: 1234567890,
        aircraft: [
          {
            icaoHex: "A1B2C3",
            source: "adsb_icao",
            seen: 1.5,
            rssi: -25.5,
            messages: 150,
          },
          {
            icaoHex: "D4E5F6",
            // missing source field
            seen: 2.0,
            rssi: -30.0,
            messages: 200,
          },
        ],
      };

      const result = validateAdapterMessage(message);
      expect(result).toBeNull();
    });

    it("rejects aircraft message with non-number timestamp", () => {
      const message: unknown = {
        type: "aircraft",
        timestamp: "1234567890",
        aircraft: [],
      };

      const result = validateAdapterMessage(message);
      expect(result).toBeNull();
    });

    it("rejects aircraft message with non-array aircraft", () => {
      const message: unknown = {
        type: "aircraft",
        timestamp: 1234567890,
        aircraft: "not-an-array",
      };

      const result = validateAdapterMessage(message);
      expect(result).toBeNull();
    });

    it("rejects stats message with non-number messagesReceived", () => {
      const message: unknown = {
        type: "stats",
        protocol: "adsb",
        messagesReceived: "5000",
        positionsDecoded: 250,
      };

      const result = validateAdapterMessage(message);
      expect(result).toBeNull();
    });

    it("rejects stats message with missing messagesReceived", () => {
      const message: unknown = {
        type: "stats",
        protocol: "adsb",
        positionsDecoded: 250,
      };

      const result = validateAdapterMessage(message);
      expect(result).toBeNull();
    });

    it("rejects stats message with non-number positionsDecoded", () => {
      const message: unknown = {
        type: "stats",
        protocol: "adsb",
        messagesReceived: 5000,
        positionsDecoded: "250",
      };

      const result = validateAdapterMessage(message);
      expect(result).toBeNull();
    });

    it("rejects rawCapture message with non-string filePath", () => {
      const message: unknown = {
        type: "rawCapture",
        filePath: 123,
        windowStart: "2026-05-26T10:00:00Z",
        windowEnd: "2026-05-26T10:01:00Z",
      };

      const result = validateAdapterMessage(message);
      expect(result).toBeNull();
    });

    it("rejects rawCapture message with missing windowStart", () => {
      const message: unknown = {
        type: "rawCapture",
        filePath: "/tmp/capture.atrx",
        windowEnd: "2026-05-26T10:01:00Z",
      };

      const result = validateAdapterMessage(message);
      expect(result).toBeNull();
    });
  });

  describe("critical issue: NaN and Infinity handling in isNumber guard", () => {
    it("rejects NaN for numeric required fields", () => {
      const aircraft: unknown = {
        icaoHex: "A1B2C3",
        source: "adsb_icao",
        seen: NaN,
        rssi: -25.5,
        messages: 150,
      };

      const result = validateNormalizedAircraft(aircraft);
      expect(result).toBeNull();
    });

    it("rejects Infinity for numeric required fields", () => {
      const aircraft: unknown = {
        icaoHex: "A1B2C3",
        source: "adsb_icao",
        seen: 1.5,
        rssi: Infinity,
        messages: 150,
      };

      const result = validateNormalizedAircraft(aircraft);
      expect(result).toBeNull();
    });

    it("rejects -Infinity for numeric required fields", () => {
      const aircraft: unknown = {
        icaoHex: "A1B2C3",
        source: "adsb_icao",
        seen: 1.5,
        rssi: -25.5,
        messages: -Infinity,
      };

      const result = validateNormalizedAircraft(aircraft);
      expect(result).toBeNull();
    });

    it("rejects NaN for numeric optional fields", () => {
      const aircraft: unknown = {
        icaoHex: "A1B2C3",
        source: "adsb_icao",
        seen: 1.5,
        rssi: -25.5,
        messages: 150,
        gs: NaN,
      };

      const result = validateNormalizedAircraft(aircraft);
      expect(result).toBeNull();
    });
  });

  describe("important issue: empty string handling for flight, squawk, category", () => {
    it("accepts empty string for flight field (readsb compatibility)", () => {
      const aircraft: unknown = {
        icaoHex: "A1B2C3",
        source: "adsb_icao",
        seen: 1.5,
        rssi: -25.5,
        messages: 150,
        flight: "",
      };

      const result = validateNormalizedAircraft(aircraft);
      expect(result).not.toBeNull();
      expect(result?.flight).toBe("");
    });

    it("accepts empty string for squawk field (readsb compatibility)", () => {
      const aircraft: unknown = {
        icaoHex: "A1B2C3",
        source: "adsb_icao",
        seen: 1.5,
        rssi: -25.5,
        messages: 150,
        squawk: "",
      };

      const result = validateNormalizedAircraft(aircraft);
      expect(result).not.toBeNull();
      expect(result?.squawk).toBe("");
    });

    it("accepts empty string for category field (readsb compatibility)", () => {
      const aircraft: unknown = {
        icaoHex: "A1B2C3",
        source: "adsb_icao",
        seen: 1.5,
        rssi: -25.5,
        messages: 150,
        category: "",
      };

      const result = validateNormalizedAircraft(aircraft);
      expect(result).not.toBeNull();
      expect(result?.category).toBe("");
    });
  });

  describe("important issue: altBaro ground string acceptance", () => {
    it("accepts altBaro: 'ground' string value", () => {
      const aircraft: unknown = {
        icaoHex: "A1B2C3",
        source: "adsb_icao",
        seen: 1.5,
        rssi: -25.5,
        messages: 150,
        altBaro: "ground",
      };

      const result = validateNormalizedAircraft(aircraft);
      expect(result).not.toBeNull();
      expect(result?.altBaro).toBe("ground");
    });

    it("rejects non-ground string for altBaro field", () => {
      const aircraft: unknown = {
        icaoHex: "A1B2C3",
        source: "adsb_icao",
        seen: 1.5,
        rssi: -25.5,
        messages: 150,
        altBaro: "climbing",
      };

      const result = validateNormalizedAircraft(aircraft);
      expect(result).toBeNull();
    });
  });
});
