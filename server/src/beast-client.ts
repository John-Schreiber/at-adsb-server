// pattern: Imperative Shell

import { Socket } from "node:net";

type BeastClientOptions = {
  readonly host: string;
  readonly port: number;
  readonly reconnectDelayMs?: number;
  readonly maxReconnectDelayMs?: number;
};

export class BeastClient {
  private readonly host: string;
  private readonly port: number;
  private readonly reconnectDelayMs: number;
  private readonly maxReconnectDelayMs: number;
  private socket: Socket | null = null;
  private chunks: Array<Buffer> = [];
  private currentReconnectDelayMs: number;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private stopped: boolean = false;

  constructor(options: BeastClientOptions) {
    this.host = options.host;
    this.port = options.port;
    this.reconnectDelayMs = options.reconnectDelayMs ?? 1000;
    this.maxReconnectDelayMs = options.maxReconnectDelayMs ?? 30000;
    this.currentReconnectDelayMs = this.reconnectDelayMs;
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

    this.socket = new Socket();

    this.socket.on("connect", () => {
      this.currentReconnectDelayMs = this.reconnectDelayMs;
      console.log(`BeastClient: Connected to ${this.host}:${this.port}`);
    });

    this.socket.on("data", (chunk: Buffer) => {
      this.chunks.push(chunk);
    });

    this.socket.on("close", () => {
      this.scheduleReconnect();
    });

    this.socket.on("error", (err: Error) => {
      console.error(`BeastClient: Connection error: ${err.message}`);
    });

    this.socket.connect(this.port, this.host);
  }

  private scheduleReconnect(): void {
    if (this.stopped) {
      return;
    }

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
    }

    const delayMs = this.currentReconnectDelayMs;
    console.log(`BeastClient: Scheduling reconnect in ${delayMs}ms`);

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delayMs);

    // Exponential backoff: double the delay, capped at max
    this.currentReconnectDelayMs = Math.min(
      this.currentReconnectDelayMs * 2,
      this.maxReconnectDelayMs,
    );
  }

  flush(): Buffer {
    const accumulated = Buffer.concat(this.chunks);
    this.chunks = [];
    return accumulated;
  }

  stop(): void {
    this.stopped = true;

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    if (this.socket) {
      this.socket.destroy();
      this.socket = null;
    }
  }

  isConnected(): boolean {
    return this.socket != null && this.socket.readyState === "open";
  }
}
