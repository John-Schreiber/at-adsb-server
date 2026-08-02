// pattern: Imperative Shell

import { createConnection, Socket } from "node:net";
import { randomUUID } from "node:crypto";
import { writeFile, unlink, mkdir } from "node:fs/promises";
import type { ReadsbAircraft } from "../readsb.js";
import {
  fetchAircraft,
  fetchStats,
} from "../readsb.js";
import type {
  NormalizedAircraft,
  AircraftMessage,
  RawCaptureMessage,
} from "../normalized.js";
import { BeastClient } from "../beast-client.js";
import {
  buildAtrxBlob,
  countBeastFrames,
  type AtrxMetadata,
} from "../atrx.js";
import {
  mapReadsbToNormalized,
  buildStatsMessage,
  calculateBackoffDelay,
} from "./readsb-mapping.js";

export type ReadsbAdapterConfig = {
  readonly socketPath: string;
  readonly readsbUrl: string;
  readonly sourceId: string;
  readonly sourceOverride?: string;
  readonly pollIntervalS: number;
  readonly beastHost?: string;
  readonly beastPort?: number;
  readonly batchWindowS: number;
  readonly atrxTempDir: string;
};

export class ReadsbAdapterClient {
  private socket: Socket | null = null;
  private reconnectDelayMs: number = 1000;
  private maxReconnectDelayMs: number = 60000;
  private currentReconnectDelayMs: number = 1000;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private pollTimer: NodeJS.Timeout | null = null;
  private batchTimer: NodeJS.Timeout | null = null;
  private stopped: boolean = false;
  private beastClient: BeastClient | null = null;
  private batchWindowStart: Date | null = null;
  private lastStatsWindowStart: number | null = null;

  constructor(private readonly config: ReadsbAdapterConfig) {
    // Ensure temp directory exists
    mkdir(config.atrxTempDir, { recursive: true }).catch((err: Error) => {
      console.error(`failed to create temp directory: ${err.message}`);
    });

    // Initialize BEAST client if configured
    if (config.beastHost && config.beastPort) {
      this.beastClient = new BeastClient({
        host: config.beastHost,
        port: config.beastPort,
      });
    }
  }

  start(): void {
    if (this.stopped) {
      return;
    }
    this.connect();
  }

  private connect(): void {
    if (this.stopped) {
      return;
    }

    this.socket = createConnection(this.config.socketPath, () => {
      this.currentReconnectDelayMs = this.reconnectDelayMs;
      console.log(`ReadsbAdapter: Connected to ${this.config.socketPath}`);

      // Send handshake
      const handshake = {
        type: "handshake",
        sourceId: this.config.sourceId,
        protocol: "adsb",
        version: 1,
      };
      this.writeMessage(handshake);

      // Start poll loop
      this.startPollLoop();

      // Start batch window if BEAST is configured
      if (this.beastClient) {
        this.beastClient.start();
        this.startBatchWindow();
      }
    });

    this.socket.on("error", (err: Error) => {
      console.error(`ReadsbAdapter: Connection error: ${err.message}`);
      this.scheduleReconnect();
    });

    this.socket.on("close", () => {
      console.log("ReadsbAdapter: Connection closed");
      this.stopPollLoop();
      this.stopBatchWindow();
      this.scheduleReconnect();
    });

    this.socket.on("data", () => {
      // We don't expect data from the daemon, just receive and ignore
    });
  }

