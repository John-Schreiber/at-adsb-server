// pattern: Imperative Shell

import { EventEmitter } from 'node:events';
import { Server as XrpcServer } from '@atproto/xrpc-server';
import type { Server as HttpServer } from 'node:http';
import type { LexiconDoc } from '@atproto/lexicon';
import express from 'express';
import subscribeEventsLexicon from '../../lexicons/at/adsb/broadcast/subscribeEvents.json' with { type: 'json' };

export type Position = {
  latitude: string;
  longitude: string;
  source: string;
  altitudeFt?: number;
  groundSpeedKts?: string;
  trackDeg?: string;
  verticalRateFpm?: number;
  timestamp: string;
};

export type AircraftUpdate = {
  icaoHex: string;
  callsign?: string;
  squawk?: string;
  position?: Position;
  nic?: number;
  rc?: number;
  rssi: string;
  seen: string;
  seenPos?: string;
  messageCount?: number;
};

export type StationRef = {
  uri: string;
  cid: string;
};

export type BroadcastOp = {
  action: 'create' | 'update' | 'delete';
  record: AircraftUpdate & { $type: string };
};

export type EventMessage = {
  $type: string;
  seq: number;
  station: StationRef;
  time: string;
  ops: Array<BroadcastOp>;
  sig?: Uint8Array;
};

export type InfoMessage = {
  readonly $type: string;
  readonly name: string;
  readonly message?: string;
};

export class StreamBroadcaster {
  private readonly emitter = new EventEmitter();
  private seq = 0;
  private server: XrpcServer | null = null;
  private httpServer: HttpServer | null = null;

  constructor() {
    this.emitter.setMaxListeners(0);
  }

  broadcast(
    station: StationRef,
    time: string,
    ops: ReadonlyArray<BroadcastOp>,
  ): void {
    if (ops.length === 0) return;
    this.seq++;
    const event: EventMessage = {
      $type: 'at.adsb.broadcast.subscribeEvents#event',
      seq: this.seq,
      station,
      time,
      ops: [...ops],
    };
    this.emitter.emit('frame', event);
  }

  buildEventMessage(
    station: StationRef,
    time: string,
    ops: ReadonlyArray<BroadcastOp>,
  ): EventMessage | null {
    if (ops.length === 0) return null;
    this.seq++;
    return {
      $type: 'at.adsb.broadcast.subscribeEvents#event',
      seq: this.seq,
      station,
      time,
      ops: [...ops],
    };
  }

  emitFrame(frame: EventMessage): void {
    this.emitter.emit('frame', frame);
  }

  broadcastInfo(name: string, message?: string): void {
    const info: InfoMessage = {
      $type: 'at.adsb.broadcast.subscribeEvents#info',
      name,
      ...(message !== undefined && { message }),
    };
    this.emitter.emit('frame', info);
  }

  async start(port: number): Promise<void> {
    this.server = new XrpcServer([subscribeEventsLexicon as unknown as LexiconDoc]);

    const emitter = this.emitter;
    const handler = async function* ({signal}: {signal?: AbortSignal; [key: string]: unknown}) {
      const queue: Array<EventMessage | InfoMessage> = [];
      let resolve: (() => void) | null = null;
      let abortHandler: (() => void) | null = null;

      const onFrame = (frame: EventMessage | InfoMessage): void => {
        queue.push(frame);
        if (resolve) {
          const r = resolve;
          resolve = null;
          r();
        }
      };

      if (signal) {
        abortHandler = (): void => {
          if (resolve) {
            const r = resolve;
            resolve = null;
            r();
          }
        };
        signal.addEventListener('abort', abortHandler);
      }

      emitter.on('frame', onFrame);
      try {
        while (!signal?.aborted) {
          while (queue.length > 0) {
            yield queue.shift()!;
          }
          await new Promise<void>((r) => {
            resolve = r;
            if (signal?.aborted) r();
          });
        }
      } finally {
        if (signal && abortHandler) signal.removeEventListener('abort', abortHandler);
        emitter.off('frame', onFrame);
      }
    };

    this.server.streamMethod(
      'at.adsb.broadcast.subscribeEvents',
      handler,
    );

    const app = express();
    app.use(this.server.router);
    this.httpServer = app.listen(port);
    await new Promise<void>((resolve) => {
      this.httpServer!.on('listening', resolve);
    });
  }

  async stop(): Promise<void> {
    if (this.httpServer) {
      if (this.server) {
        for (const [, sub] of this.server.subscriptions) {
          for (const client of sub.wss.clients) {
            client.close();
          }
        }
      }
      await new Promise<void>((resolve, reject) => {
        this.httpServer!.close((err) => (err ? reject(err) : resolve()));
      });
      this.httpServer = null;
      this.server = null;
    }
  }

  getPort(): number {
    if (!this.httpServer) {
      throw new Error('Server not started');
    }
    const addr = this.httpServer.address();
    if (!addr || typeof addr === 'string') {
      throw new Error('Unable to determine server port');
    }
    return addr.port;
  }

  get currentSeq(): number {
    return this.seq;
  }
}
