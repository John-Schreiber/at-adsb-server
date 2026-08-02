# Stream Signature Verification Spec

## Overview

Event frames on `at.adsb.broadcast.subscribeEvents` may carry a `sig` field containing a 64-byte compact secp256k1 signature. This document specifies how consumers verify that signature.

## Wire Format

Frames arrive as DAG-CBOR over WebSocket (AT Protocol subscription wire format):

```
[header: {op: 1, t: "#event"}] [body: {seq, station, time, ops, sig?}]
```

The XRPC server strips `$type` from the body and encodes it as the `t` field in the header. The `sig` field (when present) is a 64-byte `Uint8Array` encoded as CBOR bytes (major type 2).

## Verification Algorithm

Given a received event frame body and the station's `streamSigningKey` (a `did:key:z...` string from the `at.adsb.receiver.station` record):

### Step 1: Extract signature

```typescript
const { sig, ...frameWithoutSig } = receivedBody;
```

If `sig` is absent, the frame is unsigned. Skip verification.

### Step 2: Reconstruct the signed payload

The signer encodes the frame **with `$type` and without `sig`**. The XRPC wire format strips `$type`, so you must re-add it:

```typescript
const payload = {
  $type: "at.adsb.broadcast.subscribeEvents#event",
  ...frameWithoutSig,
};
```

### Step 3: DAG-CBOR encode

Encode the reconstructed payload using `@ipld/dag-cbor`:

```typescript
import { encode } from "@ipld/dag-cbor";

const msgBytes = encode(payload);
```

DAG-CBOR produces deterministic output (keys sorted by length then lexicographically). Field insertion order in your object does not matter.

### Step 4: Verify

```typescript
import { verifySignature } from "@atproto/crypto";

const valid = await verifySignature(
  stationStreamSigningKey, // did:key:z... from station record
  msgBytes,
  sig,
);
```

`verifySignature` handles did:key parsing, multicodec prefix extraction, and low-S signature normalization internally.

## Complete Example

```typescript
import { encode } from "@ipld/dag-cbor";
import { verifySignature } from "@atproto/crypto";

async function verifyEventFrame(
  body: Record<string, unknown>,
  streamSigningKey: string,
): Promise<boolean> {
  const sig = body.sig;
  if (!(sig instanceof Uint8Array)) return false;

  const { sig: _, ...frameWithoutSig } = body;
  const payload = {
    $type: "at.adsb.broadcast.subscribeEvents#event",
    ...frameWithoutSig,
  };
  const msgBytes = encode(payload);
  return verifySignature(streamSigningKey, msgBytes, sig);
}
```

## Obtaining the Station's Signing Key

Fetch the station record via `com.atproto.repo.getRecord`:

```
GET /xrpc/com.atproto.repo.getRecord?repo=<did>&collection=at.adsb.receiver.station&rkey=self
```

The `streamSigningKey` field contains the `did:key:z...` string. Cache this value and refresh it when you receive a `KeyRotated` info frame.

## Key Rotation

When the daemon restarts with a new signing key, it emits a `KeyRotated` info frame before signing any event frames with the new key:

```
header: {op: 1, t: "#info"}
body: {name: "KeyRotated", message: "Stream signing key rotated."}
```

On receiving `KeyRotated`:
1. Re-fetch the station record to get the new `streamSigningKey`
2. Use the new key for all subsequent frame verification
3. Frames received before the `KeyRotated` info frame were signed with the old key (ephemeral, no replay)

## Common Pitfalls

| Mistake | Consequence | Fix |
|---------|-------------|-----|
| Forgetting to re-add `$type` before encoding | Verification always fails | Prepend `$type: "at.adsb.broadcast.subscribeEvents#event"` to payload |
| Using `@atproto/lex-cbor` instead of `@ipld/dag-cbor` | May work today but not guaranteed | Always use `@ipld/dag-cbor` for verification encoding |
| Using noble-secp256k1 / elliptic directly | Must handle low-S normalization and did:key multicodec parsing manually | Use `@atproto/crypto` `verifySignature` |
| Including `sig` in the encoded payload | Verification always fails | Strip `sig` before encoding |
| Using JSON encoding instead of DAG-CBOR | Verification always fails | Must use DAG-CBOR (`@ipld/dag-cbor`) |
| Not handling `Uint8Array` from CBOR decode | `sig` may appear as indexed object in JSON | Ensure your CBOR decoder produces `Uint8Array` for bytes |

## Signature Properties

- **Algorithm:** ECDSA over secp256k1 (ES256K)
- **Signature format:** 64-byte compact (r || s), low-S normalized
- **Key encoding:** did:key with multicodec prefix `0xe7` (secp256k1-pub)
- **Payload encoding:** DAG-CBOR (deterministic, sorted keys)
- **Scope:** Only `#event` frames are signed. `#info` and `#identity` frames never carry `sig`.

## Dependencies

For TypeScript/JavaScript consumers:

```json
{
  "@ipld/dag-cbor": "^9.0.0",
  "@atproto/crypto": "^0.5.0"
}
```

For other languages, you need:
- A DAG-CBOR encoder that produces deterministic output (RFC 8949 §4.2 + DAG-CBOR sort order)
- secp256k1 ECDSA verification with low-S enforcement
- did:key parsing per the did:key spec (multicodec + multibase)
