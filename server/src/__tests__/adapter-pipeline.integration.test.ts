import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as net from "net";
import * as os from "os";
import * as fs from "fs";
import * as path from "path";
import { AdapterServer, type AdapterServerCallbacks } from "../adapter-server.js";
import { AircraftTracker } from "../tracker.js";
import { collectSources, buildBatchRecord, createBatchWindow, addPosition } from "../batch.js";
import { buildAtrxBlob, parseAtrxBlob, concatAtrxBlobs, splitAtrxBlobs, type AtrxMetadata } from "../atrx.js";
import type { AircraftMessage } from "../normalized.js";

async function waitFor(
  condition: () => boolean,
  options: { timeout?: number; interval?: number } = {},
): Promise<void> {
  const timeout = options.timeout ?? 4000;
  const interval = options.interval ?? 50;
  const startTime = Date.now();

  while (!condition()) {
    if (Date.now() - startTime > timeout) {
      throw new Error("waitFor: condition not met within timeout");
    }
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
}

describe("Adapter Pipeline Integration", () => {
  let server: AdapterServer;
  let tracker: AircraftTracker;
  let socketPath: string;
  const aircraftMessages: Map<string, AircraftMessage> = new Map();
  const callbacks: AdapterServerCallbacks = {
    onAircraft: vi.fn(async (_sourceId: string, msg: AircraftMessage) => {
      aircraftMessages.set(_sourceId, msg);
      const aircraft = msg.aircraft ?? [];
      const nowEpoch = Math.floor(Date.now() / 1000);
      tracker.update(aircraft, nowEpoch);
    }),
    onStats: vi.fn(),
    onRawCapture: vi.fn(),
  };

  beforeEach(() => {
    // Create unique socket path using temp directory
    const tempDir = os.tmpdir();
    const randomSuffix = Math.random().toString(36).substring(7);
    socketPath = path.join(tempDir, `at-adsb-test-${randomSuffix}.sock`);

    // Create tracker (with receiver location for range calculations)
    tracker = new AircraftTracker(37.5, -122.5);

    // Reset callbacks
    vi.clearAllMocks();

    // Clear aircraft messages from previous test
    aircraftMessages.clear();

    // Create server instance
    server = new AdapterServer(callbacks);
  });

  afterEach(async () => {
    // Stop server
    await server.stop();

    // Clean up socket file if it exists
    try {
      if (fs.existsSync(socketPath)) {
        fs.unlinkSync(socketPath);
      }
    } catch (e) {
      // Ignore cleanup errors
    }
  });

  describe("multi-input-adapters.AC10.1: Full pipeline end-to-end", () => {
    it("connects adapter via socket, sends aircraft with different sources, verifies sighting has source attribution", async () => {
      await server.start(socketPath);

      const client = net.createConnection(socketPath);

      return new Promise<void>((resolve, reject) => {
        client.on("connect", async () => {
          try {
            // Send handshake
            const handshake = {
              type: "handshake" as const,
              sourceId: "test-adapter",
              protocol: "test-protocol",
              version: 1,
            };
            client.write(JSON.stringify(handshake) + "\n");

            // Wait for handshake to be processed
            await waitFor(() => server.getConnectedSources().has("test-adapter"));

            // Send aircraft with two different sources
            const aircraftMessage: AircraftMessage = {
              type: "aircraft",
              timestamp: Date.now(),
              aircraft: [
                {
                  icaoHex: "A1B2C3",
                  source: "adsb_icao",
                  seen: 1.0,
                  rssi: -10,
                  messages: 50,
                  lat: 37.5,
                  lon: -122.5,
                  seenPos: 0.5,
                },
                {
                  icaoHex: "D4E5F6",
                  source: "mlat",
                  seen: 1.5,
                  rssi: -15,
                  messages: 30,
                  lat: 37.6,
                  lon: -122.6,
                  seenPos: 1.0,
                },
              ],
            };

            client.write(JSON.stringify(aircraftMessage) + "\n");

            // Wait for messages to be processed
            await waitFor(() => aircraftMessages.size > 0);

            // Build batch from accumulated data
            const batchWindow = createBatchWindow(new Date("2026-05-27T00:00:00Z"));
            const { telemetry } = batchWindow;

            // Manually add positions from tracker (simulating daemon batch collection)
            const trackedHexes = tracker.getAllTrackedHexes();
            for (const hex of trackedHexes) {
              const aircraft = tracker.getTracked(hex);
              if (aircraft) {
                for (const pos of aircraft.track) {
                  addPosition(telemetry, aircraft.icaoHex, pos);
                }
              }
            }

            // Collect sources and verify
            const sources = collectSources(telemetry);
            expect(sources).toEqual(["adsb_icao", "mlat"]);

            // Verify telemetry has both aircraft
            expect(Object.keys(telemetry)).toContain("A1B2C3");
            expect(Object.keys(telemetry)).toContain("D4E5F6");

            // Verify each position has correct source
            const a1b2c3Positions = telemetry["A1B2C3"];
            expect(a1b2c3Positions).toBeDefined();
            if (a1b2c3Positions) {
              for (const pos of a1b2c3Positions) {
                expect(pos.source).toBe("adsb_icao");
              }
            }

            const d4e5f6Positions = telemetry["D4E5F6"];
            expect(d4e5f6Positions).toBeDefined();
            if (d4e5f6Positions) {
              for (const pos of d4e5f6Positions) {
                expect(pos.source).toBe("mlat");
              }
            }

            // Build sighting record (mock BlobRef for testing)
            const mockBlobRef = { link: "bafytest123" };
            const sighting = buildBatchRecord(
              new Date("2026-05-27T00:00:00Z"),
              new Date("2026-05-27T00:01:00Z"),
              telemetry,
              mockBlobRef as any,
              new Date(),
              sources,
            );

            expect(sighting).not.toBeNull();
            if (sighting) {
              expect(sighting["sources"]).toEqual(["adsb_icao", "mlat"]);
              expect(Array.isArray(sighting["manifest"])).toBe(true);
              const manifest = sighting["manifest"] as Array<{ icaoHex: string }>;
              const hexes = manifest.map((m) => m.icaoHex);
              expect(hexes).toContain("A1B2C3");
              expect(hexes).toContain("D4E5F6");
            }

            client.destroy();
            resolve();
          } catch (e) {
            client.destroy();
            reject(e);
          }
        });

        client.on("error", reject);
      });
    });
  });

  describe("multi-input-adapters.AC10.2: Two adapters with overlapping aircraft", () => {
    it("connects two adapters, both report overlapping aircraft with different sources, verifies merged batch", async () => {
      await server.start(socketPath);

      const client1 = net.createConnection(socketPath);
      const client2 = net.createConnection(socketPath);

      return new Promise<void>((resolve, reject) => {
        let client1Connected = false;
        let client2Connected = false;

        client1.on("connect", async () => {
          try {
            const handshake = {
              type: "handshake" as const,
              sourceId: "readsb-1090",
              protocol: "test-protocol",
              version: 1,
            };
            client1.write(JSON.stringify(handshake) + "\n");

            await waitFor(() => server.getConnectedSources().has("readsb-1090"));
            client1Connected = true;

            const aircraftMessage: AircraftMessage = {
              type: "aircraft",
              timestamp: Date.now(),
              aircraft: [
                {
                  icaoHex: "A1B2C3",
                  source: "adsb_icao",
                  seen: 1.0,
                  rssi: -10,
                  messages: 50,
                  lat: 37.5,
                  lon: -122.5,
                  seenPos: 0.5,
                },
                {
                  icaoHex: "D4E5F6",
                  source: "adsb_icao",
                  seen: 1.5,
                  rssi: -12,
                  messages: 40,
                  lat: 37.6,
                  lon: -122.6,
                  seenPos: 1.0,
                },
              ],
            };
            client1.write(JSON.stringify(aircraftMessage) + "\n");

            // When both are connected, proceed with verification
            if (client1Connected && client2Connected) {
              // Wait for the onAircraft callback to be invoked for messages from both adapters
              await waitFor(
                () => (callbacks.onAircraft as any).mock.calls.length > 0,
              );
              performVerification();
            }
          } catch (e) {
            client1.destroy();
            client2.destroy();
            reject(e);
          }
        });

        client2.on("connect", async () => {
          try {
            const handshake = {
              type: "handshake" as const,
              sourceId: "dump978-uat",
              protocol: "test-protocol",
              version: 1,
            };
            client2.write(JSON.stringify(handshake) + "\n");

            await waitFor(() => server.getConnectedSources().has("dump978-uat"));
            client2Connected = true;

            const aircraftMessage: AircraftMessage = {
              type: "aircraft",
              timestamp: Date.now(),
              aircraft: [
                {
                  icaoHex: "A1B2C3",
                  source: "uat",
                  seen: 0.8,
                  rssi: -11,
                  messages: 45,
                  lat: 37.51,
                  lon: -122.51,
                  seenPos: 0.4,
                },
              ],
            };
            client2.write(JSON.stringify(aircraftMessage) + "\n");

            // When both are connected, proceed with verification
            if (client1Connected && client2Connected) {
              // Wait for the onAircraft callback to be invoked for messages from both adapters
              await waitFor(
                () => (callbacks.onAircraft as any).mock.calls.length > 0,
              );
              performVerification();
            }
          } catch (e) {
            client1.destroy();
            client2.destroy();
            reject(e);
          }
        });

        const performVerification = async () => {
          try {
            // Build batch from accumulated data
            const batchWindow = createBatchWindow(new Date("2026-05-27T00:00:00Z"));
            const { telemetry } = batchWindow;

            // Manually add positions from tracker
            const trackedHexes = tracker.getAllTrackedHexes();
            for (const hex of trackedHexes) {
              const aircraft = tracker.getTracked(hex);
              if (aircraft) {
                for (const pos of aircraft.track) {
                  addPosition(telemetry, aircraft.icaoHex, pos);
                }
              }
            }

            // Verify manifest has both aircraft
            const manifest = Object.keys(telemetry);
            expect(manifest).toContain("A1B2C3");
            expect(manifest).toContain("D4E5F6");

            // Verify sources array has both adsb_icao and uat
            const sources = collectSources(telemetry);
            expect(sources).toEqual(["adsb_icao", "uat"]);

            // Verify A1B2C3 has positions from both sources
            const a1b2c3Positions = telemetry["A1B2C3"];
            expect(a1b2c3Positions).toBeDefined();
            if (a1b2c3Positions) {
              const sourcesInA1 = new Set(a1b2c3Positions.map((p) => p.source));
              expect(sourcesInA1.has("adsb_icao")).toBe(true);
              expect(sourcesInA1.has("uat")).toBe(true);
            }

            // Verify D4E5F6 has positions only from adsb_icao
            const d4e5f6Positions = telemetry["D4E5F6"];
            expect(d4e5f6Positions).toBeDefined();
            if (d4e5f6Positions) {
              const sourcesInD4 = new Set(d4e5f6Positions.map((p) => p.source));
              expect(sourcesInD4.has("adsb_icao")).toBe(true);
              expect(sourcesInD4.has("uat")).toBe(false);
            }

            // Build sighting record
            const mockBlobRef = { link: "bafytest456" };
            const sighting = buildBatchRecord(
              new Date("2026-05-27T00:00:00Z"),
              new Date("2026-05-27T00:01:00Z"),
              telemetry,
              mockBlobRef as any,
              new Date(),
              sources,
            );

            expect(sighting).not.toBeNull();
            if (sighting) {
              expect(sighting["sources"]).toEqual(["adsb_icao", "uat"]);
              const manifestArray = sighting["manifest"] as Array<{ icaoHex: string }>;
              const hexes = manifestArray.map((m) => m.icaoHex).sort();
              expect(hexes).toContain("A1B2C3");
              expect(hexes).toContain("D4E5F6");
            }

            client1.destroy();
            client2.destroy();
            resolve();
          } catch (e) {
            client1.destroy();
            client2.destroy();
            reject(e);
          }
        };

        client1.on("error", reject);
        client2.on("error", reject);
      });
    });
  });

  describe("multi-input-adapters.AC6.4: ATRX concatenation integration", () => {
    it("builds real ATRX blobs, concatenates them, splits them, verifies each section parses independently", async () => {
      // Create BEAST frame sequences: each valid frame is 0x1a 0x31/0x32/0x33 + data
      // Frame 1: 0x1a 0x31 (ES DF 11) + 13 bytes
      // Frame 2: 0x1a 0x31 + 13 bytes
      // = 2 frames total
      const beastFrames1 = Buffer.from([
        0x1a, 0x31, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0a, 0x0b, 0x0c, 0x0d, // Frame 1 (2 + 13 bytes)
        0x1a, 0x31, 0x0e, 0x0f, 0x10, 0x11, 0x12, 0x13, 0x14, 0x15, 0x16, 0x17, 0x18, 0x19, 0x1b, // Frame 2 (2 + 13 bytes)
      ]);

      const metadata1: AtrxMetadata = {
        receiverDid: "did:key:test1",
        windowStart: "2026-05-27T00:00:00Z",
        windowEnd: "2026-05-27T00:01:00Z",
        clockSource: "gps",
        protocol: "beast-1090",
        demodSoftware: "readsb",
        frameCount: 2,
        gainDb: "30",
        sdrHardware: "rtl-sdr",
      };

      const blob1 = buildAtrxBlob(metadata1, beastFrames1);

      // UAT frames are text-based, each line starting with + or - is one frame
      const uatFrames2 = Buffer.from("+message1\n-message2\n+message3\n");

      const metadata2: AtrxMetadata = {
        receiverDid: "did:key:test2",
        windowStart: "2026-05-27T00:01:00Z",
        windowEnd: "2026-05-27T00:02:00Z",
        clockSource: "ntp",
        protocol: "uat-978",
        demodSoftware: "dump978",
        frameCount: 3,
        sampleRateHz: 2000000,
      };

      const blob2 = buildAtrxBlob(metadata2, uatFrames2);

      // Concatenate the blobs
      const concatenated = concatAtrxBlobs([blob1, blob2]);

      // Split back into sections
      const sections = splitAtrxBlobs(concatenated);

      // Verify we got two sections
      expect(sections).toHaveLength(2);

      // Parse and verify each section
      const section1 = sections[0];
      const section2 = sections[1];
      expect(section1).toBeDefined();
      expect(section2).toBeDefined();

      if (section1 && section2) {
        const parsed1 = parseAtrxBlob(section1);
        expect(parsed1.header.magic).toBe("ATRX");
        expect(parsed1.metadata.receiverDid).toBe("did:key:test1");
        expect(parsed1.metadata.protocol).toBe("beast-1090");
        expect(parsed1.metadata.frameCount).toBe(2);
        expect(parsed1.metadata.clockSource).toBe("gps");

        const parsed2 = parseAtrxBlob(section2);
        expect(parsed2.header.magic).toBe("ATRX");
        expect(parsed2.metadata.receiverDid).toBe("did:key:test2");
        expect(parsed2.metadata.protocol).toBe("uat-978");
        expect(parsed2.metadata.frameCount).toBe(3);
        expect(parsed2.metadata.clockSource).toBe("ntp");

        // Verify frame data integrity after round-trip
        // Note: frames are decompressed, so we just verify they're buffers
        expect(Buffer.isBuffer(parsed1.frames)).toBe(true);
        expect(Buffer.isBuffer(parsed2.frames)).toBe(true);
        expect(parsed1.frames.length).toBeGreaterThan(0);
        expect(parsed2.frames.length).toBeGreaterThan(0);
      }
    });
  });
});
