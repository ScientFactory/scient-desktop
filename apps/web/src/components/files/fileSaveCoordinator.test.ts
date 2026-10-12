import "fake-indexeddb/auto";
import type { AtomCommandResult } from "@t3tools/client-runtime/state/runtime";
import { EnvironmentId } from "@t3tools/contracts";
import { projectFileOperationKey } from "@t3tools/client-runtime/state/projects";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
  indexedDbMarkdownDrafts,
  type DocumentRenameIntent,
  type MarkdownDraftCheckpointStore,
} from "~/scient/markdownEditor/persistence/markdownDraftCheckpoint";
import { FileSaveCoordinator, type FileSaveCoordinatorOptions } from "./fileSaveCoordinator";

type Result = { readonly revision: string };
const owners: FileSaveCoordinator<Result, Error>[] = [];
const keys = new Set<string>();
let sequence = 0;
function open(
  options: Partial<FileSaveCoordinatorOptions<Result, Error>> &
    Pick<FileSaveCoordinatorOptions<Result, Error>, "persist">,
) {
  const key = options.journal?.key ?? `generic-save-${++sequence}`;
  keys.add(key);
  const owner = new FileSaveCoordinator<Result, Error>({
    debounceMs: 500,
    initialSource: "A",
    initialRevision: "rA",
    journal: { key, store: indexedDbMarkdownDrafts },
    classifyFailure: () => "transient",
    revisionFromResult: (result) => result.revision,
    onPendingChange: () => {},
    onConfirmed: () => {},
    ...options,
  });
  owners.push(owner);
  return owner;
}
function refused() {
  return AsyncResult.failure<Result, Error>(Cause.fail(new Error("Publication refused")));
}
const attention = {
  recoveryId: "review",
  mutationId: "prior",
  retainedPaths: ["draft.copy"],
  message: "Retained publication",
};

beforeEach(() => vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] }));
afterEach(async () => {
  for (const owner of owners) owner.retire();
  await Promise.all(owners.map((owner) => owner.ready()));
  owners.length = 0;
  for (const key of keys) {
    const copy = await indexedDbMarkdownDrafts.read(key);
    if (copy) await indexedDbMarkdownDrafts.replace(key, copy.token, undefined);
  }
  keys.clear();
  vi.useRealTimers();
});

