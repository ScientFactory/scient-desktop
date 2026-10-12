import { EnvironmentId } from "@t3tools/contracts";
import { projectFileOperationKey } from "@t3tools/client-runtime/state/projects";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
  MarkdownPersistenceRegistry,
  documentKeepsCheckpoint,
  documentReconcileStrategy,
  type MarkdownPersistenceLease,
} from "./markdownPersistenceRegistry";
import type {
  DocumentRenameIntent,
  MetadataFileRenameIntent,
  MetadataFileRenameCheckpoint,
  MarkdownDraftCheckpoint,
  MarkdownDraftCheckpointStore,
} from "./markdownDraftCheckpoint";
import type {
  MarkdownPersistenceTarget,
  MarkdownPersistenceTransport,
} from "./markdownPersistenceTransport";
import {
  registerRenameParticipant,
  renameOpenDocument,
  renameMetadataFile,
  readMetadataRenameIntent,
  type ServerRenameResult,
} from "./renameOpenDocument";

function fixture(extension = "md") {
  const from = {
    environmentId: EnvironmentId.make("rename-env"),
    cwd: "/rename-workspace",
    relativePath: `a.${extension}`,
  };
  const destination = { ...from, relativePath: `b.${extension}` };
  const disk = new Map([
    [from.relativePath, { source: "original source", revision: "original-revision" }],
  ]);
  const records = new Map<string, MarkdownDraftCheckpoint>();
  const controls = {
    failure: null as "quota" | "cas" | "destination" | null,
    lostReply: false,
    connected: true,
    beforeDispatch: null as null | ((intent: DocumentRenameIntent) => void),
    beforeReplace: null as null | (() => Promise<void>),
  };
  const receipts = new Map<string, Extract<ServerRenameResult, { ok: true }>>();
  const connections = new Set<(connected: boolean) => void>();
  const store: MarkdownDraftCheckpointStore = {
    read: async (key) => records.get(key),
    replace: async (key, token, next) => {
      await controls.beforeReplace?.();
      if (controls.failure === "quota") throw new Error("journal quota exhausted");
      if (controls.failure === "cas") return false;
      if (controls.failure === "destination" && key === projectFileOperationKey(destination))
        return false;
      if (records.get(key)?.token !== token) return false;
      if (next) records.set(key, next);
      else records.delete(key);
      return true;
    },
  };
  const createTransport = (target: MarkdownPersistenceTarget): MarkdownPersistenceTransport => ({
    read: async () => {
      const current = disk.get(target.relativePath);
      if (!current) throw new Error("missing source");
      return current;
    },
    readForReview: async () => disk.get(target.relativePath) ?? { missing: true, revision: null },
    write: async (intent) => {
      if (disk.get(target.relativePath)?.revision !== intent.expectedRevision)
        throw new Error("revision conflict");
      const revision = `saved:${intent.source}`;
      disk.set(target.relativePath, { source: intent.source, revision });
      return { revision };
    },
    classifyFailure: () => "terminal",
    project: () => {},
    subscribe: ({ connected }) => {
      connections.add(connected);
      connected(controls.connected);
      return () => {
        connections.delete(connected);
      };
    },
  });
  const registry = () =>
    new MarkdownPersistenceRegistry({
      checkpointStore: store,
      createTransport,
      keepsCheckpoint: documentKeepsCheckpoint,
      reconcile: documentReconcileStrategy,
    });
  const rename = async (
    expectedRevision: string,
    mutationId: string,
    intent: DocumentRenameIntent,
  ): Promise<ServerRenameResult> => {
    controls.beforeDispatch?.(intent);
    const checkpoint = records.get(projectFileOperationKey(intent.from));
    expect(checkpoint?.renameIntent).toEqual(intent);
    expect(expectedRevision).toBe(intent.expectedRevision);
    expect(mutationId).toBe(intent.mutationId);
    let receipt = receipts.get(mutationId);
    if (!receipt) {
      const source = disk.get(intent.from.relativePath);
      if (source?.revision !== expectedRevision || disk.has(intent.destination.relativePath))
        return { ok: false, cause: "revision_conflict" };
      disk.set(intent.destination.relativePath, source);
      disk.delete(intent.from.relativePath);
      receipt = {
        ok: true,
        destinationRelativePath: intent.destination.relativePath,
        revision: source.revision,
      };
      receipts.set(mutationId, receipt);
    }
    if (controls.lostReply) throw new Error("reply lost after rename");
    return receipt;
  };
  const run = (
    lease: MarkdownPersistenceLease,
    overrides: Partial<Parameters<typeof renameOpenDocument>[0]> = {},
  ) =>
    renameOpenDocument({
      lease,
      destination,
      rename,
      follow: () => {},
      followed: async () => true,
      ...overrides,
    });
  const setConnected = (connected: boolean) => {
    controls.connected = connected;
    for (const listener of connections) listener(connected);
  };
  return {
    from,
    destination,
    disk,
    records,
    controls,
    receipts,
    registry,
    run,
    connections,
    setConnected,
  };
}

