// pattern: Mixed (intentional)
// Batch window accumulates positions mutably within a single window for performance.
// buildBatchRecord and getManifestHexes remain pure functional core.

import type { PositionReport } from "./tracker.js";
import type { BlobRef } from "@atproto/api";

export type TelemetryData = Record<string, Array<PositionReport>>;

export function createBatchWindow(windowStart: Date): { telemetry: TelemetryData; windowStart: Date } {
  return {
    windowStart,
    telemetry: {},
  };
}

export function addPosition(
  telemetry: TelemetryData,
  icaoHex: string,
  report: PositionReport,
): void {
  const existing = telemetry[icaoHex];
  if (existing) {
    existing.push(report);
  } else {
    telemetry[icaoHex] = [report];
  }
}

export function buildBatchRecord(
  windowStart: Date,
  windowEnd: Date,
  telemetry: TelemetryData,
  telemetryBlobRef: BlobRef,
  now: Date,
  sources: ReadonlyArray<string>,
  rawCaptureBlobRef?: BlobRef,
): Record<string, unknown> | null {
  const icaoHexes = Object.keys(telemetry);
  if (icaoHexes.length === 0) {
    return null;
  }

  return {
    windowStart: windowStart.toISOString(),
    windowEnd: windowEnd.toISOString(),
    manifest: icaoHexes.map((icaoHex) => ({ icaoHex })),
    telemetry: telemetryBlobRef,
    sources,
    ...(rawCaptureBlobRef != null ? { rawCapture: rawCaptureBlobRef } : {}),
    createdAt: now.toISOString(),
  };
}

export function collectSources(telemetry: TelemetryData): Array<string> {
  const sourceSet = new Set<string>();
  for (const reports of Object.values(telemetry)) {
    for (const report of reports) {
      sourceSet.add(report.source);
    }
  }
  return [...sourceSet].sort();
}

export function getManifestHexes(telemetry: TelemetryData): ReadonlyArray<string> {
  return Object.keys(telemetry);
}
