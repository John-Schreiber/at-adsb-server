# ATRX Raw Capture Blob: Verification Path Specification

**Document version:** 1.0
**Date:** 2026-05-25
**Scope:** Raw capture blob verification algorithm and tolerance thresholds for aggregators and auditors

## Overview

An aggregator or auditor can verify the integrity of a raw capture blob (ATRX) by independently decoding the frame payload and comparing derived positions against the telemetry blob stored in the same batch sighting. This document specifies the step-by-step algorithm, expected sources of divergence, tolerance thresholds, and integration points for downstream use.

Verification is **optional** — batch sightings without `rawCapture` remain valid. Verification is performed at the aggregator layer, not on individual receivers. The verifier uses their own decoder implementation, making the verification independent of the receiver's decoder version.

## Verification Algorithm

### Step 0: Precondition Check

Before starting verification, confirm:
1. Batch sighting record exists and is accessible on the PDS
2. Batch contains both `rawCapture` blob (ATRX envelope) and `telemetry` blob (zstd-compressed JSON)
3. Both blobs are downloadable (check blob links are valid)

If either blob is missing, skip verification.

### Step 1: Parse ATRX Header and Metadata (No Decompression)

Download the `rawCapture` blob bytes. Parse without decompressing the frame payload:

1. Read the first 8 bytes (ATRX header):
   - Bytes 0–3: Magic must be `ATRX` (0x41 0x54 0x52 0x58)
   - Byte 4: Version must be `0x01`
   - Byte 5: Flags — bit 0 indicates zstd compression of payload (should be `0x01`)
   - Bytes 6–7: Reserved, must be `0x00 0x00`

2. Read bytes 8–11 as a 4-byte big-endian unsigned integer: this is the CBOR metadata length

3. Read the next N bytes (from offset 12 through `12 + metadataLength - 1`) and decode as CBOR:
   ```
   metadata = DAG-CBOR.decode(bytes[12:12+metadataLength])
   ```

4. Extract and validate required metadata fields:
   - `protocol`: must be `"beast-1090"` or `"uat-978"` (string)
   - `frameCount`: must be a non-negative integer matching the decompressed payload
   - `clockSource`: must be one of `"gps"`, `"ntp"`, or `"system"` (indicates timestamp authority)
   - `demodSoftware`: decoder name and version (e.g., `"readsb/3.14.1"`)
   - `windowStart`, `windowEnd`: ISO-8601 strings for capture window bounds
   - `receiverDid`: DID of the receiver

**Failure mode:** If magic, version, reserved bytes, or CBOR decoding fail, mark the blob as **invalid** (hard failure). Do not proceed.

### Step 2: Decompress Frame Payload

1. Extract the remaining bytes (from offset `12 + metadataLength` to end) as the zstd-compressed payload

2. Decompress using zstd:
   ```
   frames_decompressed = zstd.decompress(compressed_payload)
   ```

3. Store for later use (step 4)

**Failure mode:** If zstd decompression fails, mark the blob as **invalid**.

### Step 3: Validate Frame Count

Count the frames in the decompressed payload:

**For `beast-1090` protocol:**
- Walk the payload byte-by-byte looking for `0x1a` (escape byte)
- If the next byte is also `0x1a`, this is an escaped literal — skip both bytes
- If the next byte is `0x31` (Mode-A/C), `0x32` (Mode-S short), or `0x33` (Mode-S long), count as a frame
- Skip receiver ID frames (`0x1a 0xe3`) without counting
- Return the total frame count

**For `uat-978` protocol:**
- Decode the decompressed payload as UTF-8 text
- Split by newline (`\n`)
- Count non-empty lines that start with `+` or `-`
- Return the total frame count

**Comparison:**
```
if (counted_frames !== metadata.frameCount) {
  mark blob as INVALID with message:
    "frameCount mismatch: metadata declares {metadata.frameCount} frames, "
    "payload contains {counted_frames}"
}
```

**Failure mode:** Frame count mismatch is a hard failure. The blob is invalid (likely corruption or manipulation).

### Step 4: Decode Frames Independently