describe("durable open-document rename", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it.each(["md", "tex"])(
    "commits the frozen %s source and exact namespace identity before dispatch, then follows the acknowledged path",
    async (extension) => {
      const h = fixture(extension);
      const lease = await h.registry().open(h.from, {});
      let admitted: DocumentRenameIntent | undefined;
      h.controls.beforeDispatch = (intent) => {
        admitted = intent;
      };
      expect((await h.run(lease)).kind).toBe("moved");
      expect(admitted).toMatchObject({
        from: h.from,
        destination: h.destination,
        expectedRevision: "original-revision",
        baselineSource: "original source",
        source: "original source",
        draftSource: "original source",
      });
      expect(lease.target).toEqual(h.destination);
      expect(h.disk.get(h.from.relativePath)).toBeUndefined();
      expect(h.disk.get(h.destination.relativePath)).toEqual({
        source: "original source",
        revision: "original-revision",
      });
      expect(lease.change("new source", lease.getSnapshot().editVersion)).toBe(true);
      expect(await lease.flushNow()).toBe(true);
      expect(h.disk.get(h.destination.relativePath)?.source).toBe("new source");
      lease.release();
    },
  );

  it.each(["quota", "cas"] as const)(
    "does not change the namespace when %s prevents durable admission",
    async (failure) => {
      const h = fixture();
      const lease = await h.registry().open(h.from, {});
      h.controls.failure = failure;
      expect((await h.run(lease)).kind).toBe("failed");
      expect(h.disk.get(h.from.relativePath)?.source).toBe("original source");
      expect(h.disk.get(h.destination.relativePath)).toBeUndefined();
      expect(lease.getSnapshot().draftSource).toBe("original source");
      lease.release();
    },
  );

  it("rejects a retired lease while its pre-dispatch CAS was awaiting commitment", async () => {
    const h = fixture();
    const lease = await h.registry().open(h.from, {});
    const entered = Promise.withResolvers<void>();
    const gate = Promise.withResolvers<void>();
    h.controls.beforeReplace = async () => {
      entered.resolve();
      await gate.promise;
    };
    const pending = h.run(lease);
    await entered.promise;
    lease.release();
    gate.resolve();
    expect((await pending).kind).toBe("failed");
    expect(h.disk.get(h.from.relativePath)?.source).toBe("original source");
    expect(h.disk.get(h.destination.relativePath)).toBeUndefined();
  });

  it.each(["md", "tex"])(
    "reconstructs a lost %s rename acknowledgement without changing its ID, source or destination, preserving a newer draft",
    async (extension) => {
      const h = fixture(extension);
      const lease = await h.registry().open(h.from, {});
      h.controls.lostReply = true;
      expect((await h.run(lease)).kind).toBe("attention");
      const original = h.records.get(projectFileOperationKey(h.from))!.renameIntent!;
      expect(lease.target).toEqual(h.from);
      expect(lease.change("newer working source", lease.getSnapshot().editVersion)).toBe(true);
      const checkpoint = lease.beginMove(h.destination)!;
      expect(await checkpoint.preflight()).toBe("empty");
      expect(await checkpoint.admitRename()).toEqual(original);
      checkpoint.finish();
      lease.release();
      const reconstructed = await h.registry().open(h.from, {});
      expect(reconstructed.getRenameIntent()).toEqual(original);
      expect(reconstructed.getSnapshot().draftSource).toBe("newer working source");
      h.controls.lostReply = false;
      h.controls.beforeDispatch = (intent) => {
        expect(intent).toEqual(original);
        expect(h.receipts.get(intent.mutationId)?.revision).toBe("original-revision");
      };
      expect((await h.run(reconstructed)).kind).toBe("moved");
      expect(reconstructed.target).toEqual(h.destination);
      expect(reconstructed.getSnapshot().draftSource).toBe("newer working source");
      reconstructed.release();
    },
  );

  it("keeps the source identity and newer draft after an acknowledged destination CAS fails, then replays the stored receipt without transport", async () => {
    const h = fixture("tex");
    const lease = await h.registry().open(h.from, {});
    h.controls.failure = "destination";
    expect((await h.run(lease)).kind).toBe("attention");
    const original = h.records.get(projectFileOperationKey(h.from))!.renameIntent!;
    expect(original.acknowledgement).toEqual({
      destinationRelativePath: h.destination.relativePath,
      revision: "original-revision",
    });
    expect(lease.target).toEqual(h.from);
    expect(lease.change("new input after CAS failure", lease.getSnapshot().editVersion)).toBe(true);
    h.controls.failure = null;
    const outcome = await h.run(lease, {
      rename: async () => {
        throw new Error("An acknowledged intent must not redispatch");
      },
    });
    expect(outcome.kind).toBe("moved");
    expect(lease.target).toEqual(h.destination);
    expect(lease.getSnapshot().draftSource).toBe("new input after CAS failure");
    lease.release();
  });
  it("preserves transferred newer native source across a disconnected restart after the namespace receipt is acknowledged", async () => {
    const h = fixture("tex");
    const lease = await h.registry().open(h.from, {});
    h.controls.failure = "destination";
    expect((await h.run(lease)).kind).toBe("attention");
    const original = h.records.get(projectFileOperationKey(h.from))!.renameIntent!;
    expect(lease.change("unpublished native source", lease.getSnapshot().editVersion)).toBe(true);
    h.setConnected(false);
    h.controls.failure = null;
    expect((await h.run(lease)).kind).toBe("moved");
    expect(h.disk.get(h.destination.relativePath)?.source).toBe("original source");
    expect(h.records.get(projectFileOperationKey(h.destination))).toMatchObject({
      draftSource: "unpublished native source",
      renameIntent: original,
    });
    lease.release();
    h.connections.clear();
    const reconstructed = await h.registry().open(h.destination, {});
    expect(reconstructed.getSnapshot().draftSource).toBe("unpublished native source");
    expect(reconstructed.getRenameIntent()).toBeNull();
    h.setConnected(true);
    expect(await reconstructed.flushNow()).toBe(true);
    expect(h.disk.get(h.from.relativePath)).toBeUndefined();
    expect(h.disk.get(h.destination.relativePath)?.source).toBe("unpublished native source");
    expect(h.records.get(projectFileOperationKey(h.destination))?.renameIntent).toBeUndefined();
    reconstructed.release();
  });

  it("does not adopt another destination after a lost response", async () => {
    const h = fixture();
    const lease = await h.registry().open(h.from, {});
    h.controls.lostReply = true;
    expect((await h.run(lease)).kind).toBe("attention");
    const original = lease.getRenameIntent();
    expect(
      (await h.run(lease, { destination: { ...h.destination, relativePath: "different.md" } }))
        .kind,
    ).toBe("attention");
    expect(lease.getRenameIntent()).toEqual(original);
    expect(lease.target).toEqual(h.from);
    expect(h.disk.get("different.md")).toBeUndefined();
    lease.release();
  });

  it("retains input when a participant is busy, the destination gains a view, or following the acknowledged move fails", async () => {
    const h = fixture("tex");
    const lease = await h.registry().open(h.from, {});
    const remove = registerRenameParticipant(lease.documentId, { readyToMove: () => false });
    expect(await h.run(lease)).toEqual({ kind: "legacy-required", reason: "busy" });
    expect(h.disk.get(h.from.relativePath)?.source).toBe("original source");
    remove();
    let free = true;
    h.controls.beforeDispatch = () => {
      free = false;
    };
    expect((await h.run(lease, { destinationFree: () => free })).kind).toBe("attention");
    expect(lease.target).toEqual(h.from);
    expect(lease.getSnapshot().draftSource).toBe("original source");
    free = true;
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(
        (
          await h.run(lease, {
            follow: () => {
              throw new Error("view follow failed");
            },
          })
        ).kind,
      ).toBe("repair");
    } finally {
      logged.mockRestore();
    }
    expect(lease.target).toEqual(h.destination);
    expect(lease.getSnapshot().draftSource).toBe("original source");
    lease.release();
  });
});

