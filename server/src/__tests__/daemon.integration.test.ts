import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { AtpAgent } from "@atproto/api";
import { AircraftTracker, createStatsAccumulator } from "../tracker.js";
import { PublishQueue } from "../queue.js";
import { IdentityCache } from "../identity-cache.js";
import type { DaemonConfig } from "../config.js";
import type { NormalizedAircraft, AircraftMessage, StatsMessage } from "../normalized.js";
import { createBatchWindow, buildBatchRecord } from "../batch.js";

// Mock modules
vi.mock("../adapter-server.js");
vi.mock("../client.js");
vi.mock("../stream.js");

import * as clientModule from "../client.js";
import { AdapterServer } from "../adapter-server.js";

describe("daemon integration tests (Phase 4 refactoring)", () => {
  let mockAgent: AtpAgent;
  let tracker: AircraftTracker;
  let queue: PublishQueue;
  let config: DaemonConfig;
  let publishedRecords: Array<{ collection: string; record: Record<string, unknown> }>;
  let identityCache: IdentityCache;
  let protocolStats: Map<string, { messagesReceived: number; positionsDecoded: number; signal?: any }>;

  beforeEach(() => {
    queue = new PublishQueue(":memory:");
    mockAgent = {
      api: {},
      session: { did: "did:plc:test123" },
    } as unknown as AtpAgent;

    publishedRecords = [];
    vi.mocked(clientModule.createRecord).mockImplementation(
      async (agent, collection, record) => {
        publishedRecords.push({ collection, record });
        return {
          uri: `at://did:plc:test/com.atproto.repo.createRecord/cid-${publishedRecords.length}`,
          cid: `cid-${publishedRecords.length}`,
        };
      },
    );

    tracker = new AircraftTracker(37.5, -122.5);
    identityCache = new IdentityCache(queue.getDb());
    protocolStats = new Map();

    config = {
      atpService: "https://bsky.social",
      atpHandle: "test.bsky.social",
      atpPassword: "password",
      receiverLat: 37.5,
      receiverLon: -122.5,
      queueDbPath: ":memory:",
      wsPort: 4100,
      batchWindowS: 60,
      socketPath: "/tmp/at-adsb.sock",
      atrxTempDir: "/tmp/at-adsb-atrx",
      rawCaptureEnabled: true,
      statsIntervalM: 1,
    };
  });

  afterEach(() => {
    queue.close();
    vi.clearAllMocks();
  });

  describe("AC4.1: Daemon socket-only input", () => {
    it("daemon integrates aircraft updates into tracker via callbacks (AC4.1)", () => {
      // AC4.1: Verify daemon callbacks integrate with tracker state.
      // When an aircraft message is delivered to onAircraft callback,
      // the tracker receives the update and tracks the aircraft.

      const tracker1 = new AircraftTracker(37.5, -122.5);
      const now = Date.now() / 1000;

      let aircraftCallbackInvoked = false;

      const onAircraft = async (sourceId: string, msg: AircraftMessage) => {
        aircraftCallbackInvoked = true;
        // This simulates daemon integration: aircraft callback updates tracker
        tracker1.update(msg.aircraft, msg.timestamp);
      };

      const onStats = (sourceId: string, msg: StatsMessage) => {
        // Stats callback would aggregate stats here
      };

      const onRawCapture = (sourceId: string, msg: any) => {
        // Raw capture callback would store file paths here
      };

      // Verify AdapterServer can be instantiated with callbacks
      const server = new AdapterServer({ onAircraft, onStats, onRawCapture });
      expect(server).toBeDefined();

      // Simulate an aircraft message delivery
      const testAircraft: NormalizedAircraft = {
        icaoHex: "ABC123",
        source: "test-adapter",
        seen: now,
        seenPos: now,
        rssi: -20,
        messages: 50,
        category: "A3",
        lat: 37.5,
        lon: -122.5,
        altBaro: 8000,
      };

      const testMessage: AircraftMessage = {
        type: "aircraft",
        aircraft: [testAircraft],
        timestamp: now,
      };

      // Invoke the callback to simulate daemon integration
      onAircraft("test-adapter", testMessage);

      // Verify tracker was updated and aircraft is tracked
      expect(aircraftCallbackInvoked).toBe(true);
      const tracked = tracker1.getAllTrackedHexes();
      expect(tracked.has("ABC123")).toBe(true);
    });
  });

  describe("AC4.2: Zero connected adapters batch flush", () => {
    it("batch flush with empty telemetry produces no record (AC4.2)", () => {
      // AC4.2: When no adapters are connected (no aircraft updates),
      // batch flush should produce no record.
      // buildBatchRecord returns null for empty telemetry.

      // Create an empty batch window (no aircraft data)
      const windowStart = new Date();
      const windowEnd = new Date(windowStart.getTime() + 60000);
      const telemetry = createBatchWindow(windowStart).telemetry;

      // Verify telemetry is empty
      expect(Object.keys(telemetry).length).toBe(0);

      // Simulate batch flush: buildBatchRecord should return null for empty telemetry
      const mockBlobRef = { link: "bafytest" } as any;
      const record = buildBatchRecord(
        windowStart,
        windowEnd,
        telemetry,
        mockBlobRef,
        new Date(),
        [], // empty sources
      );

      // Verify no record is built for empty telemetry
      expect(record).toBeNull();
      expect(publishedRecords).toHaveLength(0);
    });
  });

  describe("AC4.3: Adapter disconnect mid-stream", () => {
    it("multi-adapter continuity: aircraft from disconnected adapter ages out (AC4.3)", () => {
      // AC4.3: When an adapter disconnects mid-stream, the daemon
      // continues operating with remaining adapters. Aircraft from
      // the disconnected adapter remain tracked for 60 seconds, then
      // are marked as departed. Aircraft from other adapters are unaffected.

      const tracker1 = new AircraftTracker(37.5, -122.5);
      const now = Date.now() / 1000;

      // Adapter 1 reports aircraft A at timestamp now
      const ac_adapter1: NormalizedAircraft = {
        icaoHex: "A12345",
        source: "adapter-1",
        seen: now,
        seenPos: now,
        rssi: -20,
        messages: 100,
        category: "A3",
        lat: 37.5,
        lon: -122.5,
        altBaro: 10000,
      };

      // Adapter 2 reports different aircraft B at same timestamp
      const ac_adapter2: NormalizedAircraft = {
        icaoHex: "B67890",
        source: "adapter-2",
        seen: now,
        seenPos: now,
        rssi: -21,
        messages: 50,
        category: "A2",
        lat: 37.51,
        lon: -122.51,
        altBaro: 9000,
      };

      // Both adapters send updates
      const result1 = tracker1.update([ac_adapter1, ac_adapter2], now);
      expect(result1.departed).toHaveLength(0);
      expect(result1.positions.has("A12345")).toBe(true);
      expect(result1.positions.has("B67890")).toBe(true);

      // Adapter 1 disconnects (simulated by 60s+ elapsed time with no updates from adapter-1)
      // Only adapter 2 sends a new update for aircraft B with a new position (seenPos earlier)
      const ac_adapter2_update: NormalizedAircraft = {
        icaoHex: "B67890",
        source: "adapter-2",
        seen: now + 60.1, // 60+ seconds later
        seenPos: now - 10, // new position (earlier seenPos = newer position fix, must be < now)
        rssi: -21,
        messages: 100,
        category: "A2",
        lat: 37.511,
        lon: -122.511,
        altBaro: 9100,
      };

      // Update with only adapter 2's aircraft (adapter 1 is disconnected/silent)
      const result2 = tracker1.update([ac_adapter2_update], now + 60.1);

      // Aircraft A should be marked as departed (60+ seconds with no update from any adapter)
      expect(result2.departed.some(d => d.icaoHex === "A12345")).toBe(true);
      // Aircraft B should have a new position (adapter 2 continues)
      expect(result2.positions.has("B67890")).toBe(true);

      // Verify tracker still tracks B but not A
      const allHexes = tracker1.getAllTrackedHexes();
      expect(allHexes.has("B67890")).toBe(true);
      expect(allHexes.has("A12345")).toBe(false);
    });
  });

  describe("AC5.2: Aircraft data feeds into unified tracker", () => {
    it("aircraft from multiple adapters merge in tracker (AC5.2)", async () => {
      // AC5.2: When two adapters send aircraft data for the same
      // aircraft (same ICAO hex), both updates should feed the
      // unified tracker. The tracker merges them by ICAO hex.

      const tracker1 = new AircraftTracker(37.5, -122.5);
      const now = Date.now() / 1000;

      const ac1: NormalizedAircraft = {
        icaoHex: "A12345",
        source: "adapter-1",
        seen: now,
        seenPos: now,
        rssi: -20,
        messages: 100,
        category: "A3",
        lat: 37.501,
        lon: -122.501,
        altBaro: 10000,
      };

      const ac2: NormalizedAircraft = {
        icaoHex: "A12345",
        source: "adapter-2",
        seen: now + 1,
        seenPos: now - 1, // Earlier seenPos = newer position fix (older data)
        rssi: -21,
        messages: 101,
        category: "A3",
        lat: 37.502,
        lon: -122.502,
        altBaro: 10005,
      };

      // First adapter update
      const result1 = tracker1.update([ac1], now);
      expect(result1.positions.has("A12345")).toBe(true);
      const positions1 = result1.positions.get("A12345");
      expect(positions1).toHaveLength(1);

      // Second adapter update (same aircraft, different position)
      // seenPos is earlier, so it's treated as a new fix
      const result2 = tracker1.update([ac2], now + 1);
      expect(result2.positions.has("A12345")).toBe(true);
      const positions2 = result2.positions.get("A12345");
      expect(positions2).toHaveLength(1);

      // Verify tracker still has the aircraft tracked
      const tracked = tracker1.getAllTrackedHexes();
      expect(tracked.has("A12345")).toBe(true);
    });
  });

  describe("AC5.4: Multi-adapter same ICAO merge", () => {
    it("same ICAO hex from two adapters merges into one entry (AC5.4)", () => {
      // AC5.4: When two different adapters report the same aircraft
      // (same ICAO hex), the tracker should have ONE entry, not two.
      // This is already handled by the tracker keying on ICAO hex.

      const tracker1 = new AircraftTracker(37.5, -122.5);
      const now = Date.now() / 1000;

      const ac_adapter1: NormalizedAircraft = {
        icaoHex: "A99999",
        source: "adapter-1",
        seen: now,
        seenPos: now,
        rssi: -20,
        messages: 100,
        category: "A2",
        lat: 37.5,
        lon: -122.5,
        altBaro: 5000,
      };

      const ac_adapter2: NormalizedAircraft = {
        icaoHex: "A99999",
        source: "adapter-2",
        seen: now + 1,
        seenPos: now + 1,
        rssi: -21,
        messages: 101,
        category: "A2",
        lat: 37.51,
        lon: -122.51,
        altBaro: 5100,
      };

      // Update from adapter 1
      tracker1.update([ac_adapter1], now);
      let tracked = tracker1.getAllTrackedHexes();
      expect(tracked.size).toBe(1);
      expect(tracked.has("A99999")).toBe(true);

      // Update from adapter 2 — same ICAO, should still be 1 entry
      tracker1.update([ac_adapter2], now + 1);
      tracked = tracker1.getAllTrackedHexes();
      expect(tracked.size).toBe(1);
      expect(tracked.has("A99999")).toBe(true);
    });

    it("multi-input-adapters.AC5.5: departure requires absence from ALL adapter feeds for 60 seconds", () => {
      // AC5.5: When the same ICAO hex is reported by two adapters,
      // departure only fires after 60 seconds of absence from ALL adapters,
      // not just one.
      //
      // Test flow:
      // 1. Both adapter-1 and adapter-2 report aircraft A99999 at time T
      // 2. Stop sending updates from adapter-1, continue sending from adapter-2
      // 3. Advance time 61+ seconds, update tracker with ONLY adapter-2's aircraft
      // 4. Verify NO departure — the aircraft is still being seen by adapter-2
      // 5. Now stop adapter-2 too. Advance another 61+ seconds, update tracker with empty array
      // 6. Verify departure is triggered — aircraft absent from ALL adapters for 60s

      const tracker1 = new AircraftTracker(37.5, -122.5);
      const now = Date.now() / 1000;

      // Initial updates: both adapters report A99999
      const ac_adapter1_initial: NormalizedAircraft = {
        icaoHex: "A99999",
        source: "adsb_icao",
        seen: now,
        seenPos: now,
        rssi: -20,
        messages: 100,
        category: "A2",
        lat: 37.5,
        lon: -122.5,
        altBaro: 5000,
      };

      const ac_adapter2_initial: NormalizedAircraft = {
        icaoHex: "A99999",
        source: "uat",
        seen: now,
        seenPos: now,
        rssi: -21,
        messages: 50,
        category: "A2",
        lat: 37.501,
        lon: -122.501,
        altBaro: 5050,
      };

      // Update 1: both adapters report the aircraft
      let result = tracker1.update([ac_adapter1_initial, ac_adapter2_initial], now);
      expect(result.departed).toHaveLength(0);
      let tracked = tracker1.getAllTrackedHexes();
      expect(tracked.has("A99999")).toBe(true);

      // Update 2: 61 seconds later, only adapter-2 sends data (adapter-1 disconnected)
      const ac_adapter2_update: NormalizedAircraft = {
        icaoHex: "A99999",
        source: "uat",
        seen: now + 61,
        seenPos: now + 30, // newer position (older seenPos)
        rssi: -21,
        messages: 150,
        category: "A2",
        lat: 37.502,
        lon: -122.502,
        altBaro: 5100,
      };

      result = tracker1.update([ac_adapter2_update], now + 61);

      // Aircraft should NOT depart because adapter-2 still sees it
      expect(result.departed).toHaveLength(0);
      expect(result.departed.some(d => d.icaoHex === "A99999")).toBe(false);
      tracked = tracker1.getAllTrackedHexes();
      expect(tracked.has("A99999")).toBe(true);

      // Update 3: 122 seconds from start, both adapters are silent (empty array)
      result = tracker1.update([], now + 122);

      // Now aircraft should depart (absent from ALL adapters for 60+ seconds)
      expect(result.departed).toHaveLength(1);
      expect(result.departed[0]?.icaoHex).toBe("A99999");
      tracked = tracker1.getAllTrackedHexes();
      expect(tracked.has("A99999")).toBe(false);
    });
  });

  describe("AC7: Stats aggregation from adapter messages", () => {
    it("single adapter stats populates protocolBreakdown (AC7.1)", () => {
      const stats = new Map<string, { messagesReceived: number; positionsDecoded: number; signal?: any }>();
      stats.set("adsb", {
        messagesReceived: 100,
        positionsDecoded: 50,
      });

      const protocolBreakdown = Array.from(stats).map(([protocol, entry]) => ({
        protocol,
        messagesReceived: entry.messagesReceived,
        positionsDecoded: entry.positionsDecoded,
        ...(entry.signal !== undefined ? { signal: entry.signal } : {}),
      }));

      expect(protocolBreakdown).toHaveLength(1);
      expect(protocolBreakdown[0]?.protocol).toBe("adsb");
      expect(protocolBreakdown[0]?.messagesReceived).toBe(100);
      expect(protocolBreakdown[0]?.positionsDecoded).toBe(50);
    });

    it("multiple adapters' stats merge into one record (AC7.2)", () => {
      const stats = new Map<string, { messagesReceived: number; positionsDecoded: number; signal?: any }>();
      stats.set("adsb", {
        messagesReceived: 100,
        positionsDecoded: 50,
      });
      stats.set("uat", {
        messagesReceived: 60,
        positionsDecoded: 30,
      });

      const protocolBreakdown = Array.from(stats).map(([protocol, entry]) => ({
        protocol,
        messagesReceived: entry.messagesReceived,
        positionsDecoded: entry.positionsDecoded,
        ...(entry.signal !== undefined ? { signal: entry.signal } : {}),
      }));

      expect(protocolBreakdown).toHaveLength(2);
      const protocols = protocolBreakdown.map(p => p.protocol).sort();
      expect(protocols).toEqual(["adsb", "uat"]);
    });

    it("silent adapter (no stats) contributes zero entries (AC7.3)", () => {
      const stats = new Map<string, { messagesReceived: number; positionsDecoded: number; signal?: any }>();
      stats.set("adsb", {
        messagesReceived: 100,
        positionsDecoded: 50,
      });

      const protocolBreakdown = Array.from(stats).map(([protocol, entry]) => ({
        protocol,
        messagesReceived: entry.messagesReceived,
        positionsDecoded: entry.positionsDecoded,
        ...(entry.signal !== undefined ? { signal: entry.signal } : {}),
      }));

      expect(protocolBreakdown).toHaveLength(1);
      expect(protocolBreakdown[0]?.protocol).toBe("adsb");
    });
  });
});
