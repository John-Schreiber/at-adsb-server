import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";
import { buildStationOpts } from "../cli.js";
import { buildStationRecord } from "../records.js";

/**
 * CLI integration tests for multi-input-adapters AC9
 */

describe("multi-input-adapters.AC9 — CLI socket-based and adapter commands", () => {
  describe("AC9.1: `at-adsb run` accepts --socket-path", () => {
    it("shows --socket-path flag in help", async () => {
      const helpOutput = await execHelp(["run"]);
      expect(helpOutput).toContain("--socket-path");
    });

    it("shows SOCKET_PATH env var in help text", async () => {
      const helpOutput = await execHelp(["run"]);
      expect(helpOutput).toMatch(/SOCKET_PATH|socket.*env/i);
    });

    it("shows --atrx-temp-dir flag in help", async () => {
      const helpOutput = await execHelp(["run"]);
      expect(helpOutput).toContain("--atrx-temp-dir");
    });
  });

  describe("AC9.3: `at-adsb run` no longer has readsb-specific flags", () => {
    it("does not show --readsb-url in help", async () => {
      const helpOutput = await execHelp(["run"]);
      expect(helpOutput).not.toContain("--readsb-url");
    });

    it("does not show --beast-host in help", async () => {
      const helpOutput = await execHelp(["run"]);
      expect(helpOutput).not.toContain("--beast-host");
    });

    it("does not show --beast-port in help", async () => {
      const helpOutput = await execHelp(["run"]);
      expect(helpOutput).not.toContain("--beast-port");
    });
  });

  describe("register --stream-endpoint", () => {
    it("shows --stream-endpoint flag in help", async () => {
      const helpOutput = await execHelp(["register"]);
      expect(helpOutput).toContain("--stream-endpoint");
    });

    it("help text mentions STREAM_ENDPOINT env var", async () => {
      const helpOutput = await execHelp(["register"]);
      expect(helpOutput).toContain("STREAM_ENDPOINT");
    });
  });
});

describe("buildStationOpts", () => {
  const savedEndpoint = process.env["STREAM_ENDPOINT"];

  afterEach(() => {
    if (savedEndpoint === undefined) {
      delete process.env["STREAM_ENDPOINT"];
    } else {
      process.env["STREAM_ENDPOINT"] = savedEndpoint;
    }
  });

  it("maps streamEndpoint from input to StationRecordOptions", () => {
    delete process.env["STREAM_ENDPOINT"];
    const opts = buildStationOpts({
      name: "Test",
      lat: 40.0,
      lon: -74.0,
      streamEndpoint: "wss://relay.example.com/xrpc/at.adsb.broadcast.subscribeEvents",
    });

    expect(opts.streamEndpoint).toBe("wss://relay.example.com/xrpc/at.adsb.broadcast.subscribeEvents");
  });

  it("returns undefined streamEndpoint when not provided and env not set", () => {
    delete process.env["STREAM_ENDPOINT"];
    const opts = buildStationOpts({
      name: "Test",
      lat: 40.0,
      lon: -74.0,
    });

    expect(opts.streamEndpoint).toBeUndefined();
  });

  it("falls back to STREAM_ENDPOINT env var when streamEndpoint not provided", () => {
    process.env["STREAM_ENDPOINT"] = "wss://env.example.com/xrpc/at.adsb.broadcast.subscribeEvents";
    const opts = buildStationOpts({
      name: "Test",
      lat: 40.0,
      lon: -74.0,
    });

    expect(opts.streamEndpoint).toBe("wss://env.example.com/xrpc/at.adsb.broadcast.subscribeEvents");
  });

  it("CLI flag takes precedence over STREAM_ENDPOINT env var", () => {
    process.env["STREAM_ENDPOINT"] = "wss://env.example.com/xrpc/at.adsb.broadcast.subscribeEvents";
    const opts = buildStationOpts({
      name: "Test",
      lat: 40.0,
      lon: -74.0,
      streamEndpoint: "wss://cli.example.com/xrpc/at.adsb.broadcast.subscribeEvents",
    });

    expect(opts.streamEndpoint).toBe("wss://cli.example.com/xrpc/at.adsb.broadcast.subscribeEvents");
  });

  it("buildStationRecord includes streamEndpoint when provided via buildStationOpts", () => {
    delete process.env["STREAM_ENDPOINT"];
    const opts = buildStationOpts({
      name: "Test",
      lat: 40.0,
      lon: -74.0,
      streamEndpoint: "wss://relay.example.com/xrpc/at.adsb.broadcast.subscribeEvents",
    });

    const record = buildStationRecord(opts, new Date());

    expect(record["streamEndpoint"]).toBe("wss://relay.example.com/xrpc/at.adsb.broadcast.subscribeEvents");
  });
});

