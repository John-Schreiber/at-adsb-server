import { createServer } from "node:http";

const READSB_URL = process.env.READSB_URL ?? "http://proxy:80";
const DUMP978_URL = process.env.DUMP978_URL ?? "http://dump978-proxy:80";
const PORT = process.env.PORT ?? 8082;

async function fetchAircraft(baseUrl) {
  try {
    const res = await fetch(`${baseUrl}/data/aircraft.json`);
    if (!res.ok) return [];
    const data = await res.json();
    return data.aircraft ?? [];
  } catch {
    return [];
  }
}

function toFeature(ac, source) {
  const altitudeFt =
    typeof ac.alt_baro === "number" ? ac.alt_baro : ac.alt_baro === "ground" ? 0 : null;

  return {
    type: "Feature",
    geometry: { type: "Point", coordinates: [ac.lon, ac.lat] },
    properties: {
      hex: ac.hex,
      flight: typeof ac.flight === "string" ? ac.flight.trim() : null,
      altitudeFt,
      groundSpeedKt: ac.gs ?? null,
      trackDeg: ac.track ?? null,
      source,
      seenS: ac.seen ?? null,
      seenPosS: ac.seen_pos ?? null,
    },
  };
}

async function buildGeoJson() {
  const [readsbAircraft, uatAircraft] = await Promise.all([
    fetchAircraft(READSB_URL),
    fetchAircraft(DUMP978_URL),
  ]);

  const byHex = new Map();

  for (const ac of readsbAircraft) {
    if (typeof ac.lat !== "number" || typeof ac.lon !== "number") continue;
    byHex.set(ac.hex, toFeature(ac, ac.type ?? "adsb"));
  }

  for (const ac of uatAircraft) {
    if (typeof ac.lat !== "number" || typeof ac.lon !== "number") continue;
    const existing = byHex.get(ac.hex);
    const existingSeenPos = existing?.properties.seenPosS ?? Infinity;
    if (!existing || (ac.seen_pos ?? Infinity) < existingSeenPos) {
      byHex.set(ac.hex, toFeature(ac, "uat"));
    }
  }

  return {
    type: "FeatureCollection",
    generated: new Date().toISOString(),
    features: [...byHex.values()],
  };
}

const server = createServer(async (req, res) => {
  if (req.url !== "/aircraft.geojson") {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not found. Try /aircraft.geojson");
    return;
  }

  try {
    const geojson = await buildGeoJson();
    res.writeHead(200, { "Content-Type": "application/geo+json" });
    res.end(JSON.stringify(geojson));
  } catch (err) {
    res.writeHead(500, { "Content-Type": "text/plain" });
    res.end(`Error building GeoJSON: ${err instanceof Error ? err.message : String(err)}`);
  }
});

server.listen(PORT, () => {
  console.log(`GeoJSON bridge listening on :${PORT}`);
});
