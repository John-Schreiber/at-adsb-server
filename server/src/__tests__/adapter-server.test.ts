import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as net from "net";
import * as os from "os";
import * as fs from "fs";
import * as path from "path";
import { AdapterServer, type AdapterServerCallbacks } from "../adapter-server.js";
import type { AircraftMessage, StatsMessage, RawCaptureMessage } from "../normalized.js";

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

describe("AdapterServer", () => {
  let server: AdapterServer;
  let socketPath: string;
  const callbacks: AdapterServerCallbacks = {
    onAircraft: vi.fn(),
    onStats: vi.fn(),
    onRawCapture: vi.fn(),
  };

  beforeEach(() => {
    // Create unique socket path using temp directory and random suffix
    const tempDir = os.tmpdir();
    const randomSuffix = Math.random().toString(36).substring(7);
    socketPath = path.join(tempDir, `at-adsb-test-${randomSuffix}.sock`);

    // Reset callbacks
    vi.clearAllMocks();

    // Create server instance
    server = new AdapterServer(callbacks);
  });

  afterEach(async () => {
    // Stop server and clean up
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

  describe("multi-input-adapters.AC1.1: Socket lifecycle", () => {
    it("creates socket file at configured path on start", async () => {
      await server.start(socketPath);
      expect(fs.existsSync(socketPath)).toBe(true);
    });

    it("removes socket file on stop", async () => {
      await server.start(socketPath);
      expect(fs.existsSync(socketPath)).toBe(true);

      await server.stop();
      expect(fs.existsSync(socketPath)).toBe(false);
    });

    it("handles stale socket file by removing it on start", async () => {
      // Create a fake socket file
      const dir = path.dirname(socketPath);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(socketPath, "stale");

      expect(fs.existsSync(socketPath)).toBe(true);

      // Start should remove the stale file and create a new socket
      await server.start(socketPath);
      expect(fs.existsSync(socketPath)).toBe(true);
    });
  });

  describe("multi-input-adapters.AC1.2: Handshake acceptance", () => {
    it("accepts valid handshake and tracks connection by sourceId", async () => {
      await server.start(socketPath);

      const client = net.createConnection(socketPath);

      return new Promise<void>((resolve, reject) => {
        client.on("connect", async () => {
          const handshake = {
            type: "handshake" as const,
            sourceId: "adapter-1",
            protocol: "readsb-json",
            version: 1,
          };

          client.write(JSON.stringify(handshake) + "\n");

          try {
            await waitFor(() => server.getConnectedSources().has("adapter-1"));
            const sources = server.getConnectedSources();
            expect(sources.get("adapter-1")?.protocol).toBe("readsb-json");
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

    it("routes aircraft messages to onAircraft callback after handshake", async () => {
      await server.start(socketPath);

      const client = net.createConnection(socketPath);

      return new Promise<void>((resolve, reject) => {
        client.on("connect", async () => {
          const handshake = {
            type: "handshake" as const,
            sourceId: "adapter-1",
            protocol: "readsb-json",
            version: 1,
          };

          client.write(JSON.stringify(handshake) + "\n");

          try {
            await waitFor(() => server.getConnectedSources().has("adapter-1"));

            const aircraftMessage: AircraftMessage = {
              type: "aircraft",
              timestamp: Date.now(),
              aircraft: [
                {
                  icaoHex: "AABBCC",
                  source: "adapter-1",
                  seen: 1.5,
                  rssi: -10,
                  messages: 100,
                  lat: 40.0,
                  lon: -74.0,
                },
              ],
            };

            client.write(JSON.stringify(aircraftMessage) + "\n");

            await waitFor(() => vi.mocked(callbacks.onAircraft).mock.calls.length > 0);

            expect(callbacks.onAircraft).toHaveBeenCalledWith(
              "adapter-1",
              expect.objectContaining({
                type: "aircraft",
                aircraft: expect.arrayContaining([
                  expect.objectContaining({ icaoHex: "AABBCC" }),
                ]),
              }),
            );
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

  describe("multi-input-adapters.AC1.4: Handshake timeout", () => {
    it("destroys connection without handshake within 5 seconds", async () => {
      // Use fake timers to control timeout
      vi.useFakeTimers();

      try {
        await server.start(socketPath);

        const client = net.createConnection(socketPath);
        const closePromise = new Promise<void>((resolve) => {
          client.on("close", resolve);
        });

        // Advance time past handshake timeout (5 seconds)
        await new Promise((resolve) => client.on("connect", resolve));
        vi.advanceTimersByTime(5001);

        await closePromise;
        expect(server.getConnectedSources().size).toBe(0);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe("multi-input-adapters.AC1.5: Malformed NDJSON handling", () => {
    it("drops malformed JSON line and keeps connection open", async () => {
      await server.start(socketPath);

      const client = net.createConnection(socketPath);

      return new Promise<void>((resolve, reject) => {
        client.on("connect", async () => {
          // Send valid handshake
          const handshake = {
            type: "handshake" as const,
            sourceId: "adapter-1",
            protocol: "readsb-json",
            version: 1,
          };

          client.write(JSON.stringify(handshake) + "\n");

          try {
            await waitFor(() => server.getConnectedSources().has("adapter-1"));

            // Send malformed JSON
            client.write("{ this is not valid json\n");

            // Send valid message after malformed one
            const aircraftMessage: AircraftMessage = {
              type: "aircraft",
              timestamp: Date.now(),
              aircraft: [
                {
                  icaoHex: "AABBCC",
                  source: "adapter-1",
                  seen: 1.5,
                  rssi: -10,
                  messages: 100,
                },
              ],
            };

            client.write(JSON.stringify(aircraftMessage) + "\n");

            await waitFor(() => vi.mocked(callbacks.onAircraft).mock.calls.length > 0);

            // Connection should still be active
            expect(server.getConnectedSources().has("adapter-1")).toBe(true);

            // Valid message should have been routed
            expect(callbacks.onAircraft).toHaveBeenCalled();

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

  describe("multi-input-adapters.AC1.6: Duplicate sourceId handling", () => {
    it("replaces old connection when new connection with same sourceId connects", async () => {
      await server.start(socketPath);

      const client1 = net.createConnection(socketPath);
      const client2 = net.createConnection(socketPath);

      return new Promise<void>((resolve, reject) => {
        client1.on("connect", () => {
          const handshake = {
            type: "handshake" as const,
            sourceId: "adapter-1",
            protocol: "protocol-v1",
            version: 1,
          };

          client1.write(JSON.stringify(handshake) + "\n");
        });

        client2.on("connect", async () => {
          try {
            // Wait for client1's handshake to register
            await waitFor(() => server.getConnectedSources().has("adapter-1"));

            const handshake = {
              type: "handshake" as const,
              sourceId: "adapter-1", // Same sourceId
              protocol: "protocol-v2",
              version: 1,
            };

            client2.write(JSON.stringify(handshake) + "\n");

            // Wait for client2's handshake to replace client1
            await waitFor(() => server.getConnectedSources().get("adapter-1")?.protocol === "protocol-v2");

            const sources = server.getConnectedSources();
            // After client2 handshake, should have protocol-v2
            expect(sources.size).toBe(1);
            expect(sources.has("adapter-1")).toBe(true);
            expect(sources.get("adapter-1")?.protocol).toBe("protocol-v2");
          } catch (e) {
            reject(e);
          } finally {
            client1.destroy();
            client2.destroy();
            resolve();
          }
        });

        client1.on("error", reject);
        client2.on("error", reject);
      });
    });
  });

  describe("multi-input-adapters.AC5.1: Multiple simultaneous connections", () => {
    it("accepts multiple adapters with different sourceIds simultaneously", async () => {
      await server.start(socketPath);

      const client1 = net.createConnection(socketPath);
      const client2 = net.createConnection(socketPath);

      return new Promise<void>((resolve, reject) => {
        client1.on("connect", () => {
          const handshake = {
            type: "handshake" as const,
            sourceId: "adapter-1",
            protocol: "readsb-json",
            version: 1,
          };

          client1.write(JSON.stringify(handshake) + "\n");
        });

        client2.on("connect", async () => {
          const handshake = {
            type: "handshake" as const,
            sourceId: "adapter-2",
            protocol: "radarcape",
            version: 1,
          };

          client2.write(JSON.stringify(handshake) + "\n");

          try {
            await waitFor(
              () =>
                server.getConnectedSources().has("adapter-1") &&
                server.getConnectedSources().has("adapter-2"),
            );

            const sources = server.getConnectedSources();
            expect(sources.size).toBe(2);
            expect(sources.has("adapter-1")).toBe(true);
            expect(sources.has("adapter-2")).toBe(true);
            expect(sources.get("adapter-1")?.protocol).toBe("readsb-json");
            expect(sources.get("adapter-2")?.protocol).toBe("radarcape");

            client1.destroy();
            client2.destroy();
            resolve();
          } catch (e) {
            client1.destroy();
            client2.destroy();
            reject(e);
          }
        });

        client1.on("error", reject);
        client2.on("error", reject);
      });
    });

    it("routes messages from each adapter independently", async () => {
      await server.start(socketPath);

      const client1 = net.createConnection(socketPath);
      const client2 = net.createConnection(socketPath);

      return new Promise<void>((resolve, reject) => {
        client1.on("connect", () => {
          const handshake = {
            type: "handshake" as const,
            sourceId: "adapter-1",
            protocol: "readsb-json",
            version: 1,
          };

          client1.write(JSON.stringify(handshake) + "\n");
        });

        client2.on("connect", async () => {
          const handshake = {
            type: "handshake" as const,
            sourceId: "adapter-2",
            protocol: "radarcape",
            version: 1,
          };

          client2.write(JSON.stringify(handshake) + "\n");

          try {
            await waitFor(
              () =>
                server.getConnectedSources().has("adapter-1") &&
                server.getConnectedSources().has("adapter-2"),
            );

            // Send from adapter-1
            const msg1: AircraftMessage = {
              type: "aircraft",
              timestamp: Date.now(),
              aircraft: [
                {
                  icaoHex: "111111",
                  source: "adapter-1",
                  seen: 1.0,
                  rssi: -10,
                  messages: 50,
                },
              ],
            };

            client1.write(JSON.stringify(msg1) + "\n");

            // Send from adapter-2
            const msg2: AircraftMessage = {
              type: "aircraft",
              timestamp: Date.now(),
              aircraft: [
                {
                  icaoHex: "222222",
                  source: "adapter-2",
                  seen: 2.0,
                  rssi: -15,
                  messages: 75,
                },
              ],
            };

            client2.write(JSON.stringify(msg2) + "\n");

            await waitFor(
              () => vi.mocked(callbacks.onAircraft).mock.calls.length >= 2,
            );

            // Both adapters should have sent
            const calls = vi.mocked(callbacks.onAircraft).mock.calls;
            expect(calls.length).toBeGreaterThanOrEqual(2);

            const call1 = calls.find((c) => c[0] === "adapter-1");
            const call2 = calls.find((c) => c[0] === "adapter-2");

            expect(call1).toBeDefined();
            expect(call2).toBeDefined();

            if (call1 && call2) {
              const msg1Data = call1[1] as AircraftMessage;
              const msg2Data = call2[1] as AircraftMessage;

              expect(msg1Data.aircraft[0]?.icaoHex).toBe("111111");
              expect(msg2Data.aircraft[0]?.icaoHex).toBe("222222");
            }

            client1.destroy();
            client2.destroy();
            resolve();
          } catch (e) {
            client1.destroy();
            client2.destroy();
            reject(e);
          }
        });

        client1.on("error", reject);
        client2.on("error", reject);
      });
    });
  });

  describe("multi-input-adapters.AC5.3: Disconnect cleanup", () => {
    it("removes source from active set when adapter disconnects", async () => {
      await server.start(socketPath);

      const client1 = net.createConnection(socketPath);
      const client2 = net.createConnection(socketPath);

      return new Promise<void>((resolve, reject) => {
        client1.on("connect", () => {
          const handshake = {
            type: "handshake" as const,
            sourceId: "adapter-1",
            protocol: "readsb-json",
            version: 1,
          };

          client1.write(JSON.stringify(handshake) + "\n");
        });

        client2.on("connect", async () => {
          const handshake = {
            type: "handshake" as const,
            sourceId: "adapter-2",
            protocol: "radarcape",
            version: 1,
          };

          client2.write(JSON.stringify(handshake) + "\n");

          try {
            await waitFor(
              () =>
                server.getConnectedSources().has("adapter-1") &&
                server.getConnectedSources().has("adapter-2"),
            );

            // Both connected
            let sources = server.getConnectedSources();
            expect(sources.size).toBe(2);

            // Disconnect client1
            client1.destroy();

            await waitFor(() => !server.getConnectedSources().has("adapter-1"));

            sources = server.getConnectedSources();

            // adapter-1 should be gone, adapter-2 should remain
            expect(sources.has("adapter-1")).toBe(false);
            expect(sources.has("adapter-2")).toBe(true);

            client2.destroy();
            resolve();
          } catch (e) {
            client2.destroy();
            reject(e);
          }
        });

        client1.on("error", reject);
        client2.on("error", reject);
      });
    });

    it("remaining adapters unaffected when one disconnects", async () => {
      await server.start(socketPath);

      const client1 = net.createConnection(socketPath);
      const client2 = net.createConnection(socketPath);

      return new Promise<void>((resolve, reject) => {
        client1.on("connect", () => {
          const handshake = {
            type: "handshake" as const,
            sourceId: "adapter-1",
            protocol: "readsb-json",
            version: 1,
          };

          client1.write(JSON.stringify(handshake) + "\n");
        });

        client2.on("connect", async () => {
          const handshake = {
            type: "handshake" as const,
            sourceId: "adapter-2",
            protocol: "radarcape",
            version: 1,
          };

          client2.write(JSON.stringify(handshake) + "\n");

          try {
            await waitFor(
              () =>
                server.getConnectedSources().has("adapter-1") &&
                server.getConnectedSources().has("adapter-2"),
            );

            // Both connected
            let sources = server.getConnectedSources();
            expect(sources.size).toBe(2);

            // Disconnect client1
            client1.destroy();

            await waitFor(() => !server.getConnectedSources().has("adapter-1"));

            // Send message from adapter-2 to verify it still works
            const msg: AircraftMessage = {
              type: "aircraft",
              timestamp: Date.now(),
              aircraft: [
                {
                  icaoHex: "222222",
                  source: "adapter-2",
                  seen: 2.0,
                  rssi: -15,
                  messages: 75,
                },
              ],
            };

            // Clear previous calls to make sure next call is from our message
            vi.clearAllMocks();
            client2.write(JSON.stringify(msg) + "\n");

            await waitFor(() => vi.mocked(callbacks.onAircraft).mock.calls.length > 0);

            // adapter-2 should still be working
            expect(callbacks.onAircraft).toHaveBeenCalledWith(
              "adapter-2",
              expect.any(Object),
            );

            client2.destroy();
            resolve();
          } catch (e) {
            client2.destroy();
            reject(e);
          }
        });

        client1.on("error", reject);
        client2.on("error", reject);
      });
    });
  });

  describe("multi-input-adapters.AC5.6: Invalid handshake rejection", () => {
    it("rejects handshake with missing sourceId", async () => {
      await server.start(socketPath);

      const client = net.createConnection(socketPath);
      let closed = false;

      return new Promise<void>((resolve, reject) => {
        client.on("connect", async () => {
          // Invalid handshake - missing sourceId
          const badHandshake = {
            type: "handshake" as const,
            protocol: "readsb-json",
            version: 1,
          };

          client.write(JSON.stringify(badHandshake) + "\n");

          try {
            // Connection should be destroyed within timeout
            await waitFor(() => closed);
            expect(server.getConnectedSources().size).toBe(0);
            resolve();
          } catch (e) {
            reject(e);
          }
        });

        client.on("close", () => {
          // Expected to close
          closed = true;
        });

        client.on("error", () => {
          // Expected to error when socket is destroyed
          closed = true;
        });
      });
    });

    it("rejects handshake with wrong version", async () => {
      await server.start(socketPath);

      const client = net.createConnection(socketPath);
      let closed = false;

      return new Promise<void>((resolve, reject) => {
        client.on("connect", async () => {
          // Invalid handshake - wrong version
          const badHandshake = {
            type: "handshake" as const,
            sourceId: "adapter-1",
            protocol: "readsb-json",
            version: 2, // Wrong version
          };

          client.write(JSON.stringify(badHandshake) + "\n");

          try {
            // Connection should be destroyed within timeout
            await waitFor(() => closed);
            expect(server.getConnectedSources().size).toBe(0);
            resolve();
          } catch (e) {
            reject(e);
          }
        });

        client.on("close", () => {
          // Expected to close
          closed = true;
        });

        client.on("error", () => {
          // Expected to error when socket is destroyed
          closed = true;
        });
      });
    });
  });

  describe("message routing", () => {
    it("routes stats messages to onStats callback", async () => {
      await server.start(socketPath);

      const client = net.createConnection(socketPath);

      return new Promise<void>((resolve, reject) => {
        client.on("connect", async () => {
          const handshake = {
            type: "handshake" as const,
            sourceId: "adapter-1",
            protocol: "readsb-json",
            version: 1,
          };

          client.write(JSON.stringify(handshake) + "\n");

          try {
            await waitFor(() => server.getConnectedSources().has("adapter-1"));

            const statsMessage: StatsMessage = {
              type: "stats",
              protocol: "readsb-json",
              messagesReceived: 1000,
              positionsDecoded: 50,
              signal: {
                meanDbfs: -25,
                noiseDbfs: -40,
                strongCount: 10,
              },
            };

            client.write(JSON.stringify(statsMessage) + "\n");

            await waitFor(() => vi.mocked(callbacks.onStats).mock.calls.length > 0);

            expect(callbacks.onStats).toHaveBeenCalledWith(
              "adapter-1",
              expect.objectContaining({
                type: "stats",
                messagesReceived: 1000,
              }),
            );
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

    it("routes rawCapture messages to onRawCapture callback", async () => {
      await server.start(socketPath);

      const client = net.createConnection(socketPath);

      return new Promise<void>((resolve, reject) => {
        client.on("connect", async () => {
          const handshake = {
            type: "handshake" as const,
            sourceId: "adapter-1",
            protocol: "readsb-json",
            version: 1,
          };

          client.write(JSON.stringify(handshake) + "\n");

          try {
            await waitFor(() => server.getConnectedSources().has("adapter-1"));

            const rawCaptureMessage: RawCaptureMessage = {
              type: "rawCapture",
              filePath: "/tmp/capture.atrx",
              windowStart: "2026-05-26T12:00:00Z",
              windowEnd: "2026-05-26T12:01:00Z",
            };

            client.write(JSON.stringify(rawCaptureMessage) + "\n");

            await waitFor(
              () => vi.mocked(callbacks.onRawCapture).mock.calls.length > 0,
            );

            expect(callbacks.onRawCapture).toHaveBeenCalledWith(
              "adapter-1",
              expect.objectContaining({
                type: "rawCapture",
                filePath: "/tmp/capture.atrx",
              }),
            );
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
});
