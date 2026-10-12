import "fake-indexeddb/auto";
import { MarkdownPersistenceCoordinator } from "@scientfactory/scient-markdown";
import { EnvironmentId } from "@t3tools/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
  indexedDbMarkdownDrafts,
  checkpointHoldsNothing,
  MarkdownDraftCheckpointWriter,
  type MarkdownDraftCheckpoint,
  type MarkdownDraftCheckpointStore,
  type MetadataFileRenameCheckpoint,
} from "./markdownDraftCheckpoint";

function memoryStore(initial?: MarkdownDraftCheckpoint) {
  let value = initial;
  const store: MarkdownDraftCheckpointStore = {
    read: vi.fn(async () => value),
    replace: vi.fn(async (_key, expected, next) => {
      if (value?.token !== expected) return false;
      value = next;
      return true;
    }),
  };
  return { store, value: () => value };
}
function snapshot(draftSource = "A", baselineSource = "A") {
  return new MarkdownPersistenceCoordinator({
    source: baselineSource,
    revision: `r${baselineSource}`,
    draftSource,
    write: async () => ({ revision: "unused" }),
    read: async () => ({ source: "A", revision: "rA" }),
    classifyFailure: () => "terminal",
    debounceMs: 60_000,
  }).getSnapshot();
}
function conflicted(draftSource: string, baselineSource: string, external: string) {
  return {
    ...snapshot(draftSource, baselineSource),
    conflict: { externalSource: external, externalRevision: `r${external}` },
    pending: true,
  };
}
describe("Markdown recovery checkpoint", () => {
  beforeEach(() => vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] }));
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });
  it("retains the newest typing copy and removes only its acknowledged draft", async () => {
    const { store, value } = memoryStore();
    const writer = new MarkdownDraftCheckpointWriter("file", store);
    writer.update(snapshot("B"));
    writer.update(snapshot("C"));
    await vi.advanceTimersByTimeAsync(200);
    expect(value()?.draftSource).toBe("C");
    writer.update(snapshot("C", "C"));
    await vi.advanceTimersByTimeAsync(200);
    expect(value()).toBeUndefined();
  });
  it("keeps a newer draft when an older file write is acknowledged", async () => {
    const { store, value } = memoryStore();
    const writer = new MarkdownDraftCheckpointWriter("file", store);
    writer.update(snapshot("B"));
    await vi.advanceTimersByTimeAsync(200);
    writer.update(snapshot("C", "B"));
    await vi.advanceTimersByTimeAsync(200);
    expect(value()).toMatchObject({ baselineSource: "B", draftSource: "C" });
  });
  it("records whether a conflict was open, including a conflict-only change", async () => {
    const { store, value } = memoryStore();
    const writer = new MarkdownDraftCheckpointWriter("file", store);
    writer.update(snapshot("B"));
    await vi.advanceTimersByTimeAsync(200);
    expect(value()).toMatchObject({ draftSource: "B", conflict: false });
    // Same sources; only the conflict appears. It must still be written.
    writer.update(conflicted("B", "A", "C"));
    await vi.advanceTimersByTimeAsync(200);
    expect(value()).toMatchObject({ draftSource: "B", conflict: true });
    // Undo back to the baseline while the conflict stays open: still a conflict copy.
    writer.update(conflicted("A", "A", "C"));
    await vi.advanceTimersByTimeAsync(200);
    expect(value()).toMatchObject({ baselineSource: "A", draftSource: "A", conflict: true });
  });
  it("keeps attention when the user undoes back to the baseline and updates attention-only changes", async () => {
    const { store, value } = memoryStore();
    const writer = new MarkdownDraftCheckpointWriter("file", store);
    const current = { ...snapshot("A"), pending: true };
    writer.update(current);
    await vi.advanceTimersByTimeAsync(200);
    writer.update({ ...current, attention: "recovery_required" });
    await vi.advanceTimersByTimeAsync(200);
    expect(value()).toMatchObject({
      baselineSource: "A",
      draftSource: "A",
      attention: "recovery_required",
    });
    expect(await writer.settle()).toBe(false);
    expect(value()?.attention).toBe("recovery_required");
  });

  it("persists the recovery reference and refusal proof even when source equals baseline", async () => {
    const attention = {
      recoveryId: "checkpoint-review",
      mutationId: "mutation",
      retainedPaths: ["/private/A"],
      message: "Review.",
    };
    const writer = new MarkdownDraftCheckpointWriter("retained-metadata", indexedDbMarkdownDrafts);
    writer.update({
      ...snapshot("A"),
      pending: true,
      attention: "recovery_required",
      publicationAttention: attention,
      publicationOutcome: "retained-attention",
      attentionMutationId: "mutation",
    });
    await vi.advanceTimersByTimeAsync(200);
    const recovered = await indexedDbMarkdownDrafts.read("retained-metadata");
    expect(recovered).toMatchObject({
      draftSource: "A",
      baselineSource: "A",
      attention: "recovery_required",
      publicationAttention: attention,
      publicationOutcome: "retained-attention",
      attentionMutationId: "mutation",
    });
    expect(await writer.settle()).toBe(false);
    await writer.retire();
  });

  it("retains a reviewed-missing draft equal to historical source through a durable round trip", async () => {
    const writer = new MarkdownDraftCheckpointWriter("missing-current", indexedDbMarkdownDrafts);
    writer.update({ ...snapshot("A"), currentMissing: true, pending: true });
    await vi.advanceTimersByTimeAsync(200);
    const recovered = await indexedDbMarkdownDrafts.read("missing-current");
    expect(recovered).toMatchObject({
      baselineSource: "A",
      draftSource: "A",
      currentMissing: true,
    });
    expect(await writer.settle()).toBe(false);
    expect(await indexedDbMarkdownDrafts.read("missing-current")).toMatchObject({
      currentMissing: true,
    });
    await writer.retire();
  });

  it("retires after a copy already being written, then removes only its own copy", async () => {
    let finish!: () => void;
    let stored: MarkdownDraftCheckpoint | undefined;
    const store: MarkdownDraftCheckpointStore = {
      read: vi.fn(async () => stored),
      replace: vi.fn(async (_key, expected, next) => {
        if (next !== undefined) await new Promise<void>((done) => (finish = done));
        if (stored?.token !== expected) return false;
        stored = next;
        return true;
      }),
    };
    const writer = new MarkdownDraftCheckpointWriter("file", store);
    writer.update(snapshot("B"));
    await vi.advanceTimersByTimeAsync(200);
    // The write is paused inside the store when the document is renamed.
    let retired = false;
    const retiring = writer.retire().then(() => (retired = true));
    await vi.advanceTimersByTimeAsync(0);
    expect(retired).toBe(false);
    finish();
    await retiring;
    expect(stored).toBeUndefined();
    // Nothing more is written for the old path.
    writer.update(snapshot("C"));
    await vi.advanceTimersByTimeAsync(1000);
    expect(stored).toBeUndefined();
  });
  it("leaves a copy another editor replaced when retiring", async () => {
    const first: MarkdownDraftCheckpoint = {
      token: "old",
      baselineSource: "A",
      baselineRevision: "rA",
      draftSource: "B",
    };
    const { store, value } = memoryStore(first);
    const writer = new MarkdownDraftCheckpointWriter("file", store, first);
    await store.replace("file", "old", { ...first, token: "other", draftSource: "C" });
    await writer.retire();
    expect(value()?.draftSource).toBe("C");
  });
  it("cannot remove or overwrite a checkpoint another editor has replaced", async () => {
    const first: MarkdownDraftCheckpoint = {
      token: "old",
      baselineSource: "A",
      baselineRevision: "rA",
      draftSource: "B",
    };
    const { store, value } = memoryStore(first);
    const writer = new MarkdownDraftCheckpointWriter("file", store, first);
    await store.replace("file", "old", { ...first, token: "other", draftSource: "C" });
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    writer.update(snapshot("B", "B"));
    await vi.advanceTimersByTimeAsync(200);
    expect(value()?.draftSource).toBe("C");
    logged.mockRestore();
  });

  it("commits the exact intent immediately while ordinary draft copies remain coalesced", async () => {
    const { store, value } = memoryStore();
    const intent = { mutationId: "exact", source: "B", expectedRevision: "rA", editVersion: 1 };
    const pending = { ...snapshot("C"), publicationIntent: intent, publicationSource: "B" };
    const writer = new MarkdownDraftCheckpointWriter("file", store);
    writer.update(pending);
    expect(value()).toBeUndefined();
    await writer.flushPublication(pending);
    expect(value()).toMatchObject({
      baselineSource: "A",
      draftSource: "C",
      publicationIntent: intent,
      publicationSource: "B",
    });
    await vi.advanceTimersByTimeAsync(1000);
    expect(store.replace).toHaveBeenCalledOnce();
    // A drained pending copy is still recovery, not permission to rename.
    expect(await writer.settle()).toBe(false);
    expect(value()?.publicationIntent).toEqual(intent);
  });

  it("propagates strict storage errors and retains the pending source for an explicit retry", async () => {
    const { store, value } = memoryStore();
    let fail = true;
    const writer = new MarkdownDraftCheckpointWriter("file", {
      read: store.read,
      replace: async (...args) => {
        if (fail) throw new Error("quota");
        return store.replace(...args);
      },
    });
    const intent = {
      mutationId: "quota-intent",
      source: "B",
      expectedRevision: "rA",
      editVersion: 1,
    };
    const pending = { ...snapshot("B"), publicationIntent: intent, publicationSource: "B" };
    await expect(writer.flushPublication(pending)).rejects.toThrow("quota");
    expect(await writer.settle()).toBe(false);
    expect(value()).toBeUndefined();
    fail = false;
    await writer.flushPublication(pending);
    expect(value()?.publicationIntent).toEqual(intent);
    expect(value()?.draftSource).toBe("B");
  });

  it("rejects publication when retirement begins while its durable transaction is active", async () => {
    const { store, value } = memoryStore();
    const commit = Promise.withResolvers<void>();
    const entered = Promise.withResolvers<void>();
    const writer = new MarkdownDraftCheckpointWriter("file", {
      read: store.read,
      replace: async (...args) => {
        if (args[2] !== undefined) {
          entered.resolve();
          await commit.promise;
        }
        return store.replace(...args);
      },
    });
    const intent = {
      mutationId: "retired-intent",
      source: "B",
      expectedRevision: "rA",
      editVersion: 1,
    };
    const pending = { ...snapshot("B"), publicationIntent: intent, publicationSource: "B" };
    const publication = writer.flushPublication(pending);
    const rejected = expect(publication).rejects.toThrow("retired during admission");
    await entered.promise;
    const retiring = writer.retire();
    commit.resolve();
    await rejected;
    await retiring;
    expect(value()).toBeUndefined();
    await expect(writer.flushPublication(pending)).rejects.toThrow("has retired");
  });
});