describe("multi-input-adapters.AC9.2 — adapter subcommands (re-grouped)", () => {
  describe("AC9.2: `at-adsb adapter readsb` subcommand exists", () => {
    it("shows adapter command in help", async () => {
      const helpOutput = await execHelp([]);
      expect(helpOutput).toContain("adapter");
    });

    it("adapter readsb command exists and shows help", async () => {
      const helpOutput = await execHelp(["adapter", "readsb"]);
      expect(helpOutput).toBeTruthy();
    });

    it("adapter readsb accepts --socket flag", async () => {
      const helpOutput = await execHelp(["adapter", "readsb"]);
      expect(helpOutput).toContain("--socket");
    });

    it("adapter readsb accepts --url flag", async () => {
      const helpOutput = await execHelp(["adapter", "readsb"]);
      expect(helpOutput).toContain("--url");
    });

    it("adapter readsb accepts --source-id flag", async () => {
      const helpOutput = await execHelp(["adapter", "readsb"]);
      expect(helpOutput).toContain("--source-id");
    });

    it("adapter readsb accepts --source-override flag", async () => {
      const helpOutput = await execHelp(["adapter", "readsb"]);
      expect(helpOutput).toContain("--source-override");
    });

    it("adapter readsb accepts --beast-host flag", async () => {
      const helpOutput = await execHelp(["adapter", "readsb"]);
      expect(helpOutput).toContain("--beast-host");
    });

    it("adapter readsb accepts --beast-port flag", async () => {
      const helpOutput = await execHelp(["adapter", "readsb"]);
      expect(helpOutput).toContain("--beast-port");
    });

    it("adapter readsb accepts --batch-window flag", async () => {
      const helpOutput = await execHelp(["adapter", "readsb"]);
      expect(helpOutput).toContain("--batch-window");
    });

    it("adapter readsb accepts --poll-interval flag", async () => {
      const helpOutput = await execHelp(["adapter", "readsb"]);
      expect(helpOutput).toContain("--poll-interval");
    });

    it("adapter readsb accepts --atrx-temp-dir flag", async () => {
      const helpOutput = await execHelp(["adapter", "readsb"]);
      expect(helpOutput).toContain("--atrx-temp-dir");
    });
  });
});

/**
 * Helper to run CLI and capture help output
 */
const serverDir = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const tsxBin = resolve(serverDir, "node_modules/.bin/tsx");

async function execHelp(args: Array<string>): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn(tsxBin, ["src/cli.ts", ...args, "--help"], {
      cwd: serverDir,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    proc.stdout?.on("data", (data) => {
      stdout += data.toString();
    });

    proc.stderr?.on("data", (data) => {
      stderr += data.toString();
    });

    proc.on("close", (code) => {
      // Fix 5: only resolve on exit code 0; reject otherwise so failed
      // invocations don't pass silently.
      if (code === 0) {
        resolve(stdout + stderr);
      } else {
        reject(new Error(`Command exited with code ${code}: ${stderr || stdout}`));
      }
    });

    proc.on("error", reject);

    // Timeout after 10s
    setTimeout(() => {
      proc.kill();
      reject(new Error("Help command timed out"));
    }, 10000);
  });
}
