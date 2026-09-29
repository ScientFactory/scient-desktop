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
