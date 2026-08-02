# geojson-bridge

A small local-only tool, not part of the upstream at-adsb-server project (kept on this fork until there's interest in contributing it upstream).

Merges the readsb and dump978 `aircraft.json` feeds by ICAO hex and serves the result as a GeoJSON `FeatureCollection` at `/aircraft.geojson`, for viewing current traffic on a local map (e.g., in QGIS or a Leaflet page) without polling either source directly.

Intentionally **not** exposed through the Cloudflare Tunnel — only published to the host, same as the `proxy`/`dump978-proxy` services it depends on.

## Environment variables

- `READSB_URL` (default `http://proxy:80`)
- `DUMP978_URL` (default `http://dump978-proxy:80`)
- `PORT` (default `8082`)
