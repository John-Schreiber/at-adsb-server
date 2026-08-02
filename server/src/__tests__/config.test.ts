import { describe, it, expect } from 'vitest';
import type { DaemonConfig } from '../config.js';
import { buildDaemonConfig } from '../config.js';

describe('DaemonConfig type', () => {
  it('is a valid type with required properties', () => {
    const config: DaemonConfig = {
      atpService: 'https://bsky.social',
      atpHandle: 'receiver.bsky.social',
      atpPassword: 'app-password',
      receiverLat: 40.7128,
      receiverLon: -74.0060,
      statsIntervalM: 60,
      queueDbPath: './at-adsb-queue.db',
      wsPort: 4100,
      batchWindowS: 60,
      socketPath: '/tmp/at-adsb.sock',
      atrxTempDir: '/tmp/at-adsb-atrx',
      rawCaptureEnabled: true,
    };

    expect(config.atpService).toBe('https://bsky.social');
    expect(config.atpHandle).toBe('receiver.bsky.social');
    expect(config.receiverLat).toBe(40.7128);
    expect(config.receiverLon).toBe(-74.0060);
    expect(config.wsPort).toBe(4100);
  });

  it('adsb-firehose.AC2.1: accepts wsPort from config (port plumbing)', () => {
    const config: DaemonConfig = {
      atpService: 'https://bsky.social',
      atpHandle: 'receiver.bsky.social',
      atpPassword: 'app-password',
      receiverLat: 40.7128,
      receiverLon: -74.0060,
      statsIntervalM: 60,
      queueDbPath: './at-adsb-queue.db',
      wsPort: 9000,
      batchWindowS: 60,
      socketPath: '/tmp/at-adsb.sock',
      atrxTempDir: '/tmp/at-adsb-atrx',
      rawCaptureEnabled: true,
    };

    expect(config.wsPort).toBe(9000);
  });

  it('adsb-firehose.AC2.2: default wsPort is 4100 (config type accepts field)', () => {
    const config: DaemonConfig = {
      atpService: 'https://bsky.social',
      atpHandle: 'receiver.bsky.social',
      atpPassword: 'app-password',
      receiverLat: 40.7128,
      receiverLon: -74.0060,
      statsIntervalM: 60,
      queueDbPath: './at-adsb-queue.db',
      wsPort: 4100,
      batchWindowS: 60,
      socketPath: '/tmp/at-adsb.sock',
      atrxTempDir: '/tmp/at-adsb-atrx',
      rawCaptureEnabled: true,
    };

    expect(config.wsPort).toBe(4100);
  });

  it('accepts optional streamEndpoint', () => {
    const config: DaemonConfig = {
      atpService: 'https://bsky.social',
      atpHandle: 'receiver.bsky.social',
      atpPassword: 'app-password',
      receiverLat: 40.7128,
      receiverLon: -74.0060,
      statsIntervalM: 60,
      queueDbPath: './at-adsb-queue.db',
      wsPort: 4100,
      batchWindowS: 60,
      socketPath: '/tmp/at-adsb.sock',
      atrxTempDir: '/tmp/at-adsb-atrx',
      rawCaptureEnabled: true,
      streamEndpoint: 'wss://example.com/xrpc/at.adsb.broadcast.subscribeEvents',
    };

    expect(config.streamEndpoint).toBe('wss://example.com/xrpc/at.adsb.broadcast.subscribeEvents');
  });

  it('works without streamEndpoint (optional field)', () => {
    const config: DaemonConfig = {
      atpService: 'https://bsky.social',
      atpHandle: 'receiver.bsky.social',
      atpPassword: 'app-password',
      receiverLat: 40.7128,
      receiverLon: -74.0060,
      statsIntervalM: 60,
      queueDbPath: './at-adsb-queue.db',
      wsPort: 4100,
      batchWindowS: 60,
      socketPath: '/tmp/at-adsb.sock',
      atrxTempDir: '/tmp/at-adsb-atrx',
      rawCaptureEnabled: true,
    };

    expect(config.streamEndpoint).toBeUndefined();
  });
});

const baseParams = {
  service: 'https://bsky.social',
  identifier: 'receiver.bsky.social',
  password: 'app-password',
  receiverLat: 40.0,
  receiverLon: -74.0,
  socketPath: '/tmp/at-adsb.sock',
  atrxTempDir: '/tmp/at-adsb-atrx',
};

describe('buildDaemonConfig', () => {
  it('maps STREAM_ENDPOINT env var to config.streamEndpoint', () => {
    const config = buildDaemonConfig({
      ...baseParams,
      env: { STREAM_ENDPOINT: 'wss://relay.example.com/xrpc/at.adsb.broadcast.subscribeEvents' },
    });

    expect(config.streamEndpoint).toBe('wss://relay.example.com/xrpc/at.adsb.broadcast.subscribeEvents');
  });

  it('returns undefined for streamEndpoint when env has no STREAM_ENDPOINT', () => {
    const config = buildDaemonConfig({
      ...baseParams,
      env: {},
    });

    expect(config.streamEndpoint).toBeUndefined();
  });

  it('passes through empty string for STREAM_ENDPOINT', () => {
    const config = buildDaemonConfig({
      ...baseParams,
      env: { STREAM_ENDPOINT: '' },
    });

    expect(config.streamEndpoint).toBe('');
  });

  it('throws on invalid BATCH_WINDOW_S', () => {
    expect(() =>
      buildDaemonConfig({
        ...baseParams,
        env: { BATCH_WINDOW_S: '5' },
      }),
    ).toThrow('BATCH_WINDOW_S must be between 15 and 600');
  });
});
