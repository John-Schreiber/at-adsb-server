import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const lexiconsDir = resolve(dirname(fileURLToPath(import.meta.url)), "../../../lexicons");

function loadLexicon(relPath: string): Record<string, unknown> {
  const fullPath = resolve(lexiconsDir, relPath);
  const raw = readFileSync(fullPath, "utf-8");
  return JSON.parse(raw) as Record<string, unknown>;
}

describe("sync lexicon structural validation", () => {
  const lex = loadLexicon("at/adsb/sync/subscribeEvents.json");

  describe("top-level structure", () => {
    it("has lexicon version 1", () => {
      expect(lex["lexicon"]).toBe(1);
    });

    it("has correct id", () => {
      expect(lex["id"]).toBe("at.adsb.sync.subscribeEvents");
    });

    it("has a top-level description", () => {
      expect(typeof lex["description"]).toBe("string");
      expect(lex["description"]).not.toBe("");
    });
  });

  describe("defs.main (subscription)", () => {
    const main = (lex["defs"] as Record<string, unknown>)["main"] as Record<string, unknown>;

    it("type is subscription", () => {
      expect(main["type"]).toBe("subscription");
    });

    it("has a description", () => {
      expect(typeof main["description"]).toBe("string");
      expect(main["description"]).not.toBe("");
    });

    it("has cursor parameter of type integer with description", () => {
      const params = main["parameters"] as Record<string, unknown>;
      const props = params["properties"] as Record<string, unknown>;
      const cursor = props["cursor"] as Record<string, unknown>;
      expect(cursor["type"]).toBe("integer");
      expect(typeof cursor["description"]).toBe("string");
    });

    it("message schema is union with correct refs", () => {
      const message = main["message"] as Record<string, unknown>;
      const schema = message["schema"] as Record<string, unknown>;
      expect(schema["type"]).toBe("union");
      expect(schema["refs"]).toEqual(["#event", "#station", "#info"]);
    });

    it("has exactly FutureCursor and ConsumerTooSlow errors with descriptions", () => {
      const errors = main["errors"] as Array<Record<string, unknown>>;
      expect(errors).toHaveLength(2);
      const names = errors.map((e) => e["name"]);
      expect(names).toContain("FutureCursor");
      expect(names).toContain("ConsumerTooSlow");
      for (const err of errors) {
        expect(typeof err["description"]).toBe("string");
        expect(err["description"]).not.toBe("");
      }
    });
  });

  describe("defs.event", () => {
    const event = (lex["defs"] as Record<string, unknown>)["event"] as Record<string, unknown>;

    it("type is object", () => {
      expect(event["type"]).toBe("object");
    });

    it("has a description", () => {
      expect(typeof event["description"]).toBe("string");
      expect(event["description"]).not.toBe("");
    });

    it("required fields are exactly the right set (sig not required)", () => {
      expect(event["required"]).toEqual(["seq", "src", "upstreamSeq", "station", "time", "ops"]);
    });

    it("seq is integer with description", () => {
      const props = event["properties"] as Record<string, unknown>;
      const seq = props["seq"] as Record<string, unknown>;
      expect(seq["type"]).toBe("integer");
      expect(typeof seq["description"]).toBe("string");
    });

    it("src is string with format did and description", () => {
      const props = event["properties"] as Record<string, unknown>;
      const src = props["src"] as Record<string, unknown>;
      expect(src["type"]).toBe("string");
      expect(src["format"]).toBe("did");
      expect(typeof src["description"]).toBe("string");
    });

    it("upstreamSeq is integer with description mentioning restart", () => {
      const props = event["properties"] as Record<string, unknown>;
      const upstreamSeq = props["upstreamSeq"] as Record<string, unknown>;
      expect(upstreamSeq["type"]).toBe("integer");
      const desc = upstreamSeq["description"] as string;
      expect(desc.toLowerCase()).toContain("restart");
    });

    it("station is ref to com.atproto.repo.strongRef with description", () => {
      const props = event["properties"] as Record<string, unknown>;
      const station = props["station"] as Record<string, unknown>;
      expect(station["type"]).toBe("ref");
      expect(station["ref"]).toBe("com.atproto.repo.strongRef");
      expect(typeof station["description"]).toBe("string");
    });

    it("time is string with format datetime and description", () => {
      const props = event["properties"] as Record<string, unknown>;
      const time = props["time"] as Record<string, unknown>;
      expect(time["type"]).toBe("string");
      expect(time["format"]).toBe("datetime");
      expect(typeof time["description"]).toBe("string");
    });

    it("ops is array with ref to #broadcastOp and description", () => {
      const props = event["properties"] as Record<string, unknown>;
      const ops = props["ops"] as Record<string, unknown>;
      expect(ops["type"]).toBe("array");
      const items = ops["items"] as Record<string, unknown>;
      expect(items["type"]).toBe("ref");
      expect(items["ref"]).toBe("#broadcastOp");
      expect(typeof ops["description"]).toBe("string");
    });

    it("sig is bytes with description mentioning upstream and reconstruct", () => {
      const props = event["properties"] as Record<string, unknown>;
      const sig = props["sig"] as Record<string, unknown>;
      expect(sig["type"]).toBe("bytes");
      const desc = sig["description"] as string;
      expect(desc.toLowerCase()).toContain("upstream");
      expect(desc.toLowerCase()).toContain("reconstruct");
    });
  });

  describe("defs.broadcastOp", () => {
    const broadcastOp = (lex["defs"] as Record<string, unknown>)["broadcastOp"] as Record<string, unknown>;

    it("type is object", () => {
      expect(broadcastOp["type"]).toBe("object");
    });

    it("has a description mentioning at.adsb.broadcast.subscribeEvents", () => {
      const desc = broadcastOp["description"] as string;
      expect(desc).toContain("at.adsb.broadcast.subscribeEvents");
    });

    it("required is exactly [action, record]", () => {
      expect(broadcastOp["required"]).toEqual(["action", "record"]);
    });

    it("action is string with correct knownValues and maxLength", () => {
      const props = broadcastOp["properties"] as Record<string, unknown>;
      const action = props["action"] as Record<string, unknown>;
      expect(action["type"]).toBe("string");
      expect(action["knownValues"]).toEqual(["create", "update", "delete"]);
      expect(action["maxLength"]).toBe(16);
    });

    it("record is unknown type", () => {
      const props = broadcastOp["properties"] as Record<string, unknown>;
      const record = props["record"] as Record<string, unknown>;
      expect(record["type"]).toBe("unknown");
    });

    it("cross-checks shape against broadcast lexicon broadcastOp", () => {
      const broadcastLex = loadLexicon("at/adsb/broadcast/subscribeEvents.json");
      const bcBroadcastOp = (broadcastLex["defs"] as Record<string, unknown>)["broadcastOp"] as Record<string, unknown>;

      // Same required fields
      expect(broadcastOp["required"]).toEqual(bcBroadcastOp["required"]);

      // Same action knownValues
      const syncAction = (broadcastOp["properties"] as Record<string, unknown>)["action"] as Record<string, unknown>;
      const bcAction = (bcBroadcastOp["properties"] as Record<string, unknown>)["action"] as Record<string, unknown>;
      expect(syncAction["knownValues"]).toEqual(bcAction["knownValues"]);
      expect(syncAction["maxLength"]).toBe(bcAction["maxLength"]);

      // Same record type
      const syncRecord = (broadcastOp["properties"] as Record<string, unknown>)["record"] as Record<string, unknown>;
      const bcRecord = (bcBroadcastOp["properties"] as Record<string, unknown>)["record"] as Record<string, unknown>;
      expect(syncRecord["type"]).toBe(bcRecord["type"]);
    });
  });

  describe("defs.station", () => {
    const station = (lex["defs"] as Record<string, unknown>)["station"] as Record<string, unknown>;

    it("type is object", () => {
      expect(station["type"]).toBe("object");
    });

    it("has a description", () => {
      expect(typeof station["description"]).toBe("string");
      expect(station["description"]).not.toBe("");
    });

    it("required is exactly [seq, src, op, time] (record not required)", () => {
      expect(station["required"]).toEqual(["seq", "src", "op", "time"]);
    });

    it("seq is integer with description", () => {
      const props = station["properties"] as Record<string, unknown>;
      const seq = props["seq"] as Record<string, unknown>;
      expect(seq["type"]).toBe("integer");
      expect(typeof seq["description"]).toBe("string");
    });

    it("src is string with format did and description", () => {
      const props = station["properties"] as Record<string, unknown>;
      const src = props["src"] as Record<string, unknown>;
      expect(src["type"]).toBe("string");
      expect(src["format"]).toBe("did");
      expect(typeof src["description"]).toBe("string");
    });

    it("op is string with correct knownValues", () => {
      const props = station["properties"] as Record<string, unknown>;
      const op = props["op"] as Record<string, unknown>;
      expect(op["type"]).toBe("string");
      expect(op["knownValues"]).toEqual(["create", "update", "delete"]);
    });

    it("time is string with format datetime and description", () => {
      const props = station["properties"] as Record<string, unknown>;
      const time = props["time"] as Record<string, unknown>;
      expect(time["type"]).toBe("string");
      expect(time["format"]).toBe("datetime");
      expect(typeof time["description"]).toBe("string");
    });

    it("record is unknown with description mentioning absent and delete", () => {
      const props = station["properties"] as Record<string, unknown>;
      const record = props["record"] as Record<string, unknown>;
      expect(record["type"]).toBe("unknown");
      const desc = record["description"] as string;
      expect(desc.toLowerCase()).toContain("absent");
      expect(desc.toLowerCase()).toContain("delete");
    });
  });

  describe("defs.info", () => {
    const info = (lex["defs"] as Record<string, unknown>)["info"] as Record<string, unknown>;

    it("type is object", () => {
      expect(info["type"]).toBe("object");
    });

    it("required is exactly [name]", () => {
      expect(info["required"]).toEqual(["name"]);
    });

    it("name is string with knownValues OutdatedCursor and maxLength 64", () => {
      const props = info["properties"] as Record<string, unknown>;
      const name = props["name"] as Record<string, unknown>;
      expect(name["type"]).toBe("string");
      expect(name["knownValues"]).toEqual(["OutdatedCursor"]);
      expect(name["maxLength"]).toBe(64);
    });

    it("message is string with maxLength 1024", () => {
      const props = info["properties"] as Record<string, unknown>;
      const message = props["message"] as Record<string, unknown>;
      expect(message["type"]).toBe("string");
      expect(message["maxLength"]).toBe(1024);
    });
  });
});

describe("station lexicon streamEndpoint field", () => {
  const stationLex = loadLexicon("at/adsb/receiver/station.json");
  const record = ((stationLex["defs"] as Record<string, unknown>)["main"] as Record<string, unknown>)["record"] as Record<string, unknown>;
  const props = record["properties"] as Record<string, unknown>;
  const streamEndpoint = props["streamEndpoint"] as Record<string, unknown>;

  it("streamEndpoint exists", () => {
    expect(streamEndpoint).toBeDefined();
  });

  it("type is string", () => {
    expect(streamEndpoint["type"]).toBe("string");
  });

  it("format is uri", () => {
    expect(streamEndpoint["format"]).toBe("uri");
  });

  it("has non-empty description", () => {
    expect(typeof streamEndpoint["description"]).toBe("string");
    expect(streamEndpoint["description"]).not.toBe("");
  });

  it("is NOT in required array", () => {
    const required = record["required"] as string[];
    expect(required).not.toContain("streamEndpoint");
  });
});
