// pattern: Imperative Shell

import type { AtpAgent } from "@atproto/api";
import type { Secp256k1Keypair } from "@atproto/crypto";
import { getSigningKeyDid } from "./keys.js";
import { getRecord, putRecord } from "./client.js";
import type { FetchedStationRecord } from "./client.js";
import type { StreamBroadcaster } from "./stream.js";

export type RotationResult =
  | { readonly rotated: true; readonly stationRecord: FetchedStationRecord }
  | { readonly rotated: false; readonly reason: string; readonly stationRecord: FetchedStationRecord | null };

export async function detectAndApplyKeyRotation(
  agent: AtpAgent,
  broadcaster: StreamBroadcaster,
  signingKey: Secp256k1Keypair,
): Promise<RotationResult> {
  const currentDidKey = getSigningKeyDid(signingKey);

  const stationRecord = await getRecord(
    agent,
    "at.adsb.receiver.station",
    "self",
  );

  if (!stationRecord) {
    return { rotated: false, reason: "station record not found", stationRecord: null };
  }

  const recordValue = stationRecord.value as Record<string, unknown>;
  const existingKey = recordValue["streamSigningKey"] as string | undefined;

  if (existingKey === currentDidKey) {
    return { rotated: false, reason: "key unchanged", stationRecord };
  }

  // Key differs — rotation detected. Sequence:
  // 1. Emit KeyRotated info frame (signal consumers before new key takes effect)
  // 2. Update station record with new public key
  // 3. Return success (caller already has the new key loaded)

  broadcaster.broadcastInfo("KeyRotated", "Stream signing key rotated.");

  const updatedRecord: Record<string, unknown> = {
    ...recordValue,
    streamSigningKey: currentDidKey,
  };
  if ("$type" in updatedRecord) {
    delete updatedRecord["$type"];
  }

  await putRecord(agent, "at.adsb.receiver.station", "self", updatedRecord);

  return { rotated: true, stationRecord: { uri: stationRecord.uri, cid: stationRecord.cid, value: updatedRecord } };
}
