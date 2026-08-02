import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { IdentityCache, type CachedIdentity } from "../identity-cache.js";

describe("IdentityCache", () => {
  let db: Database.Database;
  let cache: IdentityCache;

  beforeEach(() => {
    db = new Database(":memory:");
  });

  afterEach(() => {
    cache.dbSize(); // Ensure in-memory operations complete before closing
    db.close();
  });

  describe("provenance-chain.AC4.1 — Cache stores and retrieves entries", () => {
    it("stores and retrieves a single entry", () => {
      cache = new IdentityCache(db);

      const identity: CachedIdentity = {
        ref: { uri: "at://did:plc:test/at.adsb.aircraft.identity/abc123", cid: "cid-1" },
        rkey: "abc123",
        category: "A0",
      };

      cache.set("A1B2C3", identity);
      const retrieved = cache.get("A1B2C3");

      expect(retrieved).toEqual(identity);
    });

    it("stores entry with correct icaoHex, URI, CID, rkey, and category", () => {
      cache = new IdentityCache(db);

      const identity: CachedIdentity = {
        ref: {
          uri: "at://did:plc:example/at.adsb.aircraft.identity/rkey123",
          cid: "bagcid-example",
        },
        rkey: "rkey123",
        category: "A1",
      };

      cache.set("A1B2C3", identity);

      // Verify all fields are correctly stored
      const entry = db.prepare("SELECT icao_hex, uri, cid, rkey, category FROM identity_cache WHERE icao_hex = ?").get("A1B2C3") as any;
      expect(entry.icao_hex).toBe("A1B2C3");
      expect(entry.uri).toBe("at://did:plc:example/at.adsb.aircraft.identity/rkey123");
      expect(entry.cid).toBe("bagcid-example");
      expect(entry.rkey).toBe("rkey123");
      expect(entry.category).toBe("A1");
    });

    it("stores entry without category", () => {
      cache = new IdentityCache(db);

      const identity: CachedIdentity = {
        ref: { uri: "at://did:plc:test/at.adsb.aircraft.identity/xyz", cid: "cid-2" },
        rkey: "xyz",
      };

      cache.set("B2C3D4", identity);
      const retrieved = cache.get("B2C3D4");

      expect(retrieved).toEqual(identity);
      expect(retrieved?.category).toBeUndefined();
    });

    it("returns undefined for unknown ICAO hex", () => {
      cache = new IdentityCache(db);

      const result = cache.get("UNKNOWN");

      expect(result).toBeUndefined();
    });
  });

  describe("provenance-chain.AC4.2 — Cache persistence across restarts", () => {
    it("loads previously stored entries on new instance", () => {
      // Create first cache instance and store data
      cache = new IdentityCache(db);
      const identity: CachedIdentity = {
        ref: { uri: "at://did:plc:test/at.adsb.aircraft.identity/abc", cid: "cid-abc" },
        rkey: "abc",
        category: "B1",
      };
      cache.set("HEXABC1", identity);

      // Create new cache instance from same database
      const cache2 = new IdentityCache(db);
      const retrieved = cache2.get("HEXABC1");

      expect(retrieved).toEqual(identity);
    });

    it("loads multiple previously stored entries", () => {
      cache = new IdentityCache(db);

      const entries: Array<[string, CachedIdentity]> = [
        ["HEX0001", {
          ref: { uri: "at://uri1", cid: "cid1" },
          rkey: "rkey1",
          category: "A0",
        }],
        ["HEX0002", {
          ref: { uri: "at://uri2", cid: "cid2" },
          rkey: "rkey2",
        }],
        ["HEX0003", {
          ref: { uri: "at://uri3", cid: "cid3" },
          rkey: "rkey3",
          category: "C5",
        }],
      ];

      for (const [hex, identity] of entries) {
        cache.set(hex, identity);
      }

      // Create new instance and verify all entries are available
      const cache2 = new IdentityCache(db);
      for (const [hex, identity] of entries) {
        const retrieved = cache2.get(hex);
        expect(retrieved).toEqual(identity);
      }
    });
  });

  describe("provenance-chain.AC4.3 — Cache updates on category change", () => {
    it("updates entry when category changes", () => {
      cache = new IdentityCache(db);

      const original: CachedIdentity = {
        ref: { uri: "at://did:plc:test/at.adsb.aircraft.identity/rkey1", cid: "cid-v1" },
        rkey: "rkey1",
        category: "A0",
      };

      cache.set("HEXABC1", original);

      const updated: CachedIdentity = {
        ref: { uri: "at://did:plc:test/at.adsb.aircraft.identity/rkey1", cid: "cid-v2" },
        rkey: "rkey1",
        category: "A1",
      };

      cache.set("HEXABC1", updated);
      const retrieved = cache.get("HEXABC1");

      expect(retrieved?.category).toBe("A1");
      expect(retrieved?.ref.cid).toBe("cid-v2");
    });

    it("updates both in-memory cache and SQLite", () => {
      cache = new IdentityCache(db);

      const original: CachedIdentity = {
        ref: { uri: "at://uri1", cid: "cid-v1" },
        rkey: "rkey1",
        category: "A0",
      };

      cache.set("HEXTEST", original);

      const updated: CachedIdentity = {
        ref: { uri: "at://uri1", cid: "cid-v2" },
        rkey: "rkey1",
        category: "B2",
      };

      cache.set("HEXTEST", updated);

      // Check in-memory cache
      const inMemory = cache.get("HEXTEST");
      expect(inMemory?.category).toBe("B2");

      // Verify in SQLite (through new instance)
      const cache2 = new IdentityCache(db);
      const fromDb = cache2.get("HEXTEST");
      expect(fromDb?.category).toBe("B2");
      expect(fromDb?.ref.cid).toBe("cid-v2");
    });
  });

  describe("provenance-chain.AC4.4 — Cache survives daemon restarts", () => {
    it("data persists across multiple instances", () => {
      const identities: Array<[string, CachedIdentity]> = [
        ["ACFT001", {
          ref: { uri: "at://uri1", cid: "cid1" },
          rkey: "rkey1",
          category: "A0",
        }],
        ["ACFT002", {
          ref: { uri: "at://uri2", cid: "cid2" },
          rkey: "rkey2",
          category: "B1",
        }],
        ["ACFT003", {
          ref: { uri: "at://uri3", cid: "cid3" },
          rkey: "rkey3",
        }],
      ];

      // First "run" of daemon
      cache = new IdentityCache(db);
      for (const [hex, identity] of identities) {
        cache.set(hex, identity);
      }

      // Simulate "restart" by creating new instance
      const cache2 = new IdentityCache(db);
      for (const [hex, identity] of identities) {
        expect(cache2.get(hex)).toEqual(identity);
      }

      // Simulate another "restart"
      const cache3 = new IdentityCache(db);
      for (const [hex, identity] of identities) {
        expect(cache3.get(hex)).toEqual(identity);
      }
    });
  });

  describe("Upsert behaviour — setting same ICAO hex twice", () => {
    it("updates entry instead of duplicating", () => {
      cache = new IdentityCache(db);

      const entry1: CachedIdentity = {
        ref: { uri: "at://uri1", cid: "cid1" },
        rkey: "rkey1",
        category: "A0",
      };

      cache.set("HEXDUP1", entry1);
      expect(cache.size()).toBe(1);

      const entry2: CachedIdentity = {
        ref: { uri: "at://uri2", cid: "cid2" },
        rkey: "rkey2",
        category: "B2",
      };

      cache.set("HEXDUP1", entry2);
      expect(cache.size()).toBe(1);

      // Verify the latest entry is returned
      const retrieved = cache.get("HEXDUP1");
      expect(retrieved).toEqual(entry2);
    });

    it("does not create duplicate database rows", () => {
      cache = new IdentityCache(db);

      const entry1: CachedIdentity = {
        ref: { uri: "at://uri1", cid: "cid1" },
        rkey: "rkey1",
      };

      cache.set("HEXPK1", entry1);
      const dbSize1 = cache.dbSize();

      cache.set("HEXPK1", { ...entry1, ref: { ...entry1.ref, cid: "cid2" } });
      const dbSize2 = cache.dbSize();

      expect(dbSize2).toBe(dbSize1);
    });
  });

  describe("Cache size tracking", () => {
    it("size() returns number of cached entries", () => {
      cache = new IdentityCache(db);

      expect(cache.size()).toBe(0);

      cache.set("HEX1", {
        ref: { uri: "at://uri1", cid: "cid1" },
        rkey: "rkey1",
      });
      expect(cache.size()).toBe(1);

      cache.set("HEX2", {
        ref: { uri: "at://uri2", cid: "cid2" },
        rkey: "rkey2",
      });
      expect(cache.size()).toBe(2);
    });

    it("dbSize() matches in-memory size()", () => {
      cache = new IdentityCache(db);

      const hexes = ["HEX1", "HEX2", "HEX3", "HEX4", "HEX5"];
      for (const hex of hexes) {
        cache.set(hex, {
          ref: { uri: `at://uri/${hex}`, cid: `cid-${hex}` },
          rkey: `rkey-${hex}`,
        });
      }

      expect(cache.dbSize()).toBe(cache.size());
      expect(cache.dbSize()).toBe(5);
    });
  });
});
