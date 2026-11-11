import { shareLink, type ShareAccess, type ShareRecord } from "@scientfactory/scient-cloud/api";
import {
  decodeShareKey,
  encodeShareKey,
  encryptShareObject,
  generateShareKey,
} from "@scientfactory/scient-cloud/share-crypto";
import type { ScientCloudShareBuild, ScopedThreadRef } from "@t3tools/contracts";

import { shareLinkOrigin, type CloudApi } from "./cloudApi";
import { gzipBytes } from "./cloudConversationCodec";

export interface ShareOptions {
  readonly encrypted: boolean;
  readonly access: ShareAccess;
  readonly expiresAt: string | null;
  readonly indexable: boolean;
}

export interface PublishShareInput {
  readonly api: Pick<CloudApi, "createShare" | "putShareObject" | "publishShare" | "updateShare">;
  readonly threadRef: ScopedThreadRef;
  /** The build the person previewed; its `documentJson` is published byte for byte. */
  readonly build: ScientCloudShareBuild;
  readonly title: string;
  readonly options: ShareOptions;
  /** The link being updated, with its key when it is encrypted. */
  readonly existing: { readonly share: ShareRecord; readonly key: string | null } | null;
  /** Reads one attachment the build listed, from the computer that built it. */
  readonly readBlob: (relativeUrl: string) => Promise<Uint8Array>;
}

/**
 * Publishes a previewed share: a new link, or a new version of an existing one. Encrypted shares
 * are sealed here with the link's key before anything leaves the renderer.
 */
export async function publishShare(
  input: PublishShareInput,
): Promise<{ id: string; link: string; key: string | null }> {
  const { api, build, options, existing } = input;
  // A link keeps its encryption: its readers already hold the key, or a card.
  const encrypted = existing?.share.encrypted ?? options.encrypted;
  const keyText = encrypted ? (existing?.key ?? encodeShareKey(generateShareKey())) : null;
  const key = keyText === null ? null : decodeShareKey(keyText);

  // An update applies the chosen access first: new content is never readable under the old,
  // looser rules, and if the change fails nothing new is published.
  if (existing !== null) {
    await api.updateShare(existing.share.id, {
      access: options.access,
      expiresAt: options.expiresAt,
      indexable: !encrypted && options.indexable,
    });
  }
  const id =
    existing?.share.id ??
    (await api.createShare({
      source: { env: input.threadRef.environmentId, thread: input.threadRef.threadId },
      encrypted,
      access: options.access,
      expiresAt: options.expiresAt,
      indexable: !encrypted && options.indexable,
      ...(encrypted ? {} : { card: { title: input.title.slice(0, 300) } }),
    }));
  const version =
    existing === null
      ? 1
      : Math.max(0, ...existing.share.versions.map((entry) => entry.version)) + 1;

  const seal = async (object: string, bytes: Uint8Array) =>
    key === null ? bytes : encryptShareObject(key, { version, object }, bytes);
  const put = async (object: string, bytes: Uint8Array) =>
    api.putShareObject(id, version, object, await seal(object, bytes));

  const encoder = new TextEncoder();
  await put("snapshot", await gzipBytes(encoder.encode(build.documentJson)));
  await put(
    "meta",
    encoder.encode(JSON.stringify({ title: input.title, sharedAt: new Date().toISOString() })),
  );
  for (const blob of build.blobs) {
    await put(`blob-${blob.sha256}`, await input.readBlob(blob.relativeUrl));
  }
  await api.publishShare(id, version);
  return { id, link: shareLink(id, keyText ?? undefined, shareLinkOrigin()), key: keyText };
}
