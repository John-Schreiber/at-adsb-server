// pattern: Imperative Shell

import type { AtpAgent, BlobRef } from "@atproto/api";
import { XRPCError } from "@atproto/api";
import type { Secp256k1Keypair } from "@atproto/crypto";
import { readFile, unlink } from "node:fs/promises";
import { chunkTelemetry } from "./blobs.js";
import { createRecord, getRecord, putRecord, uploadBlob } from "./client.js";
import type { DaemonConfig } from "./config.js";
import {
  buildAircraftIdentityRecord,
  buildFlightRecord,
  buildStatsRecord,
  type StrongRef,
  type ProtocolBreakdownEntry,
} from "./records.js";
import {
  AircraftTracker,
  createStatsAccumulator,
  type StatsAccumulator,
} from "./tracker.js";
import { PublishQueue } from "./queue.js";
import { IdentityCache } from "./identity-cache.js";
import { StreamBroadcaster } from "./stream.js";
import { buildAircraftUpdate } from "./stream-payload.js";
import type { StationRef } from "./stream.js";
import {
  createBatchWindow,
  addPosition,
  buildBatchRecord,
  collectSources,
  getManifestHexes,
  type TelemetryData,
} from "./batch.js";
import { concatAtrxBlobs, parseAtrxBlob, buildAtrxBlob } from "./atrx.js";
import type { NormalizedAircraft, AircraftMessage, StatsMessage, RawCaptureMessage } from "./normalized.js";
import { AdapterServer } from "./adapter-server.js";
import { signEventFrame } from "./frame-signer.js";
import { importSigningKey } from "./keys.js";
import { detectAndApplyKeyRotation } from "./key-rotation.js";
import { updateStreamEndpoint } from "./stream-endpoint-update.js";
import type { FetchedStationRecord } from "./client.js";

export type BatchState = {
  telemetry: TelemetryData;
  windowStart: Date;
};

type BatchIndex = Map<string, Array<StrongRef>>;

// Intentional mutation: protocol stats accumulate across multiple adapters
// in the imperative shell. These mutable fields collect stats until flush.
type AdapterStatsEntry = {
  messagesReceived: number;
  positionsDecoded: number;
  signal?: { meanDbfs: number; noiseDbfs: number; strongCount: number };
};

async function drainQueue(
  agent: AtpAgent,
  queue: PublishQueue,
): Promise<void> {
  try {
    const ready = queue.getReady();

    for (const entry of ready) {
      try {
        const result = await createRecord(
          agent,
          entry.collection,
          entry.record,
        );
        queue.markDone(entry.id);
        console.log(
          `Drained queued record: ${entry.collection} — ${result.uri}`,
        );
      } catch (err) {
        // Parse 429 with Retry-After header
        let retryAfterMs: number | undefined;

        if (err instanceof XRPCError && err.status === 429 && err.headers) {
          const retryAfter = err.headers["retry-after"];
          if (retryAfter) {
            // Retry-After is in seconds, convert to ms
            retryAfterMs = Number(retryAfter) * 1000;
          }
        }

        queue.markFailed(
          entry.id,
          err instanceof Error ? err.message : String(err),
          retryAfterMs,
        );
      }
    }
  } catch (err) {
    console.error(
      "Queue drain error:",
      err instanceof Error ? err.message : err,
    );
  }
}

