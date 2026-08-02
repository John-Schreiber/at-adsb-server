import { describe, it, expect, beforeEach, vi } from "vitest";
import type { AtpAgent } from "@atproto/api";
import type { DaemonConfig } from "../config.js";
import { StreamBroadcaster } from "../stream.js";

vi.mock("../client.js");
vi.mock("../stream-endpoint-update.js");

import { runStartupUpdates } from "../daemon.js";
import * as clientModule from "../client.js";
import * as streamEndpointModule from "../stream-endpoint-update.js";

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

describe("runStartupUpdates — streamEndpoint wiring", () => {
  let mockAgent: AtpAgent;
  let broadcaster: StreamBroadcaster;

  beforeEach(() => {
    mockAgent = makeMockAgent();
    broadcaster = new StreamBroadcaster();
    vi.clearAllMocks();
  });

  it("calls updateStreamEndpoint exactly once when streamEndpoint is configured", async () => {
    vi.mocked(streamEndpointModule.updateStreamEndpoint).mockResolvedValue({ updated: true });

    const config = makeBaseConfig({
      streamEndpoint: "wss://relay.example.com/xrpc/at.adsb.broadcast.subscribeEvents",
    });

    await runStartupUpdates(mockAgent, config, broadcaster);

    expect(vi.mocked(streamEndpointModule.updateStreamEndpoint)).toHaveBeenCalledOnce();
  });

  it("passes agent, endpoint, and undefined (no key rotation) as third arg", async () => {
    vi.mocked(streamEndpointModule.updateStreamEndpoint).mockResolvedValue({ updated: false, reason: "noop" });

    const config = makeBaseConfig({
      streamEndpoint: "wss://relay.example.com/xrpc/at.adsb.broadcast.subscribeEvents",
    });

    await runStartupUpdates(mockAgent, config, broadcaster);

    const args = vi.mocked(streamEndpointModule.updateStreamEndpoint).mock.calls[0]!;
    expect(args[0]).toBe(mockAgent);
    expect(args[1]).toBe("wss://relay.example.com/xrpc/at.adsb.broadcast.subscribeEvents");
    expect(args[2]).toBeUndefined();
  });

  it("does NOT call updateStreamEndpoint when streamEndpoint is undefined", async () => {
    const config = makeBaseConfig({ streamEndpoint: undefined });

    await runStartupUpdates(mockAgent, config, broadcaster);

    expect(vi.mocked(streamEndpointModule.updateStreamEndpoint)).not.toHaveBeenCalled();
  });

  it("passes empty string through to updateStreamEndpoint", async () => {
    vi.mocked(streamEndpointModule.updateStreamEndpoint).mockResolvedValue({ updated: false, reason: "invalid" });

    const config = makeBaseConfig({ streamEndpoint: "" });

    await runStartupUpdates(mockAgent, config, broadcaster);

    expect(vi.mocked(streamEndpointModule.updateStreamEndpoint)).toHaveBeenCalledOnce();
    const args = vi.mocked(streamEndpointModule.updateStreamEndpoint).mock.calls[0]!;
    expect(args[1]).toBe("");
  });

  it("does not crash when updateStreamEndpoint rejects", async () => {
    vi.mocked(streamEndpointModule.updateStreamEndpoint).mockRejectedValue(new Error("unexpected"));

    const config = makeBaseConfig({
      streamEndpoint: "wss://relay.example.com/xrpc/at.adsb.broadcast.subscribeEvents",
    });

    // Fix 6: assert updateStreamEndpoint was actually called once with the
    // configured endpoint before checking that the rejection didn't crash.
    await expect(runStartupUpdates(mockAgent, config, broadcaster)).resolves.toBeDefined();
    expect(vi.mocked(streamEndpointModule.updateStreamEndpoint)).toHaveBeenCalledOnce();
    expect(vi.mocked(streamEndpointModule.updateStreamEndpoint)).toHaveBeenCalledWith(
      mockAgent,
      "wss://relay.example.com/xrpc/at.adsb.broadcast.subscribeEvents",
      undefined,
    );
  });
});
