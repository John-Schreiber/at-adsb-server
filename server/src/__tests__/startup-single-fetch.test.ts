import { describe, it, expect, beforeEach, vi } from "vitest";
import type { AtpAgent } from "@atproto/api";
import type { DaemonConfig } from "../config.js";
import { StreamBroadcaster } from "../stream.js";

vi.mock("../client.js");

// Mock only importSigningKey in keys.js; leave generateSigningKey and getSigningKeyDid real
vi.mock("../keys.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../keys.js")>();
  return {
    ...actual,
    importSigningKey: vi.fn(),
  };
});

import { runStartupUpdates } from "../daemon.js";
import * as clientModule from "../client.js";
import * as keysModule from "../keys.js";
import { generateSigningKey, getSigningKeyDid } from "../keys.js";

function makeMockAgent(): AtpAgent {
  return {
    session: { did: "did:plc:test-user" },
  } as unknown as AtpAgent;
}

function makeBaseConfig(overrides: Partial<DaemonConfig> = {}): DaemonConfig {
  return {
    atpService: "https://bsky.social",
    atpHandle: "receiver.bsky.social",
    atpPassword: "app-password",
    receiverLat: 40.0,
    receiverLon: -74.0,
    statsIntervalM: 60,
    queueDbPath: "./at-adsb-queue.db",
    wsPort: 0,
    batchWindowS: 300,
    socketPath: "/tmp/at-adsb.sock",
    atrxTempDir: "/tmp/at-adsb-atrx",
    rawCaptureEnabled: false,
    ...overrides,
  };
}

describe("runStartupUpdates — single getRecord with real modules", () => {
  let mockAgent: AtpAgent;
  let broadcaster: StreamBroadcaster;

  beforeEach(() => {
    mockAgent = makeMockAgent();
    broadcaster = new StreamBroadcaster();
    vi.clearAllMocks();
  });

  it("calls getRecord exactly once when both signing key and streamEndpoint are configured", async () => {
    // Use real key generation
    const keypair = await generateSigningKey();

    vi.mocked(keysModule.importSigningKey).mockResolvedValue(keypair);

    vi.mocked(clientModule.getRecord).mockResolvedValue({
      uri: "at://did:plc:test-user/at.adsb.receiver.station/self",
      cid: "cid-station",
      value: {
        $type: "at.adsb.receiver.station",
        displayName: "Test",
        streamSigningKey: getSigningKeyDid(keypair),
        location: { latitude: "40.0", longitude: "-74.0" },
      },
    });
    vi.mocked(clientModule.putRecord).mockResolvedValue({
      uri: "at://did:plc:test-user/at.adsb.receiver.station/self",
      cid: "cid-updated",
    });

    const config = makeBaseConfig({
      streamSigningKeyHex: "abcd0123".repeat(8),
      streamEndpoint: "wss://relay.example.com/xrpc/at.adsb.broadcast.subscribeEvents",
    });

    await runStartupUpdates(mockAgent, config, broadcaster);

    expect(vi.mocked(clientModule.getRecord)).toHaveBeenCalledOnce();
    // Fix 4: prove the endpoint update actually occurred, not just that getRecord
    // was called once. A regression that skips the prefetch could still produce
    // exactly 1 getRecord call, so assert putRecord received the streamEndpoint.
    expect(vi.mocked(clientModule.putRecord)).toHaveBeenCalledOnce();
    const putCallArgs = vi.mocked(clientModule.putRecord).mock.calls[0]!;
    const putRecord_ = putCallArgs[3] as Record<string, unknown>;
    expect(putRecord_["streamEndpoint"]).toBe("wss://relay.example.com/xrpc/at.adsb.broadcast.subscribeEvents");
  });

  it("calls getRecord exactly once when station record not found", async () => {
    const keypair = await generateSigningKey();
    vi.mocked(keysModule.importSigningKey).mockResolvedValue(keypair);

    vi.mocked(clientModule.getRecord).mockResolvedValue(null);

    const config = makeBaseConfig({
      streamSigningKeyHex: "abcd0123".repeat(8),
      streamEndpoint: "wss://relay.example.com/xrpc/at.adsb.broadcast.subscribeEvents",
    });

    await runStartupUpdates(mockAgent, config, broadcaster);

    expect(vi.mocked(clientModule.getRecord)).toHaveBeenCalledOnce();
  });

  it("returns signing key when streamSigningKeyHex is configured", async () => {
    const keypair = await generateSigningKey();
    vi.mocked(keysModule.importSigningKey).mockResolvedValue(keypair);

    vi.mocked(clientModule.getRecord).mockResolvedValue({
      uri: "at://did:plc:test-user/at.adsb.receiver.station/self",
      cid: "cid-station",
      value: {
        $type: "at.adsb.receiver.station",
        streamSigningKey: getSigningKeyDid(keypair),
        displayName: "Test",
        location: { latitude: "40.0", longitude: "-74.0" },
      },
    });
    vi.mocked(clientModule.putRecord).mockResolvedValue({
      uri: "at://did:plc:test-user/at.adsb.receiver.station/self",
      cid: "cid-updated",
    });

    const config = makeBaseConfig({
      streamSigningKeyHex: "abcd0123".repeat(8),
    });

    const result = await runStartupUpdates(mockAgent, config, broadcaster);
    expect(result).not.toBeNull();
  });

  it("returns null when streamSigningKeyHex is not configured", async () => {
    const config = makeBaseConfig({ streamSigningKeyHex: undefined });

    const result = await runStartupUpdates(mockAgent, config, broadcaster);
    expect(result).toBeNull();
  });
});