export async function runStartupUpdates(
  agent: AtpAgent,
  config: DaemonConfig,
  broadcaster: StreamBroadcaster,
): Promise<Secp256k1Keypair | null> {
  // Derive signing key from config
  const signingKey = config.streamSigningKeyHex
    ? await importSigningKey(config.streamSigningKeyHex)
    : undefined;

  // Key rotation (if configured) — emits KeyRotated BEFORE writing, per protocol guarantee
  let prefetchedStationRecord: FetchedStationRecord | null | undefined;
  if (signingKey) {
    console.log("Stream signing enabled.");
    const rotation = await detectAndApplyKeyRotation(agent, broadcaster, signingKey);
    prefetchedStationRecord = rotation.stationRecord;
    if (rotation.rotated) {
      console.log("Stream signing key rotated and station record updated.");
    }
  }

  // Update streamEndpoint on station record if configured.
  // Pass the pre-fetched record from key rotation to avoid a redundant getRecord (F8).
  // Fix 8: guard on `!== undefined` (not truthiness) so empty strings reach
  // updateStreamEndpoint, where validateStreamEndpoint catches them.
  if (config.streamEndpoint !== undefined) {
    try {
      const endpointResult = await updateStreamEndpoint(
        agent,
        config.streamEndpoint,
        prefetchedStationRecord,
      );
      if (endpointResult.updated) {
        console.log("Station record streamEndpoint updated.");
      }
    } catch (err) {
      console.error("streamEndpoint update failed:", err instanceof Error ? err.message : err);
    }
  }

  // Return the signing key so runDaemon can use it for ongoing event signing
  return signingKey ?? null;
}

