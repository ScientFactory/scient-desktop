import "fake-indexeddb/auto";
import { EnvironmentId } from "@t3tools/contracts";
import { projectFileOperationKey } from "@t3tools/client-runtime/state/projects";
import { AsyncResult } from "effect/reactivity";
import * as Cause from "effect/Cause";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { indexedDbMarkdownDrafts } from "~/scient/markdownEditor/persistence/markdownDraftCheckpoint";
import {
  WorkspaceFileSessionRegistry,
  type WorkspaceFileSessionLeaseOptions,
} from "./workspaceFileSessionRegistry";

type Result = { revision: string };
const registries: WorkspaceFileSessionRegistry<Result, Error>[] = [];
const keys = new Set<string>();
let sequence = 0;
function registry() {
  const owner = new WorkspaceFileSessionRegistry<Result, Error>();
  registries.push(owner);
  return owner;
}
function options(
  extra: Partial<WorkspaceFileSessionLeaseOptions<Result, Error>> &
    Pick<WorkspaceFileSessionLeaseOptions<Result, Error>, "persist">,
): WorkspaceFileSessionLeaseOptions<Result, Error> {
  const key = extra.key ?? `generic-lease-${++sequence}`;
  keys.add(key);
  return {
    key,
    initialSource: "A",
    initialRevision: "rA",
    journalStore: indexedDbMarkdownDrafts,
    debounceMs: 500,
    revisionFromResult: (result) => result.revision,
    classifyFailure: () => "conflict",
    ...extra,
  };
}
beforeEach(() => vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] }));
afterEach(async () => {
  for (const owner of registries) owner.clear();
  registries.length = 0;
  for (const key of keys) {
    const copy = await indexedDbMarkdownDrafts.read(key);
    if (copy) await indexedDbMarkdownDrafts.replace(key, copy.token, undefined);
  }
  keys.clear();
  vi.useRealTimers();
});

