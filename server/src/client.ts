// pattern: Imperative Shell

import { AtpAgent, XRPCError, type BlobRef } from "@atproto/api";

export type Credentials = {
  readonly service: string;
  readonly identifier: string;
  readonly password: string;
};

export async function createAgent(creds: Credentials): Promise<AtpAgent> {
  const agent = new AtpAgent({ service: creds.service });
  await agent.login({
    identifier: creds.identifier,
    password: creds.password,
  });
  return agent;
}

export async function putRecord(
  agent: AtpAgent,
  collection: string,
  rkey: string,
  record: Record<string, unknown>,
): Promise<{ uri: string; cid: string }> {
  const repo = agent.session?.did;
  if (!repo) throw new Error("Not logged in.");

  const res = await agent.com.atproto.repo.putRecord({
    repo,
    collection,
    rkey,
    record: { $type: collection, ...record },
  });
  return { uri: res.data.uri, cid: res.data.cid };
}

export async function createRecord(
  agent: AtpAgent,
  collection: string,
  record: Record<string, unknown>,
): Promise<{ uri: string; cid: string }> {
  const repo = agent.session?.did;
  if (!repo) throw new Error("Not logged in.");

  const res = await agent.com.atproto.repo.createRecord({
    repo,
    collection,
    record: { $type: collection, ...record },
  });
  return { uri: res.data.uri, cid: res.data.cid };
}

export async function uploadBlob(
  agent: AtpAgent,
  data: Uint8Array,
  mimeType: string,
): Promise<BlobRef> {
  const res = await agent.com.atproto.repo.uploadBlob(data, {
    encoding: mimeType,
  });
  return res.data.blob;
}

export type FetchedStationRecord = {
  readonly uri: string;
  readonly cid: string | null;
  readonly value: unknown;
};

export async function getRecord(
  agent: AtpAgent,
  collection: string,
  rkey: string,
): Promise<FetchedStationRecord | null> {
  const repo = agent.session?.did;
  if (!repo) throw new Error("Not logged in.");

  try {
    const res = await agent.com.atproto.repo.getRecord({
      repo,
      collection,
      rkey,
    });
    return {
      uri: res.data.uri,
      cid: res.data.cid ?? null,
      value: res.data.value,
    };
  } catch (error) {
    // ATP returns 400 for missing records with RecordNotFound error
    if (error instanceof XRPCError && error.error === 'RecordNotFound') {
      return null;
    }
    throw error;
  }
}
