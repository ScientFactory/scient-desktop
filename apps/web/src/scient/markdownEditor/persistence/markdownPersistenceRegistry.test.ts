import { EnvironmentId, type ProjectReadFileResult } from "@t3tools/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { MarkdownSaveIntent } from "@scientfactory/scient-markdown";
import type { MarkdownPersistenceTransport } from "./markdownPersistenceTransport";
import type {
  MarkdownDraftCheckpoint,
  MarkdownDraftCheckpointStore,
} from "./markdownDraftCheckpoint";

vi.mock("./markdownPersistenceTransport", () => ({ createMarkdownPersistenceTransport: vi.fn() }));

import {
  adoptRendererRegistry,
  documentKeepsCheckpoint,
  MarkdownPersistenceRegistry,
  type MarkdownPersistenceTarget,
} from "./markdownPersistenceRegistry";

const target: MarkdownPersistenceTarget = {
  environmentId: EnvironmentId.make("synthetic-environment"),
  cwd: "/synthetic-workspace",
  relativePath: "notes.md",
};
const initial: ProjectReadFileResult = {
  relativePath: target.relativePath,
  contents: "A",
  revision: "rA",
  byteLength: 1,
  truncated: false,
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

function setup(options: { cleanTtlMs?: number; cleanLimit?: number } = {}) {
  let source = "A";
  let revision = "rA";
  const transport: MarkdownPersistenceTransport = {
    write: vi.fn(async (intent: MarkdownSaveIntent) => {
      if (intent.expectedRevision !== revision) throw "conflict";
      source = intent.source;
      revision = `r${source}`;
      return { revision };
    }),
    read: vi.fn(async () => ({ source, revision })),
    classifyFailure: (error) => (error === "conflict" ? "conflict" : "terminal"),
    subscribe: vi.fn(() => vi.fn()),
    project: vi.fn(),
  };
  const createTransport = vi.fn(() => transport);
  const registry = new MarkdownPersistenceRegistry({
    createTransport,
    debounceMs: 250,
    ...options,
  });
  return {
    registry,
    transport,
    createTransport,
    externalChange(next: string) {
      source = next;
      revision = `r${next}`;
    },
  };
}

describe("MarkdownPersistenceRegistry", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("retains unconverted input through released views and blocks publication and departure cleanup", async () => {
    const { registry, transport } = setup({ cleanTtlMs: 1, cleanLimit: 0 });
    const first = registry.acquire(target, initial)!;
    const pending = { message: "Cannot safely write this edit.", payload: { text: "Unconverted" } };
    const notify = vi.fn();
    const unsubscribe = first.subscribe(notify);
    first.retainPendingInput(pending);
    expect(notify).toHaveBeenCalled();
    expect(registry.getSnapshot()[0]).toMatchObject({ pending: true, attention: true });
    expect(first.change("Unsafe", 0)).toBe(false);
    expect(
      first.applyEdit({
        basedOnVersion: 0,
        patches: [{ start: 0, end: 1, replacement: "Unsafe", expected: "A" }],
      }),
    ).toEqual({ accepted: false, reason: "unavailable" });
    expect(await first.flushNow()).toBe(false);
    expect(await registry.flushTarget(target)).toBe(false);
    expect(await registry.flushWorkspace(target.environmentId, target.cwd)).toBe(false);
    expect(first.holdForRename()).toBeNull();
    expect(registry.forgetClean(target)).toBe(false);
    unsubscribe();
    first.release();
    await vi.advanceTimersByTimeAsync(10);
    expect(registry.has(target)).toBe(true);
    const reopened = registry.acquire(target, null)!;
    expect(reopened.getPendingInput()).toBe(pending);
    expect(reopened.getSnapshot().draftSource).toBe("A");
    expect(transport.write).not.toHaveBeenCalled();
    expect(reopened.claimPendingInput()).toBe(true);
    reopened.retainPendingInput(null);
    expect(registry.getSnapshot()[0]).toMatchObject({ pending: false, attention: false });
    reopened.release();
  });

  it("keeps outside source out of a pending rich input and verifies it before publishing a correction", async () => {
    const { registry, transport, externalChange } = setup();
    const lease = registry.acquire(target, initial)!;
    lease.retainPendingInput({ message: "Pending input", payload: {} });
    externalChange("Agent");
    lease.noteFreshnessHint();
    await vi.advanceTimersByTimeAsync(500);
    expect(lease.getSnapshot().draftSource).toBe("A");
    expect(transport.read).not.toHaveBeenCalled();
    lease.retainPendingInput(null);
    expect(lease.change("Corrected", 0)).toBe(true);
    await vi.advanceTimersByTimeAsync(500);
    expect(lease.getSnapshot()).toMatchObject({
      draftSource: "Corrected",
      conflict: { externalSource: "Agent", externalRevision: "rAgent" },
    });
    expect(transport.write).not.toHaveBeenCalled();
    lease.release();
  });

  it("protects a pending buffer from another lease and hands it off only after its owner releases", () => {
    const { registry } = setup();
    const first = registry.acquire(target, initial)!;
    const second = registry.acquire(target, null)!;
    const original = { message: "First pending", payload: { text: "First" } };
    const newer = { message: "Newer pending", payload: { text: "Newer" } };
    expect(first.retainPendingInput(original)).toBe(true);
    expect(second.canEditPendingInput()).toBe(false);
    expect(second.claimPendingInput()).toBe(false);
    expect(second.retainPendingInput(null)).toBe(false);
    expect(second.retainPendingInput(newer)).toBe(false);
    expect(first.retainPendingInput(newer)).toBe(true);
    expect(second.getPendingInput()).toBe(newer);
    first.release();
    expect(second.canEditPendingInput()).toBe(true);
    expect(second.retainPendingInput(null)).toBe(false);
    expect(second.claimPendingInput()).toBe(true);
    expect(first.retainPendingInput(null)).toBe(false);
    expect(second.getPendingInput()).toBe(newer);
    expect(second.retainPendingInput(null)).toBe(true);
    expect(registry.getSnapshot()[0]).toMatchObject({ pending: false, attention: false });
    second.release();
  });

  it("protects pending input between rich editors sharing one lease and releases the claim without discarding input", () => {
    const { registry } = setup();
    const lease = registry.acquire(target, initial)!;
    const firstEditor = {};
    const secondEditor = {};
    const pending = { message: "Pending", payload: {} };
    expect(lease.retainPendingInput(pending, firstEditor)).toBe(true);
    expect(lease.canEditPendingInput(secondEditor)).toBe(false);
    expect(lease.claimPendingInput(secondEditor)).toBe(false);
    expect(lease.retainPendingInput(null, secondEditor)).toBe(false);
    lease.releasePendingInputClaim(secondEditor);
    expect(lease.canEditPendingInput(secondEditor)).toBe(false);
    lease.releasePendingInputClaim(firstEditor);
    expect(lease.getPendingInput()).toBe(pending);
    expect(lease.claimPendingInput(secondEditor)).toBe(true);
    expect(lease.retainPendingInput(null, firstEditor)).toBe(false);
    expect(lease.retainPendingInput(null, secondEditor)).toBe(true);
    lease.release();
  });

  it("releases only the old hold when a clear observer synchronously retains newer input", async () => {
    const { registry, transport } = setup();
    const lease = registry.acquire(target, initial)!;
    const first = { message: "First", payload: {} };
    const next = { message: "Newer", payload: {} };
    lease.retainPendingInput(first);
    const unsubscribe = lease.subscribe(() => {
      if (lease.getPendingInput() === null) lease.retainPendingInput(next);
    });
    expect(lease.retainPendingInput(null)).toBe(true);
    expect(lease.getPendingInput()).toBe(next);
    expect(await lease.flushNow()).toBe(false);
    expect(transport.read).not.toHaveBeenCalled();
    unsubscribe();
    lease.retainPendingInput(null);
    const settled = vi.fn();
    const flush = lease.flushNow().then(settled);
    await vi.advanceTimersByTimeAsync(1);
    expect(settled).toHaveBeenCalledExactlyOnceWith(true);
    await flush;
    expect(transport.read).toHaveBeenCalledOnce();
    lease.release();
  });

  it("isolates a throwing pending-input observer and still releases its hold", async () => {
    const { registry } = setup();
    const lease = registry.acquire(target, initial)!;
    lease.retainPendingInput({ message: "Pending", payload: {} });
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const unsubscribe = lease.subscribe(() => {
      throw new Error("Observer failed");
    });
    expect(() => lease.retainPendingInput(null)).not.toThrow();
    unsubscribe();
    const settled = vi.fn();
    const flush = lease.flushNow().then(settled);
    await vi.advanceTimersByTimeAsync(1);
    expect(settled).toHaveBeenCalledExactlyOnceWith(true);
    await flush;
    expect(log).toHaveBeenCalled();
    log.mockRestore();
    lease.release();
  });

  it("exposes initial pending input consistently and refuses mutation before its hold is owned", async () => {
    const { registry } = setup();
    const lease = registry.acquire(target, initial)!;
    const first = { message: "Initial", payload: {} };
    const next = { message: "Reentrant", payload: {} };
    let attempted = false;
    const observed = vi.fn();
    const unsubscribe = lease.subscribe(() => {
      if (attempted) return;
      attempted = true;
      observed(lease.getPendingInput(), lease.retainPendingInput(next));
    });
    expect(lease.retainPendingInput(first)).toBe(true);
    expect(observed).toHaveBeenCalledExactlyOnceWith(first, false);
    expect(lease.getPendingInput()).toBe(first);
    unsubscribe();
    expect(lease.retainPendingInput(next)).toBe(true);
    lease.retainPendingInput(null);
    const settled = vi.fn();
    const flush = lease.flushNow().then(settled);
    await vi.advanceTimersByTimeAsync(1);
    expect(settled).toHaveBeenCalledExactlyOnceWith(true);
    await flush;
    lease.release();
  });

  it("prepares every mounted projection before committing and respects a veto", async () => {
    const { registry, externalChange } = setup();
    const base = "First\n\nSecond\n";
    const first = registry.acquire(target, { ...initial, contents: base })!;
    const second = registry.acquire(target, null)!;
    const apply = vi.fn();
    first.registerExternalProjection(() => apply);
    second.registerExternalProjection(() => null);
    first.change(base.replace("First", "Local"), 0);
    externalChange(base + "\nAgent\n");
    expect(await first.flushNow()).toBe(false);
    expect(apply).not.toHaveBeenCalled();
    expect(first.getSnapshot().draftSource).toBe(base.replace("First", "Local"));
    first.release();
    second.release();
  });

  it("releases a detached composing view's deferral without losing the retained draft", async () => {
    const { registry, externalChange, transport } = setup();
    const base = "First\n\nSecond\n";
    const first = registry.acquire(target, { ...initial, contents: base })!;
    first.registerExternalProjection(() => "defer");
    first.change(base.replace("First", "Local"), 0);
    externalChange(base + "\nAgent\n");
    const flushed = first.flushNow();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(first.getSnapshot()).toMatchObject({ pending: true, conflict: null });
    first.release();
    expect(await flushed).toBe(true);
    expect(transport.write).toHaveBeenLastCalledWith(
      expect.objectContaining({ source: base.replace("First", "Local") + "\nAgent\n" }),
    );
  });

  it("retains ancestry over remount while a write is in flight and rejects released callbacks", async () => {
    const { registry, transport, createTransport } = setup();
    const first = registry.acquire(target, initial)!;
    const held = deferred<{ revision: string }>();
    vi.mocked(transport.write).mockImplementationOnce(() => held.promise);
    first.change("B", 0);
    const firstSave = first.flushNow();
    first.release();
    const second = registry.acquire(target, initial, "stale optimistic source")!;
    expect(second.getSnapshot().draftSource).toBe("B");
    expect(second.change("C", 1)).toBe(true);
    expect(first.change("discard C", 2)).toBe(false);
    expect(await first.retry()).toBe(false);
    expect(createTransport).toHaveBeenCalledTimes(1);
    held.resolve({ revision: "rB" });
    // The second invocation is a real CAS lane against the newly confirmed B.
    vi.mocked(transport.write).mockImplementationOnce(async (intent) => {
      expect(intent).toMatchObject({ source: "C", expectedRevision: "rB" });
      return { revision: "rC" };
    });
    await second.flushNow();
    await firstSave;
    expect(transport.write).toHaveBeenCalledTimes(2);
    expect(second.getSnapshot()).toMatchObject({
      draftSource: "C",
      baselineRevision: "rC",
      pending: false,
      conflict: null,
    });
    second.release();
  });

  it("does not let a duplicate view submit an older full document", () => {
    const { registry } = setup();
    const first = registry.acquire(target, initial)!;
    const second = registry.acquire(target, initial)!;
    expect(first.change("B", 0)).toBe(true);
    expect(second.change("stale", 0)).toBe(false);
    expect(second.getSnapshot().draftSource).toBe("B");
    first.release();
    expect(registry.getSnapshot()).toEqual([{ ...target, pending: true, attention: false }]);
    second.release();
    expect(registry.getSnapshot()[0]?.pending).toBe(true);
  });

  it("never reactivates a released binding when a successor lease is acquired", () => {
    const { registry, transport } = setup();
    const listener = vi.fn();
    registry.subscribe(listener);
    const lease = registry.acquire(target, initial)!;
    expect(listener).toHaveBeenCalledTimes(1);
    expect(transport.subscribe).toHaveBeenCalledTimes(1);
    lease.release();
    const successor = registry.acquire(target, initial)!;
    expect(lease.change("B", 0)).toBe(false);
    expect(successor.change("B", 0)).toBe(true);
    successor.release();
  });

  it("requires a complete writable baseline only for a new entry", () => {
    const { registry } = setup();
    expect(registry.acquire(target, null)).toBeNull();
    expect(registry.acquire(target, { ...initial, truncated: true })).toBeNull();
    expect(registry.acquire(target, { ...initial, readOnly: true })).toBeNull();
    const lease = registry.acquire(target, initial)!;
    lease.change("B", 0);
    lease.release();
    expect(registry.acquire(target, null)?.getSnapshot().draftSource).toBe("B");
    expect(
      registry.acquire(target, { ...initial, truncated: true })?.getSnapshot().draftSource,
    ).toBe("B");
  });

  it("evicts only unleased clean entries after TTL, never unsaved edits", async () => {
    const { registry, transport } = setup({ cleanTtlMs: 1_000 });
    const clean = registry.acquire(target, initial)!;
    clean.release();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(registry.has(target)).toBe(false);
    vi.mocked(transport.write).mockRejectedValue(new Error("permanent failure"));
    const dirty = registry.acquire(target, initial)!;
    dirty.change("B", 0);
    dirty.release();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(registry.has(target)).toBe(true);
    expect(registry.getSnapshot()).toEqual([{ ...target, pending: true, attention: true }]);
  });

  it("does not retry or clear a conflict when its final lease is released", async () => {
    const { registry, transport, externalChange } = setup();
    const lease = registry.acquire(target, initial)!;
    externalChange("external");
    lease.change("B", 0);
    expect(await lease.flushNow()).toBe(false);
    expect(lease.getSnapshot().conflict?.externalSource).toBe("external");
    lease.release();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(transport.write).toHaveBeenCalledTimes(1);
    expect(registry.has(target)).toBe(true);
    expect(registry.getSnapshot()[0]?.attention).toBe(true);
  });

  it("flushes retained pending files even after views have gone", async () => {
    const { registry } = setup();
    const lease = registry.acquire(target, initial)!;
    lease.change("B", 0);
    lease.release();
    expect(await registry.flushWorkspace(target.environmentId, target.cwd)).toBe(true);
    expect(registry.getSnapshot()[0]?.pending).toBe(false);
  });

  it("bounds idle clean entries without evicting active or dirty entries", () => {
    const { registry } = setup({ cleanLimit: 1 });
    const active = registry.acquire(target, initial)!;
    const secondTarget = { ...target, relativePath: "second.md" };
    registry.acquire(secondTarget, { ...initial, relativePath: "second.md" })!.release();
    const thirdTarget = { ...target, relativePath: "third.md" };
    registry.acquire(thirdTarget, { ...initial, relativePath: "third.md" })!.release();
    expect(registry.has(target)).toBe(true);
    expect(registry.has(secondTarget)).toBe(false);
    expect(registry.has(thirdTarget)).toBe(true);
    active.release();
  });

  it("retires a successfully renamed clean identity even with an ordered read still running", async () => {
    const { registry, transport } = setup();
    const lease = registry.acquire(target, initial)!;
    const read = deferred<{ source: string; revision: string }>();
    vi.mocked(transport.read).mockReturnValueOnce(read.promise);
    lease.noteFreshnessHint("watch-ready");
    expect(lease.getSnapshot().reading).toBe(true);
    expect(registry.forgetClean(target)).toBe(true);
    expect(registry.has(target)).toBe(false);
    expect(lease.change("late callback", 0)).toBe(false);
    const projectCalls = vi.mocked(transport.project).mock.calls.length;
    read.resolve({ source: "obsolete", revision: "obsolete" });
    await Promise.resolve();
    lease.release();
    expect(transport.project).toHaveBeenCalledTimes(projectCalls);
    expect(registry.getSnapshot()).toEqual([]);
    const replacement = registry.acquire(target, {
      ...initial,
      contents: "new document",
      revision: "new revision",
    })!;
    expect(replacement.getSnapshot().draftSource).toBe("new document");
    replacement.release();
  });

  it("refuses to retire unsaved bytes under the rename cleanup API", () => {
    const { registry } = setup();
    const lease = registry.acquire(target, initial)!;
    lease.change("B", 0);
    expect(registry.forgetClean(target)).toBe(false);
    expect(registry.has(target)).toBe(true);
    expect(lease.change("C", 1)).toBe(true);
    lease.release();
  });

  it("shares a new-entry ordered bootstrap and never admits cached stale contents", async () => {
    const { registry, transport, createTransport } = setup();
    const read = deferred<{ source: string; revision: string }>();
    vi.mocked(transport.read).mockReturnValueOnce(read.promise);
    const first = registry.open(target);
    const second = registry.open(target);
    expect(transport.read).toHaveBeenCalledTimes(1);
    expect(registry.has(target)).toBe(false);
    read.resolve({ source: "B", revision: "rB" });
    const [lease1, lease2] = await Promise.all([first, second]);
    expect(createTransport).toHaveBeenCalledTimes(1);
    expect(lease1.getSnapshot()).toMatchObject({
      baselineSource: "B",
      draftSource: "B",
      pending: false,
    });
    expect(lease1.getSnapshot()).toBe(lease2.getSnapshot());
    expect(transport.write).not.toHaveBeenCalled();
    lease1.release();
    lease2.release();
  });

  it("freshly bootstraps after clean eviction instead of reviving a stale presentation baseline", async () => {
    const { registry, externalChange } = setup({ cleanTtlMs: 1_000 });
    const first = await registry.open(target);
    first.release();
    await vi.advanceTimersByTimeAsync(1_000);
    externalChange("B");
    const next = await registry.open(target);
    expect(next.getSnapshot().baselineSource).toBe("B");
    next.change("C", 0);
    expect(await next.flushNow()).toBe(true);
    expect(next.getSnapshot().conflict).toBeNull();
    next.release();
  });

  it("fails closed for an incomplete bootstrap and can retry without leaking a rejected initializer", async () => {
    const { registry, transport } = setup();
    vi.mocked(transport.read).mockResolvedValueOnce({
      source: "partial",
      revision: "partial",
      truncated: true,
    });
    await expect(registry.open(target)).rejects.toThrow("too large");
    expect(registry.has(target)).toBe(false);
    vi.mocked(transport.read).mockResolvedValueOnce({
      source: "read-only",
      revision: "locked",
      readOnly: true,
    });
    await expect(registry.open(target)).rejects.toThrow("read-only");
    const lease = await registry.open(target);
    expect(lease.getSnapshot().baselineSource).toBe("A");
    lease.release();
  });

  it("holds a clean document during rename and cannot retire unsaved source under the hold API", async () => {
    const { registry } = setup();
    const lease = registry.acquire(target, initial)!;
    const unlock = lease.holdForRename();
    expect(unlock).not.toBeNull();
    expect(lease.getSnapshot()).toMatchObject({ pending: true, editingBlocked: true });
    expect(lease.change("typed during rename", 0)).toBe(false);
    unlock!();
    expect(lease.change("B", 0)).toBe(true);
    expect(lease.holdForRename()).toBeNull();
    await lease.flushNow();
    const releaseRename = lease.holdForRename();
    expect(registry.forgetClean(target)).toBe(true);
    releaseRename?.();
    expect(lease.change("late", 1)).toBe(false);
    lease.release();
  });

  it("flushes only the exact requested target, leaving other documents debounced", async () => {
    const writes = vi.fn(async () => ({ revision: "next" }));
    const registry = new MarkdownPersistenceRegistry({
      createTransport: () => ({
        write: writes,
        read: async () => ({ source: "A", revision: "rA" }),
        classifyFailure: () => "terminal",
        subscribe: () => () => {},
        project: () => {},
      }),
    });
    const otherTarget = { ...target, relativePath: "other.md" };
    const first = registry.acquire(target, initial)!;
    const other = registry.acquire(otherTarget, { ...initial, relativePath: "other.md" })!;
    first.change("first", 0);
    other.change("other", 0);
    expect(await registry.flushTarget(target)).toBe(true);
    expect(writes).toHaveBeenCalledTimes(1);
    expect(other.getSnapshot().pending).toBe(true);
    first.release();
    other.release();
  });

  it("keeps the watcher and reconnect subscription until an unleased ordered read settles", async () => {
    const { registry, transport } = setup();
    const stop = vi.fn();
    vi.mocked(transport.subscribe).mockReturnValue(stop);
    const read = deferred<{ source: string; revision: string }>();
    vi.mocked(transport.read).mockReturnValue(read.promise);
    const lease = registry.acquire(target, initial)!;
    lease.noteFreshnessHint("file-changed");
    lease.release();
    expect(stop).not.toHaveBeenCalled();
    read.resolve({ source: "A", revision: "rA" });
    await Promise.resolve();
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it("keeps the renderer registry identity when its module is hot-reloaded", async () => {
    const before = await import("./markdownPersistenceRegistry");
    vi.resetModules();
    const after = await import("./markdownPersistenceRegistry");
    expect(after.markdownPersistenceRegistry).toBe(before.markdownPersistenceRegistry);
  });

  it.each([0, 128])(
    "retains a disconnected queued read until reconnect, then evicts (limit %i)",
    async (cleanLimit) => {
      const { registry, transport } = setup({ cleanTtlMs: 100, cleanLimit });
      const stop = vi.fn();
      let connected!: (value: boolean) => void;
      vi.mocked(transport.subscribe).mockImplementation((callbacks) => {
        connected = callbacks.connected;
        return stop;
      });
      const held = deferred<{ source: string; revision: string }>();
      vi.mocked(transport.read).mockReturnValueOnce(held.promise);
      const lease = registry.acquire(target, initial)!;
      lease.noteFreshnessHint("first");
      connected(false);
      lease.noteFreshnessHint("new-generation");
      lease.release();
      held.resolve({ source: "A", revision: "rA" });
      await Promise.resolve();
      expect(lease.getSnapshot()).toMatchObject({ reading: true, pending: false });
      expect(stop).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(500);
      expect(registry.has(target)).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
      expect(transport.read).toHaveBeenCalledOnce();
      connected(true);
      await vi.advanceTimersByTimeAsync(100);
      expect(transport.read).toHaveBeenCalledTimes(2);
      expect(stop).toHaveBeenCalledOnce();
      expect(registry.has(target)).toBe(false);
    },
  );

  it("acquires a bootstrapped entry atomically under clean-limit pressure", async () => {
    const { registry, transport } = setup({ cleanLimit: 0 });
    const other = registry.acquire({ ...target, relativePath: "other.md" }, initial)!;
    const held = deferred<{ source: string; revision: string }>();
    vi.mocked(transport.read).mockReturnValueOnce(held.promise);
    const opening = registry.open(target);
    held.resolve({ source: "A", revision: "rA" });
    // Exercise the former createEntry -> finally -> acquire admission gap.
    await Promise.resolve();
    await Promise.resolve();
    other.change("B", 0);
    const lease = await opening;
    expect(registry.has(target)).toBe(true);
    expect(lease.change("C", 0)).toBe(true);
    expect(await lease.flushNow()).toBe(true);
    lease.release();
    other.release();
  });

  it("keeps guards and saving correct when cache projection or another observer throws", async () => {
    const report = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const { registry, transport } = setup();
      vi.mocked(transport.project).mockImplementation(() => {
        throw new Error("presentation failed");
      });
      registry.subscribe(() => {
        throw new Error("observer failed");
      });
      const laterObserver = vi.fn();
      registry.subscribe(laterObserver);
      const lease = registry.acquire(target, initial)!;
      expect(lease.change("B", 0)).toBe(true);
      expect(registry.getSnapshot()[0]?.pending).toBe(true);
      expect(laterObserver).toHaveBeenCalled();
      expect(lease.getSnapshot().draftSource).toBe("B");
      expect(await registry.flushTarget(target)).toBe(true);
      expect(registry.getSnapshot()[0]?.pending).toBe(false);
      lease.release();
    } finally {
      report.mockRestore();
    }
  });
});

describe("a merge strategy per file", () => {
  const texTarget: MarkdownPersistenceTarget = { ...target, relativePath: "paper.tex" };
  const conflictOnly = vi.fn(() => null);
  const transport = (disk: () => { source: string; revision: string }) => ({
    read: async () => disk(),
    write: vi.fn(async (intent: MarkdownSaveIntent) => {
      if (intent.expectedRevision !== disk().revision) throw "conflict";
      return { revision: "written" };
    }),
    classifyFailure: (error: unknown): "conflict" | "terminal" =>
      error === "conflict" ? "conflict" : "terminal",
    subscribe: () => () => {},
    project: () => {},
  });

  beforeEach(() => {
    vi.useFakeTimers();
    conflictOnly.mockClear();
  });
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("uses the file's own strategy for an outside change, and Markdown's for other files", async () => {
    const disk = { source: "First\n\nSecond\n", revision: "r0" };
    const registry = new MarkdownPersistenceRegistry({
      createTransport: () => transport(() => disk),
      reconcile: (file) => (file.relativePath.endsWith(".tex") ? conflictOnly : undefined),
    });
    // The .tex file never merges: both versions are kept as a conflict.
    const tex = await registry.open(texTarget);
    tex.change("Local\n\nSecond\n", 0);
    disk.source = "First\n\nSecond\n\nAgent\n";
    disk.revision = "r1";
    expect(await tex.flushNow()).toBe(false);
    expect(conflictOnly).toHaveBeenCalledWith(
      "First\n\nSecond\n",
      "Local\n\nSecond\n",
      "First\n\nSecond\n\nAgent\n",
    );
    expect(tex.getSnapshot()).toMatchObject({
      draftSource: "Local\n\nSecond\n",
      conflict: { externalSource: "First\n\nSecond\n\nAgent\n" },
    });
    tex.release();
  });

  it("falls back to Markdown's merge when no strategy is given for a file", async () => {
    const disk = { source: "First\n\nSecond\n", revision: "r0" };
    const registry = new MarkdownPersistenceRegistry({
      createTransport: () => ({
        ...transport(() => disk),
        write: vi.fn(async (intent: MarkdownSaveIntent) => {
          if (intent.expectedRevision !== disk.revision) throw "conflict";
          disk.source = intent.source;
          disk.revision = "r2";
          return { revision: disk.revision };
        }),
      }),
    });
    const lease = await registry.open(target);
    lease.change("Local\n\nSecond\n", 0);
    disk.source = "First\n\nSecond\n\nAgent\n";
    disk.revision = "r1";
    expect(await lease.flushNow()).toBe(true);
    expect(lease.getSnapshot().draftSource).toBe("Local\n\nSecond\n\nAgent\n");
    lease.release();
  });

  it("uses the same strategy when a recovery checkpoint meets a changed file", async () => {
    const checkpoint = {
      token: "checkpoint",
      baselineSource: "First\n\nSecond\n",
      baselineRevision: "r0",
      draftSource: "Local\n\nSecond\n",
    };
    const registry = new MarkdownPersistenceRegistry({
      checkpointStore: { read: async () => checkpoint, replace: async () => true },
      createTransport: () =>
        transport(() => ({ source: "First\n\nSecond\n\nAgent\n", revision: "r1" })),
      reconcile: () => conflictOnly,
    });
    const lease = await registry.open(texTarget);
    // Markdown's merge would have combined these; this file's strategy keeps both.
    expect(conflictOnly).toHaveBeenCalledOnce();
    expect(lease.getSnapshot()).toMatchObject({
      draftSource: "Local\n\nSecond\n",
      baselineSource: "First\n\nSecond\n",
      conflict: { externalSource: "First\n\nSecond\n\nAgent\n", externalRevision: "r1" },
    });
    lease.release();
  });
});

describe("several projections and planned edits on one lease", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("asks every projection registered on one lease, and one veto stops them all", async () => {
    const { registry, externalChange } = setup();
    const base = "First\n\nSecond\n";
    const lease = registry.acquire(target, { ...initial, contents: base })!;
    const applySource = vi.fn();
    const prepareSource = vi.fn(() => applySource);
    const prepareRendered = vi.fn(() => null);
    lease.registerExternalProjection(prepareSource);
    const stopRendered = lease.registerExternalProjection(prepareRendered);
    lease.change(base.replace("First", "Local"), 0);
    externalChange(base + "\nAgent\n");
    expect(await lease.flushNow()).toBe(false);
    expect(prepareSource).toHaveBeenCalled();
    expect(prepareRendered).toHaveBeenCalled();
    expect(applySource).not.toHaveBeenCalled();
    // Once the vetoing projection leaves, the other one alone decides.
    stopRendered();
    expect(await lease.resolveWithLocal(lease.getSnapshot().conflict!.externalRevision)).toBe(true);
    lease.release();
  });

  it("keeps the other projection when one registered on the same lease is removed", async () => {
    const { registry, externalChange } = setup();
    const base = "First\n\nSecond\n";
    const lease = registry.acquire(target, { ...initial, contents: base })!;
    const apply = vi.fn();
    const stopFirst = lease.registerExternalProjection(() => () => {});
    lease.registerExternalProjection(() => apply);
    stopFirst();
    lease.change(base.replace("First", "Local"), 0);
    externalChange(base + "\nAgent\n");
    expect(await lease.flushNow()).toBe(true);
    expect(apply).toHaveBeenCalledOnce();
    lease.release();
  });

  it("takes a planned edit through a lease and refuses it on a released one", () => {
    const { registry } = setup();
    const lease = registry.acquire(target, { ...initial, contents: "one two" })!;
    expect(
      lease.applyEdit({
        basedOnVersion: 0,
        patches: [{ start: 4, end: 7, replacement: "2", expected: "two" }],
      }),
    ).toEqual({ accepted: true });
    expect(lease.getSnapshot().draftSource).toBe("one 2");
    expect(
      lease.applyEdit({ basedOnVersion: 0, patches: [{ start: 0, end: 3, replacement: "1" }] }),
    ).toEqual({ accepted: false, reason: "version" });
    const successor = registry.acquire(target, null)!;
    lease.release();
    expect(
      lease.applyEdit({ basedOnVersion: 1, patches: [{ start: 0, end: 3, replacement: "1" }] }),
    ).toEqual({ accepted: false, reason: "unavailable" });
    expect(successor.getSnapshot().draftSource).toBe("one 2");
    successor.release();
  });
});

