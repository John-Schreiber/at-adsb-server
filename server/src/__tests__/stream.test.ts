import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { WebSocket } from 'ws';
import { decodeAll } from '@atproto/lex-cbor';
import { StreamBroadcaster, type StationRef, type BroadcastOp } from '../stream.js';

const TEST_STATION: StationRef = {
  uri: 'at://did:plc:test123/at.adsb.receiver.station/self',
  cid: 'bafytest',
};

function makeOps(count: number): BroadcastOp[] {
  return Array.from({ length: count }, (_, i) => ({
    action: 'update' as const,
    record: {
      $type: 'at.adsb.broadcast.message',
      icaoHex: `A${String(i).padStart(5, '0')}`,
      rssi: '-25',
      seen: '0.5',
    },
  }));
}

describe('StreamBroadcaster', () => {
  let broadcaster: StreamBroadcaster;
  let port: number;

  beforeEach(async () => {
    broadcaster = new StreamBroadcaster();
    await broadcaster.start(0);
    port = broadcaster.getPort();
  });

  afterEach(async () => {
    await broadcaster.stop();
  });

  function connectClient(): { ws: WebSocket; frames: Array<Record<string, unknown>>; open: Promise<void> } {
    const frames: Array<Record<string, unknown>> = [];
    const ws = new WebSocket(`ws://localhost:${port}/xrpc/at.adsb.broadcast.subscribeEvents`);

    ws.on('message', (data: Buffer) => {
      try {
        const items = Array.from(decodeAll(data));
        const [, body] = items;
        if (body && typeof body === 'object') {
          frames.push(body as Record<string, unknown>);
        }
      } catch {
        // ignore
      }
    });

    const open = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('WebSocket connection timeout')), 2000);
      ws.on('open', () => { clearTimeout(timeout); resolve(); });
      ws.on('error', (err) => { clearTimeout(timeout); reject(new Error(`ws error: ${err}`)); });
    });

    return { ws, frames, open };
  }

  // adsb-firehose.AC2.3: Multiple simultaneous clients receive broadcast
  it('adsb-firehose.AC2.3: broadcasts to multiple simultaneous clients', async () => {
    const c1 = connectClient();
    const c2 = connectClient();
    await Promise.all([c1.open, c2.open]);

    broadcaster.broadcast(TEST_STATION, '2026-05-24T10:00:00Z', makeOps(1));
    await new Promise<void>((r) => setTimeout(r, 500));

    expect(c1.frames.length).toBe(1);
    expect(c2.frames.length).toBe(1);
    expect(c1.frames[0]?.['station']).toEqual(TEST_STATION);

    c1.ws.close();
    c2.ws.close();
  });

  // adsb-firehose.AC2.4: Client disconnect doesn't affect other clients
  it('adsb-firehose.AC2.4: handles client disconnection without affecting others', async () => {
    const c1 = connectClient();
    const c2 = connectClient();
    await Promise.all([c1.open, c2.open]);

    c1.ws.close();
    await new Promise<void>((r) => setTimeout(r, 50));

    broadcaster.broadcast(TEST_STATION, '2026-05-24T10:00:00Z', makeOps(1));
    await new Promise<void>((r) => setTimeout(r, 500));

    expect(c2.frames.length).toBe(1);
    c2.ws.close();
  });

  // adsb-firehose.AC3.1, AC3.2: Frame format and header
  it('adsb-firehose.AC3.1 & AC3.2: frames contain valid DAG-CBOR with correct header', async () => {
    const rawFrames: Array<{ header: unknown; body: unknown }> = [];
    const ws = new WebSocket(`ws://localhost:${port}/xrpc/at.adsb.broadcast.subscribeEvents`);

    ws.on('message', (data: Buffer) => {
      try {
        const items = Array.from(decodeAll(data));
        const [header, body] = items;
        rawFrames.push({ header, body });
      } catch {
        // ignore
      }
    });

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('timeout')), 2000);
      ws.on('open', () => { clearTimeout(timeout); resolve(); });
      ws.on('error', (err) => { clearTimeout(timeout); reject(err); });
    });

    broadcaster.broadcast(TEST_STATION, '2026-05-24T10:00:00Z', makeOps(1));
    await new Promise<void>((r) => setTimeout(r, 500));

    expect(rawFrames.length).toBe(1);
    const header = rawFrames[0]!.header as Record<string, unknown>;
    expect(header['op']).toBe(1);
    expect(header['t']).toBe('#event');

    ws.close();
  });

  // adsb-firehose.AC3.3: Payload structure matches envelope schema
  it('adsb-firehose.AC3.3: payload contains envelope with station, time, and ops', async () => {
    const c = connectClient();
    await c.open;

    const ops = makeOps(2);
    broadcaster.broadcast(TEST_STATION, '2026-05-24T10:00:00Z', ops);
    await new Promise<void>((r) => setTimeout(r, 500));

    expect(c.frames.length).toBe(1);
    const event = c.frames[0]!;
    expect(event['station']).toEqual(TEST_STATION);
    expect(event['time']).toBe('2026-05-24T10:00:00Z');
    expect(event['seq']).toBe(1);
    const receivedOps = event['ops'] as Array<Record<string, unknown>>;
    expect(receivedOps).toHaveLength(2);
    expect(receivedOps[0]!['action']).toBe('update');
    expect((receivedOps[0]!['record'] as Record<string, unknown>)['icaoHex']).toBe('A00000');

    c.ws.close();
  });

  // adsb-firehose.AC5.1: Monotonically increasing sequence numbers
  it('adsb-firehose.AC5.1: events carry monotonically increasing seq', async () => {
    const c = connectClient();
    await c.open;

    broadcaster.broadcast(TEST_STATION, '2026-05-24T10:00:00Z', makeOps(1));
    broadcaster.broadcast(TEST_STATION, '2026-05-24T10:00:05Z', makeOps(1));
    broadcaster.broadcast(TEST_STATION, '2026-05-24T10:00:10Z', makeOps(1));
    await new Promise<void>((r) => setTimeout(r, 500));

    expect(c.frames.length).toBe(3);
    const seqs = c.frames.map((f) => f['seq'] as number);
    expect(seqs[0]).toBe(1);
    expect(seqs[1]).toBe(2);
    expect(seqs[2]).toBe(3);

    c.ws.close();
  });

  // adsb-firehose.AC5.2: Sequence is global (one per event batch)
  it('adsb-firehose.AC5.2: sequence increments per batch, not per aircraft', async () => {
    const c = connectClient();
    await c.open;

    // Single batch with 3 aircraft = 1 seq increment
    broadcaster.broadcast(TEST_STATION, '2026-05-24T10:00:00Z', makeOps(3));
    await new Promise<void>((r) => setTimeout(r, 500));

    expect(c.frames.length).toBe(1);
    expect(c.frames[0]!['seq']).toBe(1);
    expect((c.frames[0]!['ops'] as unknown[]).length).toBe(3);

    c.ws.close();
  });

  // adsb-firehose.AC4.4: No event emitted when ops array is empty
  it('adsb-firehose.AC4.4: no event emitted for empty ops', async () => {
    const c = connectClient();
    await c.open;

    broadcaster.broadcast(TEST_STATION, '2026-05-24T10:00:00Z', []);
    await new Promise<void>((r) => setTimeout(r, 200));

    expect(c.frames.length).toBe(0);
    c.ws.close();
  });

  // adsb-firehose.AC2.4: Graceful stop closes all connections
  it('adsb-firehose.AC2.4: graceful stop closes all client connections', async () => {
    const closedConnections: boolean[] = [];
    const c1 = connectClient();
    const c2 = connectClient();
    c1.ws.on('close', () => closedConnections.push(true));
    c2.ws.on('close', () => closedConnections.push(true));
    await Promise.all([c1.open, c2.open]);

    broadcaster.broadcast(TEST_STATION, '2026-05-24T10:00:00Z', makeOps(1));
    await new Promise<void>((r) => setTimeout(r, 50));
    expect(c1.frames.length).toBeGreaterThan(0);

    await broadcaster.stop();
    await new Promise<void>((r) => setTimeout(r, 500));

    expect(closedConnections.length).toBe(2);
  });
});
