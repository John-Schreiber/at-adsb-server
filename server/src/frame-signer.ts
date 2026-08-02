// pattern: Functional Core (async crypto — deterministic on inputs, no I/O side effects)

import { encode } from '@ipld/dag-cbor';
import type { Secp256k1Keypair } from '@atproto/crypto';
import type { EventMessage } from './stream.js';

export async function signEventFrame(
  frame: EventMessage,
  keypair: Secp256k1Keypair,
): Promise<EventMessage> {
  const { sig: _, ...frameWithoutSig } = frame;
  const encoded = encode(frameWithoutSig);
  const signature = await keypair.sign(encoded);
  return { ...frame, sig: signature };
}