it("commits IndexedDB compare-and-replace atomically across competing writers", async () => {
  const value = { token: "one", baselineSource: "A", baselineRevision: "rA", draftSource: "B" };
  expect(await indexedDbMarkdownDrafts.replace("atomic-test", undefined, value)).toBe(true);
  const outcomes = await Promise.all([
    indexedDbMarkdownDrafts.replace("atomic-test", "one", {
      ...value,
      token: "two",
      draftSource: "C",
    }),
    indexedDbMarkdownDrafts.replace("atomic-test", "one", undefined),
  ]);
  expect(outcomes.filter(Boolean)).toHaveLength(1);
  expect(await indexedDbMarkdownDrafts.read("atomic-test")).toMatchObject({
    token: "two",
    draftSource: "C",
  });
});

it("round-trips the conflict field and reads its absence as unknown", async () => {
  const value = {
    token: "conflict-field",
    baselineSource: "A",
    baselineRevision: "rA",
    draftSource: "A",
    conflict: true,
  };
  expect(await indexedDbMarkdownDrafts.replace("conflict-field", undefined, value)).toBe(true);
  expect(await indexedDbMarkdownDrafts.read("conflict-field")).toMatchObject({ conflict: true });
  const { conflict: _conflict, ...legacy } = { ...value, token: "legacy" };
  expect(await indexedDbMarkdownDrafts.replace("legacy-field", undefined, legacy)).toBe(true);
  expect(await indexedDbMarkdownDrafts.read("legacy-field")).not.toHaveProperty("conflict");
});
it("keeps opaque rename ownership, atomic CAS and quota refusal in the same physical journal", async () => {
  const { readMetadataRename, replaceMetadataRename } = indexedDbMarkdownDrafts;
  if (readMetadataRename === undefined || replaceMetadataRename === undefined)
    throw new Error("The actual IndexedDB journal must support source-free rename intents.");
  const key = "physical-opaque-rename";
  const textKey = "physical-text-owner";
  const target = {
    environmentId: EnvironmentId.make("journal-test"),
    cwd: "/workspace",
    relativePath: "image.png",
  };
  const original: MetadataFileRenameCheckpoint = {
    kind: "file-rename",
    token: "original",
    intent: {
      mutationId: "opaque-move",
      from: target,
      destination: { ...target, relativePath: "renamed.png" },
      expectedRevision: "sha256:opaque",
    },
  };
  const text = { token: "text", baselineSource: "A", baselineRevision: "rA", draftSource: "B" };
  try {
    expect(await replaceMetadataRename(key, undefined, original)).toBe(true);
    const next = [
      { ...original, token: "first" },
      { ...original, token: "second" },
    ];
    const accepted = await Promise.all(
      next.map((value) => replaceMetadataRename(key, original.token, value)),
    );
    expect(accepted.filter(Boolean)).toHaveLength(1);
    const winner = next[accepted.indexOf(true)];
    if (winner === undefined)
      throw new Error("The competing checkpoint writers did not retain an owner.");
    await expect(indexedDbMarkdownDrafts.read(key)).rejects.toBeInstanceOf(Error);
    await expect(indexedDbMarkdownDrafts.replace(key, winner.token, text)).rejects.toBeInstanceOf(
      Error,
    );
    expect(await readMetadataRename(key)).toEqual(winner);
    await expect(
      replaceMetadataRename(key, winner.token, {
        ...winner,
        token: "oversized",
        intent: {
          ...winner.intent,
          destination: { ...target, relativePath: "x".repeat(4 * 1024 * 1024) },
        },
      }),
    ).rejects.toBeInstanceOf(Error);
    expect(await readMetadataRename(key)).toEqual(winner);
    expect(await indexedDbMarkdownDrafts.replace(textKey, undefined, text)).toBe(true);
    await expect(readMetadataRename(textKey)).rejects.toBeInstanceOf(Error);
    await expect(replaceMetadataRename(textKey, text.token, original)).rejects.toBeInstanceOf(
      Error,
    );
    expect(await indexedDbMarkdownDrafts.read(textKey)).toMatchObject(text);
  } finally {
    const metadata = await readMetadataRename(key);
    if (metadata !== undefined) await replaceMetadataRename(key, metadata.token, undefined);
    const textual = await indexedDbMarkdownDrafts.read(textKey);
    if (textual !== undefined)
      await indexedDbMarkdownDrafts.replace(textKey, textual.token, undefined);
  }
});

