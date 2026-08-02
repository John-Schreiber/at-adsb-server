// pattern: Imperative Shell

import type { AtpAgent } from "@atproto/api";
import { getRecord, putRecord } from "./client.js";
import type { FetchedStationRecord } from "./client.js";

export type StreamEndpointResult =
  | { readonly updated: true }
  | { readonly updated: false; readonly reason: string };

/**
 * Validates that a streamEndpoint value is a well-formed WebSocket URL.
 * Must use ws:// or wss:// protocol and have a hostname.
 */
export function validateStreamEndpoint(value: string | undefined): boolean {
  if (!value) return false;
  try {
    const url = new URL(value);
    return (url.protocol === "ws:" || url.protocol === "wss:") && !!url.hostname;
  } catch {
    return false;
  }
}

/**
 * Checks if streamEndpoint is set and updates the station record
 * if the value differs from the current record. Returns a result describing
 * what happened.
 *
 * `existingRecord` uses a three-value sentinel (Fix 4):
 *   - `undefined`  → key rotation not configured; fetch the record independently
 *   - `null`       → key rotation ran, record not found; skip fetch, return "not found"
 *   - object       → key rotation ran, record fetched/present; use directly, skip fetch
 *
 * Errors are caught and returned — this function never throws.
 */
export async function updateStreamEndpoint(
  agent: AtpAgent,
  streamEndpoint: string | undefined,
  existingRecord?: FetchedStationRecord | null,
): Promise<StreamEndpointResult> {
  if (streamEndpoint === undefined) {
    return { updated: false, reason: "streamEndpoint not configured" };
  }

  if (!validateStreamEndpoint(streamEndpoint)) {
    console.warn(
      `Invalid streamEndpoint value "${streamEndpoint}": must be a ws:// or wss:// URL with a hostname. Skipping update.`,
    );
    return { updated: false, reason: "invalid streamEndpoint format" };
  }

  try {
    // Three-value sentinel (Fix 4):
    //   existingRecord === undefined → key rotation not configured, fetch independently
    //   existingRecord === null      → key rotation ran, record not found; no fetch needed
    //   existingRecord is an object  → key rotation ran, record present; use directly
    // `null !== undefined` is `true`, so null is used as-is (no fetch), then caught by
    // the `!stationRecord` check below → "station record not found".
    const stationRecord = existingRecord !== undefined
      ? existingRecord
      : await getRecord(agent, "at.adsb.receiver.station", "self");

    if (!stationRecord) {
      return { updated: false, reason: "station record not found" };
    }

    const recordValue = stationRecord.value as Record<string, unknown>;
    const existingEndpoint = recordValue["streamEndpoint"] as string | undefined;

    if (existingEndpoint === streamEndpoint) {
      return { updated: false, reason: "streamEndpoint unchanged" };
    }

    const updatedRecord: Record<string, unknown> = {
      ...recordValue,
      streamEndpoint,
    };
    if ("$type" in updatedRecord) {
      delete updatedRecord["$type"];
    }

    await putRecord(agent, "at.adsb.receiver.station", "self", updatedRecord);
    return { updated: true };
  } catch (err) {
    console.error(
      "Failed to update streamEndpoint:",
      err instanceof Error ? err.message : err,
    );
    return { updated: false, reason: "error during update" };
  }
}