describe("WorkspaceFileSessionRegistry durable leases", () => {
  it("serializes shared views and keeps every pending guard until newer input also lands", async () => {
    let disk = { source: "A", revision: "rA" };
    const admitted = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let hold = true;
    const persist = async (source: string, expected: string | undefined) => {
      if (hold) {
        hold = false;
        admitted.resolve();
        await release.promise;
      }
      if (expected !== disk.revision)
        return AsyncResult.failure<Result, Error>(Cause.fail(new Error("Revision changed")));
      disk = { source, revision: `r${source}` };
      return AsyncResult.success({ revision: disk.revision });
    };
    const owner = registry();
    const input = options({ persist });
    let firstPending = false;
    let secondPending = false;
    const first = owner.acquire({
      ...input,
      callbacks: {
        onPendingChange: (value) => {
          firstPending = value;
        },
      },
    });
    const second = owner.acquire({
      ...input,
      callbacks: {
        onPendingChange: (value) => {
          secondPending = value;
        },
      },
    });
    await first.ready();
    first.change("B");
    const saving = second.flush();
    await admitted.promise;
    second.change("C");
    expect([firstPending, secondPending]).toEqual([true, true]);
    expect(disk.source).toBe("A");
    release.resolve();
    await expect(saving).resolves.toBe(true);
    expect(disk).toEqual({ source: "C", revision: "rC" });
    expect([firstPending, secondPending]).toEqual([false, false]);
    expect(await indexedDbMarkdownDrafts.read(input.key)).toMatchObject({
      baselineSource: "C",
      draftSource: "C",
      publicationIntent: null,
    });
  });

  it("does not let a stale joining view regress the authoritative baseline", async () => {
    let disk = { source: "A", revision: "rA" };
    const persist = async (source: string, expected: string | undefined) => {
      if (expected !== disk.revision)
        return AsyncResult.failure<Result, Error>(Cause.fail(new Error("Revision changed")));
      disk = { source, revision: `r${source}` };
      return AsyncResult.success({ revision: disk.revision });
    };
    const owner = registry();
    const input = options({ persist });
    const first = owner.acquire(input);
    await first.ready();
    first.change("B");
    await first.flush();
    const stale = owner.acquire(input);
    stale.syncConfirmedFileRevision("rA", "A");
    stale.change("C");
    await expect(stale.flush()).resolves.toBe(true);
    expect(disk).toEqual({ source: "C", revision: "rC" });
    disk = { source: "D", revision: "rD" };
    stale.syncConfirmedFileRevision("rD", "D");
    stale.change("E");
    await expect(stale.flush()).resolves.toBe(true);
    expect(disk).toEqual({ source: "E", revision: "rE" });
  });

  it("keeps the shared writer suspended until every suspending view releases it", async () => {
    let disk = "A";
    const owner = registry();
    const input = options({
      persist: async (source) => {
        disk = source;
        return AsyncResult.success({ revision: "rB" });
      },
    });
    const first = owner.acquire(input);
    const second = owner.acquire(input);
    await first.ready();
    first.setSuspended(true);
    second.setSuspended(true);
    first.change("B");
    first.setSuspended(false);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(disk).toBe("A");
    second.release();
    await vi.advanceTimersByTimeAsync(500);
    await first.flush();
    expect(disk).toBe("B");
  });

  it("flushes final release but keeps stale callbacks inert when another view remounts", async () => {
    let disk = "A";
    const landed = Promise.withResolvers<void>();
    const owner = registry();
    const input = options({
      persist: async (source) => {
        disk = source;
        landed.resolve();
        return AsyncResult.success({ revision: `r${source}` });
      },
    });
    const first = owner.acquire(input);
    await first.ready();
    first.change("B");
    first.release();
    await landed.promise;
    expect(disk).toBe("B");
    const successor = owner.acquire({ ...input, initialSource: "B", initialRevision: "rB" });
    await successor.ready();
    first.change("retired callback");
    await expect(first.flush()).resolves.toBe(false);
    successor.change("C");
    await expect(successor.flush()).resolves.toBe(true);
    expect(disk).toBe("C");
  });

  it("restores an unmounted conflicted draft from the store in a new registry, not the old map", async () => {
    let disk = { source: "D", revision: "rD" };
    const persist = async (source: string, expected: string | undefined) => {
      if (expected !== disk.revision)
        return AsyncResult.failure<Result, Error>(Cause.fail(new Error("Conflict")));
      disk = { source, revision: `r${source}` };
      return AsyncResult.success({ revision: disk.revision });
    };
    const original = registry();
    const input = options({ persist });
    const first = original.acquire(input);
    await first.ready();
    first.change("B");
    await expect(first.flush()).resolves.toBe(false);
    original.clear();
    let shown = "D";
    const successor = registry().acquire({
      ...input,
      initialSource: "D",
      initialRevision: "rD",
      callbacks: {
        onRestoredSource: (source) => {
          shown = source;
        },
      },
    });
    await successor.ready();
    expect(shown).toBe("B");
    await expect(successor.flush()).resolves.toBe(false);
    expect(disk.source).toBe("D");
    successor.retryPending("rD");
    await expect(successor.flush()).resolves.toBe(true);
    expect(disk).toEqual({ source: "B", revision: "rB" });
  });

  it("preserves independent workspace identities while one journal refuses admission", async () => {
    let diskA = "A";
    let diskB = "A";
    const owner = registry();
    const first = owner.acquire(
      options({
        journalStore: { read: async () => undefined, replace: async () => false },
        persist: async (source) => {
          diskA = source;
          return AsyncResult.success({ revision: "rB" });
        },
      }),
    );
    const second = owner.acquire(
      options({
        persist: async (source) => {
          diskB = source;
          return AsyncResult.success({ revision: "rC" });
        },
      }),
    );
    first.change("B");
    second.change("C");
    await expect(first.flush()).resolves.toBe(false);
    await expect(second.flush()).resolves.toBe(true);
    expect([diskA, diskB]).toEqual(["A", "C"]);
  });

  it("releases a genuinely clean journal after retirement and waits cleanup before reacquiring the same key", async () => {
    const released = Promise.withResolvers<void>();
    let disk = { source: "A", revision: "rA" };
    const input = options({
      journalStore: {
        read: (key) => indexedDbMarkdownDrafts.read(key),
        replace: async (key, expected, next) => {
          const accepted = await indexedDbMarkdownDrafts.replace(key, expected, next);
          if (accepted && next === undefined) released.resolve();
          return accepted;
        },
      },
      persist: async (source, expected) => {
        if (expected !== disk.revision)
          return AsyncResult.failure<Result, Error>(Cause.fail(new Error("Revision changed")));
        disk = { source, revision: `r${source}` };
        return AsyncResult.success({ revision: disk.revision });
      },
    });
    const owner = registry();
    const first = owner.acquire(input);
    await first.ready();
    first.release();
    await released.promise;
    expect(await indexedDbMarkdownDrafts.read(input.key)).toBeUndefined();
    disk = { source: "D", revision: "rD" };
    const fresh = owner.acquire({ ...input, initialSource: "D", initialRevision: "rD" });
    await fresh.ready();
    first.change("stale retired input");
    fresh.change("E");
    await expect(fresh.flush()).resolves.toBe(true);
    expect(disk).toEqual({ source: "E", revision: "rE" });
  });

  it("retires a settled old pathname without trapping a subsequently recreated file in the retired registry entry", async () => {
    const from = {
      environmentId: EnvironmentId.make("generic-lease-rename"),
      cwd: "/repo",
      relativePath: "a.txt",
    };
    const destination = { ...from, relativePath: "b.txt" };
    const key = projectFileOperationKey(from);
    keys.add(projectFileOperationKey(destination));
    let disk = { source: "A", revision: "rA" };
    const input = options({
      key,
      persist: async (source, expected) => {
        if (expected !== disk.revision)
          return AsyncResult.failure<Result, Error>(Cause.fail(new Error("Revision changed")));
        disk = { source, revision: `r${source}` };
        return AsyncResult.success({ revision: disk.revision });
      },
    });
    const owner = registry();
    const source = owner.acquire(input);
    await source.ready();
    const intent = (await source.beginRename(from, destination))!;
    await expect(
      source.acknowledgeRename(intent, { destinationRelativePath: "b.txt", revision: "rA" }),
    ).resolves.toBe(true);
    disk = { source: "D", revision: "rD" };
    const recreated = owner.acquire({ ...input, initialSource: "D", initialRevision: "rD" });
    await recreated.ready();
    source.change("stale original source");
    recreated.change("E");
    await expect(recreated.flush()).resolves.toBe(true);
    expect(disk).toEqual({ source: "E", revision: "rE" });
    expect(await indexedDbMarkdownDrafts.read(key)).toMatchObject({
      baselineSource: "E",
      draftSource: "E",
    });
  });
});
