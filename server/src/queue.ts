// pattern: Imperative Shell
import Database from 'better-sqlite3';

export const BASE_DELAY_MS = 5000;
export const MAX_DELAY_MS = 300000; // 5 minutes

export type QueueEntry = {
  readonly id: number;
  readonly collection: string;
  readonly record: Record<string, unknown>;
  readonly attempts: number;
};

export class PublishQueue {
  private readonly db: Database.Database;
  private readonly insertStmt: Database.Statement<[string, string, string, string]>;
  private readonly selectReadyStmt: Database.Statement<[string], {id: number; collection: string; record_json: string; attempts: number}>;
  private readonly deleteStmt: Database.Statement<[number]>;
  private readonly updateFailedStmt: Database.Statement<[string, string, number]>;
  private readonly countStmt: Database.Statement<[], {count: number}>;
  private readonly selectAttemptsStmt: Database.Statement<[number], {attempts: number}>;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);

    // Enable WAL mode for better concurrency
    this.db.pragma('journal_mode = WAL');

    // Create table if not exists
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS publish_queue (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        collection TEXT NOT NULL,
        record_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        next_retry_at TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        last_error TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_next_retry ON publish_queue(next_retry_at);
    `);

    // Prepare statements
    this.insertStmt = this.db.prepare(`
      INSERT INTO publish_queue (collection, record_json, created_at, next_retry_at, attempts)
      VALUES (?, ?, ?, ?, 0)
    `);

    this.selectReadyStmt = this.db.prepare(`
      SELECT id, collection, record_json, attempts
      FROM publish_queue
      WHERE next_retry_at <= ?
      ORDER BY created_at ASC
    `);

    this.deleteStmt = this.db.prepare(`
      DELETE FROM publish_queue
      WHERE id = ?
    `);

    this.updateFailedStmt = this.db.prepare(`
      UPDATE publish_queue
      SET attempts = attempts + 1, next_retry_at = ?, last_error = ?
      WHERE id = ?
    `);

    this.countStmt = this.db.prepare(`
      SELECT COUNT(*) as count FROM publish_queue
    `);

    this.selectAttemptsStmt = this.db.prepare(`
      SELECT attempts FROM publish_queue WHERE id = ?
    `);
  }

  enqueue(collection: string, record: Record<string, unknown>): void {
    const now = new Date().toISOString();
    const nextRetry = new Date(Date.now() + BASE_DELAY_MS).toISOString();
    const recordJson = JSON.stringify(record);

    this.insertStmt.run(collection, recordJson, now, nextRetry);
  }

  getReady(): Array<QueueEntry> {
    const now = new Date().toISOString();
    const rows = this.selectReadyStmt.all(now);

    return rows.map(row => {
      let record: Record<string, unknown>;
      try {
        const parsed = JSON.parse(row.record_json);
        // Validate that parsed result is a non-null object
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
          throw new Error('Record must be a non-null object');
        }
        record = parsed as Record<string, unknown>;
      } catch (e) {
        throw new Error(`failed to parse record_json for id ${row.id}: ${e instanceof Error ? e.message : String(e)}`);
      }

      return {
        id: row.id,
        collection: row.collection,
        record,
        attempts: row.attempts,
      };
    });
  }

  markDone(id: number): void {
    this.deleteStmt.run(id);
  }

  markFailed(id: number, error: string, retryAfterMs?: number): void {
    let nextRetryAt: string;

    if (retryAfterMs !== undefined) {
      // Use the provided retry-after time
      nextRetryAt = new Date(Date.now() + retryAfterMs).toISOString();
    } else {
      // Calculate exponential backoff
      // Fetch current attempt count from prepared statement
      const currentRow = this.selectAttemptsStmt.get(id) as {attempts: number} | undefined;

      // Handle missing row: if it doesn't exist, the record was deleted (race condition)
      // Don't update anything, just return early
      if (!currentRow) {
        return;
      }

      // Backoff formula: BASE_DELAY_MS * 2^(attempts+1)
      const delayMs = Math.min(BASE_DELAY_MS * Math.pow(2, currentRow.attempts + 1), MAX_DELAY_MS);
      nextRetryAt = new Date(Date.now() + delayMs).toISOString();
    }

    this.updateFailedStmt.run(nextRetryAt, error, id);
  }

  size(): number {
    const result = this.countStmt.get() as {count: number};
    return result.count;
  }

  getDb(): Database.Database {
    return this.db;
  }

  close(): void {
    this.db.close();
  }
}