Use your own decoder implementation (not the receiver's) to parse and decode frames:

**For `beast-1090` protocol:**

Parse BEAST frames from the decompressed payload:
1. Read an escape byte (`0x1a`)
2. Read the type byte (should be `0x31`, `0x32`, or `0x33`)
3. Read 6 bytes: MLAT timestamp (12 MHz clock, big-endian)
4. Read 1 byte: signal level (RSSI)
5. Read message bytes (2 for Mode-A/C, 7 for Mode-S short, 14 for Mode-S long)
   - Handle escaped `0x1a 0x1a` sequences by treating as a single `0x1a` byte
6. Decode the message payload as Mode S Extended Squitter (DF17/DF18)
   - Extract position (ODD/EVEN CPR frames require both for a fix)
   - Extract velocity (if available in the message type)
   - Extract altitude (barometric pressure altitude)
   - Extract ICAO hex code (6-byte transponder address)

**For `uat-978` protocol:**

Parse AVR lines from the decompressed text:
1. For each non-empty line starting with `+` or `-`:
   - Direction: `+` = uplink, `-` = downlink
   - Extract hex-encoded payload after the prefix and before the `;` (if present)
   - Decode hex to bytes
   - Decode the Reed-Solomon error-corrected payload
   - Extract position (if available in the message type)
   - Extract velocity (if available)
   - Extract altitude
   - Extract aircraft address/ICAO code
2. For timestamp (optional `t=` field after `;`):
   - If present (e.g., `;t=1716652800.123`), parse as Unix epoch with millisecond precision
   - Use as frame capture time for correlation with telemetry

**Important:** If a frame fails to decode, log the error but continue processing other frames. Some frames may be corrupted or not yet known Mode S types — decoder robustness is expected.

### Step 5: Build Per-Aircraft Position Map

Create an in-memory map keyed by ICAO hex code:

```
positions: Map<icao_hex: string, PositionEntry[]> = {
  "ABCDEF": [
    { timestamp: "2026-05-25T14:32:15.123Z", lat: 37.7749, lon: -122.4194, alt_m: 1234, gps: false },
    { timestamp: "2026-05-25T14:32:16.456Z", lat: 37.7750, lon: -122.4193, alt_m: 1235, gps: false },
    ...
  ],
  "123456": [ ... ],
  ...
}
```

For each position derived:
- **timestamp**: absolute wall-clock time of the position fix (from MLAT or `t=` field, or derived from window bounds + frame ordering)
- **lat, lon**: decimal degrees (WGS-84)
- **alt_m**: altitude in meters (or `null` if unavailable)
- **gps**: boolean indicating whether altitude is GPS-derived (geometric) or barometric pressure

Use ICAO hex codes in uppercase.

### Step 6: Decompress Telemetry Blob

Download and decompress the `telemetry` blob from the same batch record:

```
telemetry_compressed = download_blob(batch.telemetry)
telemetry_json = zstd.decompress(telemetry_compressed)
telemetry_map = JSON.parse(telemetry_json)  // keyed by ICAO hex -> position arrays
```

The telemetry structure is:
```json
{
  "ABCDEF": [
    { "ts": "2026-05-25T14:32:15.123Z", "lat": 37.7749, "lon": -122.4194, "alt": 1234 },
    { "ts": "2026-05-25T14:32:16.456Z", "lat": 37.7750, "lon": -122.4193, "alt": 1235 },
    ...
  ],
  "123456": [ ... ],
  ...
}
```

**Failure mode:** If telemetry blob is corrupted or unparseable, mark as **invalid**.

### Step 7: Compare Per-Aircraft Positions

For each aircraft in the independently-derived position map:

1. Look up the same ICAO hex in the telemetry map
2. For each derived position, find the closest timestamp match in telemetry (within a 1-second window)
3. If a match exists, compare:
   - **Position**: Euclidean distance in degrees (lat/lon) ≤ 0.01 degrees (~1.1 km)
   - **Altitude**: Difference ≤ 100 feet (~30 meters)
4. Record matches and mismatches

For aircraft in the derived map but **not** in telemetry:
- This may indicate the receiver filtered out late-arriving or low-confidence positions
- Not necessarily invalid — flag for investigation

For aircraft in telemetry but **not** in the derived map:
- Indicates frames were missing from the raw capture or decoding failed
- Suggests incomplete or corrupted blob — flag for investigation

### Step 8: Determine Verification Outcome

Classify the result as one of:

**✓ Verified:**
- Frame count matches metadata exactly
- All ATRX header/metadata parse correctly
- At least 80% of telemetry positions have matching derived positions within tolerance
- No hard failures in frame decoding or decompression

**⚠ Flagged:**
- Frame count matches, parsing succeeds, but discrepancies exceed tolerance
- Examples:
  - 5+ position pairs exceed distance tolerance by >0.02 degrees
  - Altitude differences >200 feet on multiple positions
  - Significant portion of telemetry aircraft missing from decoded frames
- **Action:** Investigate — could indicate decoder version difference, CPR ambiguity, or frame loss

**✗ Invalid (Hard Failure):**
- Magic bytes or version mismatch
- Frame count mismatch (metadata says N, payload has M ≠ N)
- Reserved bytes non-zero
- Zstd decompression fails
- CBOR metadata parsing fails
- **Action:** Do not trust this blob for provenance chain

## Expected Sources of Divergence (AC5.3)

Small discrepancies between independently-derived positions and telemetry are normal and expected. Do not invalidate blobs over minor differences.

### 1. Decoder Version Differences

Receivers use readsb (various versions); verifiers may use a different readsb build, dump1090, or custom decoder. Decoders may implement slightly different:
- CPR decoding heuristics (global vs. local, zone transitions)
- Barometric altitude sources
- Velocity calculation methods
- Age or confidence filtering of positions

**Tolerance:** Accumulated tolerance is ±0.01 degrees + a decoder-version multiplier. See **Tolerance Thresholds** section.

### 2. CPR (Compact Position Reporting) Ambiguity

ADS-B encodes position across alternating ODD/EVEN frames. Decoders resolve ambiguity by:
- **Global decoding:** Using receiver's own position as reference
- **Local decoding:** Using prior position history
- Different decoders make different choices near zone boundaries (~111 km latitude, ~55 km longitude at equator)

This can produce position fixes 50–100 km apart for the same aircraft briefly (resolved on the next frame pair).

**Tolerance:** 0.5 degrees (~55 km) for single-position divergence; 0.05 degrees (~5 km) for consistent error.

### 3. Altitude Source (Barometric vs. Geometric)

Mode S provides barometric pressure altitude. GPS-equipped aircraft may provide geometric altitude. Decoders choose differently:
- readsb defaults to barometric; ICAO specifies it
- Some decoders prefer geometric (more accurate but less common)

Barometric altitude varies with atmospheric pressure; geometric is more stable. Difference: typically ±500 feet (~150 m) during seasonal pressure changes.

**Tolerance:** ±100 feet for barometric/geometric mismatch is acceptable.

### 4. Timestamp Rounding and Frame Ordering

Frame timestamps come from:
- MLAT clock (12 MHz counter in BEAST, relative timing)
- AVR `t=` field (millisecond precision epoch for UAT)
- Window bounds (coarse estimate if no per-frame timing)

Decoders may round timestamps differently. ATRX preserves frame order (chronological); telemetry may reorder by ICAO hex.

**Tolerance:** ±100 ms for timestamp rounding is acceptable.

### 5. Frame Loss and Late Arrival

Receiver may filter frames:
- Low signal-to-noise (filtered at receiver)
- Age threshold (position too old compared to latest for this aircraft)
- Transmission timeouts during quiet periods

ATRX captures all demodulated frames. Telemetry reflects receiver's filtering logic. Not an error — just explains why some derived positions don't appear in telemetry.

**Tolerance:** Up to 10% of derived frames missing from telemetry is acceptable (frame filtering is normal).

### 6. Message Corruption and Partial Decoding

BEAST frames include RSSI (signal strength) but no FEC. Some frames may be partially corrupted. Decoders apply heuristics:
- Reject frames with RSSI below threshold
- Reject positions that differ too much from neighbors

ATRX includes all frames; telemetry reflects receiver's quality filtering. Not necessarily an error.

**Tolerance:** Up to 5% of derived frames decode to invalid positions (discarded by receiver) is acceptable.

## Tolerance Thresholds

These are **recommended starting points**. Aggregator implementations may refine based on observed data and decoder versions.

| Metric | Threshold | Rationale |
|--------|-----------|-----------|
| **Position (degrees)** | 0.01° (~1.1 km) | CPR decoding variance, decoder differences, rounding |
| **Altitude (feet)** | 100 ft (~30 m) | Barometric/geometric source difference |
| **Speed (knots)** | 5 kts | Rounding, different velocity encoding methods |
| **Timestamp (seconds)** | 1.0 s | Frame ordering, coarse clock sources, window bounds |
| **Missing aircraft (%)** | 10% | Receiver filtering (age, SNR), frame loss |
| **Decoding errors (%)** | 5% | Corrupted frames, unknown message types |

**Application:**

For each position comparison:
```
distance = haversine(lat_derived, lon_derived, lat_telemetry, lon_telemetry)
if (distance <= 0.01 degrees) {
  MATCH
} else if (distance <= 0.05 degrees) {
  FLAGGED (investigate)
} else {
  MISMATCH (counts toward "flagged" outcome)
}

altitude_diff = abs(alt_derived - alt_telemetry)
if (altitude_diff > 100 feet) {
  ALTITUDE MISMATCH
}
```

**Aggregator Refinement:**

As the aggregator processes more blobs, it should track per-receiver decoder signatures:
- Does readsb/3.14.1 consistently produce ±0.005° CPR variance?
- Do different decoders have systematic biases?
- Can we detect manipulation vs. natural decoder variance?

Update thresholds based on empirical analysis.

## Verification Outcomes

### Verified ✓

**Criteria:**
- All hard validations pass (magic, version, frame count, CBOR parse)
- At least 80% of telemetry positions have matching derived positions
- Matching positions satisfy tolerance thresholds
- No evidence of manipulation or corruption

**Use:**
- Increase receiver trust score
- Include in downstream flight analyses
- Safe to include in public summaries of aircraft movement

### Flagged ⚠

**Criteria:**
- All hard validations pass
- But discrepancies exceed tolerance in multiple positions or aircraft
- Examples:
  - 15+ position pairs with distance > 0.01° (but < 0.05°)
  - 3+ aircraft with systematic altitude offset > 150 feet
  - 20%+ of telemetry positions missing from decoded frames
  - Decoder version known to produce this variance

**Use:**
- Log for manual inspection
- Decrease receiver trust score slightly
- Flag the specific aircraft/times in question
- Investigate: ask receiver operator for details

**Not invalid** — this is normal for decoder variance. Accumulate data to refine thresholds.

### Invalid ✗ (Hard Failure)

**Criteria:**
- Magic bytes mismatch
- Frame count mismatch (frame payload has different count than metadata)
- Reserved bytes non-zero
- Decompression fails
- CBOR metadata parsing fails
- Physical impossibility: derived position changes by >100 nm in <1 second

**Use:**
- Reject the blob entirely
- Do not use for provenance chain or flight analysis
- Penalize receiver trust score significantly
- Investigate: likely indicates receiver malfunction, software bug, or intentional manipulation

## Aggregator Integration Notes

### Architecture

Verification runs **on the aggregator**, not on individual receivers:

```
Receiver A (PDS) ──> publishes batch with rawCapture + telemetry
Receiver B (PDS) ──> publishes batch with rawCapture + telemetry
         └─────────────────┬─────────────────┘
                           │
                     Aggregator
                           │
        ┌──────────────────┼──────────────────┐
        │                  │                  │
    Download          Verify each          Cross-reference
    batch A           batch              with other receivers
        │                  │                  │
        └──────────┬───────┴──────────┬───────┘
                   │
          Trust scoring & results
```

The aggregator has access to multiple receivers' sightings for the same aircraft — enabling cross-reference and receiver comparison.

### Verification is Batch-Level

One verification run processes:
- One ATRX blob + one telemetry blob (from the same batch sighting record)
- Result: single outcome (Verified / Flagged / Invalid) per batch

If a receiver publishes 10 batches per hour, the aggregator produces 10 verification outcomes per hour per receiver.

### Trust Scoring

Aggregate per-receiver trust over time:

```
receiver_trust = (verified_batches × 1.0 + flagged_batches × 0.5 + invalid_batches × 0.0) 
                 / total_batches

// Example: 8 verified, 2 flagged, 0 invalid over 10 batches
trust = (8 × 1.0 + 2 × 0.5 + 0 × 0.0) / 10 = 0.9 (90% trustworthy)
```

Use trust score to:
- Weight receiver contributions in aggregated flight tracks
- Flag low-trust receivers for operator investigation
- Seed anomaly detection (sudden drop in trust = possible misconfiguration or attack)

### Storage and Reporting

Store verification results in a queryable database:

```
verification_results(
  batch_uri: string,          // AT-URI of the batch sighting record
  receiver_did: string,       // DID of the receiver
  outcome: enum,              // verified | flagged | invalid
  frames_decoded: integer,    // count of successfully-decoded frames
  positions_compared: integer,// count of position pairs compared
  matches: integer,           // count within tolerance
  mismatches: integer,        // count outside tolerance
  missing_aircraft: integer,  // telemetry aircraft not in raw
  extra_aircraft: integer,    // raw aircraft not in telemetry
  details: json,              // per-aircraft mismatch details
  verified_at: timestamp
)
```

Expose verification results in:
- Per-receiver health dashboard
- Per-aircraft flight summary (which receivers verified the observation?)
- Public trust attestation (aggregator publishes which receivers it trusts)

### Handling Unknown Protocols or Versions

Forward compatibility:

- If `metadata.protocol` is unknown (not `beast-1090` or `uat-978`), mark as **Invalid** with reason: "unknown protocol"
- If `metadata.version` ≠ 0x01, mark as **Invalid** with reason: "unsupported ATRX version"
- Reserved bits set in flags byte → **Invalid**: "forward compatibility violation"

This prevents verifiers from silently accepting future protocol extensions they don't understand.

### Decoder Implementation Notes

When implementing the decoder for verification:

1. **Robustness over accuracy:** Decode as many frames as possible even if some fail. Log failures but continue.

2. **Standard libraries:** Use well-maintained ADS-B/UAT libraries if available:
   - **Python:** `pyModeS`, `dump1090-python`, `ADSBExchange` libraries
   - **Go:** `mode-s`, `readsb-go` variants
   - **Node.js:** `beast-client`, custom parsing

3. **CPR handling:** Implement both global and local CPR decoding; choose based on receiver location. Be aware of zone transitions.

4. **Timestamp correlation:** Match derived positions to telemetry by timestamp (within ±1 second), not by sequence order. Frame order in payload may not match telemetry order.

5. **Logging:** Log decoder errors at INFO level (not WARN) — some frame corruption is normal. Reserve WARN for unexplained systematic errors.

6. **Testing:** Verify your decoder against known BEAST/AVR captures. Compare against readsb output on the same capture.

## Glossary

- **ATRX:** AT Radio eXchange — the binary envelope format for storing raw SDR capture blobs
- **CPR:** Compact Position Reporting — the ADS-B position encoding method using alternating ODD/EVEN frames
- **DAG-CBOR:** Deterministic CBOR (Concise Binary Object Representation) used by AT Protocol for canonical encoding
- **Decoder variance:** Minor differences between decoder implementations (e.g., readsb vs. custom decoder) due to different heuristics
- **Extended Squitter:** Mode S DF17/DF18 message type carrying position, velocity, and identity
- **Frame:** Single radio demodulation output (one BEAST message or one AVR line)
- **MLAT:** 12 MHz hardware clock timestamp in BEAST frames (relative timing, not absolute wall-clock)
- **Mode S:** The transponder interrogation protocol used by ADS-B
- **Provenance chain:** Cryptographic strongRef links from flight records → batch sightings → PDS commit signatures, enabling verification from RF to record
- **UAT:** Universal Access Transceiver — 978 MHz alternative to 1090 MHz ADS-B
- **Verification:** Process of independently decoding an ATRX blob and comparing derived positions against telemetry blob to validate receiver integrity
- **Zstd:** Zstandard compression algorithm (level 3 used in ATRX)

## References

- ATRX Design Plan: `docs/design-plans/2026-05-25-raw-capture-blob.md`
- Provenance Chain Design: `docs/design-plans/2026-05-25-provenance-chain.md`
- ICAO Annex 10: Mode S Address, Altitude and Identity Codes (reference for DF17/DF18)
- readsb Implementation: https://github.com/wiedehopf/readsb (BEAST parser reference)
- dump978 Implementation: https://github.com/flightaware/dump978 (UAT AVR format reference)
- AT Protocol Specification: https://atproto.com (for strongRef and blob link formats)
