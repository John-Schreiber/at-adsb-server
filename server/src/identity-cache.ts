// pattern: Imperative Shell
import Database from "better-sqlite3";

export type CachedIdentity = {
  readonly ref: { readonly uri: string; readonly cid: string };
  readonly rkey: string;
  readonly category?: string;
};

export class IdentityCache {
  private readonly db: Database.Database;
  private readonly upsertStmt: Database.Statement<[string, string, string, string, string | null, string]>;
  private readonly selectAllStmt: Database.Statement<[], { icao_hex: string; uri: string; cid: string; rkey: string; category: string | null; updated_at: string }>;
  private readonly countStmt: Database.Statement<[], { count: number }>;
  private readonly cache: Map<string, CachedIdentity>;

  constructor(db: Database.Database) {
    this.db = db;

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS identity_cache (
        icao_hex TEXT PRIMARY KEY,
        uri TEXT NOT NULL,
        cid TEXT NOT NULL,
        rkey TEXT NOT NULL,
        category TEXT,
        updated_at TEXT NOT NULL
      )
    `);

    this.upsertStmt = this.db.prepare(`
      INSERT INTO identity_cache (icao_hex, uri, cid, rkey, category, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(icao_hex) DO UPDATE SET
        uri = excluded.uri,
        cid = excluded.cid,
        rkey = excluded.rkey,
        category = excluded.category,
        updated_at = excluded.updated_at
    `);

    this.selectAllStmt = this.db.prepare(`
      SELECT icao_hex, uri, cid, rkey, category, updated_at FROM identity_cache
    `);

    this.countStmt = this.db.prepare(`
      SELECT COUNT(*) as count FROM identity_cache
    `);

    this.cache = this.loadAll();
  }

  private loadAll(): Map<string, CachedIdentity> {
    const map = new Map<string, CachedIdentity>();
    const rows = this.selectAllStmt.all();
    for (const row of rows) {
      map.set(row.icao_hex, {
        ref: { uri: row.uri, cid: row.cid },
        rkey: row.rkey,
        category: row.category ?? undefined,
      });
    }
    return map;
  }

  get(icaoHex: string): CachedIdentity | undefined {
    return this.cache.get(icaoHex);
  }

  set(icaoHex: string, entry: CachedIdentity): void {
    const now = new Date().toISOString();
    this.upsertStmt.run(
      icaoHex,
      entry.ref.uri,
      entry.ref.cid,
      entry.rkey,
      entry.category ?? null,
      now,
    );
    this.cache.set(icaoHex, entry);
  }

  size(): number {
    return this.cache.size;
  }

  dbSize(): number {
    const result = this.countStmt.get();
    return result?.count ?? 0;
  }
}
