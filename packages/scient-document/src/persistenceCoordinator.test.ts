import { describe, expect, it, vi } from "vite-plus/test";

import {
  DocumentPersistenceCoordinator,
  type DocumentPersistenceFailureKind,
  type DocumentPersistenceOptions,
  type DocumentPersistenceReadResult,
  type ReconcileDocument,
} from "./persistenceCoordinator.ts";
import type { DocumentSaveIntent } from "./session.ts";
import { reconcileKeyedLines, type KeyedLinesReconciliation } from "./testing/keyedLines.ts";

function deferred<A>() {
  let resolve!: (value: A) => void;
  const promise = new Promise<A>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}

const classifyFailure = (error: unknown): DocumentPersistenceFailureKind =>
  error === "conflict" ? "conflict" : "terminal";

function fixture(
  overrides: Partial<DocumentPersistenceOptions<KeyedLinesReconciliation>> & {
    readonly source?: string;
  } = {},
) {
  const initial = overrides.source ?? "a=1\nb=1\n";
  let disk = { source: initial, revision: "r0" };
  let revisions = 0;
  const write = vi.fn(async (intent: DocumentSaveIntent) => {
    if (intent.expectedRevision !== disk.revision) throw "conflict";
    revisions += 1;
    disk = { source: intent.source, revision: `r${revisions}` };
    return { revision: disk.revision };
  });
  const read = vi.fn(async (): Promise<DocumentPersistenceReadResult> => disk);
  const reconcile = vi.fn<ReconcileDocument<KeyedLinesReconciliation>>(reconcileKeyedLines);
  const coordinator = new DocumentPersistenceCoordinator<KeyedLinesReconciliation>({
    source: initial,
    revision: "r0",
    write,
    read,
    classifyFailure,
    reconcile,
    debounceMs: 100,
    maxWaitMs: 500,
    ...overrides,
  });
  return {
    coordinator,
    write,
    read,
    reconcile,
    disk: () => disk,
    setDisk: (source: string) => {
      revisions += 1;
      disk = { source, revision: `r${revisions}` };
    },
  };
}

