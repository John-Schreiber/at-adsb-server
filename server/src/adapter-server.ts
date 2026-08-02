// pattern: Imperative Shell

import * as net from "net";
import * as fs from "fs";
import * as path from "path";
import {
  validateAdapterMessage,
  type AircraftMessage,
  type StatsMessage,
  type RawCaptureMessage,
  type HandshakeMessage,
} from "./normalized.js";

export type AdapterServerCallbacks = {
  onAircraft: (sourceId: string, msg: AircraftMessage) => Promise<void> | void;
  onStats: (sourceId: string, msg: StatsMessage) => Promise<void> | void;
  onRawCapture: (sourceId: string, msg: RawCaptureMessage) => Promise<void> | void;
};

type ConnectionState = {
  socket: net.Socket;
  sourceId?: string;
  protocol: string;
  handshakeDone: boolean;
  handshakeTimer?: NodeJS.Timeout;
  dataBuffer: string;
};

export class AdapterServer {
  private connections: Map<string, ConnectionState> = new Map();
  private pendingConnections: Set<ConnectionState> = new Set();
  private server: net.Server | null = null;
  private socketPath: string | null = null;
  private readonly handshakeTimeoutMs = 5000;

  constructor(
    private readonly callbacks: AdapterServerCallbacks,
    private readonly logger?: (msg: string) => void,
  ) {}

  async start(socketPath: string): Promise<void> {
    this.socketPath = socketPath;

    // Remove stale socket file if it exists
    const socketDir = path.dirname(socketPath);
    this.removeSocketFile();

    // Ensure directory exists
    try {
      fs.mkdirSync(socketDir, { recursive: true });
    } catch (e) {
      // Ignore if directory already exists
    }

    this.server = net.createServer((socket) => {
      this.handleNewConnection(socket);
    });

    return new Promise((resolve, reject) => {
      if (!this.server) {
        reject(new Error("Server not initialized"));
        return;
      }

      this.server.listen(socketPath, () => {
        resolve();
      });

      this.server.on("error", (err) => {
        if (!this.server) {
          reject(err);
        } else {
          this.log(`server error: ${err.message}`);
        }
      });
    });
  }

  async stop(): Promise<void> {
    // Close all pending (pre-handshake) connections
    for (const state of this.pendingConnections) {
      if (state.handshakeTimer) {
        clearTimeout(state.handshakeTimer);
      }
      state.socket.destroy();
    }
    this.pendingConnections.clear();

    // Close all active connections
    for (const [sourceId, state] of this.connections.entries()) {
      if (state.handshakeTimer) {
        clearTimeout(state.handshakeTimer);
      }
      state.socket.destroy();
      this.connections.delete(sourceId);
    }

    // Close server
    if (this.server) {
      return new Promise<void>((resolve, reject) => {
        if (!this.server) {
          // Server was already closed
          this.removeSocketFile();
          resolve();
          return;
        }

        this.server.close((err) => {
          if (err) {
            reject(err);
          } else {
            this.removeSocketFile();
            this.server = null;
            resolve();
          }
        });
      });
    } else {
      // Server not running, just clean up socket file
      this.removeSocketFile();
    }
  }

  getConnectedSources(): ReadonlyMap<string, { protocol: string }> {
    const result = new Map<string, { protocol: string }>();
    for (const [sourceId, state] of this.connections.entries()) {
      if (state.handshakeDone) {
        result.set(sourceId, { protocol: state.protocol });
      }
    }
    return result;
  }

  private handleNewConnection(socket: net.Socket): void {
    const state: ConnectionState = {
      socket,
      protocol: "",
      handshakeDone: false,
      dataBuffer: "",
    };

    // Track as pending connection
    this.pendingConnections.add(state);

    // Set up handshake timeout
    state.handshakeTimer = setTimeout(() => {
      this.log(`handshake timeout on new connection`);
      socket.destroy();
    }, this.handshakeTimeoutMs);

    socket.on("data", (data) => {
      state.dataBuffer += data.toString();
      this.processBuffer(socket, state);
    });

    socket.on("error", (err) => {
      this.log(`socket error: ${err.message}`);
      this.cleanupConnection(state);
    });

    socket.on("close", () => {
      this.cleanupConnection(state);
    });
  }

