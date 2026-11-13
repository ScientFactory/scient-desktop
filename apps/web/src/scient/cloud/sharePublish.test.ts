import { decodeShareKey, decryptShareObject } from "@scientfactory/scient-cloud/share-crypto";
import { ShareRecord } from "@scientfactory/scient-cloud/api";
import { EnvironmentId, ThreadId, type ScientCloudShareBuild } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { fixtureConversation } from "./cloudConversation.test-fixtures";
import { publishShare } from "./sharePublish";

const SHARE_ID = "AAAAAAAAAAAAAAAAAAAAAA";
const decodeShareRecord = Schema.decodeUnknownSync(ShareRecord);

async function gunzip(bytes: Uint8Array) {
  const stream = new Blob([Uint8Array.from(bytes)])
    .stream()
    .pipeThrough(new DecompressionStream("gzip"));
  return new TextDecoder().decode(await new Response(stream).arrayBuffer());
}

function fakeApi() {
  const objects = new Map<string, Uint8Array>();
  const published: number[] = [];
  return {
    objects,
    published,
    api: {
      createShare: async () => SHARE_ID,
      putShareObject: async (_id: string, version: number, object: string, bytes: Uint8Array) => {
        objects.set(`${version}/${object}`, bytes);
      },
      publishShare: async (_id: string, version: number) => {
        published.push(version);
      },
      updateShare: async () => {
        throw new Error("not called for a new link");
      },
    },
  };
}

// The preview shows this text; Publish must not re-serialize it.
const documentJson = `${JSON.stringify(fixtureConversation, null, 1)}\n`;
const build: ScientCloudShareBuild = {
  documentJson,
  contentDigest: fixtureConversation.snapshot.contentDigest,
  redactions: [],
  kept: [],
  coverage: { savedSecretsSearched: 0, binaryAttachmentsNotSearched: 0 },
  blobs: [
    {
      localId: "attachment-1",
      sha256: "a".repeat(64),
      bytes: 3,
      name: "decay.png",
      mimeType: "image/png",
      relativeUrl: "/attachments/1",
    },
  ],
};

describe("publishShare", () => {
  it("publishes exactly the previewed document, sealed with the key in the link", async () => {
    const { api, objects, published } = fakeApi();
    const result = await publishShare({
      api,
      threadRef: {
        environmentId: EnvironmentId.make("env-1"),
        threadId: ThreadId.make("thread-1"),
      },
      build,
      title: "Fit the decay model",
      options: { encrypted: true, access: { mode: "link" }, expiresAt: null, indexable: false },
      existing: null,
      readBlob: async () => Uint8Array.of(1, 2, 3),
    });

    expect(published).toEqual([1]);
    const fragment = new URL(result.link).hash;
    expect(fragment.length).toBeGreaterThan(1);
    const key = decodeShareKey(fragment);
    const snapshot = await decryptShareObject(
      key,
      { version: 1, object: "snapshot" },
      objects.get("1/snapshot")!,
    );
    expect(await gunzip(snapshot)).toBe(documentJson);
    const blob = await decryptShareObject(
      key,
      { version: 1, object: `blob-${"a".repeat(64)}` },
      objects.get(`1/blob-${"a".repeat(64)}`)!,
    );
    expect([...blob]).toEqual([1, 2, 3]);
  });
});

describe("publishShare update", () => {
  const share = decodeShareRecord({
    id: SHARE_ID,
    source: { env: "env-1", thread: "thread-1" },
    encrypted: false,
    access: { mode: "link" },
    expiresAt: null,
    indexable: false,
    createdAt: "2026-11-10T00:00:00.000Z",
    currentVersion: 1,
    versions: [{ version: 1, publishedAt: "2026-11-10T00:00:00.000Z" }],
  });

  function update(api: Parameters<typeof publishShare>[0]["api"]) {
    return publishShare({
      api,
      threadRef: {
        environmentId: EnvironmentId.make("env-1"),
        threadId: ThreadId.make("thread-1"),
      },
      build: { ...build, blobs: [] },
      title: "Fit the decay model",
      options: { encrypted: false, access: { mode: "me" }, expiresAt: null, indexable: false },
      existing: { share, key: null },
      readBlob: async () => new Uint8Array(),
    });
  }

  it("applies the new access before the new version can be read", async () => {
    const calls: string[] = [];
    await update({
      createShare: async () => SHARE_ID,
      putShareObject: async (_id, version, object) => void calls.push(`put ${version}/${object}`),
      publishShare: async (_id, version) => void calls.push(`publish ${version}`),
      updateShare: async (_id, patch) => {
        calls.push(`access ${patch.access?.mode}`);
        return share;
      },
    });
    expect(calls).toEqual(["access me", "put 2/snapshot", "put 2/meta", "publish 2"]);
  });

  it("publishes nothing when the access change fails", async () => {
    const calls: string[] = [];
    await expect(
      update({
        createShare: async () => SHARE_ID,
        putShareObject: async (_id, version, object) => void calls.push(`put ${version}/${object}`),
        publishShare: async (_id, version) => void calls.push(`publish ${version}`),
        updateShare: async () => {
          throw new Error("offline");
        },
      }),
    ).rejects.toThrow("offline");
    expect(calls).toEqual([]);
  });
});