describe("DocumentPersistenceCoordinator with an injected reconciliation", () => {
  it("passes the baseline, local draft, and verified disk bytes to the format's strategy", async () => {
    const h = fixture();
    h.setDisk("a=1\nb=agent\n");
    h.coordinator.change("a=mine\nb=1\n");
    expect(await h.coordinator.flushNow()).toBe(true);
    expect(h.reconcile).toHaveBeenCalledWith("a=1\nb=1\n", "a=mine\nb=1\n", "a=1\nb=agent\n");
    expect(h.disk().source).toBe("a=mine\nb=agent\n");
    expect(h.coordinator.getSnapshot()).toMatchObject({
      draftSource: "a=mine\nb=agent\n",
      pending: false,
      conflict: null,
    });
  });

  it("hands the strategy's format-specific detail to external-update preparation", async () => {
    const prepare = vi.fn(() => () => {});
    const h = fixture({ prepareExternalUpdate: prepare });
    h.setDisk("a=1\nb=agent\n");
    h.coordinator.change("a=mine\nb=1\n");
    expect(await h.coordinator.flushNow()).toBe(true);
    expect(prepare).toHaveBeenCalledWith(
      expect.objectContaining({
        source: "a=mine\nb=agent\n",
        changedKeys: ["b"],
        previousSource: "a=mine\nb=1\n",
      }),
    );
  });

  it("keeps both versions as an explicit conflict when the strategy cannot combine them", async () => {
    const h = fixture();
    h.setDisk("a=agent\nb=1\n");
    h.coordinator.change("a=mine\nb=1\n");
    expect(await h.coordinator.flushNow()).toBe(false);
    expect(h.coordinator.getSnapshot()).toMatchObject({
      draftSource: "a=mine\nb=1\n",
      conflict: { externalSource: "a=agent\nb=1\n" },
    });
    expect(h.disk().source).toBe("a=agent\nb=1\n");
  });

  it("treats a throwing strategy like an unmergeable change and keeps both versions", async () => {
    const report = vi.spyOn(console, "error").mockImplementation(() => {});
    const h = fixture({
      reconcile: () => {
        throw new Error("strategy defect");
      },
    });
    h.setDisk("a=1\nb=agent\n");
    h.coordinator.change("a=mine\nb=1\n");
    expect(await h.coordinator.flushNow()).toBe(false);
    expect(h.coordinator.getSnapshot()).toMatchObject({
      draftSource: "a=mine\nb=1\n",
      error: null,
      conflict: { externalSource: "a=1\nb=agent\n" },
    });
    expect(report).toHaveBeenCalledWith("Document reconciliation failed:", expect.any(Error));
    report.mockRestore();
  });

  it("adopts an external change while clean even when the strategy declines to merge", async () => {
    const h = fixture({ reconcile: () => null });
    h.setDisk("a=agent\nb=1\n");
    h.coordinator.noteFreshnessHint();
    expect(await h.coordinator.flushNow()).toBe(true);
    expect(h.write).not.toHaveBeenCalled();
    expect(h.coordinator.getSnapshot()).toMatchObject({
      draftSource: "a=agent\nb=1\n",
      baselineSource: "a=agent\nb=1\n",
      pending: false,
    });
  });

  it("does not let an older save acknowledgement clear newer edits", async () => {
    const held = deferred<{ readonly revision: string }>();
    const writes: DocumentSaveIntent[] = [];
    const h = fixture({
      write: (intent) => {
        writes.push(intent);
        return writes.length === 1 ? held.promise : Promise.resolve({ revision: "r2" });
      },
    });
    h.coordinator.change("a=2\nb=1\n");
    const first = h.coordinator.flushNow();
    await Promise.resolve();
    h.coordinator.change("a=3\nb=1\n");
    held.resolve({ revision: "r1" });
    expect(await first).toBe(true);
    expect(writes.map((intent) => intent.source)).toEqual(["a=2\nb=1\n", "a=3\nb=1\n"]);
    expect(writes[1]?.expectedRevision).toBe("r1");
    expect(h.coordinator.getSnapshot()).toMatchObject({
      baselineSource: "a=3\nb=1\n",
      draftSource: "a=3\nb=1\n",
      pending: false,
    });
  });

  it("rejects a change based on a stale edit version without replacing newer text", () => {
    const h = fixture();
    const base = h.coordinator.getSnapshot().editVersion;
    expect(h.coordinator.change("a=2\nb=1\n", base)).toBe(true);
    expect(h.coordinator.change("a=stale\nb=1\n", base)).toBe(false);
    expect(h.coordinator.getSnapshot().draftSource).toBe("a=2\nb=1\n");
  });
});

