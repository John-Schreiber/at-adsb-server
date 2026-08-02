// pattern: Functional Core

import type { ReadsbAircraft, ReadsbStats } from "../readsb.js";
import type { NormalizedAircraft, StatsMessage } from "../normalized.js";

export function mapReadsbToNormalized(
  ac: ReadsbAircraft,
  sourceOverride?: string,
): NormalizedAircraft {
  return {
    icaoHex: ac.hex.toUpperCase(),
    source: sourceOverride ?? ac.type ?? "mode_s",
    seen: ac.seen,
    rssi: ac.rssi,
    messages: ac.messages,
    lat: ac.lat,
    lon: ac.lon,
    seenPos: ac.seen_pos,
    altBaro:
      typeof ac.alt_baro === "string" ? (ac.alt_baro as "ground") : ac.alt_baro,
    altGeom: ac.alt_geom,
    gs: ac.gs,
    track: ac.track,
    baroRate: ac.baro_rate,
    flight: ac.flight,
    squawk: ac.squawk,
    category: ac.category,
    navQnh: ac.nav_qnh,
    nic: ac.lastPosition?.nic,
    rc: ac.lastPosition?.rc,
  };
}

// readsb's last1min block is a rolling window that the daemon sums per stats
// period. Emitting it on every poll (default 1s) would count each 60s window
// ~60 times, so a window is reported only once, keyed on its start timestamp.
export function buildStatsMessage(
  stats: Readonly<ReadsbStats>,
  lastSentWindowStart: number | null,
): StatsMessage | null {
  if (stats.last1min.start === lastSentWindowStart) {
    return null;
  }

  return {
    type: "stats",
    protocol: "adsb",
    messagesReceived: stats.last1min.messages_valid,
    positionsDecoded: stats.last1min.position_count_total,
    signal: {
      meanDbfs: stats.last1min.local.signal,
      noiseDbfs: stats.last1min.local.noise,
      strongCount: stats.last1min.local.strong_signals,
    },
  };
}

export function calculateBackoffDelay(
  currentDelay: number,
  maxDelay: number,
): number {
  return Math.min(currentDelay * 2, maxDelay);
}