it("retains an accepted missing hold even when every source byte equals baseline", async () => {
  const key = "physical-generic-missing-hold";
  const held = {
    token: "held",
    baselineSource: "A",
    baselineRevision: "rA",
    draftSource: "A",
    conflict: false,
    genericSaveState: {
      editRevision: 0,
      confirmedEditRevision: 0,
      failureKind: null,
      acceptedMissingHold: true,
      unchangedRefusal: false,
      recoveryReceiptPending: false,
      resolvedRecoveryId: null,
      authorizedRecovery: null,
      pendingReview: null,
    },
  } satisfies MarkdownDraftCheckpoint;
  try {
    expect(await indexedDbMarkdownDrafts.replace(key, undefined, held)).toBe(true);
    const recovered = await indexedDbMarkdownDrafts.read(key);
    if (recovered === undefined) throw new Error("The accepted missing hold was discarded.");
    expect(checkpointHoldsNothing(recovered)).toBe(false);
    const released = {
      ...recovered,
      token: "released",
      genericSaveState: { ...held.genericSaveState, acceptedMissingHold: false },
    };
    expect(await indexedDbMarkdownDrafts.replace(key, recovered.token, released)).toBe(true);
    const settled = await indexedDbMarkdownDrafts.read(key);
    if (settled === undefined) throw new Error("The explicit hold transition lost its owner.");
    expect(checkpointHoldsNothing(settled)).toBe(true);
  } finally {
    const current = await indexedDbMarkdownDrafts.read(key);
    if (current !== undefined) await indexedDbMarkdownDrafts.replace(key, current.token, undefined);
  }
});

