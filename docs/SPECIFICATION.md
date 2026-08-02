# at-adsb Functional Specification

**Version:** 0.1 (Draft)
**Date:** 2026-05-28

## What Is This?

at-adsb is an open flight tracking network built on the [AT Protocol](https://atproto.com). It lets anyone with an RTL-SDR receiver contribute aircraft surveillance data to a shared, verifiable dataset — and retain a provable stake in that contribution.

Think of it as ADS-B Exchange or adsb.lol, but where every data point traces back to the person who captured it, and where contributors can participate in the value their data creates.

## The Problem

Today's flight tracking platforms work on a familiar bargain: contributors donate receiver data, and platforms monetize it. FlightAware charges $80+ per aircraft profile lookup. ADS-B Exchange built a community-driven alternative, then sold to JETNET. In every case, individual contributors — the people running antennas on their roofs — capture none of the commercial value their data produces.

The data itself is also opaque. There's no way to verify which receiver contributed a given observation, no audit trail linking a commercial data product back to the person who generated it, and no mechanism for contributors to control how their data gets used downstream.

## The Approach

at-adsb addresses this by publishing flight data as verifiable records on the AT Protocol network. Every observation is content-addressed and signed. Every flight record links back to the batch observations that produced it, and every batch links back to the receiver that captured it. This chain is cryptographically verifiable — not by at-adsb's say-so, but by the protocol itself.

This provenance chain is the foundation for everything else: data quality validation, contributor attribution, and eventually, revenue sharing.

## How It Works

### The Receiver

A receiver is a single physical installation: an SDR dongle, an antenna, and a computer running decoder software (readsb, dump1090, etc.). Each receiver is registered as an AT Protocol account and publishes data under its own identity (DID).

One account = one station = one location. A station can listen on multiple frequencies and protocols (1090 MHz ADS-B, 978 MHz UAT, ACARS, VDL2) simultaneously through separate decoder adapters, but it represents a single geographic point.

### Two Data Streams

The receiver produces two distinct streams of data:

```
                                    ┌─────────────────────────────────┐
                                    │        AT Protocol PDS          │
                                    │                                 │
                              ┌────►│  Sighting batches (60s windows) │
                              │     │  Flight records (on departure)  │
 ┌──────────┐   ┌──────────┐ │     │  Aircraft identities            │
 │ SDR/     │──►│ at-adsb  │─┤     │  Telemetry + raw capture blobs  │
 │ Decoder  │   │ Daemon   │ │     │  Station record                 │
 └──────────┘   └──────────┘ │     └─────────────────────────────────┘
                              │
                              │     ┌─────────────────────────────────┐
                              │     │      Broadcast Stream           │
                              └────►│                                 │
                                    │  Real-time aircraft positions   │
                                    │  (WebSocket, ephemeral, signed) │
                                    └─────────────────────────────────┘
```

**The PDS stream** writes durable records to the receiver's AT Protocol repository at regular intervals. Every five minutes, it creates a batch sighting containing a manifest of observed aircraft plus compressed telemetry and (optionally) the raw SDR frames. When an aircraft departs the receiver's coverage, a flight record is created summarizing the entire transit. These records are permanent, content-addressed, and linked by cryptographic references. The PDS is the authoritative dataset — it's what gets reconstructed, queried, and commercially licensed downstream. The value isn't in real-time positions (those are widely available for free) but in the durable, provenance-linked history: aircraft tracking, ownership research, airframe valuations, and fleet analysis.

**The broadcast stream** emits real-time aircraft positions over a WebSocket. This is a high-frequency, ephemeral feed intended primarily for live map displays. It does not write to the PDS. The stream is signed using a key pair published in the station record, so consumers can verify that events originate from the claimed station.

The broadcast stream and the PDS batches carry the same underlying data — the positions emitted in real time are the same positions that get compressed into the telemetry blob at the end of each batch window. An aggregator could cache the broadcast stream and validate it against the PDS by unpacking the telemetry blob and comparing contents, but in practice this is likely unnecessary. The broadcast stream is the live view; the PDS is the record of truth.

### The Provenance Chain

Every piece of data links back to its source:

```
  Flight Record
       │
       ├── references → Aircraft Identity (who was flying)
       │
       └── references → Batch Sighting 1
       │                    │
       │                    ├── telemetry blob (compressed JSON positions)
       │                    └── raw capture blob (original SDR frames)
       │
       └── references → Batch Sighting 2
                            │
                            ├── telemetry blob
                            └── raw capture blob
```

Each arrow is a `strongRef` — a content-addressed pointer containing both the record's URI and its content hash (CID). If the referenced record changes, the hash won't match. This makes the chain tamper-evident by construction, not by policy.

The raw capture blobs are particularly important: they contain the actual radio frames as received from the SDR, before any decoding or interpretation. This allows independent verification that the structured data matches what was actually received over the air.

### Station Privacy

A station's geographic coordinates are published in its record, which creates a tension: location is necessary for data quality (MLAT, range calculations, coverage maps) but also reveals where the operator lives.

The current approach truncates coordinates to two decimal places (~1.1 km precision). This is sufficient for general coverage mapping but insufficient for MLAT, which requires sub-metre precision. Handling MLAT contribution without exposing precise location is an open problem — potential approaches include out-of-band coordinate sharing with trusted aggregators, or differential privacy techniques applied at the aggregation layer.

## Data Model

### Station

One per account. Declares the receiver's existence, location, capabilities, and signing key.

| Field | Description |
|-------|-------------|
| Display name | Human-readable station name |
| Location | Geographic coordinates (truncated for privacy) |
| Status | Active, inactive, or maintenance |
| Hardware | Receiver model, antenna type, software version |
| Protocols | Which signals the station decodes (ADS-B, UAT, MLAT, ACARS, etc.) |
| Signing key | Public key for broadcast stream authentication |

### Sighting Batch

Created every 300 seconds. One per window, regardless of how many aircraft are observed.

| Field | Description |
|-------|-------------|
| Window start/end | Time boundaries of the observation window |
| Manifest | List of ICAO hex codes observed during the window |
| Telemetry | Compressed blob of position reports, keyed by aircraft |
| Sources | Which decoder protocols contributed data |
| Raw capture | Optional blob of original SDR frames (ATRX format) |

The telemetry blob contains the full position history for every aircraft in the manifest: latitude, longitude, altitude, ground speed, heading, vertical rate, timestamps, and decoder source attribution. Positions are stored as strings to preserve decimal precision across the protocol's CBOR encoding.

### Flight Record

Created when an aircraft departs the receiver's coverage area. Summarizes the entire transit.

| Field | Description |
|-------|-------------|
| Aircraft | Reference to the aircraft identity record |
| First/last seen | Time boundaries of the observation |
| Batches | References to all contributing sighting batches |
| Callsign | ATC callsign (if transmitted) |
| Position/message counts | Volume metrics |
| Initial/final state | Altitude, heading, speed, vertical rate at entry and exit |
| Max range | Farthest distance from the receiver |

### Aircraft Identity

One per unique ICAO hex code per account. Created on first observation.

| Field | Description |
|-------|-------------|
| ICAO hex | 24-bit aircraft address (e.g., `A0B1C2`) |
| Registration | Tail number (if known) |
| Type | Aircraft type designator (e.g., `B738`) |
| Operator | Airline or operator name |
| Category | ADS-B emitter category |

### Broadcast Message

Ephemeral. Emitted in real time over WebSocket. Not persisted.

| Field | Description |
|-------|-------------|
| ICAO hex | Aircraft identifier |
| Position | Current lat/lon/altitude |
| Speed/heading | Current ground speed and track |
| Signal strength | RSSI in dBFS |
| Callsign, squawk | If available |

## Architecture

### Adapter Model

The daemon doesn't talk to decoders directly. Instead, each decoder type has its own adapter process that translates decoder-specific output into a normalized message format and sends it to the daemon over a Unix domain socket.

```
  ┌──────────────────┐
  │ readsb (1090MHz) │──► readsb adapter ──┐
  └──────────────────┘                     │
                                           ▼
  ┌──────────────────┐              ┌─────────────┐
  │ dump978 (UAT)    │──► UAT      │             │
  └──────────────────┘    adapter ─►│  at-adsb    │──► PDS + Broadcast
                                    │  daemon     │
  ┌──────────────────┐              │             │
  │ dumpvdl2 (VDL2)  │──► VDL2    │             │
  └──────────────────┘    adapter ─►└─────────────┘
```

This separation means:
- New decoder types can be supported by writing a new adapter, not modifying the daemon
- Each adapter handles the quirks of its decoder independently
- Multiple decoders can feed a single station simultaneously
- The daemon sees a uniform stream of aircraft observations regardless of source

Each observation carries a `source` field identifying which decoder protocol produced it (e.g., `adsb_icao`, `mlat`, `tisb_icao`, `uat`). This source attribution flows through the entire chain — from individual positions in the telemetry blob, through the sighting batch's source list, all the way to downstream consumers.

### Durability

Failed writes to the PDS are queued in a local SQLite database and retried with exponential backoff. This handles transient network issues, PDS rate limits, and brief outages without data loss. The queue is persistent across daemon restarts.

### Stream Authentication

The broadcast stream is signed using a secp256k1 key pair. The public key is published in the station record as a `did:key`. Consumers of the broadcast stream can verify that events originate from the station they claim to, independent of any transport-layer authentication.

When the signing key needs to be rotated, the station publishes a `KeyRotated` info frame on the stream and updates the public key in its station record. Consumers re-validate using the new key.

## What Exists Today

The receiver side of the system is implemented and functional:

- Station registration and identity management
- Daemon with batch windowing, aircraft tracking, and departure detection
- Sighting batch publication with compressed telemetry blobs
- Flight record creation with full provenance chain (strongRef links)
- Aircraft identity caching (SQLite-backed, survives restarts)
- Raw SDR frame capture in ATRX envelope format
- Real-time broadcast stream (WebSocket, XRPC-compliant)
- Adapter architecture with readsb adapter implemented
- Durable publish queue with exponential backoff
- CLI for station registration and daemon operation

## What Doesn't Exist Yet

### Aggregator

The critical missing piece. An aggregator would:

1. Consume PDS records from multiple receiver accounts (the authoritative data source)
2. Correlate observations of the same aircraft from different stations
3. Synthesize a unified flight track from multiple perspectives
4. Build the composite database that downstream consumers query
5. Optionally subscribe to broadcast streams for a real-time map layer

The aggregator's primary data source is the PDS, not the broadcast stream. Receiver repositories contain the content-addressed, provenance-linked records that can be independently verified — that's the dataset with commercial value. The broadcast stream may feed a live map view, but the durable database is reconstructed from PDS records, where backlinks work and every observation is traceable to its contributor.

The aggregator is where multi-receiver flight synthesis happens — merging overlapping observations, resolving conflicts between receivers, and producing the canonical view of a flight that draws from all available sources.

### Contributor Attribution and Value Chain

The provenance chain makes it possible to trace any data point back to its contributor. The open question is how to translate that into a value-sharing mechanism.

Consider the scenario: three receivers around Logan Airport all observe the same departure. The aggregated flight track draws from all three. If that aggregated data is later sold as part of a commercial product, how should revenue be allocated?

Potential approaches:
- **Proximity-weighted**: the station closest to the aircraft at each point in time gets the largest share for that segment
- **Accuracy-weighted**: the station providing the highest-quality data (best signal, most positions, highest integrity) gets priority
- **Equal share**: all contributing stations split evenly
- **Exclusive windows**: each station "owns" the portions of the track where it was the sole observer

This is fundamentally a business model question, not a technical one. The technical infrastructure (provenance chain, source attribution, contributor tracking) is designed to support any of these approaches.

### Two-Way Authorization

Current AT Protocol patterns are largely one-directional: a user opts into a labeler or grants an app read/write access. at-adsb needs something closer to a bilateral agreement: a contributor authorizes a specific aggregator to use and monetize their data, and the aggregator commits to the terms of that arrangement.

This likely involves:
- A handshake mechanism where contributors explicitly authorize specific aggregators
- Terms encoded in a way that both parties can reference
- Key exchange for any data that shouldn't be publicly readable
- A revocation mechanism if the relationship ends

The exact form this takes is TBD — it may involve existing AT Protocol OAuth flows, a custom lexicon for authorization records, or an out-of-band agreement system.

### Additional Decoder Support

The adapter architecture is designed for multiple decoders but currently only the readsb adapter is implemented. Future adapters:
- **UAT (978 MHz)**: dump978 adapter for US-specific traffic
- **ACARS/VDL2/HFDL**: datalink message capture (lexicon defined, adapter not built)
- **MLAT**: multilateration data (requires solving the coordinate privacy problem)

### Raw Stream Broadcasting

The current broadcast stream emits structured JSON derived from decoder output. An alternative approach would broadcast raw BEAST-format data directly from the SDR, with decoding happening at the aggregator level. This would provide:
- True real-time data (no decoder processing delay)
- Protocol-agnostic transport (aggregator handles decoding)
- Reduced computational load on the receiver

The tradeoff is increased bandwidth and processing requirements at the aggregator. This is a technical decision that depends on how the aggregator architecture evolves.

## Design Principles

**Provenance over convenience.** Every design decision favours traceability. Data that can't be attributed to a source isn't useful for the value chain, regardless of how convenient it might be to work with.

**AT Protocol native.** The system uses AT Protocol conventions, libraries, and patterns wherever possible. Records live in PDS repositories. Identity is DID-based. References use strongRef. The broadcast stream follows XRPC conventions even though it's ephemeral.

**Graceful degradation.** Raw capture is optional. Broadcast streams are ephemeral. The publish queue absorbs transient failures. A receiver with intermittent connectivity still produces useful, verifiable data — it just produces less of it.

**Contributor sovereignty.** The long-term architecture assumes contributors control their data. They choose which aggregators to authorize. They can revoke access. Their contribution is independently verifiable regardless of what any aggregator claims.

## Glossary

| Term | Meaning |
|------|---------|
| **ADS-B** | Automatic Dependent Surveillance-Broadcast. Aircraft self-report position via 1090 MHz transponder. |
| **UAT** | Universal Access Transceiver. US-specific ADS-B on 978 MHz for aircraft below 18,000 ft. |
| **MLAT** | Multilateration. Triangulates aircraft position from the time difference of signal arrival at multiple receivers. |
| **BEAST** | Binary format for raw Mode S messages as received from the SDR. |
| **ICAO hex** | 24-bit aircraft address assigned by national aviation authority. Uniquely identifies an airframe. |
| **Squawk** | Four-digit transponder code assigned by ATC for identification. |
| **readsb** | Open-source ADS-B decoder commonly used with RTL-SDR receivers. |
| **PDS** | Personal Data Server. AT Protocol's per-user data repository. |
| **DID** | Decentralized Identifier. AT Protocol's identity primitive. |
| **strongRef** | Content-addressed reference (URI + CID hash) that links AT Protocol records immutably. |
| **XRPC** | AT Protocol's RPC framework. Used here for the WebSocket broadcast endpoint. |
| **ATRX** | at-adsb's envelope format for raw SDR frame captures with CBOR metadata. |
| **RTL-SDR** | Low-cost software-defined radio receiver (~$30) commonly used for ADS-B reception. |
