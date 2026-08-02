#!/usr/bin/env tsx
import { WebSocket } from "ws";
import { decodeAll } from "@atproto/lex-cbor";

const url =
  process.argv[2] ?? "ws://localhost:4100/xrpc/at.adsb.broadcast.subscribeEvents";

process.stderr.write(`Connecting to ${url}...\n`);

const ws = new WebSocket(url);

ws.on("open", () => {
  process.stderr.write("Connected.\n");
});

ws.on("message", (data: Buffer) => {
  const items = Array.from(decodeAll(data));
  const [header, body] = items as [Record<string, unknown>, Record<string, unknown>];
  const rawType = header["t"] as string ?? "";
  const type = rawType.replace(/^#/, "");
  const line = JSON.stringify({ type, ...body as object }, (_key, value) =>
    value instanceof Uint8Array
      ? { $bytes: Buffer.from(value).toString("base64") }
      : value,
  );
  process.stdout.write(line + "\n");
});

ws.on("close", (code, reason) => {
  process.stderr.write(`Disconnected: ${code} ${reason.toString()}\n`);
  process.exit(0);
});

ws.on("error", (err) => {
  process.stderr.write(`Error: ${err.message}\n`);
  process.exit(1);
});