  private writeMessage(message: unknown): void {
    if (!this.socket || this.socket.destroyed) {
      return;
    }
    try {
      const json = JSON.stringify(message);
      this.socket.write(`${json}\n`);
    } catch (err) {
      console.error(`failed to write message: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private startPollLoop(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
    }

    const pollMs = this.config.pollIntervalS * 1000;

    // Poll immediately
    this.pollOnce().catch((err: Error) => {
      console.error(`failed to poll aircraft: ${err.message}`);
    });

    // Then poll at interval
    this.pollTimer = setInterval(() => {
      this.pollOnce().catch((err: Error) => {
        console.error(`failed to poll aircraft: ${err.message}`);
      });
    }, pollMs);
  }

  private stopPollLoop(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  private async pollOnce(): Promise<void> {
    const data = await fetchAircraft(this.config.readsbUrl);
    const aircraft = data.aircraft.map((ac) =>
      mapReadsbToNormalized(ac, this.config.sourceOverride),
    );

    const message: AircraftMessage = {
      type: "aircraft",
      timestamp: data.now,
      aircraft,
    };

    this.writeMessage(message);

    // Also fetch and send stats
    try {
      const stats = await fetchStats(this.config.readsbUrl);
      const statsMessage = buildStatsMessage(stats, this.lastStatsWindowStart);
      if (statsMessage) {
        this.writeMessage(statsMessage);
        this.lastStatsWindowStart = stats.last1min.start;
      }
    } catch (err) {
      // Stats are optional, just log the error
      console.error(
        `failed to fetch stats: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private startBatchWindow(): void {
    if (this.batchTimer) {
      clearInterval(this.batchTimer);
    }

    this.batchWindowStart = new Date();

    const batchMs = this.config.batchWindowS * 1000;

    // Flush at interval
    this.batchTimer = setInterval(() => {
      this.flushBatchWindow().catch((err: Error) => {
        console.error(`failed to flush batch window: ${err.message}`);
      });
    }, batchMs);
  }

  private stopBatchWindow(): void {
    if (this.batchTimer) {
      clearInterval(this.batchTimer);
      this.batchTimer = null;
    }
  }

  private async flushBatchWindow(): Promise<void> {
    if (!this.beastClient || !this.batchWindowStart) {
      return;
    }

    const windowEnd = new Date();
    const rawFrames = this.beastClient.flush();

    if (rawFrames.length === 0) {
      // Reset window start for next batch
      this.batchWindowStart = new Date();
      return;
    }

    const frameCount = countBeastFrames(rawFrames);
    if (frameCount === 0) {
      // No valid BEAST frames, skip
      this.batchWindowStart = new Date();
      return;
    }

    // Build ATRX blob
    const metadata: AtrxMetadata = {
      receiverDid: this.config.sourceId,
      windowStart: this.batchWindowStart.toISOString(),
      windowEnd: windowEnd.toISOString(),
      clockSource: "system",
      protocol: "beast-1090",
      demodSoftware: "readsb",
      frameCount,
    };

    const blob = buildAtrxBlob(metadata, rawFrames);

    // Write to temp file
    const tempFileName = `atrx-${randomUUID()}.blob`;
    const tempPath = `${this.config.atrxTempDir}/${tempFileName}`;

    try {
      await writeFile(tempPath, blob);

      // Send rawCapture message
      const message: RawCaptureMessage = {
        type: "rawCapture",
        filePath: tempPath,
        windowStart: this.batchWindowStart.toISOString(),
        windowEnd: windowEnd.toISOString(),
      };

      this.writeMessage(message);
    } catch (err) {
      console.error(
        `failed to write ATRX blob: ${err instanceof Error ? err.message : String(err)}`,
      );
      // Try to clean up temp file
      await unlink(tempPath).catch(() => {
        // Ignore cleanup errors
      });
    }

    // Reset window start for next batch
    this.batchWindowStart = new Date();
  }

  private scheduleReconnect(): void {
    if (this.stopped) {
      return;
    }

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
    }

    const delayMs = this.currentReconnectDelayMs;
    console.log(`ReadsbAdapter: Scheduling reconnect in ${delayMs}ms`);

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delayMs);

    // Exponential backoff: double the delay, capped at max
    this.currentReconnectDelayMs = calculateBackoffDelay(
      this.currentReconnectDelayMs,
      this.maxReconnectDelayMs,
    );
  }

  stop(): void {
    this.stopped = true;

    this.stopPollLoop();
    this.stopBatchWindow();

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    if (this.beastClient) {
      this.beastClient.stop();
    }

    if (this.socket) {
      this.socket.destroy();
      this.socket = null;
    }
  }
}

export async function runReadsbAdapter(
  config: ReadsbAdapterConfig,
): Promise<void> {
  const client = new ReadsbAdapterClient(config);
  client.start();

  // Handle graceful shutdown
  process.on("SIGINT", () => {
    console.log("ReadsbAdapter: SIGINT received, shutting down");
    client.stop();
    process.exit(0);
  });

  process.on("SIGTERM", () => {
    console.log("ReadsbAdapter: SIGTERM received, shutting down");
    client.stop();
    process.exit(0);
  });

  // Keep running
  await new Promise(() => {
    // Never resolves, process is kept alive by timers
  });
}
