# Manual E2E Testing

## Prerequisites

- A running readsb-protobuf instance with HTTP API enabled
- An AT Protocol account (e.g., on bsky.social)
- An app password for the account

## Setup

1. Copy `.env.example` to `.env` and fill in values
2. Run `npm run build`

## Test: Register Station

```bash
npm start -- register \
  --name "Test Station" \
  --lat 38.8977 --lon -77.0365 \
  --receiver "RTL-SDR V4" \
  --antenna "1090MHz ADS-B" \
  --software "readsb" \
  --protocols "adsb"
```

Verify: Station record appears in your PDS repository.

## Test: Run Daemon

```bash
npm start -- run
```

Verify:
- Daemon connects and starts polling
- Aircraft sightings are published when aircraft depart
- Stats are published after the configured interval
- Sighting records include track blobs (check PDS)
- Ctrl+C triggers graceful shutdown with stats flush

## Test: Queue Retry

1. Start daemon with invalid ATP_PASSWORD to force publish failures
2. Verify records are queued (check sqlite database)
3. Fix ATP_PASSWORD and restart
4. Verify queued records are published on retry