describe("durable generic file publication", () => {
  it("reconstructs the lost-ACK identity and frozen source separately from newer input without overwriting outside D", async () => {
    let disk = { source: "A", revision: "rA" };
    let loseAcknowledgement = true;
    const receipts = new Map<
      string,
      { source: string; expected: string | undefined; result: Result }
    >();
    let kind: "transient" | "target_changed" = "transient";
    const persist = async (
      source: string,
      expected: string | undefined,
      mutationId: string,
    ): Promise<AtomCommandResult<Result, Error>> => {
      const receipt = receipts.get(mutationId);
      if (receipt) {
        if (receipt.source !== source || receipt.expected !== expected)
          throw new Error("Mutation identity changed");
        return AsyncResult.success(receipt.result);
      }
      if (expected !== disk.revision) {
        kind = "target_changed";
        return refused();
      }
      disk = { source, revision: `r${source}` };
      const result = { revision: disk.revision };
      receipts.set(mutationId, { source, expected, result });
      if (loseAcknowledgement) {
        loseAcknowledgement = false;
        throw new Error("Lost acknowledgement");
      }
      return AsyncResult.success(result);
    };
    const first = open({
      persist,
      classifyFailure: () => kind,
      publicationOutcome: () => (kind === "target_changed" ? "unchanged" : null),
    });
    await first.ready();
    first.change("B");
    await expect(first.flush()).resolves.toBe(false);
    first.change("C");
    await first.ready();
    const key = [...keys][0]!;
    const journal = (await indexedDbMarkdownDrafts.read(key))!;
    expect(journal).toMatchObject({
      draftSource: "C",
      publicationIntent: { source: "B", expectedRevision: "rA" },
    });
    const originalId = journal.publicationIntent!.mutationId;
    first.retire();
    disk = { source: "D", revision: "rD" };
    let restored = "";
    const renderer = open({
      persist,
      journal: { key, store: indexedDbMarkdownDrafts },
      initialSource: "D",
      initialRevision: "rD",
      onRestoredSource: (source) => {
        restored = source;
      },
      classifyFailure: () => kind,
      publicationOutcome: () => (kind === "target_changed" ? "unchanged" : null),
    });
    await renderer.ready();
    expect(restored).toBe("C");
    await expect(renderer.flush()).resolves.toBe(false);
    expect(disk).toEqual({ source: "D", revision: "rD" });
    expect(receipts.get(originalId)).toEqual({
      source: "B",
      expected: "rA",
      result: { revision: "rB" },
    });
    expect(renderer.reviewRequired).toBe(true);
    expect(await indexedDbMarkdownDrafts.read(key)).toMatchObject({
      baselineSource: "B",
      baselineRevision: "rB",
      draftSource: "C",
      publicationOutcome: "unchanged",
      publicationIntent: { source: "C", expectedRevision: "rB" },
    });
  });

  it("keeps accepted physical absence across reconstruction and typing until explicit create-only recreation", async () => {
    let disk: { source: string; revision: string } | null = null;
    let retained = true;
    const persist = async (
      source: string,
      expected: string | undefined,
      _id: string,
      createOnly?: boolean,
    ) => {
      if (createOnly ? disk !== null : disk?.revision !== expected) return refused();
      disk = { source, revision: `r${source}` };
      return AsyncResult.success({ revision: disk.revision });
    };
    const first = open({
      persist,
      initialAttention: attention,
      readForRecovery: async () => ({
        missing: true,
        revision: null,
        publicationAttention: retained ? attention : null,
      }),
      resolveRecovery: async () => {
        retained = false;
        return { revision: null };
      },
    });
    await first.ready();
    first.change("B");
    await expect(first.resolveRetainedAttention("review", null)).resolves.toBe(true);
    const key = [...keys][0]!;
    expect(await indexedDbMarkdownDrafts.read(key)).toMatchObject({
      currentMissing: true,
      genericSaveState: { acceptedMissingHold: true },
    });
    first.retire();
    const renderer = open({ persist, journal: { key, store: indexedDbMarkdownDrafts } });
    await renderer.ready();
    expect(renderer.currentMissing).toBe(true);
    renderer.change("C");
    renderer.syncConfirmedFileRevision("watcher", "outside cached source");
    renderer.retryPending("watcher");
    renderer.discardPending("watcher");
    await vi.advanceTimersByTimeAsync(5_000);
    await expect(renderer.flush()).resolves.toBe(false);
    expect(disk).toBeNull();
    expect(await indexedDbMarkdownDrafts.read(key)).toMatchObject({
      draftSource: "C",
      currentMissing: true,
    });
    expect(renderer.recreateMissingCurrent("stale rendered source")).toBe(true);
    await expect(renderer.flush()).resolves.toBe(true);
    expect(disk).toEqual({ source: "C", revision: "rC" });
    expect(renderer.currentMissing).toBe(false);
  });

  it.each(["read", "CAS", "quota"] as const)(
    "never dispatches when journal admission fails at %s",
    async (stage) => {
      let disk = "A";
      const store: MarkdownDraftCheckpointStore = {
        read: async () => {
          if (stage === "read") throw new Error("Storage unavailable");
          return undefined;
        },
        replace: async () => {
          if (stage === "quota") throw new Error("Quota exceeded");
          return false;
        },
      };
      const owner = open({
        journal: { key: `failed-${stage}`, store },
        persist: async (source) => {
          disk = source;
          return AsyncResult.success({ revision: "rB" });
        },
      });
      owner.change("B");
      await expect(owner.flush()).resolves.toBe(false);
      expect(disk).toBe("A");
      expect(owner.hasPendingChanges).toBe(true);
    },
  );

  it.each(["CAS", "quota"] as const)(
    "keeps the draft recoverable and admits no transport when exact intent commit fails at %s",
    async (stage) => {
      const key = `publication-admission-${stage}`;
      let disk = "A";
      const store: MarkdownDraftCheckpointStore = {
        read: (at) => indexedDbMarkdownDrafts.read(at),
        replace: async (at, expected, next) => {
          if (next?.publicationIntent != null) {
            if (stage === "quota")
              throw new Error("Quota exceeded while admitting the frozen mutation");
            return false;
          }
          return indexedDbMarkdownDrafts.replace(at, expected, next);
        },
      };
      const owner = open({
        journal: { key, store },
        persist: async (source) => {
          disk = source;
          return AsyncResult.success({ revision: "rB" });
        },
      });
      await owner.ready();
      owner.change("B");
      await owner.ready();
      await expect(owner.flush()).resolves.toBe(false);
      expect(disk).toBe("A");
      expect(await indexedDbMarkdownDrafts.read(key)).toMatchObject({
        draftSource: "B",
        publicationIntent: null,
      });
    },
  );

  it.each([
    "target_changed",
    "recovery_required",
    "mutation_unavailable",
    "mutation_intent_conflict",
    "operation",
  ] as const)(
    "retains %s and the newest draft through typing, external reads, discard, retry and reconstruction",
    async (kind) => {
      let disk = "A";
      const persist = async (source: string) => {
        if (source === "C") disk = source;
        return refused();
      };
      const owner = open({ persist, classifyFailure: () => kind });
      await owner.ready();
      owner.change("B");
      await expect(owner.flush()).resolves.toBe(false);
      owner.change("C");
      owner.syncConfirmedFileRevision("rD", "D");
      owner.discardPending("rD");
      owner.retryPending("rD");
      await expect(owner.flush()).resolves.toBe(false);
      await owner.ready();
      const key = [...keys][0]!;
      owner.retire();
      const renderer = open({
        persist,
        classifyFailure: () => kind,
        journal: { key, store: indexedDbMarkdownDrafts },
      });
      await renderer.ready();
      await expect(renderer.flush()).resolves.toBe(false);
      expect(disk).toBe("A");
      expect(renderer.hasPendingChanges).toBe(true);
      expect(await indexedDbMarkdownDrafts.read(key)).toMatchObject({
        draftSource: "C",
        publicationIntent: { source: "B" },
        genericSaveState: { failureKind: kind },
      });
    },
  );

  it("binds an unchanged review to current source and revision, then reconstructs its hold without acknowledging the refused draft", async () => {
    let disk = { source: "D", revision: "rD" };
    let kind: "target_changed" | "transient" = "target_changed";
    let acknowledgedId: string | null = null;
    const persist = async (source: string, expected: string | undefined, id: string) => {
      if (expected !== disk.revision) return refused();
      acknowledgedId = id;
      disk = { source, revision: `r${source}` };
      return AsyncResult.success({ revision: disk.revision });
    };
    const owner = open({
      persist,
      classifyFailure: () => kind,
      publicationOutcome: () => (kind === "target_changed" ? "unchanged" : null),
      readForRecovery: async () => ({ source: disk.source, revision: disk.revision }),
    });
    await owner.ready();
    owner.change("B");
    await expect(owner.flush()).resolves.toBe(false);
    const key = [...keys][0]!;
    const refusedId = (await indexedDbMarkdownDrafts.read(key))!.publicationIntent!.mutationId;
    await expect(owner.reviewUnchangedRefusal("rA")).resolves.toBe(false);
    await expect(owner.reviewUnchangedRefusal("rD")).resolves.toBe(true);
    expect(await indexedDbMarkdownDrafts.read(key)).toMatchObject({
      baselineSource: "D",
      baselineRevision: "rD",
      draftSource: "B",
      publicationIntent: null,
    });
    owner.retire();
    const renderer = open({
      persist,
      journal: { key, store: indexedDbMarkdownDrafts },
      initialSource: "D",
      initialRevision: "rD",
    });
    await renderer.ready();
    await expect(renderer.flush()).resolves.toBe(false);
    expect(disk.source).toBe("D");
    expect(acknowledgedId).toBeNull();
    kind = "transient";
    renderer.change("C");
    await expect(renderer.flush()).resolves.toBe(true);
    expect(disk).toEqual({ source: "C", revision: "rC" });
    expect(acknowledgedId).not.toBe(refusedId);
  });

  it("fences an old renderer's late acknowledgement and future writes from its successor journal", async () => {
    const admitted = Promise.withResolvers<void>();
    const acknowledgement = Promise.withResolvers<AtomCommandResult<Result, Error>>();
    const first = open({
      persist: async () => {
        admitted.resolve();
        return acknowledgement.promise;
      },
    });
    await first.ready();
    first.change("B");
    const oldFlush = first.flush();
    await admitted.promise;
    const key = [...keys][0]!;
    const successor = open({
      journal: { key, store: indexedDbMarkdownDrafts },
      persist: async () => refused(),
      classifyFailure: () => "conflict",
    });
    await successor.ready();
    successor.change("C");
    await successor.ready();
    const owned = await indexedDbMarkdownDrafts.read(key);
    acknowledgement.resolve(AsyncResult.success({ revision: "rB" }));
    await expect(oldFlush).resolves.toBe(false);
    first.change("stale owner input");
    await expect(first.flush()).resolves.toBe(false);
    expect(await indexedDbMarkdownDrafts.read(key)).toEqual(owned);
    first.retire();
    await expect(first.flush()).resolves.toBe(false);
  });

  it("persists exact reviewed authorization before resolution and resumes its confirmation after renderer loss", async () => {
    let disk = { source: "A", revision: "rA" };
    let retained = true;
    let failConfirmation = true;
    let authorization: string | null = null;
    const first = open({
      initialAttention: attention,
      persist: async () => refused(),
      readForRecovery: async () => {
        if (!retained && failConfirmation) {
          failConfirmation = false;
          throw new Error("Confirmation disconnected");
        }
        return {
          source: disk.source,
          revision: disk.revision,
          publicationAttention: retained ? attention : null,
        };
      },
      resolveRecovery: async (review) => {
        const copy = await indexedDbMarkdownDrafts.read([...keys][0]!);
        expect(copy?.genericSaveState?.pendingReview).toEqual(review);
        authorization = review.currentRevision;
        retained = false;
        return { revision: review.currentRevision };
      },
    });
    await first.ready();
    first.change("B");
    await expect(first.resolveRetainedAttention("review", "rA")).resolves.toBe(false);
    const key = [...keys][0]!;
    expect(await indexedDbMarkdownDrafts.read(key)).toMatchObject({
      genericSaveState: {
        authorizedRecovery: { recoveryId: "review", currentRevision: "rA" },
        pendingReview: { recoveryId: "review", currentRevision: "rA" },
      },
    });
    first.retire();
    const renderer = open({
      initialAttention: attention,
      journal: { key, store: indexedDbMarkdownDrafts },
      readForRecovery: async () => ({
        source: disk.source,
        revision: disk.revision,
        publicationAttention: retained ? attention : null,
      }),
      resolveRecovery: async () => {
        throw new Error("Confirmed authorization must not resolve again");
      },
      persist: async (source, expected) => {
        if (disk.revision !== expected) return refused();
        disk = { source, revision: `r${source}` };
        return AsyncResult.success({ revision: disk.revision });
      },
    });
    await renderer.ready();
    await expect(renderer.resolveRetainedAttention("review", "rA")).resolves.toBe(true);
    expect(authorization).toBe("rA");
    await expect(renderer.flush()).resolves.toBe(false);
    expect(disk.source).toBe("A");
    renderer.change("C");
    await expect(renderer.flush()).resolves.toBe(true);
    expect(disk).toEqual({ source: "C", revision: "rC" });
  });

  it.each(["before", "after", "receipt"] as const)(
    "refuses missing acceptance when a pathname appears at %s",
    async (stage) => {
      let read = 0;
      const owner = open({
        initialAttention: attention,
        persist: async () => refused(),
        readForRecovery: async () =>
          ++read === (stage === "before" ? 1 : stage === "after" ? 2 : 0)
            ? { source: "D", revision: "rD" }
            : { missing: true, revision: null },
        resolveRecovery: async () => ({ revision: stage === "receipt" ? "rD" : null }),
      });
      await owner.ready();
      owner.change("B");
      await expect(owner.resolveRetainedAttention("review", null)).resolves.toBe(false);
      expect(owner.currentMissing).toBe(false);
      expect(owner.publicationAttention).toEqual(attention);
      await expect(owner.flush()).resolves.toBe(false);
    },
  );

  it("retains typed input during ordered confirmation and requires explicit action after acceptance", async () => {
    const confirming = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let retained = true;
    let disk = "A";
    const owner = open({
      initialAttention: attention,
      persist: async (source) => {
        disk = source;
        return AsyncResult.success({ revision: "rB" });
      },
      readForRecovery: async () => {
        if (!retained) {
          confirming.resolve();
          await release.promise;
        }
        return { source: "A", revision: "rA", publicationAttention: retained ? attention : null };
      },
      resolveRecovery: async () => {
        retained = false;
        return { revision: "rA" };
      },
    });
    await owner.ready();
    owner.change("B");
    const accepting = owner.resolveRetainedAttention("review", "rA");
    await confirming.promise;
    owner.change("C");
    release.resolve();
    await expect(accepting).resolves.toBe(true);
    await expect(owner.flush()).resolves.toBe(false);
    expect(disk).toBe("A");
    owner.retryPending("rA");
    await expect(owner.flush()).resolves.toBe(true);
    expect(disk).toBe("C");
  });

  it("debounces shared input, respects suspension and flushes the actual newest source on final disposal", async () => {
    let disk = "A";
    const owner = open({
      persist: async (source) => {
        disk = source;
        return AsyncResult.success({ revision: `r${source}` });
      },
    });
    await owner.ready();
    owner.change("B");
    await vi.advanceTimersByTimeAsync(300);
    owner.change("C");
    await vi.advanceTimersByTimeAsync(499);
    expect(disk).toBe("A");
    await vi.advanceTimersByTimeAsync(1);
    await owner.flush();
    expect(disk).toBe("C");
    owner.setSuspended(true);
    owner.change("D");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(disk).toBe("C");
    owner.dispose();
    await owner.flush();
    expect(disk).toBe("D");
    owner.change("retired edit");
    await owner.flush();
    expect(disk).toBe("D");
  });

  it("retains a denied draft and publishes it only after write permission returns", async () => {
    let canWrite = false;
    let disk = "A";
    const owner = open({
      canPersist: () => canWrite,
      persist: async (source) => {
        disk = source;
        return AsyncResult.success({ revision: "rB" });
      },
    });
    await owner.ready();
    owner.change("B");
    await expect(owner.flush()).resolves.toBe(false);
    expect(disk).toBe("A");
    canWrite = true;
    await expect(owner.flush()).resolves.toBe(true);
    expect(disk).toBe("B");
  });

  it("journals a rename before dispatch and moves input typed during it into the destination checkpoint", async () => {
    const from = {
      environmentId: EnvironmentId.make("generic-rename"),
      cwd: "/repo",
      relativePath: "a.txt",
    };
    const destination = { ...from, relativePath: "b.txt" };
    const key = projectFileOperationKey(from);
    keys.add(projectFileOperationKey(destination));
    const owner = open({
      journal: { key, store: indexedDbMarkdownDrafts },
      persist: async () => refused(),
    });
    await owner.ready();
    const intent = (await owner.beginRename(from, destination))!;
    expect(await indexedDbMarkdownDrafts.read(key)).toMatchObject({ renameIntent: intent });
    owner.change("C");
    await expect(owner.flush()).resolves.toBe(false);
    owner.retire();
    const renderer = open({
      journal: { key, store: indexedDbMarkdownDrafts },
      persist: async () => refused(),
    });
    await renderer.ready();
    const replay = (await renderer.beginRename(from, destination))!;
    expect(replay).toEqual(intent);
    await expect(
      renderer.acknowledgeRename(replay, { destinationRelativePath: "b.txt", revision: "rA" }),
    ).resolves.toBe(true);
    expect(await indexedDbMarkdownDrafts.read(key)).toBeUndefined();
    expect(await indexedDbMarkdownDrafts.read(projectFileOperationKey(destination))).toMatchObject({
      baselineSource: "A",
      baselineRevision: "rA",
      draftSource: "C",
      renameIntent: {
        mutationId: intent.mutationId,
        acknowledgement: { destinationRelativePath: "b.txt", revision: "rA" },
      },
    });
  });

  it("preserves a refused rename receipt and newer input when the destination journal belongs to another owner", async () => {
    const from = {
      environmentId: EnvironmentId.make("generic-rename-collision"),
      cwd: "/repo",
      relativePath: "a.txt",
    };
    const destination = { ...from, relativePath: "b.txt" };
    const key = projectFileOperationKey(from);
    const destinationKey = projectFileOperationKey(destination);
    keys.add(destinationKey);
    const foreign = {
      token: "foreign-destination",
      baselineSource: "D",
      baselineRevision: "rD",
      draftSource: "E",
      conflict: true,
    };
    await indexedDbMarkdownDrafts.replace(destinationKey, undefined, foreign);
    const owner = open({
      journal: { key, store: indexedDbMarkdownDrafts },
      persist: async () => refused(),
    });
    await owner.ready();
    const intent = (await owner.beginRename(from, destination))!;
    owner.change("C");
    await expect(
      owner.acknowledgeRename(intent, { destinationRelativePath: "b.txt", revision: "rA" }),
    ).resolves.toBe(false);
    expect(await indexedDbMarkdownDrafts.read(destinationKey)).toEqual(foreign);
    expect(await indexedDbMarkdownDrafts.read(key)).toMatchObject({
      draftSource: "C",
      renameIntent: {
        mutationId: intent.mutationId,
        acknowledgement: { destinationRelativePath: "b.txt", revision: "rA" },
      },
    });
    owner.retire();
    const renderer = open({
      journal: { key, store: indexedDbMarkdownDrafts },
      persist: async () => refused(),
    });
    await renderer.ready();
    const replay = (await renderer.beginRename(from, destination))!;
    expect(replay.acknowledgement).toEqual({ destinationRelativePath: "b.txt", revision: "rA" });
    expect(replay.mutationId).toBe(intent.mutationId);
    expect(renderer.isRenameCurrent(replay)).toBe(true);
    renderer.retire();
    expect(renderer.isRenameCurrent(replay)).toBe(false);
  });
  it.each(["path_exists", "revision_conflict"])(
    "releases a definitive %s rename only after durable admission and preserves newer typing",
    async (failure) => {
      const from = {
        environmentId: EnvironmentId.make(`rename-refusal-${failure}`),
        cwd: "/repo",
        relativePath: "a.txt",
      };
      const destination = { ...from, relativePath: "b.txt" };
      const key = projectFileOperationKey(from);
      let admitClear!: () => void;
      let clearing!: () => void;
      const clearStarted = new Promise<void>((resolve) => {
        clearing = resolve;
      });
      const clearAdmission = new Promise<void>((resolve) => {
        admitClear = resolve;
      });
      let holdClear = false;
      const store: MarkdownDraftCheckpointStore = {
        read: indexedDbMarkdownDrafts.read,
        replace: async (rowKey, token, next) => {
          if (holdClear && next?.renameIntent === null) {
            holdClear = false;
            clearing();
            await clearAdmission;
          }
          return indexedDbMarkdownDrafts.replace(rowKey, token, next);
        },
      };
      const persisted: string[] = [];
      const owner = open({
        journal: { key, store },
        persist: async (source) => {
          persisted.push(source);
          return AsyncResult.success({ revision: `r${source}` });
        },
      });
      await owner.ready();
      const original = (await owner.beginRename(from, destination))!;
      await owner.rejectRename(original, new Error("Lost transport reply"));
      owner.change("C");
      await owner.ready();
      holdClear = true;
      const rejected = owner.rejectRename(original, { failure });
      await clearStarted;
      expect(owner.getRenameIntent()?.mutationId).toBe(original.mutationId);
      expect(await indexedDbMarkdownDrafts.read(key)).toMatchObject({
        renameIntent: original,
        draftSource: "C",
      });
      const replacement: { value: DocumentRenameIntent | null | undefined } = { value: undefined };
      const nextRename = owner
        .beginRename(from, { ...destination, relativePath: "c.txt" })
        .then((value) => {
          replacement.value = value;
        });
      await Promise.resolve();
      expect(replacement.value).toBeUndefined();
      expect(persisted).toEqual([]);
      owner.change("D");
      admitClear();
      await expect(rejected).resolves.toBe(true);
      await nextRename;
      expect(replacement.value?.destination.relativePath).toBe("c.txt");
      expect(replacement.value?.mutationId).not.toBe(original.mutationId);
      expect(persisted).toEqual(["D"]);
      expect(await indexedDbMarkdownDrafts.read(key)).toMatchObject({
        draftSource: "D",
        renameIntent: replacement.value,
      });
    },
  );

  it.each(["CAS", "throw"] as const)(
    "holds the original rename and blocks new-name transport when refusal clearing fails at %s",
    async (mode) => {
      const from = {
        environmentId: EnvironmentId.make(`rename-clear-${mode}`),
        cwd: "/repo",
        relativePath: "a.txt",
      };
      const key = projectFileOperationKey(from);
      let refuseClear = false;
      const store: MarkdownDraftCheckpointStore = {
        read: indexedDbMarkdownDrafts.read,
        replace: async (rowKey, token, next) => {
          if (refuseClear && next?.renameIntent === null) {
            if (mode === "throw") throw new Error("Storage unavailable");
            return false;
          }
          return indexedDbMarkdownDrafts.replace(rowKey, token, next);
        },
      };
      const persist = vi.fn(async () => AsyncResult.success({ revision: "unexpected" }));
      const owner = open({ journal: { key, store }, persist });
      await owner.ready();
      const original = (await owner.beginRename(from, { ...from, relativePath: "b.txt" }))!;
      owner.change("C");
      await owner.ready();
      refuseClear = true;
      await expect(owner.rejectRename(original, { failure: "path_exists" })).resolves.toBe(false);
      await expect(owner.beginRename(from, { ...from, relativePath: "c.txt" })).resolves.toBeNull();
      await expect(owner.flush()).resolves.toBe(false);
      expect(persist).not.toHaveBeenCalled();
      expect(await indexedDbMarkdownDrafts.read(key)).toMatchObject({
        draftSource: "C",
        renameIntent: original,
      });
    },
  );

  it.each([
    new Error("Reply lost"),
    { failure: "target_changed", publicationOutcome: "retained-attention" },
    { failure: "path_exists", publicationOutcome: "retained-attention" },
  ])(
    "keeps ambiguous or retained rename identity through retry and reconstruction",
    async (error) => {
      const from = {
        environmentId: EnvironmentId.make(`rename-ambiguous-${++sequence}`),
        cwd: "/repo",
        relativePath: "a.txt",
      };
      const destination = { ...from, relativePath: "b.txt" };
      const key = projectFileOperationKey(from);
      const options = {
        journal: { key, store: indexedDbMarkdownDrafts },
        persist: async () => refused(),
        publicationOutcome: (cause: unknown) =>
          typeof cause === "object" &&
          cause !== null &&
          "publicationOutcome" in cause &&
          cause.publicationOutcome === "retained-attention"
            ? ("retained-attention" as const)
            : null,
      };
      const owner = open(options);
      await owner.ready();
      const original = (await owner.beginRename(from, destination))!;
      await expect(owner.rejectRename(original, error)).resolves.toBe(true);
      await expect(
        owner.beginRename(from, { ...destination, relativePath: "c.txt" }),
      ).resolves.toBeNull();
      await expect(owner.beginRename(from, destination)).resolves.toEqual(original);
      owner.retire();
      const restored = open(options);
      await restored.ready();
      await expect(restored.beginRename(from, destination)).resolves.toEqual(original);
    },
  );

  it("clears only rejected rename state, not another publication's retained recovery", async () => {
    const from = {
      environmentId: EnvironmentId.make("rename-unrelated-recovery"),
      cwd: "/repo",
      relativePath: "a.txt",
    };
    const key = projectFileOperationKey(from);
    const owner = open({
      journal: { key, store: indexedDbMarkdownDrafts },
      persist: async () => refused(),
    });
    await owner.ready();
    const intent = (await owner.beginRename(from, { ...from, relativePath: "b.txt" }))!;
    owner.change("C");
    owner.observePublicationAttention(attention);
    await expect(owner.rejectRename(intent, { failure: "path_exists" })).resolves.toBe(true);
    expect(await indexedDbMarkdownDrafts.read(key)).toMatchObject({
      draftSource: "C",
      renameIntent: null,
      publicationAttention: attention,
    });
    await expect(owner.flush()).resolves.toBe(false);
    expect(owner.publicationAttention).toEqual(attention);
  });

  it.each(["CAS", "throw"] as const)(
    "adopts the durable destination despite source retirement %s and never replays its source mutation after restart",
    async (mode) => {
      const from = {
        environmentId: EnvironmentId.make(`rename-retirement-${mode}`),
        cwd: "/repo",
        relativePath: "a.txt",
      };
      const destination = { ...from, relativePath: "b.txt" };
      const key = projectFileOperationKey(from);
      const destinationKey = projectFileOperationKey(destination);
      keys.add(destinationKey);
      let typeDuringDestination = true;
      let owner!: FileSaveCoordinator<Result, Error>;
      const store: MarkdownDraftCheckpointStore = {
        read: indexedDbMarkdownDrafts.read,
        replace: async (rowKey, token, next) => {
          if (rowKey === key && next === undefined) {
            if (mode === "throw") throw new Error("Storage disconnected during retirement");
            return false;
          }
          if (rowKey === destinationKey && typeDuringDestination) {
            typeDuringDestination = false;
            owner.change("D");
          }
          return indexedDbMarkdownDrafts.replace(rowKey, token, next);
        },
      };
      const sourcePersist = vi.fn(async () => refused());
      owner = open({ journal: { key, store }, persist: sourcePersist });
      await owner.ready();
      const intent = (await owner.beginRename(from, destination))!;
      owner.change("C");
      const acknowledgement = { destinationRelativePath: destination.relativePath, revision: "rA" };
      await expect(owner.acknowledgeRename(intent, acknowledgement)).resolves.toBe(true);
      expect(owner.isRenameCurrent(intent)).toBe(false);
      owner.change("stale source callback");
      await expect(owner.flush()).resolves.toBe(false);
      expect(sourcePersist).not.toHaveBeenCalled();
      expect(await indexedDbMarkdownDrafts.read(key)).toMatchObject({
        draftSource: "D",
        renameIntent: { mutationId: intent.mutationId, acknowledgement },
      });
      expect(await indexedDbMarkdownDrafts.read(destinationKey)).toMatchObject({
        draftSource: "D",
      });
      const destinationWrites: string[] = [];
      const adopted = open({
        journal: { key: destinationKey, store },
        persist: async (source) => {
          destinationWrites.push(source);
          return AsyncResult.success({ revision: `r${source}` });
        },
      });
      await adopted.ready();
      expect(adopted.getRenameIntent()).toBeNull();
      await expect(adopted.flush()).resolves.toBe(true);
      adopted.change("E");
      await expect(adopted.flush()).resolves.toBe(true);
      expect(destinationWrites).toEqual(["D", "E"]);
      const authoritativeDestination = await indexedDbMarkdownDrafts.read(destinationKey);
      const sourceRestart = open({ journal: { key, store }, persist: sourcePersist });
      await sourceRestart.ready();
      const replay = (await sourceRestart.beginRename(from, destination))!;
      expect(replay.mutationId).toBe(intent.mutationId);
      expect(replay.acknowledgement).toEqual(acknowledgement);
      await expect(sourceRestart.acknowledgeRename(replay, acknowledgement)).resolves.toBe(true);
      expect(await indexedDbMarkdownDrafts.read(destinationKey)).toEqual(authoritativeDestination);
      expect(sourcePersist).not.toHaveBeenCalled();
      await expect(
        adopted.beginRename(destination, { ...destination, relativePath: "c.txt" }),
      ).resolves.toMatchObject({
        from: destination,
        destination: { ...destination, relativePath: "c.txt" },
        source: "E",
        expectedRevision: "rE",
      });
    },
  );

  it("does not erase a foreign source owner when obsolete receipt deletion loses its CAS", async () => {
    const from = {
      environmentId: EnvironmentId.make("rename-retirement-foreign"),
      cwd: "/repo",
      relativePath: "a.txt",
    };
    const destination = { ...from, relativePath: "b.txt" };
    const key = projectFileOperationKey(from);
    const destinationKey = projectFileOperationKey(destination);
    keys.add(destinationKey);
    const foreign = {
      token: "foreign-source-owner",
      baselineSource: "\u0000outside",
      baselineRevision: "rOutside",
      draftSource: "\u0000newer",
      conflict: true,
    };
    const store: MarkdownDraftCheckpointStore = {
      read: indexedDbMarkdownDrafts.read,
      replace: async (rowKey, token, next) => {
        if (rowKey === key && next === undefined)
          await indexedDbMarkdownDrafts.replace(rowKey, token, foreign);
        return indexedDbMarkdownDrafts.replace(rowKey, token, next);
      },
    };
    const owner = open({ journal: { key, store }, persist: async () => refused() });
    await owner.ready();
    const intent = (await owner.beginRename(from, destination))!;
    owner.change("C");
    await expect(
      owner.acknowledgeRename(intent, { destinationRelativePath: "b.txt", revision: "rA" }),
    ).resolves.toBe(true);
    expect(await indexedDbMarkdownDrafts.read(key)).toEqual(foreign);
    expect(await indexedDbMarkdownDrafts.read(destinationKey)).toMatchObject({
      baselineSource: "A",
      draftSource: "C",
    });
  });
});