describe("DocumentPersistenceCoordinator pending-input holds", () => {
  it("defers an in-flight clean refresh and re-reads the latest disk after release", async () => {
    const firstRead = deferred<DocumentPersistenceReadResult>();
    const read = vi
      .fn<() => Promise<DocumentPersistenceReadResult>>()
      .mockImplementationOnce(() => firstRead.promise)
      .mockResolvedValue({ source: "a=newest\nb=1\n", revision: "r2" });
    const h = fixture({ read });
    h.coordinator.noteFreshnessHint();
    const release = h.coordinator.suspendExternalUpdates();
    firstRead.resolve({ source: "a=older\nb=1\n", revision: "r1" });
    await Promise.resolve();
    expect(h.coordinator.getSnapshot()).toMatchObject({
      baselineSource: "a=1\nb=1\n",
      baselineRevision: "r0",
      draftSource: "a=1\nb=1\n",
      pending: true,
    });
    expect(read).toHaveBeenCalledTimes(1);
    release();
    expect(await h.coordinator.flushNow()).toBe(true);
    expect(read).toHaveBeenCalledTimes(2);
    expect(h.coordinator.getSnapshot()).toMatchObject({
      baselineRevision: "r2",
      draftSource: "a=newest\nb=1\n",
      pending: false,
    });
    expect(h.write).not.toHaveBeenCalled();
  });

  it("does not advance a same-source revision from an in-flight read during a hold", async () => {
    const firstRead = deferred<DocumentPersistenceReadResult>();
    const read = vi
      .fn<() => Promise<DocumentPersistenceReadResult>>()
      .mockImplementationOnce(() => firstRead.promise)
      .mockResolvedValue({ source: "a=1\nb=1\n", revision: "r2" });
    const h = fixture({ read });
    h.coordinator.noteFreshnessHint();
    const release = h.coordinator.suspendExternalUpdates();
    firstRead.resolve({ source: "a=1\nb=1\n", revision: "r1" });
    await Promise.resolve();
    expect(h.coordinator.getSnapshot().baselineRevision).toBe("r0");
    release();
    expect(await h.coordinator.flushNow()).toBe(true);
    expect(h.coordinator.getSnapshot().baselineRevision).toBe("r2");
  });

  it("stops adoption when a projection preparation acquires a hold synchronously", async () => {
    let release: (() => void) | undefined;
    const applyProjection = vi.fn();
    const prepare = vi.fn(() => {
      release ??= h.coordinator.suspendExternalUpdates();
      return applyProjection;
    });
    const h = fixture({ prepareExternalUpdate: prepare });
    h.setDisk("a=agent\nb=1\n");
    h.coordinator.noteFreshnessHint();
    await Promise.resolve();
    expect(h.coordinator.getSnapshot()).toMatchObject({
      baselineRevision: "r0",
      draftSource: "a=1\nb=1\n",
      pending: true,
    });
    expect(applyProjection).not.toHaveBeenCalled();
    release?.();
    expect(await h.coordinator.flushNow()).toBe(true);
    expect(h.coordinator.getSnapshot().draftSource).toBe("a=agent\nb=1\n");
    expect(applyProjection).toHaveBeenCalledTimes(1);
  });

  it("does not update a presented conflict from a read resolving during a hold", async () => {
    const firstRead = deferred<DocumentPersistenceReadResult>();
    const read = vi
      .fn<() => Promise<DocumentPersistenceReadResult>>()
      .mockImplementationOnce(() => firstRead.promise)
      .mockResolvedValue({ source: "a=newest\nb=1\n", revision: "r2" });
    const h = fixture({
      read,
      draftSource: "a=mine\nb=1\n",
      initialConflict: { externalSource: "a=agent\nb=1\n", externalRevision: "r1" },
    });
    const refresh = h.coordinator.refresh();
    const release = h.coordinator.suspendExternalUpdates();
    firstRead.resolve({ source: "a=intermediate\nb=1\n", revision: "r-intermediate" });
    await Promise.resolve();
    expect(h.coordinator.getSnapshot().conflict?.externalRevision).toBe("r1");
    release();
    expect(await refresh).toBe(false);
    await Promise.resolve();
    expect(h.coordinator.getSnapshot()).toMatchObject({
      draftSource: "a=mine\nb=1\n",
      conflict: { externalSource: "a=newest\nb=1\n", externalRevision: "r2" },
    });
    expect(h.write).not.toHaveBeenCalled();
  });

  it("invalidates a read begun before the hold even if it resolves after release", async () => {
    const firstRead = deferred<DocumentPersistenceReadResult>();
    const nextRead = deferred<DocumentPersistenceReadResult>();
    const read = vi
      .fn<() => Promise<DocumentPersistenceReadResult>>()
      .mockImplementationOnce(() => firstRead.promise)
      .mockImplementationOnce(() => nextRead.promise);
    const h = fixture({ read });
    h.coordinator.noteFreshnessHint();
    const release = h.coordinator.suspendExternalUpdates();
    release();
    firstRead.resolve({ source: "a=stale\nb=1\n", revision: "r1" });
    await Promise.resolve();
    expect(h.coordinator.getSnapshot().draftSource).toBe("a=1\nb=1\n");
    expect(read).toHaveBeenCalledTimes(2);
    nextRead.resolve({ source: "a=newest\nb=1\n", revision: "r2" });
    expect(await h.coordinator.flushNow()).toBe(true);
    expect(h.coordinator.getSnapshot().draftSource).toBe("a=newest\nb=1\n");
  });

  it("does not adopt a disk-resolution read while input is held", async () => {
    const firstRead = deferred<DocumentPersistenceReadResult>();
    const nextRead = deferred<DocumentPersistenceReadResult>();
    const read = vi
      .fn<() => Promise<DocumentPersistenceReadResult>>()
      .mockImplementationOnce(() => firstRead.promise)
      .mockImplementationOnce(() => nextRead.promise);
    const h = fixture({
      read,
      draftSource: "a=mine\nb=1\n",
      initialConflict: { externalSource: "a=agent\nb=1\n", externalRevision: "r1" },
    });
    const chosenDisk = h.coordinator.resolveWithDisk();
    const release = h.coordinator.suspendExternalUpdates();
    firstRead.resolve({ source: "a=agent\nb=1\n", revision: "r1" });
    await Promise.resolve();
    expect(h.coordinator.getSnapshot()).toMatchObject({
      baselineRevision: "r0",
      draftSource: "a=mine\nb=1\n",
      recoverySource: null,
    });
    h.coordinator.change("a=corrected\nb=1\n");
    release();
    nextRead.resolve({ source: "a=newest\nb=1\n", revision: "r2" });
    expect(await chosenDisk).toBe(false);
    await Promise.resolve();
    expect(h.coordinator.getSnapshot().draftSource).toBe("a=corrected\nb=1\n");
    expect(h.write).not.toHaveBeenCalled();
  });

  it("drops a read failure from before a hold instead of blocking the corrected input", async () => {
    let rejectRead!: (error: unknown) => void;
    const firstRead = new Promise<DocumentPersistenceReadResult>((_resolve, reject) => {
      rejectRead = reject;
    });
    const read = vi
      .fn<() => Promise<DocumentPersistenceReadResult>>()
      .mockImplementationOnce(() => firstRead)
      .mockResolvedValue({ source: "a=1\nb=1\n", revision: "r0" });
    const h = fixture({ read });
    h.coordinator.noteFreshnessHint();
    const release = h.coordinator.suspendExternalUpdates();
    rejectRead(new Error("superseded read failed"));
    await Promise.resolve();
    expect(h.coordinator.getSnapshot().error).toBeNull();
    h.coordinator.change("a=corrected\nb=1\n");
    release();
    expect(await h.coordinator.flushNow()).toBe(true);
    expect(h.disk().source).toBe("a=corrected\nb=1\n");
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("verifies disk and combines a corrected source before publishing it", async () => {
    const h = fixture();
    const release = h.coordinator.suspendExternalUpdates();
    h.setDisk("a=1\nb=agent\n");
    h.coordinator.noteFreshnessHint();
    expect(h.coordinator.change("a=corrected\nb=1\n")).toBe(true);
    expect(await h.coordinator.flushNow()).toBe(false);
    expect(h.read).not.toHaveBeenCalled();
    expect(h.write).not.toHaveBeenCalled();
    release();
    expect(await h.coordinator.flushNow()).toBe(true);
    expect(h.read).toHaveBeenCalledTimes(1);
    expect(h.read.mock.invocationCallOrder[0]).toBeLessThan(h.write.mock.invocationCallOrder[0]!);
    expect(h.write).toHaveBeenCalledWith(
      expect.objectContaining({ source: "a=corrected\nb=agent\n", expectedRevision: "r1" }),
    );
    expect(h.disk().source).toBe("a=corrected\nb=agent\n");
  });

  it("retains conflicting disk edits when corrected input is released", async () => {
    const h = fixture();
    const release = h.coordinator.suspendExternalUpdates();
    h.setDisk("a=agent\nb=1\n");
    h.coordinator.change("a=corrected\nb=1\n");
    release();
    expect(await h.coordinator.flushNow()).toBe(false);
    expect(h.coordinator.getSnapshot()).toMatchObject({
      draftSource: "a=corrected\nb=1\n",
      conflict: { externalSource: "a=agent\nb=1\n" },
    });
    expect(h.write).not.toHaveBeenCalled();
    expect(h.disk().source).toBe("a=agent\nb=1\n");
  });

  it("waits for all holders, releases idempotently, and prevents clean eviction", async () => {
    const h = fixture();
    const firstRelease = h.coordinator.suspendExternalUpdates();
    const lastRelease = h.coordinator.suspendExternalUpdates();
    h.coordinator.noteFreshnessHint();
    expect(h.coordinator.dispose()).toBe(false);
    expect(h.coordinator.retireClean()).toBe(false);
    expect(h.coordinator.holdForRename()).toBeNull();
    firstRelease();
    firstRelease();
    expect(h.coordinator.getSnapshot().pending).toBe(true);
    expect(h.read).not.toHaveBeenCalled();
    h.coordinator.change("a=mine\nb=1\n");
    expect(h.write).not.toHaveBeenCalled();
    lastRelease();
    lastRelease();
    expect(await h.coordinator.flushNow()).toBe(true);
    expect(h.read).toHaveBeenCalledTimes(1);
    expect(h.write).toHaveBeenCalledTimes(1);
    expect(h.coordinator.dispose()).toBe(true);
  });

  it("allows an accepted in-flight publication to acknowledge without starting newer work", async () => {
    const acknowledged = deferred<{ readonly revision: string }>();
    const write = vi.fn(() => acknowledged.promise);
    const h = fixture({
      write,
      read: async () => ({ source: "a=accepted\nb=1\n", revision: "r1" }),
    });
    h.coordinator.change("a=accepted\nb=1\n");
    const saved = h.coordinator.flushNow();
    const release = h.coordinator.suspendExternalUpdates();
    acknowledged.resolve({ revision: "r1" });
    await Promise.resolve();
    expect(h.coordinator.getSnapshot()).toMatchObject({
      baselineSource: "a=accepted\nb=1\n",
      baselineRevision: "r1",
      pending: true,
      inFlight: false,
    });
    expect(write).toHaveBeenCalledTimes(1);
    release();
    expect(await saved).toBe(true);
    expect(write).toHaveBeenCalledTimes(1);
  });
});

describe("DocumentPersistenceCoordinator.applyEdit", () => {
  it("takes a planned edit into the working source and saves it like any change", async () => {
    const h = fixture();
    const version = h.coordinator.getSnapshot().editVersion;
    expect(
      h.coordinator.applyEdit({
        basedOnVersion: version,
        patches: [{ start: 2, end: 3, replacement: "mine", expected: "1" }],
      }),
    ).toEqual({ accepted: true });
    expect(h.coordinator.getSnapshot()).toMatchObject({
      draftSource: "a=mine\nb=1\n",
      editVersion: version + 1,
      pending: true,
    });
    expect(await h.coordinator.flushNow()).toBe(true);
    expect(h.disk().source).toBe("a=mine\nb=1\n");
  });

  it("refuses a plan made against an older working source", () => {
    const h = fixture();
    const planned = h.coordinator.getSnapshot().editVersion;
    h.coordinator.change("a=1\nb=typed since\n");
    const before = h.coordinator.getSnapshot();
    expect(
      h.coordinator.applyEdit({
        basedOnVersion: planned,
        patches: [{ start: 2, end: 3, replacement: "mine" }],
      }),
    ).toEqual({ accepted: false, reason: "version" });
    expect(h.coordinator.getSnapshot()).toBe(before);
  });

  it.each([
    ["stale", [{ start: 2, end: 3, replacement: "x", expected: "9" }]],
    ["bounds", [{ start: 2, end: 99, replacement: "x" }]],
    [
      "overlap",
      [
        { start: 0, end: 3, replacement: "x" },
        { start: 2, end: 4, replacement: "y" },
      ],
    ],
  ] as const)(
    "refuses an unsafe plan (%s) and leaves the working source untouched",
    (reason, patches) => {
      const h = fixture();
      const before = h.coordinator.getSnapshot();
      expect(h.coordinator.applyEdit({ basedOnVersion: before.editVersion, patches })).toEqual({
        accepted: false,
        reason,
      });
      expect(h.coordinator.getSnapshot()).toBe(before);
      expect(h.write).not.toHaveBeenCalled();
    },
  );

  it("refuses while the document cannot take edits", () => {
    const h = fixture();
    const version = h.coordinator.getSnapshot().editVersion;
    const release = h.coordinator.holdForRename();
    expect(release).not.toBeNull();
    expect(
      h.coordinator.applyEdit({
        basedOnVersion: version,
        patches: [{ start: 2, end: 3, replacement: "mine" }],
      }),
    ).toEqual({ accepted: false, reason: "unavailable" });
    release?.();
    expect(
      h.coordinator.applyEdit({
        basedOnVersion: version,
        patches: [{ start: 2, end: 3, replacement: "mine" }],
      }),
    ).toEqual({ accepted: true });
  });

  it("accepts a plan that changes nothing without creating an edit", () => {
    const h = fixture();
    const before = h.coordinator.getSnapshot();
    expect(h.coordinator.applyEdit({ basedOnVersion: before.editVersion, patches: [] })).toEqual({
      accepted: true,
    });
    expect(h.coordinator.getSnapshot().editVersion).toBe(before.editVersion);
  });

  it("accepts a plan whose patches leave the source as it is, without creating an edit", () => {
    const h = fixture();
    const before = h.coordinator.getSnapshot();
    expect(
      h.coordinator.applyEdit({
        basedOnVersion: before.editVersion,
        patches: [{ start: 2, end: 3, replacement: "1", expected: "1" }],
      }),
    ).toEqual({ accepted: true });
    expect(h.coordinator.getSnapshot()).toBe(before);
    expect(h.write).not.toHaveBeenCalled();
  });

  it("refuses once the owner is disposed", () => {
    const h = fixture();
    const version = h.coordinator.getSnapshot().editVersion;
    expect(h.coordinator.dispose()).toBe(true);
    expect(h.coordinator.applyEdit({ basedOnVersion: version, patches: [] })).toEqual({
      accepted: false,
      reason: "unavailable",
    });
  });

  it("refuses a plan made before an outside change was merged in", async () => {
    const h = fixture();
    h.coordinator.change("a=mine\nb=1\n");
    const planned = h.coordinator.getSnapshot().editVersion;
    h.setDisk("a=1\nb=agent\n");
    expect(await h.coordinator.flushNow()).toBe(true);
    // The working source now holds both changes; the old plan no longer fits it.
    expect(h.coordinator.getSnapshot().draftSource).toBe("a=mine\nb=agent\n");
    expect(
      h.coordinator.applyEdit({
        basedOnVersion: planned,
        patches: [{ start: 9, end: 10, replacement: "2" }],
      }),
    ).toEqual({ accepted: false, reason: "version" });
    expect(h.coordinator.getSnapshot().draftSource).toBe("a=mine\nb=agent\n");
  });

  it("keeps taking edits during a conflict, without publishing them", async () => {
    const h = fixture();
    h.setDisk("a=agent\nb=1\n");
    h.coordinator.change("a=mine\nb=1\n");
    expect(await h.coordinator.flushNow()).toBe(false);
    const conflicted = h.coordinator.getSnapshot();
    expect(conflicted.conflict).not.toBeNull();
    const writes = h.write.mock.calls.length;
    expect(
      h.coordinator.applyEdit({
        basedOnVersion: conflicted.editVersion,
        patches: [{ start: 9, end: 10, replacement: "2", expected: "1" }],
      }),
    ).toEqual({ accepted: true });
    expect(h.coordinator.getSnapshot()).toMatchObject({ draftSource: "a=mine\nb=2\n" });
    expect(h.coordinator.getSnapshot().conflict).not.toBeNull();
    expect(h.write.mock.calls.length).toBe(writes);
    expect(h.disk().source).toBe("a=agent\nb=1\n");
  });

  it("lets a defect that is not a patch problem surface instead of calling it a refusal", () => {
    const h = fixture();
    const version = h.coordinator.getSnapshot().editVersion;
    const broken = [
      {
        start: 0,
        end: 1,
        get replacement(): string {
          throw new Error("planner defect");
        },
      },
    ];
    expect(() => h.coordinator.applyEdit({ basedOnVersion: version, patches: broken })).toThrow(
      "planner defect",
    );
  });
});

describe("DocumentPersistenceCoordinator.pendingOnlyForRename", () => {
  it("is true only while a rename alone holds a clean document", () => {
    const h = fixture();
    expect(h.coordinator.pendingOnlyForRename()).toBe(false);
    const release = h.coordinator.holdForRename()!;
    expect(h.coordinator.getSnapshot().pending).toBe(true);
    expect(h.coordinator.pendingOnlyForRename()).toBe(true);
    // Another reason to be pending alongside the rename: no longer rename-only.
    const resume = h.coordinator.suspendExternalUpdates();
    expect(h.coordinator.pendingOnlyForRename()).toBe(false);
    resume();
    expect(h.coordinator.pendingOnlyForRename()).toBe(true);
    release();
    expect(h.coordinator.pendingOnlyForRename()).toBe(false);
  });
});
