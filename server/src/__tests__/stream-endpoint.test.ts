import { describe, it, expect, beforeEach, vi } from "vitest";
import type { AtpAgent } from "@atproto/api";

vi.mock("../client.js");

import { updateStreamEndpoint, validateStreamEndpoint } from "../stream-endpoint-update.js";
import * as clientModule from "../client.js";

describe("validateStreamEndpoint", () => {
  it("accepts wss:// URL", () => {
    expect(validateStreamEndpoint("wss://example.com/xrpc/at.adsb.broadcast.subscribeEvents")).toBe(true);
  });

  it("accepts ws:// URL", () => {
    expect(validateStreamEndpoint("ws://localhost:4100/xrpc/at.adsb.broadcast.subscribeEvents")).toBe(true);
  });

  it("rejects https:// URL", () => {
    expect(validateStreamEndpoint("https://example.com")).toBe(false);
  });

  it("rejects empty string", () => {
    expect(validateStreamEndpoint("")).toBe(false);
  });

  it("rejects undefined", () => {
    expect(validateStreamEndpoint(undefined)).toBe(false);
  });

  it("rejects wss:// without hostname", () => {
    expect(validateStreamEndpoint("wss://")).toBe(false);
  });
});

describe("updateStreamEndpoint", () => {
  let mockAgent: AtpAgent;

  beforeEach(() => {
    mockAgent = {
      session: { did: "did:plc:test-user" },
    } as unknown as AtpAgent;
    vi.clearAllMocks();
  });

  describe("update path", () => {
    it("updates record with new streamEndpoint", async () => {
      vi.mocked(clientModule.getRecord).mockResolvedValue({
        uri: "at://did:plc:test-user/at.adsb.receiver.station/self",
        cid: "cid-station",
        value: {
          $type: "at.adsb.receiver.station",
          displayName: "Test Station",
          location: { latitude: "37.5", longitude: "-122.5" },
        },
      });
      vi.mocked(clientModule.putRecord).mockResolvedValue({
        uri: "at://did:plc:test-user/at.adsb.receiver.station/self",
        cid: "cid-updated",
      });

      const result = await updateStreamEndpoint(mockAgent, "wss://relay.example.com/xrpc/at.adsb.broadcast.subscribeEvents");

      expect(result).toEqual({ updated: true });
      expect(vi.mocked(clientModule.putRecord)).toHaveBeenCalledOnce();

      const callArgs = vi.mocked(clientModule.putRecord).mock.calls[0]!;
      const record = callArgs[3] as Record<string, unknown>;
      expect(record["streamEndpoint"]).toBe("wss://relay.example.com/xrpc/at.adsb.broadcast.subscribeEvents");
      expect(record["displayName"]).toBe("Test Station");
      expect("$type" in record).toBe(false);
    });
  });

  describe("no-op when unchanged", () => {
    it("does not call putRecord when streamEndpoint matches", async () => {
      vi.mocked(clientModule.getRecord).mockResolvedValue({
        uri: "at://did:plc:test-user/at.adsb.receiver.station/self",
        cid: "cid-station",
        value: {
          streamEndpoint: "wss://relay.example.com/xrpc/at.adsb.broadcast.subscribeEvents",
        },
      });

      const result = await updateStreamEndpoint(mockAgent, "wss://relay.example.com/xrpc/at.adsb.broadcast.subscribeEvents");

      expect(result).toEqual({ updated: false, reason: "streamEndpoint unchanged" });
      expect(vi.mocked(clientModule.putRecord)).not.toHaveBeenCalled();
    });
  });

  describe("station record missing", () => {
    it("returns not found when getRecord returns null", async () => {
      vi.mocked(clientModule.getRecord).mockResolvedValue(null);

      const result = await updateStreamEndpoint(mockAgent, "wss://relay.example.com/xrpc/at.adsb.broadcast.subscribeEvents");

      expect(result).toEqual({ updated: false, reason: "station record not found" });
      expect(vi.mocked(clientModule.putRecord)).not.toHaveBeenCalled();
    });
  });

  describe("config undefined", () => {
    it("skips entirely when streamEndpoint is undefined", async () => {
      const result = await updateStreamEndpoint(mockAgent, undefined);

      expect(result).toEqual({ updated: false, reason: "streamEndpoint not configured" });
      expect(vi.mocked(clientModule.getRecord)).not.toHaveBeenCalled();
      expect(vi.mocked(clientModule.putRecord)).not.toHaveBeenCalled();
    });
  });

  describe("invalid URL", () => {
    it("rejects non-ws URL without fetching record", async () => {
      const result = await updateStreamEndpoint(mockAgent, "https://invalid.com");

      expect(result).toEqual({ updated: false, reason: "invalid streamEndpoint format" });
      expect(vi.mocked(clientModule.getRecord)).not.toHaveBeenCalled();
      expect(vi.mocked(clientModule.putRecord)).not.toHaveBeenCalled();
    });
  });

  describe("error containment", () => {
    it("catches getRecord errors and returns result", async () => {
      vi.mocked(clientModule.getRecord).mockRejectedValue(new Error("network error"));

      const result = await updateStreamEndpoint(mockAgent, "wss://relay.example.com/xrpc/at.adsb.broadcast.subscribeEvents");

      expect(result).toEqual({ updated: false, reason: "error during update" });
      expect(vi.mocked(clientModule.putRecord)).not.toHaveBeenCalled();
    });

    it("catches putRecord errors and returns result", async () => {
      vi.mocked(clientModule.getRecord).mockResolvedValue({
        uri: "at://did:plc:test-user/at.adsb.receiver.station/self",
        cid: "cid-station",
        value: { displayName: "Test" },
      });
      vi.mocked(clientModule.putRecord).mockRejectedValue(new Error("write error"));

      const result = await updateStreamEndpoint(mockAgent, "wss://relay.example.com/xrpc/at.adsb.broadcast.subscribeEvents");

      expect(result).toEqual({ updated: false, reason: "error during update" });
    });
  });

  describe("uses pre-fetched record (F8)", () => {
    it("skips getRecord when existingRecord provided", async () => {
      const prefetched = {
        uri: "at://did:plc:test-user/at.adsb.receiver.station/self",
        cid: "cid-station",
        value: {
          $type: "at.adsb.receiver.station",
          displayName: "Test",
          streamSigningKey: "did:key:old",
        },
      };

      vi.mocked(clientModule.putRecord).mockResolvedValue({
        uri: "at://did:plc:test-user/at.adsb.receiver.station/self",
        cid: "cid-updated",
      });

      const result = await updateStreamEndpoint(mockAgent, "wss://relay.example.com/xrpc/at.adsb.broadcast.subscribeEvents", prefetched);

      expect(result).toEqual({ updated: true });
      expect(vi.mocked(clientModule.getRecord)).not.toHaveBeenCalled();
      expect(vi.mocked(clientModule.putRecord)).toHaveBeenCalledOnce();

      const callArgs = vi.mocked(clientModule.putRecord).mock.calls[0]!;
      const record = callArgs[3] as Record<string, unknown>;
      expect(record["streamEndpoint"]).toBe("wss://relay.example.com/xrpc/at.adsb.broadcast.subscribeEvents");
      expect(record["displayName"]).toBe("Test");
    });

    it("returns not found when pre-fetched record is null", async () => {
      const result = await updateStreamEndpoint(mockAgent, "wss://relay.example.com/xrpc/at.adsb.broadcast.subscribeEvents", null);

      expect(result).toEqual({ updated: false, reason: "station record not found" });
      expect(vi.mocked(clientModule.getRecord)).not.toHaveBeenCalled();
      expect(vi.mocked(clientModule.putRecord)).not.toHaveBeenCalled();
    });

    it("fetches independently when existingRecord is undefined (standalone mode)", async () => {
      vi.mocked(clientModule.getRecord).mockResolvedValue({
        uri: "at://did:plc:test-user/at.adsb.receiver.station/self",
        cid: "cid-station",
        value: { displayName: "Test" },
      });
      vi.mocked(clientModule.putRecord).mockResolvedValue({
        uri: "at://did:plc:test-user/at.adsb.receiver.station/self",
        cid: "cid-updated",
      });

      await updateStreamEndpoint(mockAgent, "wss://relay.example.com/xrpc/at.adsb.broadcast.subscribeEvents");

      expect(vi.mocked(clientModule.getRecord)).toHaveBeenCalledOnce();
    });
  });
});