it("replays the exact ambiguous publication identity recovered from IndexedDB instead of generating another", async () => {
  let rejectWrite!: (error: unknown) => void;
  const coordinator = new MarkdownPersistenceCoordinator({
    source: "A",
    revision: "rA",
    write: () =>
      new Promise<{ revision: string }>((_resolve, reject) => {
        rejectWrite = reject;
      }),
    read: async () => ({ source: "B", revision: "rB" }),
    classifyFailure: () => "terminal",
  });
  coordinator.change("B");
  const saving = coordinator.flushNow();
  const pending = coordinator.getSnapshot();
  const value: MarkdownDraftCheckpoint = {
    token: "restart-identity",
    baselineSource: pending.baselineSource,
    baselineRevision: pending.baselineRevision,
    draftSource: pending.draftSource,
    publicationSource: pending.publicationSource,
    publicationIntent: pending.publicationIntent,
    conflict: false,
  };
  await indexedDbMarkdownDrafts.replace("restart-identity", undefined, value);
  const recovered = (await indexedDbMarkdownDrafts.read("restart-identity"))!;
  const replay = new MarkdownPersistenceCoordinator({
    source: recovered.baselineSource,
    revision: recovered.baselineRevision,
    draftSource: recovered.draftSource,
    initialPublication: recovered.publicationIntent!,
    write: async (intent) => {
      if (intent.mutationId !== pending.publicationIntent?.mutationId) throw "wrong-identity";
      throw "retained";
    },
    read: async () => ({ source: "B", revision: "rB" }),
    classifyFailure: (error) => (error === "retained" ? "recovery_required" : "terminal"),
  });
  expect(await replay.flushNow()).toBe(false);
  expect(replay.getSnapshot()).toMatchObject({
    attention: "recovery_required",
    baselineRevision: "rA",
    draftSource: "B",
    pending: true,
  });
  rejectWrite("disposed-process");
  expect(await saving).toBe(false);
});

