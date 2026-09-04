import { EnvironmentId, type ProjectReadFileResult } from "@t3tools/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { MarkdownSaveIntent } from "@scientfactory/scient-markdown";
import type { MarkdownPersistenceTransport } from "./markdownPersistenceTransport";

vi.mock("./markdownPersistenceTransport", () => ({ createMarkdownPersistenceTransport: vi.fn() }));

import {
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