  private processBuffer(socket: net.Socket, state: ConnectionState): void {
    while (true) {
      const newlineIndex = state.dataBuffer.indexOf("\n");
      if (newlineIndex === -1) {
        break;
      }

      const line = state.dataBuffer.substring(0, newlineIndex).trim();
      state.dataBuffer = state.dataBuffer.substring(newlineIndex + 1);

      if (line.length === 0) {
        continue; // Skip empty lines
      }

      try {
        const parsed = JSON.parse(line) as unknown;
        const message = validateAdapterMessage(parsed);

        if (message === null) {
          if (!state.handshakeDone) {
            this.log(`invalid handshake message, destroying socket`);
            socket.destroy();
            return;
          } else {
            // Malformed line after handshake - log and drop
            this.log(`malformed message, skipping: ${line.substring(0, 50)}`);
            continue;
          }
        }

        if (message.type === "handshake") {
          this.handleHandshake(socket, state, message);
        } else if (state.handshakeDone) {
          // Route data messages only after handshake is complete
          this.routeMessage(state, message);
        } else {
          // Non-handshake message before handshake complete
          this.log(`non-handshake message before handshake, destroying socket`);
          socket.destroy();
          return;
        }
      } catch (e) {
        if (!state.handshakeDone) {
          this.log(`failed to parse handshake: ${e instanceof Error ? e.message : String(e)}`);
          socket.destroy();
          return;
        } else {
          // Malformed JSON after handshake - log and drop
          this.log(`failed to parse message: ${e instanceof Error ? e.message : String(e)}`);
          continue;
        }
      }
    }
  }

  private handleHandshake(
    socket: net.Socket,
    state: ConnectionState,
    message: HandshakeMessage,
  ): void {
    // Clear the timeout
    if (state.handshakeTimer) {
      clearTimeout(state.handshakeTimer);
      state.handshakeTimer = undefined;
    }

    state.handshakeDone = true;
    state.protocol = message.protocol;

    const { sourceId } = message;
    state.sourceId = sourceId;

    // Remove from pending connections
    this.pendingConnections.delete(state);

    // Check for duplicate sourceId
    if (this.connections.has(sourceId)) {
      const oldState = this.connections.get(sourceId);
      if (oldState) {
        if (oldState.handshakeTimer) {
          clearTimeout(oldState.handshakeTimer);
        }
        oldState.socket.destroy();
        this.log(`replaced connection for sourceId: ${sourceId}`);
      }
    }

    // Store new connection
    this.connections.set(sourceId, state);
    this.log(`accepted handshake from sourceId: ${sourceId}, protocol: ${message.protocol}`);
  }

  private routeMessage(
    state: ConnectionState,
    message: Exclude<ReturnType<typeof validateAdapterMessage>, HandshakeMessage | null>,
  ): void {
    const sourceId = state.sourceId;

    if (!sourceId) {
      return; // Connection not found (shouldn't happen)
    }

    if (message.type === "aircraft") {
      const result = this.callbacks.onAircraft(sourceId, message);
      if (result instanceof Promise) {
        result.catch((err) => {
          this.log(`aircraft callback error: ${err instanceof Error ? err.message : String(err)}`);
        });
      }
    } else if (message.type === "stats") {
      const result = this.callbacks.onStats(sourceId, message);
      if (result instanceof Promise) {
        result.catch((err) => {
          this.log(`stats callback error: ${err instanceof Error ? err.message : String(err)}`);
        });
      }
    } else if (message.type === "rawCapture") {
      const result = this.callbacks.onRawCapture(sourceId, message);
      if (result instanceof Promise) {
        result.catch((err) => {
          this.log(`rawCapture callback error: ${err instanceof Error ? err.message : String(err)}`);
        });
      }
    }
  }

  private cleanupConnection(state: ConnectionState): void {
    // Clear timer if present
    if (state.handshakeTimer) {
      clearTimeout(state.handshakeTimer);
    }

    // Remove from pending if present
    if (this.pendingConnections.has(state)) {
      this.pendingConnections.delete(state);
      return;
    }

    // Remove from active connections by matching socket
    // (cannot use sourceId alone as it may have been replaced)
    for (const [sourceId, connState] of this.connections.entries()) {
      if (connState.socket === state.socket) {
        this.connections.delete(sourceId);
        this.log(`connection closed for sourceId: ${sourceId}`);
        return;
      }
    }
  }

  private removeSocketFile(): void {
    if (this.socketPath) {
      try {
        if (fs.existsSync(this.socketPath)) {
          fs.unlinkSync(this.socketPath);
        }
      } catch (e) {
        // Ignore errors during cleanup
      }
    }
  }

  private log(msg: string): void {
    if (this.logger) {
      this.logger(`[AdapterServer] ${msg}`);
    }
  }
}
