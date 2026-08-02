export type DaemonConfig = {
  readonly atpService: string;
  readonly atpHandle: string;
  readonly atpPassword: string;
  readonly receiverLat: number;
  readonly receiverLon: number;
  readonly statsIntervalM: number;
  readonly queueDbPath: string;
  readonly wsPort: number;
  readonly batchWindowS: number;
  readonly socketPath: string;
  readonly atrxTempDir: string;
  readonly rawCaptureEnabled: boolean;
  readonly streamSigningKeyHex?: string;
  readonly streamEndpoint?: string;
};

/**
 * Constructs a DaemonConfig from explicit inputs.
 * Env-only config reads centralized in buildDaemonConfig; commander-option-backed
 * values (SOCKET_PATH, ATRX_TEMP_DIR) resolved in cli.ts and passed as params.
 */
export function buildDaemonConfig(params: {
  service: string;
  identifier: string;
  password: string;
  receiverLat: number;
  receiverLon: number;
  socketPath: string;
  atrxTempDir: string;
  env: Record<string, string | undefined>;
}): DaemonConfig {
  const statsIntervalM = parseInt(params.env["STATS_INTERVAL_M"] ?? "60", 10);
  const batchWindowS = Number(params.env["BATCH_WINDOW_S"] ?? "300");
  if (!Number.isFinite(batchWindowS) || batchWindowS < 15 || batchWindowS > 600) {
    throw new Error("BATCH_WINDOW_S must be between 15 and 600");
  }
  return {
    atpService: params.service,
    atpHandle: params.identifier,
    atpPassword: params.password,
    receiverLat: params.receiverLat,
    receiverLon: params.receiverLon,
    statsIntervalM,
    queueDbPath: params.env["QUEUE_DB_PATH"] ?? "./at-adsb-queue.db",
    wsPort: parseInt(params.env["WS_PORT"] ?? "4100", 10),
    batchWindowS,
    socketPath: params.socketPath,
    atrxTempDir: params.atrxTempDir,
    rawCaptureEnabled: params.env["RAW_CAPTURE_ENABLED"] !== "false",
    streamSigningKeyHex: params.env["STREAM_SIGNING_KEY_HEX"],
    streamEndpoint: params.env["STREAM_ENDPOINT"],
  };
}