describe("the registry a renderer keeps across hot reloads", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });
  /** A registry as code from before per-format strategies would have left it. */
  function earlier(registry: MarkdownPersistenceRegistry) {
    Object.defineProperty(registry, "generation", { value: undefined });
    return registry;
  }
  const create = () => new MarkdownPersistenceRegistry();

  it("starts one when there is none, and keeps one from the same code", () => {
    const first = adoptRendererRegistry(undefined, create);
    expect(first.current).toBe(true);
    expect(adoptRendererRegistry(first.registry, create)).toEqual({
      registry: first.registry,
      current: true,
    });
  });

  it("replaces one from earlier code only while it owns no file", async () => {
    const { registry, transport } = setup();
    const lease = earlier(registry).acquire(target, initial)!;
    lease.change("B", 0);
    // It is still saving a file: a second registry would be a second writer.
    expect(adoptRendererRegistry(registry, create)).toEqual({ registry, current: false });
    expect(await lease.flushNow()).toBe(true);
    expect(transport.write).toHaveBeenCalledOnce();
    // Clean but still retained for its views: it remains the owner.
    expect(adoptRendererRegistry(registry, create).registry).toBe(registry);
    lease.release();
    expect(registry.forgetClean(target)).toBe(true);
    const next = adoptRendererRegistry(registry, create);
    expect(next.current).toBe(true);
    expect(next.registry).not.toBe(registry);
  });

  it("keeps one from earlier code while it is still opening a file", async () => {
    const { registry } = setup();
    const opening = earlier(registry).open(target);
    expect(adoptRendererRegistry(registry, create)).toEqual({ registry, current: false });
    (await opening).release();
  });
});