export async function runDaemon(
  agent: AtpAgent,
  config: DaemonConfig,
  stationRefParam: StationRef,
): Promise<void> {
  // Fix 2: stationRef is mutable so it can be updated after startup key/endpoint
  // updates change the record CID.
  let stationRef = stationRefParam;
  const tracker = new AircraftTracker(config.receiverLat, config.receiverLon);
  let stats = createStatsAccumulator();
  const queue = new PublishQueue(config.queueDbPath);
  const identityCache = new IdentityCache(queue.getDb());
  let batchState = createBatchWindow(new Date());
  const batchIndex: BatchIndex = new Map();
  const protocolStats = new Map<string, AdapterStatsEntry>();
  let rawCapturePaths: string[] = [];

  const broadcaster = new StreamBroadcaster();
  await broadcaster.start(config.wsPort);
  console.log(`Stream server listening on port ${config.wsPort}.`);

  const signingKey = await runStartupUpdates(agent, config, broadcaster);

  // Fix 2: After startup updates (key rotation and/or streamEndpoint), the station
  // record CID may have changed. Re-fetch to get the fresh strongRef so the
  // broadcaster emits the correct CID. Only when an update was configured —
  // one-time startup cost. Wrapped in try/catch so transient PDS failures
  // don't crash startup — falls back to the original stationRef.
  if (config.streamEndpoint !== undefined || config.streamSigningKeyHex) {
    try {
      const updatedRecord = await getRecord(
        agent,
        "at.adsb.receiver.station",
        "self",
      );
      if (updatedRecord) {
        stationRef = {
          uri: updatedRecord.uri,
          cid: updatedRecord.cid ?? "",
        };
      }
    } catch (err) {
      console.warn("Failed to refresh station record after startup updates, using original strongRef", err);
    }
  }

  function buildProtocolBreakdown(): Array<ProtocolBreakdownEntry> {
    const breakdown: Array<ProtocolBreakdownEntry> = [];
    for (const [protocol, entry] of protocolStats) {
      breakdown.push({
        protocol,
        messagesReceived: entry.messagesReceived,
        positionsDecoded: entry.positionsDecoded,
        ...(entry.signal !== undefined ? { signal: entry.signal } : {}),
      });
    }
    return breakdown;
  }

  const statsIntervalMs = config.statsIntervalM * 60 * 1000;
  const batchFlushIntervalMs = config.batchWindowS * 1000;
  const queueDrainIntervalMs = 30000; // 30 seconds

  console.log(
    `Daemon started with AdapterServer socket: ${config.socketPath}`,
  );
  console.log(
    `Stats will be published every ${config.statsIntervalM} minutes.`,
  );
  console.log(
    `Batch window duration: ${config.batchWindowS} seconds.`,
  );

  // Handle aircraft data from adapter
  const onAircraft = async (sourceId: string, msg: AircraftMessage): Promise<void> => {
    try {
      // Update tracker: get departed aircraft and positions added this cycle
      const result = tracker.update(msg.aircraft, msg.timestamp);
      const toPublish = result.departed;
      const positions = result.positions;

      // Feed positions into batch window
      for (const [hex, reports] of positions) {
        for (const report of reports) {
          addPosition(batchState.telemetry, hex, report);
        }
      }

      // Broadcast ephemeral frames for all tracked aircraft
      if (broadcaster && stationRef) {
        const trackedHexes = tracker.getAllTrackedHexes();
        const timestamp = new Date(msg.timestamp * 1000).toISOString();
        const ops = msg.aircraft
          .filter((ac) => trackedHexes.has(ac.icaoHex))
          .map((ac) => ({
            action: 'update' as const,
            record: { ...buildAircraftUpdate(ac), $type: 'at.adsb.broadcast.message' },
          }));
        if (signingKey) {
          const unsigned = broadcaster.buildEventMessage(stationRef, timestamp, ops);
          if (unsigned) {
            const signed = await signEventFrame(unsigned, signingKey);
            broadcaster.emitFrame(signed);
          }
        } else {
          broadcaster.broadcast(stationRef, timestamp, ops);
        }
      }

      // Process departed aircraft: resolve identities, create flight records
      for (const ac of toPublish) {
        stats.aircraftSeen.add(ac.icaoHex);

        // Retrieve and remove batch refs for this aircraft (always clean up)
        const batchRefs = batchIndex.get(ac.icaoHex) ?? [];
        batchIndex.delete(ac.icaoHex);

        if (ac.positionCount === 0) {
          // AC2.5: skip zero-position aircraft (already cleaned up batchIndex)
          continue;
        }

        // Resolve or create aircraft identity record
        let cached = identityCache.get(ac.icaoHex);
        if (!cached) {
          try {
            const identityRecord = buildAircraftIdentityRecord(ac.icaoHex, new Date(), ac.category);
            const result = await createRecord(
              agent,
              "at.adsb.aircraft.identity",
              identityRecord,
            );
            const rkey = result.uri.split("/").pop()!;
            cached = { ref: { uri: result.uri, cid: result.cid }, rkey, category: ac.category };
            identityCache.set(ac.icaoHex, cached);
            console.log(`Identity: ${ac.icaoHex} — ${result.uri}`);
          } catch (err) {
            console.error(
              `Failed to create identity for ${ac.icaoHex}: ${err instanceof Error ? err.message : String(err)}`,
            );
            continue;
          }
        } else if (ac.category !== undefined && ac.category !== cached.category) {
          try {
            const identityRecord = buildAircraftIdentityRecord(ac.icaoHex, new Date(), ac.category);
            const result = await putRecord(
              agent,
              "at.adsb.aircraft.identity",
              cached.rkey,
              identityRecord,
            );
            cached = { ref: { uri: result.uri, cid: result.cid }, rkey: cached.rkey, category: ac.category };
            identityCache.set(ac.icaoHex, cached);
            console.log(`Identity updated: ${ac.icaoHex} category=${ac.category}`);
          } catch (err) {
            console.error(
              `Failed to update identity for ${ac.icaoHex}: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
        }

        // Create and publish flight record with batch strongRef chain (AC2.2, AC2.3, AC3.2)
        const flightRecord = buildFlightRecord(ac, cached.ref, batchRefs, new Date());
        if (flightRecord) {
          try {
            const result = await createRecord(agent, "at.adsb.flight.record", flightRecord);
            console.log(`Flight: ${ac.icaoHex} — ${result.uri}`);
          } catch (err) {
            // Enqueue for retry
            queue.enqueue("at.adsb.flight.record", flightRecord);
            console.error(
              `Failed to publish flight record for ${ac.icaoHex}, enqueued for retry: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
        }

        stats.positionsReported += ac.positionCount;

        if (ac.maxRangeNm != null && ac.maxRangeNm > stats.maxRangeNm) {
          stats.maxRangeNm = ac.maxRangeNm;
        }
      }

      // Update stats accumulator with aircraft seen this update
      for (const ac of msg.aircraft) {
        stats.aircraftSeen.add(ac.icaoHex);
      }

      // Update stats with current max range from live aircraft
      const liveMax = tracker.getCurrentMaxRange();
      if (liveMax > stats.maxRangeNm) {
        stats.maxRangeNm = liveMax;
      }
    } catch (err) {
      console.error(`Aircraft update error: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  // Handle stats from adapter
  const onStats = (sourceId: string, msg: StatsMessage): void => {
    try {
      const existing = protocolStats.get(msg.protocol) ?? {
        messagesReceived: 0,
        positionsDecoded: 0,
      };
      existing.messagesReceived += msg.messagesReceived;
      existing.positionsDecoded += msg.positionsDecoded;
      if (msg.signal) {
        existing.signal = msg.signal;
      }
      protocolStats.set(msg.protocol, existing);
    } catch (err) {
      console.error(`Stats update error: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  // Handle raw capture from adapter
  const onRawCapture = (sourceId: string, msg: RawCaptureMessage): void => {
    try {
      rawCapturePaths.push(msg.filePath);
    } catch (err) {
      console.error(`Raw capture error: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const adapterServer = new AdapterServer(
    { onAircraft, onStats, onRawCapture },
    (msg: string) => console.log(msg),
  );
  await adapterServer.start(config.socketPath);

  // Set up queue drain timer
  const drainTimer = setInterval(async () => {
    await drainQueue(agent, queue);
  }, queueDrainIntervalMs);

  // Set up stats flush timer
  const statsTimer = setInterval(async () => {
    const now = new Date();

    const record = buildStatsRecord(stats, now, now, buildProtocolBreakdown());
    const aircraftSeen = stats.aircraftSeen.size;

    // Reset accumulators immediately so data arriving during the publish
    // below is credited to the next period rather than dropped.
    stats = createStatsAccumulator();
    protocolStats.clear();

    try {
      const result = await createRecord(
        agent,
        "at.adsb.receiver.stats",
        record,
      );
      console.log(
        `Stats: ${aircraftSeen} aircraft — ${result.uri}`,
      );
    } catch (err) {
      // Failed to publish stats, enqueue for retry
      queue.enqueue("at.adsb.receiver.stats", record);
      console.error(
        `Failed to publish stats, enqueued for retry: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }, statsIntervalMs);

  // Set up batch flush timer
  const batchTimer = setInterval(async () => {
    // Capture current window before resetting
    const windowStart = batchState.windowStart;
    const windowEnd = new Date();
    const telemetry = batchState.telemetry;
    const capturedRawPaths = rawCapturePaths;

    // Reset batch for next window
    batchState = createBatchWindow(windowEnd);
    rawCapturePaths = [];

    // Build and publish batch record
    if (Object.keys(telemetry).length === 0) return; // AC1.4: no record for empty windows

    try {
      // Split oversized windows so every telemetry blob and manifest fits
      // the lexicon limits; chunks have disjoint aircraft sets.
      const chunks = chunkTelemetry(telemetry);
      if (chunks.length > 1) {
        console.warn(
          `Batch window split into ${chunks.length} sighting records to stay within blob/manifest limits. Consider reducing BATCH_WINDOW_S.`,
        );
      }

      // Build ATRX blob if raw captures are available and capture is enabled
      let rawCaptureBlobRef: BlobRef | undefined;

      if (config.rawCaptureEnabled && capturedRawPaths.length > 0) {
        try {
          const atrxBlobs: Array<Buffer> = [];
          for (const filePath of capturedRawPaths) {
            try {
              const fileContent = await readFile(filePath);
              const parsed = parseAtrxBlob(fileContent);

              // Re-stamp with correct receiver DID and window timestamps.
              // Use parsed.frames (already decompressed) as the second argument
              // to buildAtrxBlob() to avoid double-compression.
              const restamped = buildAtrxBlob(
                {
                  receiverDid: agent.session!.did,
                  windowStart: windowStart.toISOString(),
                  windowEnd: windowEnd.toISOString(),
                  clockSource: parsed.metadata.clockSource,
                  protocol: parsed.metadata.protocol,
                  demodSoftware: parsed.metadata.demodSoftware,
                  frameCount: parsed.metadata.frameCount,
                },
                parsed.frames,
              );
              atrxBlobs.push(restamped);

              // Delete temp file
              await unlink(filePath);
            } catch (err) {
              console.error(`Failed to process raw capture ${filePath}: ${err instanceof Error ? err.message : String(err)}`);
              // Try to clean up anyway
              try {
                await unlink(filePath);
              } catch {
                // Ignore cleanup errors
              }
            }
          }

          if (atrxBlobs.length > 0) {
            const concatenated = concatAtrxBlobs(atrxBlobs);
            rawCaptureBlobRef = await uploadBlob(
              agent,
              concatenated,
              "application/vnd.at-adsb.raw-capture+zstd",
            );
          }
        } catch (err) {
          console.error(`Raw capture processing error: ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      for (const [chunkIndex, chunk] of chunks.entries()) {
        const blobRef = await uploadBlob(agent, chunk.compressed, "application/zstd");
        const sources = collectSources(chunk.telemetry);
        // The raw capture covers the whole window, so it attaches to the
        // first chunk only.
        const record = buildBatchRecord(
          windowStart,
          windowEnd,
          chunk.telemetry,
          blobRef,
          new Date(),
          sources,
          chunkIndex === 0 ? rawCaptureBlobRef : undefined,
        );
        if (!record) continue;

        try {
          const result = await createRecord(agent, "at.adsb.receiver.sighting", record);
          console.log(`Batch: ${getManifestHexes(chunk.telemetry).length} aircraft — ${result.uri}`);

          // Populate batch index: record this batch ref for all aircraft in manifest
          const batchRef: StrongRef = { uri: result.uri, cid: result.cid };
          for (const hex of getManifestHexes(chunk.telemetry)) {
            const refs = batchIndex.get(hex);
            if (refs) {
              refs.push(batchRef);
            } else {
              batchIndex.set(hex, [batchRef]);
            }
          }
        } catch (err) {
          // Enqueue for retry if createRecord failed (blob and record were successfully built)
          queue.enqueue("at.adsb.receiver.sighting", record);
          console.error(
            `Failed to publish batch, enqueued for retry: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    } catch (err) {
      console.error(
        `Failed to build or upload batch: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }, batchFlushIntervalMs);

  // Graceful shutdown handlers
  let running = true;

  async function flushBatchOnShutdown(): Promise<void> {
    const telemetry = batchState.telemetry;
    if (Object.keys(telemetry).length === 0) {
      return;
    }

    try {
      const windowEnd = new Date();
      for (const chunk of chunkTelemetry(telemetry)) {
        const blobRef = await uploadBlob(agent, chunk.compressed, "application/zstd");
        const sources = collectSources(chunk.telemetry);
        const record = buildBatchRecord(batchState.windowStart, windowEnd, chunk.telemetry, blobRef, new Date(), sources);
        if (!record) {
          continue;
        }

        const result = await createRecord(agent, "at.adsb.receiver.sighting", record);
        console.log(`Final batch published — ${result.uri}`);
      }
    } catch (err) {
      console.error(
        `Failed to publish final batch: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  function shutdown(): void {
    if (!running) return;
    running = false;

    console.log("Shutting down...");
    clearInterval(drainTimer);
    clearInterval(statsTimer);
    clearInterval(batchTimer);

    adapterServer
      .stop()
      .then(() => {
        console.log("AdapterServer stopped.");
      })
      .catch((err) => {
        console.error(
          `AdapterServer stop error: ${err instanceof Error ? err.message : String(err)}`,
        );
      })
      .then(() => broadcaster.stop())
      .then(() => {
        console.log("Stream server stopped.");
      })
      .catch((err) => {
        console.error(
          `Stream server stop error: ${err instanceof Error ? err.message : String(err)}`,
        );
      })
      .then(async () => {
        // Flush partial batch
        await flushBatchOnShutdown();

        // Flush partial stats
        if (stats.aircraftSeen.size > 0) {
          const now = new Date();
          const record = buildStatsRecord(stats, now, now, buildProtocolBreakdown());

          try {
            const result = await createRecord(agent, "at.adsb.receiver.stats", record);
            console.log(`Final stats published — ${result.uri}`);
          } catch (err) {
            console.error(
              `Failed to publish final stats: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
        }
      })
      .finally(() => {
        queue.close();
        process.exit(0);
      });
  }

  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  // Keep alive
  await new Promise(() => {});
}