describe("strict reviewed-current phase checkpoints", () => {
  beforeEach(() => vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] }));
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });
  const attention = {
    recoveryId: "phase-review",
    mutationId: "old",
    retainedPaths: ["/private/A"],
    message: "Review.",
  };
  const authorization = { recoveryId: attention.recoveryId, currentRevision: "rC" };

  it("round-trips exact authorization and atomically settles it while keeping newer working source", async () => {
    const writer = new MarkdownDraftCheckpointWriter("authorized-phase", indexedDbMarkdownDrafts);
    const pending = {
      ...snapshot("local draft"),
      attention: "recovery_required" as const,
      publicationAttention: attention,
      authorizedCurrentReview: authorization,
    };
    await writer.flushAuthorizedCurrentReview(pending);
    const durable = await indexedDbMarkdownDrafts.read("authorized-phase");
    expect(durable).toMatchObject({
      authorizedCurrentReview: authorization,
      publicationAttention: attention,
      baselineSource: "A",
      draftSource: "local draft",
    });
    expect(checkpointHoldsNothing(durable!)).toBe(false);
    const restored = new MarkdownDraftCheckpointWriter(
      "authorized-phase",
      indexedDbMarkdownDrafts,
      durable,
    );
    await restored.flushAuthorizedCurrentReview({
      ...conflicted("newer working source", "C", "C"),
      authorizedCurrentReview: null,
      publicationAttention: null,
      attention: null,
    });
    expect(await indexedDbMarkdownDrafts.read("authorized-phase")).toMatchObject({
      authorizedCurrentReview: null,
      attention: null,
      publicationAttention: null,
      baselineSource: "C",
      draftSource: "newer working source",
      conflict: true,
    });
  });

  it("cannot erase another owner's phase or draft at authorization admission", async () => {
    const foreign = {
      token: "foreign",
      baselineSource: "foreign baseline",
      baselineRevision: "foreign revision",
      draftSource: "foreign draft",
      authorizedCurrentReview: authorization,
      publicationAttention: attention,
    };
    const { store, value } = memoryStore(foreign);
    const writer = new MarkdownDraftCheckpointWriter("file", store);
    await expect(
      writer.flushAuthorizedCurrentReview({
        ...snapshot("my draft"),
        publicationAttention: attention,
        authorizedCurrentReview: authorization,
        attention: "recovery_required",
      }),
    ).rejects.toThrow();
    expect(value()).toEqual(foreign);
    expect(await writer.settle()).toBe(false);
  });

  it("retirement during phase admission rejects confirmation permission without deleting the authorized working bytes", async () => {
    const { store, value } = memoryStore();
    const entered = Promise.withResolvers<void>();
    const commit = Promise.withResolvers<void>();
    const writer = new MarkdownDraftCheckpointWriter("file", {
      read: store.read,
      replace: async (...args) => {
        if (args[2] !== undefined) {
          entered.resolve();
          await commit.promise;
        }
        return store.replace(...args);
      },
    });
    const pending = {
      ...snapshot("working source"),
      attention: "recovery_required" as const,
      publicationAttention: attention,
      authorizedCurrentReview: authorization,
    };
    writer.update(pending);
    const admitting = writer.flushAuthorizedCurrentReview(pending);
    const rejected = expect(admitting).rejects.toThrow();
    await entered.promise;
    const retiring = writer.retire();
    commit.resolve();
    await rejected;
    await retiring;
    expect(value()).toMatchObject({
      authorizedCurrentReview: authorization,
      publicationAttention: attention,
      draftSource: "working source",
    });
    await expect(writer.flushAuthorizedCurrentReview(pending)).rejects.toThrow();
    expect(value()?.draftSource).toBe("working source");
  });
});
