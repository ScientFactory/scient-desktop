import {
  cloudPaths,
  PublicShareInfo,
  ShareId,
  type CloudConversation,
} from "@scientfactory/scient-cloud/api";
import { decodeShareKey, decryptShareObject } from "@scientfactory/scient-cloud/share-crypto";
import * as Schema from "effect/Schema";

import { decodeCloudConversation } from "../cloudConversationCodec";

const ShareOpenFailure = Schema.Literals([
  "not-found",
  "sign-in",
  "not-shared-with-you",
  "key-missing",
  "key-wrong",
  "unavailable",
]);
export type ShareOpenFailure = typeof ShareOpenFailure.Type;

export class ShareOpenError extends Schema.TaggedError<ShareOpenError>()("ShareOpenError", {
  reason: ShareOpenFailure,
}) {}

const isShareOpenError = Schema.is(ShareOpenError);

export interface ShareAddress {
  readonly shareId: ShareId;
  /** From the link's fragment; never sent anywhere. */
  readonly key: Uint8Array | null;
}

const isShareId = Schema.is(ShareId);

/** Reads `/s/<id>#<key>`. A fragment that is not a key reads as no key. */
export function readShareAddress(pathname: string, hash: string): ShareAddress | null {
  const id = /\/s\/([^/?#]+)\/?$/u.exec(pathname)?.[1];
  if (id === undefined || !isShareId(id)) return null;
  let key: Uint8Array | null = null;
  if (hash.length > 1) {
    try {
      key = decodeShareKey(hash);
    } catch {
      key = new Uint8Array(0);
    }
  }
  return { shareId: id, key };
}

export interface SharedConversation {
  readonly info: PublicShareInfo;
  readonly conversation: CloudConversation;
  readonly loadBlob: (sha256: string) => Promise<Blob>;
}

const decodeInfo = Schema.decodeUnknownSync(PublicShareInfo);

/**
 * Opens a share: its info, then the current version's snapshot, decrypted in the browser when the
 * share is encrypted. `token` is a Clerk session for shares limited to named people or the owner.
 */
export async function openSharedConversation(input: {
  readonly apiOrigin: string;
  readonly address: ShareAddress;
  readonly token?: string | null | undefined;
}): Promise<SharedConversation> {
  const { apiOrigin, address } = input;
  const headers: Record<string, string> = input.token
    ? { authorization: `Bearer ${input.token}` }
    : {};
  const get = async (path: string) => {
    let response: Response;
    try {
      response = await fetch(new URL(path, apiOrigin), {
        headers,
        credentials: "omit",
        referrerPolicy: "no-referrer",
      });
    } catch {
      throw new ShareOpenError({ reason: "unavailable" });
    }
    if (response.status === 404 || response.status === 410)
      throw new ShareOpenError({ reason: "not-found" });
    if (response.status === 401) throw new ShareOpenError({ reason: "sign-in" });
    if (response.status === 403) throw new ShareOpenError({ reason: "not-shared-with-you" });
    if (!response.ok) throw new ShareOpenError({ reason: "unavailable" });
    return response;
  };

  const info = decodeInfo(await (await get(cloudPaths.publicShare(address.shareId))).json());
  const version = info.currentVersion;
  if (info.encrypted && (address.key === null || address.key.length === 0)) {
    throw new ShareOpenError({ reason: address.key === null ? "key-missing" : "key-wrong" });
  }
  const readObject = async (object: string) => {
    const bytes = new Uint8Array(
      await (
        await get(cloudPaths.publicShareObject(address.shareId, version, object))
      ).arrayBuffer(),
    );
    if (!info.encrypted) return bytes;
    try {
      return await decryptShareObject(address.key!, { version, object }, bytes);
    } catch {
      throw new ShareOpenError({ reason: "key-wrong" });
    }
  };

  const conversation = await decodeCloudConversation(await readObject("snapshot")).catch(
    (error: unknown) => {
      if (isShareOpenError(error)) throw error;
      throw new ShareOpenError({ reason: "unavailable" });
    },
  );
  return {
    info,
    conversation,
    loadBlob: async (sha256) => new Blob([Uint8Array.from(await readObject(`blob-${sha256}`))]),
  };
}

export async function reportShare(input: {
  readonly apiOrigin: string;
  readonly shareId: string;
  readonly reason: string;
}): Promise<void> {
  const response = await fetch(
    new URL(cloudPaths.publicShareReport(input.shareId), input.apiOrigin),
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reason: input.reason }),
      credentials: "omit",
      referrerPolicy: "no-referrer",
    },
  );
  if (!response.ok) throw new Error("The report could not be sent.");
}