describe("Markdown checkpoint admission", () => {
  it.each([
    ["A", "B", "B", false],
    ["B", "B", "B", false],
    ["C", "B", "B", true],
    ["C", "A", "A", true],
  ])("recovers draft against fresh disk %s", async (disk, draft, expected, conflict) => {
    const checkpoint = {
      token: "checkpoint",
      baselineSource: "A",
      baselineRevision: "rA",
      draftSource: draft,
    };
    const store = { read: vi.fn(async () => checkpoint), replace: vi.fn(async () => true) };
    const write = vi.fn(async () => ({ revision: "written" }));
    const registry = new MarkdownPersistenceRegistry({
      checkpointStore: store,
      createTransport: () => ({
        read: async () => ({ source: disk, revision: `r${disk}` }),
        write,
        classifyFailure: () => "terminal",
        subscribe: () => () => {},
        project: () => {},
      }),
    });
    vi.useFakeTimers();
    try {
      const lease = await registry.open(target);
      expect(lease.getSnapshot().draftSource).toBe(expected);
      expect(lease.getSnapshot().conflict !== null).toBe(conflict);
      expect(lease.getSnapshot().pending).toBe(conflict || draft !== disk);
      expect(write).not.toHaveBeenCalled();
      if (conflict) {
        await vi.advanceTimersByTimeAsync(3000);
        expect(write).not.toHaveBeenCalled();
      }
      lease.release();
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });
});

it.each(["paper.tex", "refs.bib"])("keeps no session checkpoint for %s", async (relativePath) => {
  const store = { read: vi.fn(async () => undefined), replace: vi.fn(async () => true) };
  const registry = new MarkdownPersistenceRegistry({
    checkpointStore: store,
    keepsCheckpoint: documentKeepsCheckpoint,
    createTransport: () => ({
      read: async () => ({ source: "A", revision: "rA" }),
      write: () => new Promise(() => {}),
      classifyFailure: () => "terminal",
      subscribe: () => () => {},
      project: () => {},
    }),
  });
  vi.useFakeTimers();
  try {
    const latex = await registry.open({ ...target, relativePath });
    latex.change("B", 0);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(store.read).not.toHaveBeenCalled();
    expect(store.replace).not.toHaveBeenCalled();
    // Markdown in the same registry is still checkpointed.
    const markdown = await registry.open(target);
    markdown.change("B", 0);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(store.read).toHaveBeenCalledOnce();
    expect(store.replace).toHaveBeenCalled();
    latex.release();
    markdown.release();
  } finally {
    vi.clearAllTimers();
    vi.useRealTimers();
  }
});

it("recovers an undo that followed an ambiguously completed publication", async () => {
  vi.useFakeTimers();
  try {
    const registry = new MarkdownPersistenceRegistry({
      checkpointStore: {
        read: async () => ({
          token: "one",
          baselineSource: "A",
          baselineRevision: "rA",
          draftSource: "A",
          publicationSource: "B",
        }),
        replace: async () => true,
      },
      createTransport: () => ({
        read: async () => ({ source: "B", revision: "rB" }),
        write: async () => ({ revision: "rA2" }),
        classifyFailure: () => "terminal",
        subscribe: () => () => {},
        project: () => {},
      }),
    });
    const lease = await registry.open(target);
    expect(lease.getSnapshot()).toMatchObject({
      baselineSource: "B",
      draftSource: "A",
      pending: true,
      conflict: null,
    });
    lease.release();
  } finally {
    vi.clearAllTimers();
    vi.useRealTimers();
  }
});

it("keeps file admission available when optional recovery storage is unavailable", async () => {
  vi.useFakeTimers();
  const logged = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    const registry = new MarkdownPersistenceRegistry({
      checkpointStore: {
        read: async () => {
          throw new Error("storage unavailable");
        },
        replace: async () => true,
      },
      createTransport: () => ({
        read: async () => ({ source: "disk", revision: "r1" }),
        write: async () => ({ revision: "r2" }),
        classifyFailure: () => "terminal",
        subscribe: () => () => {},
        project: () => {},
      }),
    });
    const lease = await registry.open(target);
    expect(lease.getSnapshot().draftSource).toBe("disk");
    expect(logged).toHaveBeenCalledOnce();
    lease.release();
  } finally {
    logged.mockRestore();
    vi.clearAllTimers();
    vi.useRealTimers();
  }
});

