// pattern: Functional Core (generateSigningKey uses CSPRNG — sole impurity)

import {Secp256k1Keypair} from '@atproto/crypto';

export async function importSigningKey(hexKey: string): Promise<Secp256k1Keypair> {
  if (!hexKey || !/^[0-9a-fA-F]{64}$/.test(hexKey)) {
    throw new Error('invalid signing key: expected 64-character hex string');
  }
  return Secp256k1Keypair.import(hexKey, {exportable: true});
}

export async function generateSigningKey(): Promise<Secp256k1Keypair> {
  return Secp256k1Keypair.create({exportable: true});
}

export function getSigningKeyDid(keypair: Secp256k1Keypair): string {
  return keypair.did();
}

export async function exportSigningKeyHex(keypair: Secp256k1Keypair): Promise<string> {
  const bytes = await keypair.export();
  return Buffer.from(bytes).toString('hex');
}