describe("source-free metadata namespace journals", () => {
  function metadataFixture(mode: "binary" | "truncated" = "binary") {
    const from = {
      environmentId: EnvironmentId.make("opaque-env"),
      cwd: "/opaque-workspace",
      relativePath: mode === "binary" ? "figure.pdf" : "oversized.md",
    };
    const destination = {
      ...from,
      relativePath: mode === "binary" ? "renamed.pdf" : "renamed-notes.md",
    };
    const bytes =
      mode === "binary" ? Uint8Array.of(0, 255, 128, 10, 13, 0) : new Uint8Array(512).fill(65);
    const disk = new Map([[from.relativePath, { bytes, revision: "opaque-revision" }]]);
    const rows = new Map<string, MarkdownDraftCheckpoint | MetadataFileRenameCheckpoint>();
    const controls = {
      lostReply: false,
      quota: false,
      retired: false,
      cleanupFailure: null as null | "cas" | "quota",
      afterCommit: null as null | (() => void),
    };
    const store: MarkdownDraftCheckpointStore = {
      read: async (key) => {
        const row = rows.get(key);
        if (row && "kind" in row) throw new Error("Metadata owns this row.");
        return row;
      },
      replace: async (key, token, next) => {
        const row = rows.get(key);
        if (row && "kind" in row) throw new Error("Metadata owns this row.");
        if (row?.token !== token) return false;
        if (next) rows.set(key, next);
        else rows.delete(key);
        return true;
      },
      readMetadataRename: async (key) => {
        const row = rows.get(key);
        if (row && !("kind" in row)) throw new Error("A source owner holds this row.");
        return row;
      },
      replaceMetadataRename: async (key, token, next) => {
        if (controls.quota) throw new Error("Metadata journal quota exhausted");
        const row = rows.get(key);
        if (row && !("kind" in row)) throw new Error("A source owner holds this row.");
        if (row?.token !== token) return false;
        if (
          key === projectFileOperationKey(destination) &&
          next === undefined &&
          controls.cleanupFailure
        ) {
          if (controls.cleanupFailure === "quota")
            throw new Error("Receipt cleanup storage is unavailable");
          return false;
        }
        if (next) rows.set(key, next);
        else rows.delete(key);
        controls.afterCommit?.();
        return true;
      },
    };
    const receipts = new Map<string, Extract<ServerRenameResult, { ok: true }>>();
    const rename = async (intent: MetadataFileRenameIntent): Promise<ServerRenameResult> => {
      const row = rows.get(projectFileOperationKey(intent.from));
      expect(row && "kind" in row ? row.intent : undefined).toEqual(intent);
      expect("source" in intent).toBe(false);
      expect("baselineSource" in intent).toBe(false);
      let receipt = receipts.get(intent.mutationId);
      if (!receipt) {
        const original = disk.get(intent.from.relativePath);
        if (
          !original ||
          (intent.expectedRevision !== undefined && original.revision !== intent.expectedRevision)
        )
          return { ok: false, cause: { failure: "revision_conflict" } };
        if (disk.has(intent.destination.relativePath))
          return { ok: false, cause: { failure: "path_exists" } };
        disk.set(intent.destination.relativePath, original);
        disk.delete(intent.from.relativePath);
        receipt = {
          ok: true,
          destinationRelativePath: intent.destination.relativePath,
          revision: original.revision,
        };
        receipts.set(intent.mutationId, receipt);
      }
      if (controls.lostReply) throw new Error("Opaque rename reply lost");
      return receipt;
    };
    const run = (override: Partial<Parameters<typeof renameMetadataFile>[0]> = {}) =>
      renameMetadataFile({
        from,
        destination,
        store,
        isActive: () => !controls.retired,
        rename,
        ...override,
      });
    return { from, destination, bytes, disk, rows, controls, store, run, receipts };
  }

  it.each(["binary", "truncated"] as const)(
    "renames supported %s files without pretending to have UTF-8 source or inventing a revision guard",
    async (mode) => {
      const h = metadataFixture(mode);
      expect(await h.run()).toEqual({
        kind: "renamed",
        destinationRelativePath: h.destination.relativePath,
        revision: "opaque-revision",
      });
      expect(h.disk.get(h.from.relativePath)).toBeUndefined();
      expect(h.disk.get(h.destination.relativePath)?.bytes).toBe(h.bytes);
      expect(h.rows.get(projectFileOperationKey(h.from))).toBeUndefined();
      expect(h.rows.get(projectFileOperationKey(h.destination))).toBeUndefined();
    },
  );

  it.each(["cas", "quota"] as const)(
    "follows an acknowledged opaque destination after %s refuses receipt cleanup, and reconstructs safely there",
    async (failure) => {
      const h = metadataFixture();
      h.controls.cleanupFailure = failure;
      expect(await h.run()).toEqual({
        kind: "renamed",
        destinationRelativePath: h.destination.relativePath,
        revision: "opaque-revision",
      });
      expect(h.disk.get(h.from.relativePath)).toBeUndefined();
      expect(h.disk.get(h.destination.relativePath)?.bytes).toBe(h.bytes);
      expect(h.rows.get(projectFileOperationKey(h.from))).toBeUndefined();
      const completed = await h.store.readMetadataRename!(projectFileOperationKey(h.destination));
      expect(completed?.intent).toMatchObject({
        from: h.from,
        destination: h.destination,
        acknowledgement: {
          destinationRelativePath: h.destination.relativePath,
          revision: "opaque-revision",
        },
      });
      expect(h.receipts.get(completed!.intent.mutationId)).toEqual({
        ok: true,
        destinationRelativePath: h.destination.relativePath,
        revision: "opaque-revision",
      });
      expect(await readMetadataRenameIntent(h.destination, h.store)).toBeNull();
      h.controls.cleanupFailure = null;
      const nextDestination = { ...h.destination, relativePath: "final.pdf" };
      expect(
        await h.run({
          from: h.destination,
          destination: nextDestination,
          expectedRevision: "opaque-revision",
        }),
      ).toEqual({
        kind: "renamed",
        destinationRelativePath: nextDestination.relativePath,
        revision: "opaque-revision",
      });
      expect(h.disk.get(h.destination.relativePath)).toBeUndefined();
      expect(h.disk.get(nextDestination.relativePath)?.bytes).toBe(h.bytes);
      expect(h.rows.get(projectFileOperationKey(h.destination))).toBeUndefined();
      expect(h.rows.get(projectFileOperationKey(nextDestination))).toBeUndefined();
    },
  );

  it("reconstructs a lost opaque rename response and replays the same source, destination and ID", async () => {
    const h = metadataFixture();
    h.controls.lostReply = true;
    expect((await h.run()).kind).toBe("attention");
    const original = await readMetadataRenameIntent(h.from, h.store);
    expect(original).not.toHaveProperty("source");
    expect(original).not.toHaveProperty("expectedRevision");
    h.controls.lostReply = false;
    expect(
      (
        await h.run({
          rename: async (intent) => {
            expect(intent).toEqual(original);
            return h.receipts.get(intent.mutationId)!;
          },
        })
      ).kind,
    ).toBe("renamed");
    expect(h.disk.get(h.destination.relativePath)?.bytes).toBe(h.bytes);
  });

  it("keeps the original metadata identity when a different destination is offered after a lost reply", async () => {
    const h = metadataFixture();
    h.controls.lostReply = true;
    expect((await h.run()).kind).toBe("attention");
    const original = await readMetadataRenameIntent(h.from, h.store);
    expect(
      (await h.run({ destination: { ...h.destination, relativePath: "other.pdf" } })).kind,
    ).toBe("attention");
    expect(await readMetadataRenameIntent(h.from, h.store)).toEqual(original);
    expect(h.disk.get("other.pdf")).toBeUndefined();
  });

  it("refuses missing metadata capabilities, quota, retired holders and source-owned destination rows before changing the namespace", async () => {
    for (const barrier of ["capability", "quota", "retired", "destination-owner"] as const) {
      const h = metadataFixture();
      if (barrier === "quota") h.controls.quota = true;
      if (barrier === "retired")
        h.controls.afterCommit = () => {
          h.controls.retired = true;
        };
      const outside: MarkdownDraftCheckpoint = {
        token: "outside",
        baselineSource: "outside baseline",
        baselineRevision: "outside-revision",
        draftSource: "outside unsaved input",
        conflict: true,
      };
      if (barrier === "destination-owner")
        h.rows.set(projectFileOperationKey(h.destination), outside);
      const result = await h.run(
        barrier === "capability" ? { store: { read: h.store.read, replace: h.store.replace } } : {},
      );
      expect(result.kind).toBe("failed");
      expect(h.disk.get(h.from.relativePath)?.bytes).toBe(h.bytes);
      expect(h.disk.get(h.destination.relativePath)).toBeUndefined();
      if (barrier === "destination-owner")
        expect(h.rows.get(projectFileOperationKey(h.destination))).toBe(outside);
    }
  });

  it("preserves the opaque receipt at the source when another owner takes destination storage after dispatch", async () => {
    const h = metadataFixture();
    const outside: MarkdownDraftCheckpoint = {
      token: "outside",
      baselineSource: "D",
      baselineRevision: "rD",
      draftSource: "newer D input",
      conflict: true,
    };
    const result = await h.run({
      rename: async (intent) => {
        const original = h.disk.get(h.from.relativePath)!;
        h.disk.set(h.destination.relativePath, original);
        h.disk.delete(h.from.relativePath);
        h.rows.set(projectFileOperationKey(h.destination), outside);
        return {
          ok: true,
          destinationRelativePath: intent.destination.relativePath,
          revision: original.revision,
        };
      },
    });
    expect(result.kind).toBe("attention");
    expect(h.rows.get(projectFileOperationKey(h.destination))).toBe(outside);
    const preserved = await readMetadataRenameIntent(h.from, h.store);
    expect(preserved?.acknowledgement).toEqual({
      destinationRelativePath: h.destination.relativePath,
      revision: "opaque-revision",
    });
    expect(h.disk.get(h.destination.relativePath)?.bytes).toBe(h.bytes);
  });
});
