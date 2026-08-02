import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createServer, type Server, type Socket } from "node:net";
import { BeastClient } from "../beast-client.js";

async function waitFor(
  condition: () => boolean,
  timeoutMs: number = 5000,
  pollIntervalMs: number = 10,
): Promise<void> {
  const startTime = Date.now();
  while (!condition()) {
    if (Date.now() - startTime > timeoutMs) {
      throw new Error(
        `Timeout waiting for condition after ${timeoutMs}ms`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }
}

describe("BeastClient", () => {
  let server: Server;
  let port: number;

  beforeEach(async () => {
    server = createServer();
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => {
        port = (server.address() as { port: number }).port;
        resolve();
      });
    });
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("connects and accumulates data", async () => {
    const client = new BeastClient({
      host: "127.0.0.1",
      port,
    });

    const testData = Buffer.from("hello beast");

    server.on("connection", (socket) => {
      socket.write(testData);
    });

    client.start();

    await waitFor(() => client.isConnected());
    await new Promise((resolve) => setTimeout(resolve, 50)); // Give time for data to arrive

    const result = client.flush();
    expect(result).toEqual(testData);

    client.stop();
  });

  it("flush resets accumulator", async () => {
    const client = new BeastClient({
      host: "127.0.0.1",
      port,
    });

    const data1 = Buffer.from("first");
    const data2 = Buffer.from("second");

    server.on("connection", (s) => {
      s.write(data1);

      setTimeout(() => {
        s.write(data2);
      }, 200);
    });

    client.start();

    await waitFor(() => client.isConnected());
    await new Promise((resolve) => setTimeout(resolve, 150)); // Wait for first write but before second

    // First flush should return first data
    const result1 = client.flush();
    expect(result1).toEqual(data1);

    // Wait for second write
    await new Promise((resolve) => setTimeout(resolve, 250));

    // Second flush should return only second data
    const result2 = client.flush();
    expect(result2).toEqual(data2);

    client.stop();
  });

  it("flush with no data returns empty buffer", async () => {
    const client = new BeastClient({
      host: "127.0.0.1",
      port,
    });

    const result = client.flush();
    expect(result.length).toBe(0);

    client.stop();
  });

  it("concatenates multiple chunks in order", async () => {
    const client = new BeastClient({
      host: "127.0.0.1",
      port,
    });

    const chunk1 = Buffer.from("chunk1");
    const chunk2 = Buffer.from("chunk2");
    const chunk3 = Buffer.from("chunk3");

    server.on("connection", (socket) => {
      socket.write(chunk1);
      socket.write(chunk2);
      socket.write(chunk3);
    });

    client.start();

    await waitFor(() => client.isConnected());
    await new Promise((resolve) => setTimeout(resolve, 100));

    const result = client.flush();
    const expected = Buffer.concat([chunk1, chunk2, chunk3]);
    expect(result).toEqual(expected);

    client.stop();
  });

  it("reconnects on disconnect with exponential backoff", async () => {
    const client = new BeastClient({
      host: "127.0.0.1",
      port,
      reconnectDelayMs: 50,
      maxReconnectDelayMs: 200,
    });

    let connectionCount = 0;
    const connections: Array<Socket> = [];

    server.on("connection", (socket) => {
      connectionCount++;
      connections.push(socket);
    });

    client.start();

    // Wait for initial connection
    await waitFor(() => client.isConnected());

    expect(connectionCount).toBe(1);

    // Disconnect the socket to trigger reconnect
    connections[0]?.destroy();

    // Wait for reconnection (should happen within reconnectDelayMs + small buffer)
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        resolve();
      }, 300);

      const checkInterval = setInterval(() => {
        if (connectionCount >= 2) {
          clearInterval(checkInterval);
          clearTimeout(timeout);
          resolve();
        }
      }, 10);
    });

    expect(connectionCount).toBeGreaterThanOrEqual(2);

    client.stop();
  });

  it("stop prevents reconnection", async () => {
    const client = new BeastClient({
      host: "127.0.0.1",
      port,
      reconnectDelayMs: 50,
    });

    client.start();

    await waitFor(() => client.isConnected());

    expect(client.isConnected()).toBe(true);

    client.stop();

    expect(client.isConnected()).toBe(false);

    // Close server to trigger would-be reconnection
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });

    // Wait to ensure no reconnection attempt happens
    await new Promise((resolve) => setTimeout(resolve, 200));

    // Should still be stopped
    expect(client.isConnected()).toBe(false);
  });

  it("isConnected returns correct state", async () => {
    const client = new BeastClient({
      host: "127.0.0.1",
      port,
    });

    expect(client.isConnected()).toBe(false);

    client.start();

    // Wait for connection
    await waitFor(() => client.isConnected());

    expect(client.isConnected()).toBe(true);

    client.stop();

    expect(client.isConnected()).toBe(false);
  });
});
