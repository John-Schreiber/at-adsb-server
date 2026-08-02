// pattern: Functional Core

import type { AircraftUpdate, Position } from "./stream.js";
import type { NormalizedAircraft } from "./normalized.js";

export function buildAircraftUpdate(
  aircraft: Readonly<NormalizedAircraft>,
): AircraftUpdate {
  const payload: AircraftUpdate = {
    icaoHex: aircraft.icaoHex,
    rssi: aircraft.rssi.toString(),
    seen: aircraft.seen.toString(),
  };

  const trimmedCallsign = aircraft.flight?.trim();
  if (trimmedCallsign) {
    payload.callsign = trimmedCallsign;
  }

  if (aircraft.squawk !== undefined) {
    payload.squawk = aircraft.squawk;
  }

  if (aircraft.lat !== undefined && aircraft.lon !== undefined) {
    const position: Position = {
      latitude: aircraft.lat.toString(),
      longitude: aircraft.lon.toString(),
      source: aircraft.source,
      timestamp: new Date().toISOString(),
    };

    if (aircraft.altBaro !== undefined && typeof aircraft.altBaro === "number") {
      position.altitudeFt = aircraft.altBaro;
    }

    if (aircraft.gs !== undefined) {
      position.groundSpeedKts = aircraft.gs.toString();
    }

    if (aircraft.track !== undefined) {
      position.trackDeg = aircraft.track.toString();
    }

    if (aircraft.baroRate !== undefined) {
      position.verticalRateFpm = aircraft.baroRate;
    }

    payload.position = position;
  }

  if (aircraft.nic !== undefined) {
    payload.nic = aircraft.nic;
  }

  if (aircraft.rc !== undefined) {
    payload.rc = aircraft.rc;
  }

  if (aircraft.seenPos !== undefined) {
    payload.seenPos = aircraft.seenPos.toString();
  }

  if (aircraft.messages !== undefined) {
    payload.messageCount = aircraft.messages;
  }

  return payload;
}