describe("recovery copies across a rename", () => {
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
    return { store, value: () => value, set: (next?: MarkdownDraftCheckpoint) => (value = next) };
  }
  function diskTransport(source: string) {
    return () => ({
      read: async () => ({ source, revision: `r${source}` }),
      write: async () => ({ revision: "written" }),
      classifyFailure: () => "terminal" as const,
      subscribe: () => () => {},
      project: () => {},
    });
  }
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("discards and removes a copy that proves it holds nothing", async () => {
    const { store, value } = memoryStore({
      token: "stale",
      baselineSource: "old text",
      baselineRevision: "rold",
      draftSource: "old text",
      publicationSource: null,
      conflict: false,
    });
    const registry = new MarkdownPersistenceRegistry({
      checkpointStore: store,
      createTransport: diskTransport("new file"),
    });
    const lease = await registry.open(target);
    expect(lease.getSnapshot()).toMatchObject({
      draftSource: "new file",
      conflict: null,
      pending: false,
    });
    expect(value()).toBeUndefined();
    lease.release();
  });

  it("keeps a conflict copy taken after an undo back to the baseline", async () => {
    // A → B, the file became C, the user undid to A while the conflict was open.
    const { store } = memoryStore({
      token: "conflicted",
      baselineSource: "A",
      baselineRevision: "rA",
      draftSource: "A",
      publicationSource: null,
      conflict: true,
    });
    const registry = new MarkdownPersistenceRegistry({
      checkpointStore: store,
      createTransport: diskTransport("C"),
    });
    const lease = await registry.open(target);
    expect(lease.getSnapshot()).toMatchObject({
      baselineSource: "A",
      draftSource: "A",
      conflict: { externalSource: "C" },
    });
    lease.release();
  });

  it("does not let a clean copy that could not be removed raise a conflict", async () => {
    const stale: MarkdownDraftCheckpoint = {
      token: "stale",
      baselineSource: "old text",
      baselineRevision: "rold",
      draftSource: "old text",
      conflict: false,
    };
    const registry = new MarkdownPersistenceRegistry({
      checkpointStore: { read: async () => stale, replace: async () => false },
      createTransport: diskTransport("new file"),
    });
    const lease = await registry.open(target);
    expect(lease.getSnapshot()).toMatchObject({ draftSource: "new file", conflict: null });
    lease.release();
  });

  it("writes no copy while a rename holds a clean document, and removes its copy once renamed", async () => {
    const { store, value } = memoryStore();
    const registry = new MarkdownPersistenceRegistry({
      checkpointStore: store,
      createTransport: diskTransport("A"),
    });
    const lease = registry.acquire(target, initial)!;
    const release = lease.holdForRename()!;
    expect(lease.getSnapshot().pending).toBe(true);
    await vi.advanceTimersByTimeAsync(1000);
    expect(store.replace).not.toHaveBeenCalled();
    lease.release();
    expect(registry.forgetClean(target)).toBe(true);
    release();
    await vi.advanceTimersByTimeAsync(1000);
    expect(value()).toBeUndefined();
  });

  it("makes a new file under the old name wait until the old copy is gone", async () => {
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
    const registry = new MarkdownPersistenceRegistry({
      checkpointStore: store,
      createTransport: diskTransport("A"),
    });
    const lease = registry.acquire(target, initial)!;
    // An edit is saved, but its recovery copy is still being written.
    expect(lease.change("B", 0)).toBe(true);
    await vi.advanceTimersByTimeAsync(200);
    expect(await lease.flushNow()).toBe(true);
    lease.release();
    expect(registry.forgetClean(target)).toBe(true);
    // Another file now takes the old name while the old copy is still in flight.
    let admitted = false;
    const reopening = registry.open(target).then((next) => {
      admitted = true;
      return next;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(admitted).toBe(false);
    finish();
    const next = await reopening;
    expect(stored).toBeUndefined();
    expect(next.getSnapshot()).toMatchObject({ conflict: null, pending: false });
    next.release();
  });

  it("carries removals still running across a hot reload", async () => {
    let finish!: () => void;
    const old = new MarkdownPersistenceRegistry();
    Object.defineProperty(old, "generation", { value: undefined });
    (old as unknown as { retiring: Map<string, Promise<void>> }).retiring.set(
      "key",
      new Promise<void>((done) => (finish = done)),
    );
    const next = adoptRendererRegistry(old, () => new MarkdownPersistenceRegistry());
    expect(next.current).toBe(true);
    const carried = (next.registry as unknown as { retiring: Map<string, Promise<void>> }).retiring;
    expect(carried.has("key")).toBe(true);
    finish();
    await vi.advanceTimersByTimeAsync(0);
    expect(carried.has("key")).toBe(false);
  });
});

describe("moving an open document in place", () => {
  const renamed: MarkdownPersistenceTarget = { ...target, relativePath: "renamed.md" };
  function files() {
    const disk = new Map<string, { source: string; revision: string }>([
      [target.relativePath, { source: "A", revision: "rA" }],
    ]);
    const stops = new Map<string, ReturnType<typeof vi.fn>>();
    const transports = new Map<string, MarkdownPersistenceTransport>();
    const createTransport = vi.fn((at: MarkdownPersistenceTarget) => {
      const path = at.relativePath;
      const stop = vi.fn();
      stops.set(path, stop);
      const transport: MarkdownPersistenceTransport = {
        write: vi.fn(async (intent: MarkdownSaveIntent) => {
          const current = disk.get(path);
          if (current?.revision !== intent.expectedRevision) throw "conflict";
          const next = { source: intent.source, revision: `r${intent.source}` };
          disk.set(path, next);
          return { revision: next.revision };
        }),
        read: vi.fn(async () => {
          const current = disk.get(path);
          if (current === undefined) throw "missing";
          return current;
        }),
        classifyFailure: (error) => (error === "conflict" ? "conflict" : "terminal"),
        subscribe: vi.fn(() => stop),
        project: vi.fn(),
      };
      transports.set(path, transport);
      return transport;
    });
    return {
      disk,
      stops,
      transports,
      createTransport,
      renameOnDisk() {
        disk.set(renamed.relativePath, disk.get(target.relativePath)!);
        disk.delete(target.relativePath);
      },
    };
  }
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("moves the same session to the new path; saves go there and the lease stays live", async () => {
    const fs = files();
    const registry = new MarkdownPersistenceRegistry({
      createTransport: fs.createTransport,
      debounceMs: 250,
    });
    const owner = {};
    const lease = await registry.open(target, owner);
    const moved = vi.fn();
    registry.onMoved(moved);
    const move = lease.beginMove(renamed)!;
    expect(move).not.toBeNull();
    expect(lease.getSnapshot().editingBlocked).toBe(true);
    expect(await move.preflight()).toBe("empty");
    fs.renameOnDisk();
    expect(move.commit()).toBe(true);
    move.finish();
    expect(moved).toHaveBeenCalledWith({ documentId: lease.documentId, from: target, to: renamed });
    expect(lease.target).toEqual(renamed);
    expect(registry.has(target)).toBe(false);
    expect(registry.has(renamed)).toBe(true);
    // The old path's watcher was stopped; the new one is watching.
    expect(fs.stops.get(target.relativePath)).toHaveBeenCalled();
    expect(fs.transports.get(renamed.relativePath)!.subscribe).toHaveBeenCalled();
    expect(lease.getSnapshot().editingBlocked).toBe(false);
    expect(lease.change("B", lease.getSnapshot().editVersion)).toBe(true);
    expect(await lease.flushNow()).toBe(true);
    expect(fs.disk.get(renamed.relativePath)?.source).toBe("B");
    expect(fs.transports.get(target.relativePath)!.write).not.toHaveBeenCalled();
    // The same document: reopening the new path gives a lease on it.
    const again = await registry.open(renamed, owner);
    expect(again.documentId).toBe(lease.documentId);
    again.release();
    lease.release();
  });

  it("refuses to move when another view holds the document, or anything is unsettled", async () => {
    const fs = files();
    const registry = new MarkdownPersistenceRegistry({ createTransport: fs.createTransport });
    const owner = {};
    const lease = await registry.open(target, owner);
    // No owner: cannot prove that no other view holds it.
    const anonymous = await registry.open(target);
    expect(lease.beginMove(renamed)).toBeNull();
    anonymous.release();
    const other = await registry.open(target, {});
    expect(lease.beginMove(renamed)).toBeNull();
    other.release();
    // Unsaved edits: the rename hold refuses.
    expect(lease.change("B", 0)).toBe(true);
    expect(lease.beginMove(renamed)).toBeNull();
    expect(await lease.flushNow()).toBe(true);
    // Pending editor input.
    expect(lease.retainPendingInput({ message: "typing", payload: null })).toBe(true);
    expect(lease.beginMove(renamed)).toBeNull();
    expect(lease.retainPendingInput(null)).toBe(true);
    // Another kind of document at the destination.
    expect(lease.beginMove({ ...renamed, relativePath: "renamed.tex" })).toBeNull();
    // The destination is already open.
    fs.disk.set("taken.md", { source: "T", revision: "rT" });
    const taken = await registry.open({ ...target, relativePath: "taken.md" }, owner);
    expect(lease.beginMove({ ...target, relativePath: "taken.md" })).toBeNull();
    taken.release();
    // Settled again: it may move.
    const move = lease.beginMove(renamed);
    expect(move).not.toBeNull();
    move!.finish();
    expect(lease.getSnapshot().editingBlocked).toBe(false);
    lease.release();
  });

  it("changes nothing when the move cannot be installed, and releases the hold once", async () => {
    const fs = files();
    let failCreation = false;
    const registry = new MarkdownPersistenceRegistry({
      createTransport: (at) => {
        if (failCreation) throw new Error("no transport");
        return fs.createTransport(at);
      },
    });
    const lease = await registry.open(target, {});
    const move = lease.beginMove(renamed)!;
    failCreation = true;
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(move.commit()).toBe(false);
    logged.mockRestore();
    expect(lease.target).toEqual(target);
    expect(registry.has(target)).toBe(true);
    expect(registry.has(renamed)).toBe(false);
    move.finish();
    move.finish();
    expect(lease.getSnapshot().editingBlocked).toBe(false);
    lease.release();
  });

  it("reports a destination recovery copy, or unreadable storage, as not empty", async () => {
    const fs = files();
    const copy: MarkdownDraftCheckpoint = {
      token: "t",
      baselineSource: "X",
      baselineRevision: "rX",
      draftSource: "Y",
    };
    for (const [read, expected] of [
      [async () => copy, "occupied"],
      [
        async () => {
          throw new Error("unreadable");
        },
        "unknown",
      ],
    ] as const) {
      const registry = new MarkdownPersistenceRegistry({
        createTransport: fs.createTransport,
        checkpointStore: {
          read: vi.fn(async (key: string) => (key.includes("renamed.md") ? read() : undefined)),
          replace: vi.fn(async () => true),
        },
      });
      const lease = await registry.open(target, {});
      const move = lease.beginMove(renamed)!;
      expect(await move.preflight()).toBe(expected);
      move.finish();
      lease.release();
    }
  });

  it("makes admission at either path wait until the move has ended", async () => {
    const fs = files();
    const registry = new MarkdownPersistenceRegistry({ createTransport: fs.createTransport });
    const owner = {};
    const lease = await registry.open(target, owner);
    const move = lease.beginMove(renamed)!;
    let admitted = false;
    const waiting = registry.open(renamed, owner).then((next) => {
      admitted = true;
      return next;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(admitted).toBe(false);
    fs.renameOnDisk();
    expect(move.commit()).toBe(true);
    move.finish();
    const next = await waiting;
    expect(next.documentId).toBe(lease.documentId);
    next.release();
    lease.release();
  });

  it("moves the recovery copy's home: the old writer retires, the new one writes at the new path", async () => {
    const fs = files();
    const records = new Map<string, MarkdownDraftCheckpoint>();
    const store: MarkdownDraftCheckpointStore = {
      read: vi.fn(async (key) => records.get(key)),
      replace: vi.fn(async (key, expected, next) => {
        if (records.get(key)?.token !== expected) return false;
        if (next) records.set(key, next);
        else records.delete(key);
        return true;
      }),
    };
    const registry = new MarkdownPersistenceRegistry({
      createTransport: fs.createTransport,
      checkpointStore: store,
      debounceMs: 60_000,
    });
    const lease = await registry.open(target, {});
    const move = lease.beginMove(renamed)!;
    fs.renameOnDisk();
    expect(move.commit()).toBe(true);
    move.finish();
    expect(lease.change("B", lease.getSnapshot().editVersion)).toBe(true);
    await vi.advanceTimersByTimeAsync(200);
    const keys = [...records.keys()];
    expect(keys).toHaveLength(1);
    expect(keys[0]).toContain("renamed.md");
    lease.release();
  });
});
