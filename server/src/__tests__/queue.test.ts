// pattern: tests for PublishQueue
import {describe, it, expect, afterEach, beforeEach} from 'vitest';
import fs from 'fs';
import path from 'path';
import {PublishQueue, BASE_DELAY_MS, MAX_DELAY_MS} from '../queue.js';

describe('PublishQueue', () => {
  let queue: PublishQueue;
  let tempFile: string | null = null;

  beforeEach(() => {
    // Use in-memory database for most tests
    queue = new PublishQueue(':memory:');
  });

  afterEach(() => {
    if (queue) {
      queue.close();
    }
    if (tempFile && fs.existsSync(tempFile)) {
      fs.unlinkSync(tempFile);
    }
  });

  describe('AC6.1 — Enqueue stores record', () => {
    it('enqueues a record and increases size', () => {
      const record = {icaoHex: 'A1B2C3', timestamp: '2026-05-23T00:00:00Z'};
      queue.enqueue('at.adsb.receiver.sighting', record);

      expect(queue.size()).toBe(1);
    });

    it('enqueues multiple records', () => {
      queue.enqueue('at.adsb.receiver.sighting', {icaoHex: 'A1B2C3'});
      queue.enqueue('at.adsb.receiver.sighting', {icaoHex: 'B2C3D4'});

      expect(queue.size()).toBe(2);
    });

    it('stores record data correctly', () => {
      const record = {icaoHex: 'A1B2C3', timestamp: '2026-05-23T00:00:00Z'};
      queue.enqueue('at.adsb.receiver.sighting', record);

      // Set next_retry_at to the past so getReady will return it
      const db = (queue as any).db;
      const stmt = db.prepare('UPDATE publish_queue SET next_retry_at = ? WHERE id = 1');
      const pastTime = new Date(Date.now() - 10000).toISOString();
      stmt.run(pastTime);

      const ready = queue.getReady();

      expect(ready).toHaveLength(1);
      expect(ready[0]!.record).toEqual(record);
      expect(ready[0]!.collection).toBe('at.adsb.receiver.sighting');
    });
  });

  describe('AC6.2 — getReady respects next_retry_at', () => {
    it('returns empty array when no records are ready', () => {
      queue.enqueue('at.adsb.receiver.sighting', {icaoHex: 'A1B2C3'});

      const ready = queue.getReady();

      expect(ready).toHaveLength(0);
    });

    it('returns records when next_retry_at is in the past', () => {
      const record = {icaoHex: 'A1B2C3'};
      queue.enqueue('at.adsb.receiver.sighting', record);

      // Set next_retry_at to the past by manipulating the database directly
      const db = (queue as any).db;
      const stmt = db.prepare('UPDATE publish_queue SET next_retry_at = ? WHERE id = 1');
      const pastTime = new Date(Date.now() - 10000).toISOString();
      stmt.run(pastTime);

      const ready = queue.getReady();

      expect(ready).toHaveLength(1);
      expect(ready[0]!.collection).toBe('at.adsb.receiver.sighting');
      expect(ready[0]!.record).toEqual(record);
    });

    it('returns records ordered by created_at', () => {
      queue.enqueue('at.adsb.receiver.sighting', {icaoHex: 'A1B2C3'});
      queue.enqueue('at.adsb.receiver.sighting', {icaoHex: 'B2C3D4'});
      queue.enqueue('at.adsb.receiver.sighting', {icaoHex: 'C3D4E5'});

      // Set all to the past
      const db = (queue as any).db;
      const stmt = db.prepare('UPDATE publish_queue SET next_retry_at = ?');
      const pastTime = new Date(Date.now() - 10000).toISOString();
      stmt.run(pastTime);

      const ready = queue.getReady();

      expect(ready).toHaveLength(3);
      expect(ready[0]!.record["icaoHex"]).toBe('A1B2C3');
      expect(ready[1]!.record["icaoHex"]).toBe('B2C3D4');
      expect(ready[2]!.record["icaoHex"]).toBe('C3D4E5');
    });
  });

  describe('AC6.3 — Backoff doubles', () => {
    it('sets initial backoff to BASE_DELAY_MS', () => {
      queue.enqueue('at.adsb.receiver.sighting', {icaoHex: 'A1B2C3'});

      const db = (queue as any).db;
      const stmt = db.prepare('SELECT next_retry_at FROM publish_queue WHERE id = 1');
      const row = stmt.get() as {next_retry_at: string};

      const now = Date.now();
      const nextRetry = new Date(row.next_retry_at).getTime();

      // Should be approximately now + BASE_DELAY_MS
      const tolerance = 100;
      expect(nextRetry - now).toBeGreaterThanOrEqual(BASE_DELAY_MS - tolerance);
      expect(nextRetry - now).toBeLessThanOrEqual(BASE_DELAY_MS + tolerance);
    });

    it('doubles backoff on first failure (BASE_DELAY_MS -> BASE_DELAY_MS * 2)', () => {
      queue.enqueue('at.adsb.receiver.sighting', {icaoHex: 'A1B2C3'});

      const db = (queue as any).db;
      const setReady = db.prepare('UPDATE publish_queue SET next_retry_at = ? WHERE id = 1');
      setReady.run(new Date(Date.now() - 10000).toISOString());

      const before = Date.now();
      queue.markFailed(1, 'test error');
      const after = Date.now();

      const getRetry = db.prepare('SELECT next_retry_at FROM publish_queue WHERE id = 1');
      const row = getRetry.get() as {next_retry_at: string};
      const nextRetry = new Date(row.next_retry_at).getTime();

      // Should be approximately now + BASE_DELAY_MS * 2^1
      const expected = BASE_DELAY_MS * Math.pow(2, 1);
      const tolerance = 100;
      const midpoint = (before + after) / 2;
      expect(nextRetry - midpoint).toBeGreaterThanOrEqual(expected - tolerance);
      expect(nextRetry - midpoint).toBeLessThanOrEqual(expected + tolerance);
    });

    it('doubles backoff on second failure (BASE_DELAY_MS * 2 -> BASE_DELAY_MS * 4)', () => {
      queue.enqueue('at.adsb.receiver.sighting', {icaoHex: 'A1B2C3'});

      const db = (queue as any).db;
      const setReady = db.prepare('UPDATE publish_queue SET next_retry_at = ? WHERE id = 1');

      // First failure
      setReady.run(new Date(Date.now() - 10000).toISOString());
      queue.markFailed(1, 'error 1');

      // Second failure
      setReady.run(new Date(Date.now() - 10000).toISOString());
      const before = Date.now();
      queue.markFailed(1, 'error 2');
      const after = Date.now();

      const getRetry = db.prepare('SELECT next_retry_at FROM publish_queue WHERE id = 1');
      const row = getRetry.get() as {next_retry_at: string};
      const nextRetry = new Date(row.next_retry_at).getTime();

      // Should be approximately now + BASE_DELAY_MS * 2^2
      const expected = BASE_DELAY_MS * Math.pow(2, 2);
      const tolerance = 100;
      const midpoint = (before + after) / 2;
      expect(nextRetry - midpoint).toBeGreaterThanOrEqual(expected - tolerance);
      expect(nextRetry - midpoint).toBeLessThanOrEqual(expected + tolerance);
    });

    it('caps backoff at MAX_DELAY_MS', () => {
      queue.enqueue('at.adsb.receiver.sighting', {icaoHex: 'A1B2C3'});

      const db = (queue as any).db;
      const setReady = db.prepare('UPDATE publish_queue SET next_retry_at = ?, attempts = ? WHERE id = 1');

      // Simulate many failures to reach the cap (attempts = 10 gives us very large backoff)
      setReady.run(new Date(Date.now() - 10000).toISOString(), 10);

      const before = Date.now();
      queue.markFailed(1, 'error after many attempts');
      const after = Date.now();

      const getRetry = db.prepare('SELECT next_retry_at FROM publish_queue WHERE id = 1');
      const row = getRetry.get() as {next_retry_at: string};
      const nextRetry = new Date(row.next_retry_at).getTime();

      const midpoint = (before + after) / 2;
      const tolerance = 100;
      // Should not exceed MAX_DELAY_MS
      expect(nextRetry - midpoint).toBeLessThanOrEqual(MAX_DELAY_MS + tolerance);
    });
  });

  describe('AC6.4 — markDone removes record', () => {
    it('removes a record when marked done', () => {
      queue.enqueue('at.adsb.receiver.sighting', {icaoHex: 'A1B2C3'});

      expect(queue.size()).toBe(1);

      queue.markDone(1);

      expect(queue.size()).toBe(0);
    });

    it('does not affect other records', () => {
      queue.enqueue('at.adsb.receiver.sighting', {icaoHex: 'A1B2C3'});
      queue.enqueue('at.adsb.receiver.sighting', {icaoHex: 'B2C3D4'});

      queue.markDone(1);

      expect(queue.size()).toBe(1);
      const db = (queue as any).db;
      const stmt = db.prepare('SELECT id FROM publish_queue');
      const remaining = stmt.all() as Array<{id: number}>;
      expect(remaining[0]!.id).toBe(2);
    });
  });

  describe('AC6.5 — Persistence across restarts', () => {
    it('persists records to disk and retrieves them after reopening', () => {
      // Create a temporary file
      tempFile = path.join('/tmp', `test-queue-${Date.now()}.db`);

      const queue1 = new PublishQueue(tempFile);
      queue1.enqueue('at.adsb.receiver.sighting', {icaoHex: 'A1B2C3'});
      expect(queue1.size()).toBe(1);
      queue1.close();

      // Reopen the database
      const queue2 = new PublishQueue(tempFile);
      expect(queue2.size()).toBe(1);

      const db = (queue2 as any).db;
      const stmt = db.prepare('SELECT collection, record_json FROM publish_queue WHERE id = 1');
      const row = stmt.get() as {collection: string; record_json: string} | undefined;
      expect(row!.collection).toBe('at.adsb.receiver.sighting');
      expect(JSON.parse(row!.record_json)).toEqual({icaoHex: 'A1B2C3'});

      // Close queue1's original connection before assigning queue2 to queue
      // (queue1 was already closed above, but for clarity)
      queue = queue2;
    });
  });

  describe('AC6.6 — Rate limit handling', () => {
    it('uses retryAfterMs when provided', () => {
      queue.enqueue('at.adsb.receiver.sighting', {icaoHex: 'A1B2C3'});

      const db = (queue as any).db;
      const setReady = db.prepare('UPDATE publish_queue SET next_retry_at = ? WHERE id = 1');
      setReady.run(new Date(Date.now() - 10000).toISOString());

      const retryAfterMs = 30000;
      const before = Date.now();
      queue.markFailed(1, 'rate limited', retryAfterMs);
      const after = Date.now();

      const getRetry = db.prepare('SELECT next_retry_at FROM publish_queue WHERE id = 1');
      const row = getRetry.get() as {next_retry_at: string};
      const nextRetry = new Date(row.next_retry_at).getTime();

      // Should be approximately now + retryAfterMs
      const tolerance = 100;
      const midpoint = (before + after) / 2;
      expect(nextRetry - midpoint).toBeGreaterThanOrEqual(retryAfterMs - tolerance);
      expect(nextRetry - midpoint).toBeLessThanOrEqual(retryAfterMs + tolerance);
    });

    it('ignores exponential backoff when retryAfterMs is provided', () => {
      queue.enqueue('at.adsb.receiver.sighting', {icaoHex: 'A1B2C3'});

      const db = (queue as any).db;
      const setData = db.prepare('UPDATE publish_queue SET next_retry_at = ?, attempts = ? WHERE id = 1');

      // Set many failed attempts
      setData.run(new Date(Date.now() - 10000).toISOString(), 5);

      const retryAfterMs = 5000;
      const before = Date.now();
      queue.markFailed(1, 'rate limited', retryAfterMs);
      const after = Date.now();

      const getRetry = db.prepare('SELECT next_retry_at FROM publish_queue WHERE id = 1');
      const row = getRetry.get() as {next_retry_at: string};
      const nextRetry = new Date(row.next_retry_at).getTime();

      const midpoint = (before + after) / 2;
      const tolerance = 100;
      // Should use retryAfterMs, NOT exponential backoff (which would be much larger)
      expect(nextRetry - midpoint).toBeGreaterThanOrEqual(retryAfterMs - tolerance);
      expect(nextRetry - midpoint).toBeLessThanOrEqual(retryAfterMs + tolerance);
    });
  });
});
