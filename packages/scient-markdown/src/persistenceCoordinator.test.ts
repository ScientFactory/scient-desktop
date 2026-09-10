import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  MarkdownPersistenceCoordinator,
  type MarkdownPersistenceFailureKind,
  type MarkdownPersistenceOptions,
  type MarkdownPersistenceReadResult,
} from "./persistenceCoordinator.ts";
import type { MarkdownSaveIntent } from "./session.ts";

function deferred<A>() {
  let resolve!: (value: A) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<A>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

const classifyFailure = (error: unknown): MarkdownPersistenceFailureKind =>
  typeof error === "string" &&
  ["conflict", "transient", "operation", "disconnected"].includes(error)
    ? (error as MarkdownPersistenceFailureKind)
    : "terminal";

function fixture(overrides: Partial<MarkdownPersistenceOptions> = {}) {
  let disk = { source: "A", revision: "rA" };
  const write = vi.fn(async (intent: MarkdownSaveIntent) => {
    if (intent.source !== disk.source && intent.expectedRevision !== disk.revision) {
      throw "conflict";
    }
    disk = { source: intent.source, revision: `r${intent.source}` };
    return { revision: disk.revision };
  });
  const read = vi.fn(async () => disk);
  const coordinator = new MarkdownPersistenceCoordinator({
    source: "A",
    revision: "rA",
    write,
    read,
    classifyFailure,
    debounceMs: 100,
    maxWaitMs: 500,
    ...overrides,
  });
  return {
    coordinator,
    write,
    read,
    disk: () => disk,
    setDisk: (source: string, revision = `r${source}`) => {
      disk = { source, revision };
    },
  };
}

const settleMicrotasks = async () => {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
};

describe("MarkdownPersistenceCoordinator", () => {
  it("publishes an offline verification retry as retained read work before notifying observers", async () => {
    let composing = true;
    const h = fixture({ prepareExternalUpdate: () => (composing ? "defer" : () => {}) });
    h.setDisk("B");
    h.coordinator.noteFreshnessHint();
    await settleMicrotasks();
    expect(h.coordinator.getSnapshot().pending).toBe(true);
    h.coordinator.setConnected(false);
    composing = false;
    h.coordinator.resumeExternalUpdates();
    const observed: boolean[] = [];
    const unsubscribe = h.coordinator.subscribe(() =>
      observed.push(h.coordinator.getSnapshot().reading),
    );
    const retry = h.coordinator.retry();
    expect(observed[0]).toBe(true);
    expect(h.coordinator.getSnapshot()).toMatchObject({ reading: true, pending: false });
    expect(h.coordinator.dispose()).toBe(false);
    h.coordinator.setConnected(true);
    expect(await retry).toBe(true);
    expect(h.coordinator.getSnapshot()).toMatchObject({
      draftSource: "B",
      reading: false,
      pending: false,
    });
    unsubscribe();
    expect(h.coordinator.dispose()).toBe(true);
  });
  const mergeBase = "First paragraph.\n\nSecond paragraph.\n";
  it("reconciles separate blocks against verified disk bytes and confirms only publication", async () => {
    const h = fixture({ source: mergeBase });
    h.setDisk(mergeBase + "\nAgent appendix.\n", "external");
    h.coordinator.change(mergeBase.replace("First", "My first"));
    expect(await h.coordinator.flushNow()).toBe(true);
    expect(h.disk().source).toBe(mergeBase.replace("First", "My first") + "\nAgent appendix.\n");
    expect(h.write.mock.calls[1]?.[0].expectedRevision).toBe("external");
    expect(h.coordinator.getSnapshot()).toMatchObject({ pending: false, conflict: null });
  });
  it("includes typing during verification rather than replacing it with the attempted draft", async () => {
    const held = deferred<MarkdownPersistenceReadResult>();
    const h = fixture({ source: mergeBase, read: () => held.promise });
    h.setDisk(mergeBase + "\nAgent\n", "external");
    h.coordinator.change(mergeBase.replace("First", "First!"));
    const flushed = h.coordinator.flushNow();
    await settleMicrotasks();
    h.coordinator.change(mergeBase.replace("First", "First!new typing"));
    held.resolve(h.disk());
    expect(await flushed).toBe(true);
    expect(h.disk().source).toContain("First!new typing");
    expect(h.disk().source).toContain("Agent");
  });
  it("uses the same history-preserving projection for a safe already-saved update without writing", async () => {
    const apply = vi.fn();
    const h = fixture({ source: mergeBase, prepareExternalUpdate: () => apply });
    h.setDisk(mergeBase + "\nAgent\n", "external");
    h.coordinator.noteFreshnessHint();
    expect(await h.coordinator.flushNow()).toBe(true);
    expect(apply).toHaveBeenCalledOnce();
    expect(h.write).not.toHaveBeenCalled();
    expect(h.coordinator.getSnapshot()).toMatchObject({
      draftSource: h.disk().source,
      pending: false,
      confirmedEditVersion: 1,
    });
  });
  it("reprepares when typing occurs during preparation instead of publishing a stale merge", async () => {
    const stale = vi.fn();
    let first = true;
    const h = fixture({
      source: mergeBase,
      prepareExternalUpdate: () => {
        if (first) {
          first = false;
          h.coordinator.change(mergeBase.replace("First", "Latest typing"));
          return stale;
        }
        return () => {};
      },
    });
    h.setDisk(mergeBase + "\nAgent\n", "external");
    h.coordinator.change(mergeBase.replace("First", "Local"));
    expect(await h.coordinator.flushNow()).toBe(true);
    expect(stale).not.toHaveBeenCalled();
    expect(h.disk().source).toBe(mergeBase.replace("First", "Latest typing") + "\nAgent\n");
  });
  it("does not publish if an editor throws while applying an external update", async () => {
    const h = fixture({
      source: mergeBase,
      prepareExternalUpdate: () => () => {
        throw new Error("view detached");
      },
    });
    const local = mergeBase.replace("First", "Local");
    h.setDisk(mergeBase + "\nAgent\n", "external");
    h.coordinator.change(local);
    expect(await h.coordinator.flushNow()).toBe(false);
    expect(h.write).toHaveBeenCalledTimes(1);
    expect(h.coordinator.getSnapshot()).toMatchObject({
      draftSource: local,
      conflict: { externalRevision: "external" },
    });
  });
  it("does not resurrect an undone ambiguous write underneath an external appendix", async () => {
    vi.useFakeTimers();
    const h = fixture({ source: mergeBase, retryDelaysMs: [1] });
    h.write.mockImplementationOnce(async (intent) => {
      h.setDisk(intent.source + "\nAgent\n", "external");
      throw "transient";
    });
    h.coordinator.change(mergeBase.replace("First", "First!"));
    const flushed = h.coordinator.flushNow();
    await settleMicrotasks();
    h.coordinator.change(mergeBase);
    await vi.runAllTimersAsync();
    expect(await flushed).toBe(false);
    expect(h.coordinator.getSnapshot().draftSource).toBe(mergeBase);
    expect(h.coordinator.getSnapshot().conflict).not.toBeNull();
  });
  it("defers a merge during composition and resumes with current text", async () => {
    let composing = true;
    const apply = vi.fn();
    const h = fixture({
      source: mergeBase,
      prepareExternalUpdate: () => (composing ? "defer" : apply),
    });
    h.setDisk(mergeBase + "\nAgent\n", "external");
    h.coordinator.change(mergeBase.replace("First", "Local"));
    const flushed = h.coordinator.flushNow();
    await settleMicrotasks();
    expect(apply).not.toHaveBeenCalled();
    expect(h.coordinator.getSnapshot().conflict).toBeNull();
    h.coordinator.change(mergeBase.replace("First", "Local final"));
    composing = false;
    h.coordinator.resumeExternalUpdates();
    expect(await flushed).toBe(true);
    expect(h.disk().source).toContain("Local final");
    expect(apply).toHaveBeenCalledOnce();
  });
  it("keeps the original draft when an editor cannot map its history", async () => {
    const h = fixture({ source: mergeBase, prepareExternalUpdate: () => null });
    h.setDisk(mergeBase + "\nAgent\n", "external");
    const local = mergeBase.replace("First", "Local");
    h.coordinator.change(local);
    expect(await h.coordinator.flushNow()).toBe(false);
    expect(h.coordinator.getSnapshot().draftSource).toBe(local);
    expect(h.disk().source).toBe(mergeBase + "\nAgent\n");
  });
  it("bounds reconciliation even when every retry encounters another writer", async () => {
    let attempt = 0;
    const h = fixture({ source: mergeBase });
    h.write.mockImplementation(async () => {
      h.setDisk(mergeBase + "\nAgent " + ++attempt + "\n", "external" + attempt);
      throw "conflict";
    });
    h.coordinator.change(mergeBase.replace("First", "Local"));
    expect(await h.coordinator.flushNow()).toBe(false);
    expect(h.write).toHaveBeenCalledTimes(4);
    expect(h.coordinator.getSnapshot().conflict).not.toBeNull();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("holds a clean rename against late typing and watcher reads until release", async () => {
    const { coordinator, read, write } = fixture();
    const release = coordinator.holdForRename();
    expect(release).not.toBeNull();
    expect(coordinator.getSnapshot()).toMatchObject({ pending: true, editingBlocked: true });
    expect(coordinator.change("typing during rename")).toBe(false);
    expect(coordinator.holdForRename()).toBeNull();
    coordinator.noteFreshnessHint();
    expect(read).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
    release!();
    await settleMicrotasks();
    expect(coordinator.getSnapshot()).toMatchObject({ pending: false, editingBlocked: false });
    expect(read).toHaveBeenCalledOnce();
    expect(coordinator.change("B")).toBe(true);
    await coordinator.flushNow();
  });

  it("refuses rename while dirty or while a clean freshness read is active", async () => {
    const { coordinator } = fixture();
    coordinator.change("B");
    expect(coordinator.holdForRename()).toBeNull();
    await coordinator.flushNow();
    const held = deferred<MarkdownPersistenceReadResult>();
    const other = fixture({ read: () => held.promise });
    other.coordinator.noteFreshnessHint();
    expect(other.coordinator.holdForRename()).toBeNull();
    held.resolve({ source: "A", revision: "rA" });
    await settleMicrotasks();
  });

  it("retires a held clean identity on successful rename and makes stale release inert", () => {
    const { coordinator } = fixture();
    const release = coordinator.holdForRename()!;
    expect(coordinator.dispose()).toBe(false);
    expect(coordinator.retireClean()).toBe(true);
    release();
    expect(coordinator.change("old path edit")).toBe(false);
    expect(coordinator.holdForRename()).toBeNull();
  });

  it("debounces rapid edits and caps continuous typing at maxWait", async () => {
    vi.useFakeTimers();
    const { coordinator, write, disk } = fixture();
    coordinator.change("B");
    await vi.advanceTimersByTimeAsync(80);
    coordinator.change("C");
    await vi.advanceTimersByTimeAsync(80);
    coordinator.change("D");
    expect(write).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(100);
    expect(disk().source).toBe("D");

    for (let i = 0; i < 7; i += 1) {
      coordinator.change(`continuous ${i}`);
      await vi.advanceTimersByTimeAsync(80);
    }
    expect(write).toHaveBeenCalledTimes(2);
    await coordinator.flushNow();
    expect(disk().source).toBe("continuous 6");
  });

  it("preserves A→B→C ancestry across view unsubscribe/rebind", async () => {
    const held = deferred<{ revision: string }>();
    const { coordinator, write, setDisk } = fixture();
    write.mockImplementationOnce(() => held.promise);
    const releaseView = coordinator.subscribe(vi.fn());
    coordinator.change("B");
    const flushed = coordinator.flushNow();
    releaseView();
    coordinator.subscribe(vi.fn());
    coordinator.change("C", coordinator.getSnapshot().editVersion);
    expect(write).toHaveBeenCalledTimes(1);
    setDisk("B");
    held.resolve({ revision: "rB" });
    await flushed;
    expect(write.mock.calls[1]?.[0]).toEqual({
      source: "C",
      expectedRevision: "rB",
      editVersion: 2,
    });
    expect(coordinator.getSnapshot()).toMatchObject({
      draftSource: "C",
      pending: false,
      conflict: null,
    });
  });

  it("rejects a stale full-document projection without replacing current typing", () => {
    const { coordinator } = fixture();
    expect(coordinator.change("B", 0)).toBe(true);
    expect(coordinator.change("stale view", 0)).toBe(false);
    expect(coordinator.getSnapshot().draftSource).toBe("B");
  });

  it("writes compensation after undo during an in-flight save", async () => {
    const held = deferred<{ revision: string }>();
    const { coordinator, write } = fixture();
    write.mockImplementationOnce(() => held.promise);
    coordinator.change("B");
    const saved = coordinator.flushNow();
    coordinator.change("A");
    expect(coordinator.getSnapshot().pending).toBe(true);
    held.resolve({ revision: "rB" });
    await saved;
    expect(write.mock.calls[1]?.[0]).toEqual({
      source: "A",
      expectedRevision: "rB",
      editVersion: 2,
    });
    expect(coordinator.getSnapshot()).toMatchObject({
      draftSource: "A",
      baselineSource: "A",
      pending: false,
    });
  });

  it("retries the exact immutable ambiguous write before a newer draft", async () => {
    vi.useFakeTimers();
    const { coordinator, write, setDisk } = fixture();
    write.mockImplementationOnce(async () => {
      setDisk("B");
      throw "transient";
    });
    coordinator.change("B");
    const saved = coordinator.flushNow();
    await settleMicrotasks();
    coordinator.change("C");
    expect(coordinator.getSnapshot()).toMatchObject({ retrying: true, error: null });
    await vi.advanceTimersByTimeAsync(250);
    expect(await saved).toBe(true);
    expect(write.mock.calls.map(([intent]) => [intent.source, intent.expectedRevision])).toEqual([
      ["B", "rA"],
      ["B", "rA"],
      ["C", "rB"],
    ]);
    expect(write.mock.calls[0]?.[0]).toBe(write.mock.calls[1]?.[0]);
  });

  it("settles a lost response against an older strict-CAS server with an ordered read", async () => {
    vi.useFakeTimers();
    const { coordinator, write, read, setDisk } = fixture();
    write.mockImplementationOnce(async () => {
      setDisk("B");
      throw "transient";
    });
    write.mockRejectedValueOnce("conflict");
    coordinator.change("B");
    const saved = coordinator.flushNow();
    await vi.advanceTimersByTimeAsync(250);
    expect(await saved).toBe(true);
    expect(read).toHaveBeenCalledOnce();
    expect(coordinator.getSnapshot()).toMatchObject({
      baselineSource: "B",
      baselineRevision: "rB",
      conflict: null,
    });
  });

  it("does not retire compensating A from an old read while B can publish", async () => {
    const oldRead = deferred<MarkdownPersistenceReadResult>();
    const { coordinator, read, write } = fixture();
    read.mockImplementationOnce(() => oldRead.promise);
    coordinator.noteFreshnessHint("watch-ready");
    coordinator.change("B");
    const saved = coordinator.flushNow();
    expect(write).not.toHaveBeenCalled();
    oldRead.resolve({ source: "A", revision: "rA" });
    await saved;
    expect(write.mock.calls[0]?.[0].source).toBe("B");
    expect(coordinator.getSnapshot().baselineSource).toBe("B");
  });

  it("defers watcher reads until queued writes settle", async () => {
    const held = deferred<{ revision: string }>();
    const { coordinator, write, read, setDisk } = fixture();
    write.mockImplementationOnce(() => held.promise);
    coordinator.change("B");
    const saved = coordinator.flushNow();
    coordinator.noteFreshnessHint();
    coordinator.noteFreshnessHint();
    expect(read).not.toHaveBeenCalled();
    setDisk("B");
    held.resolve({ revision: "rB" });
    await saved;
    await settleMicrotasks();
    expect(read).toHaveBeenCalledOnce();
  });

  it("rejects an overtaken watcher read and reads the latest generation", async () => {
    const held = deferred<MarkdownPersistenceReadResult>();
    const { coordinator, read, setDisk } = fixture();
    read.mockImplementationOnce(() => held.promise);
    coordinator.noteFreshnessHint();
    setDisk("C");
    coordinator.noteFreshnessHint();
    held.resolve({ source: "B", revision: "rB" });
    await settleMicrotasks();
    expect(read).toHaveBeenCalledTimes(2);
    expect(coordinator.getSnapshot()).toMatchObject({ draftSource: "C", baselineRevision: "rC" });
  });

  it("invalidates old view versions when an external clean read replaces the document", async () => {
    const { coordinator, setDisk } = fixture();
    setDisk("external");
    await coordinator.refresh();
    expect(coordinator.change("stale", 0)).toBe(false);
    expect(coordinator.getSnapshot().draftSource).toBe("external");
  });

  it("catches up a freshness hint when typing is undone back to clean", async () => {
    const { coordinator, setDisk, write, read } = fixture();
    coordinator.change("B");
    setDisk("external");
    coordinator.noteFreshnessHint();
    coordinator.change("A");
    await settleMicrotasks();
    expect(write).not.toHaveBeenCalled();
    expect(read).toHaveBeenCalledOnce();
    expect(coordinator.getSnapshot().draftSource).toBe("external");
  });

  it.each([
    { diskSource: "B", diskRevision: "rB", expectedSecond: null },
    { diskSource: "A", diskRevision: "rA-new", expectedSecond: "rA-new" },
  ])(
    "verifies a CAS rejection internally when disk is $diskSource",
    async ({ diskSource, diskRevision, expectedSecond }) => {
      const { coordinator, write, setDisk } = fixture();
      write.mockImplementationOnce(async () => {
        setDisk(diskSource, diskRevision);
        throw "conflict";
      });
      const conflicts: unknown[] = [];
      coordinator.subscribe(() => conflicts.push(coordinator.getSnapshot().conflict));
      coordinator.change("B");
      expect(await coordinator.flushNow()).toBe(true);
      expect(conflicts.every((value) => value === null)).toBe(true);
      expect(write.mock.calls[1]?.[0].expectedRevision ?? null).toBe(expectedSecond);
    },
  );

  it("preserves a newer draft when verification proves the failed attempt was published", async () => {
    const held = deferred<MarkdownPersistenceReadResult>();
    const { coordinator, write, read, setDisk } = fixture();
    write.mockRejectedValueOnce("conflict");
    read.mockImplementationOnce(() => held.promise);
    coordinator.change("B");
    const saved = coordinator.flushNow();
    await settleMicrotasks();
    coordinator.change("C");
    setDisk("B");
    held.resolve({ source: "B", revision: "rB" });
    expect(await saved).toBe(true);
    expect(write.mock.calls[1]?.[0]).toMatchObject({ source: "C", expectedRevision: "rB" });
  });

  it("exposes only verified divergent content and cannot flush or release past a conflict", async () => {
    const held = deferred<MarkdownPersistenceReadResult>();
    const { coordinator, write, read } = fixture();
    write.mockRejectedValueOnce("conflict");
    read.mockImplementationOnce(() => held.promise);
    coordinator.change("B");
    const saved = coordinator.flushNow();
    await settleMicrotasks();
    expect(coordinator.getSnapshot()).toMatchObject({ conflict: null, reading: true });
    held.resolve({ source: "external", revision: "rX" });
    expect(await saved).toBe(false);
    expect(coordinator.getSnapshot()).toMatchObject({
      baselineSource: "A",
      draftSource: "B",
      conflict: { externalSource: "external", externalRevision: "rX" },
    });
    expect(await coordinator.flushNow()).toBe(false);
    expect(await coordinator.retry()).toBe(false);
    expect(coordinator.dispose()).toBe(false);
    expect(write).toHaveBeenCalledOnce();
  });

  it("rechecks the displayed external revision before keeping local edits", async () => {
    const { coordinator, setDisk, write } = fixture();
    coordinator.change("B");
    setDisk("external", "rX");
    expect(await coordinator.flushNow()).toBe(false);
    setDisk("newer external", "rY");
    expect(await coordinator.resolveWithLocal("rX")).toBe(false);
    expect(write).toHaveBeenCalledOnce();
    expect(coordinator.getSnapshot().conflict?.externalRevision).toBe("rY");
    expect(await coordinator.resolveWithLocal("rY")).toBe(true);
    expect(write.mock.calls[1]?.[0].expectedRevision).toBe("rY");
  });

  it("preserves discarded local content for explicit recovery", async () => {
    const { coordinator, setDisk, disk } = fixture();
    coordinator.change("B");
    setDisk("external");
    await coordinator.flushNow();
    expect(await coordinator.resolveWithDisk()).toBe(true);
    expect(coordinator.getSnapshot()).toMatchObject({
      draftSource: "external",
      recoverySource: "B",
      pending: false,
    });
    expect(coordinator.restoreRecovery()).toBe(true);
    expect(await coordinator.flushNow()).toBe(true);
    expect(disk().source).toBe("B");
  });

  it("keeps recovery reversible after the user has edited the adopted disk version", async () => {
    const { coordinator, setDisk } = fixture();
    coordinator.change("B");
    setDisk("external");
    await coordinator.flushNow();
    expect(await coordinator.resolveWithDisk()).toBe(true);
    coordinator.change("C");

    expect(coordinator.restoreRecovery()).toBe(true);
    expect(coordinator.getSnapshot()).toMatchObject({ draftSource: "B", recoverySource: "C" });
    expect(coordinator.restoreRecovery()).toBe(true);
    expect(coordinator.getSnapshot()).toMatchObject({ draftSource: "C", recoverySource: "B" });
    await coordinator.flushNow();
    expect(coordinator.getSnapshot().baselineSource).toBe("C");
  });

  it("does not discard typing made while Use disk version is reading", async () => {
    const { coordinator, setDisk, read } = fixture();
    coordinator.change("B");
    setDisk("external");
    await coordinator.flushNow();
    const held = deferred<MarkdownPersistenceReadResult>();
    read.mockImplementationOnce(() => held.promise);
    const resolved = coordinator.resolveWithDisk();
    coordinator.change("C");
    held.resolve({ source: "external", revision: "rexternal" });
    expect(await resolved).toBe(false);
    expect(coordinator.getSnapshot().draftSource).toBe("C");
  });

  it.each(["transient", "operation"] as const)(
    "does not discard typing made while Use disk version waits for a %s retry",
    async (failure) => {
      vi.useFakeTimers();
      const { coordinator, setDisk, read } = fixture();
      coordinator.change("B");
      setDisk("external");
      await coordinator.flushNow();
      read.mockRejectedValueOnce(failure);
      const resolved = coordinator.resolveWithDisk();
      await settleMicrotasks();
      expect(coordinator.getSnapshot().retrying).toBe(true);
      coordinator.change("C");

      await vi.advanceTimersByTimeAsync(250);

      expect(await resolved).toBe(false);
      expect(coordinator.getSnapshot()).toMatchObject({
        draftSource: "C",
        recoverySource: null,
        pending: true,
        conflict: { externalSource: "external" },
      });
    },
  );

  it.each(["transient", "operation"] as const)(
    "bounds automatic %s retries and preserves the draft on exhaustion",
    async (failure) => {
      vi.useFakeTimers();
      const { coordinator, write } = fixture();
      write.mockRejectedValue(failure);
      coordinator.change("B");
      const saved = coordinator.flushNow();
      await vi.runAllTimersAsync();
      expect(await saved).toBe(false);
      expect(write).toHaveBeenCalledTimes(failure === "operation" ? 3 : 4);
      expect(coordinator.getSnapshot()).toMatchObject({
        draftSource: "B",
        pending: true,
        error: failure,
      });
      expect(await coordinator.flushNow()).toBe(false);
    },
  );

  it("never retries terminal policy failures automatically", async () => {
    vi.useFakeTimers();
    const failure = new Error("read-only policy");
    const { coordinator, write } = fixture();
    write.mockRejectedValue(failure);
    coordinator.change("B");
    expect(await coordinator.flushNow()).toBe(false);
    await vi.runAllTimersAsync();
    expect(write).toHaveBeenCalledOnce();
    expect(coordinator.getSnapshot().error).toBe(failure);
  });

  it("pauses disconnected writes and replays the immutable attempt on reconnect", async () => {
    const { coordinator, write } = fixture();
    write.mockRejectedValueOnce("disconnected");
    coordinator.change("B");
    expect(await coordinator.flushNow()).toBe(false);
    coordinator.change("C");
    coordinator.setConnected(true);
    expect(await coordinator.flushNow()).toBe(true);
    expect(write.mock.calls.map(([intent]) => intent.source)).toEqual(["B", "B", "C"]);
  });

  it.each([{ truncated: true }, { readOnly: true }])(
    "does not adopt a structural read failure: %j",
    async (flags) => {
      const { coordinator, write, read } = fixture();
      write.mockRejectedValueOnce("conflict");
      read.mockResolvedValueOnce({ source: "B", revision: "rB", ...flags });
      coordinator.change("B");
      expect(await coordinator.flushNow()).toBe(false);
      expect(coordinator.getSnapshot()).toMatchObject({
        baselineSource: "A",
        draftSource: "B",
        conflict: null,
      });
      expect(coordinator.getSnapshot().error).toBeInstanceOf(Error);
    },
  );

  it("does not turn a failed verification read into an external conflict", async () => {
    vi.useFakeTimers();
    const { coordinator, write, read } = fixture();
    write.mockRejectedValueOnce("conflict");
    read.mockRejectedValue("transient");
    coordinator.change("B");
    const saved = coordinator.flushNow();
    await vi.runAllTimersAsync();
    expect(await saved).toBe(false);
    expect(coordinator.getSnapshot()).toMatchObject({
      draftSource: "B",
      conflict: null,
      error: "transient",
    });
    expect(read).toHaveBeenCalledTimes(4);
  });

  it("keeps exhausted transient background refreshes quiet when no edits need saving", async () => {
    vi.useFakeTimers();
    const { coordinator, read } = fixture();
    read.mockRejectedValue("transient");
    coordinator.noteFreshnessHint();
    await vi.runAllTimersAsync();
    expect(read).toHaveBeenCalledTimes(4);
    expect(coordinator.getSnapshot()).toMatchObject({
      pending: false,
      error: null,
      reading: false,
    });
    read.mockResolvedValueOnce({ source: "external", revision: "rX" });
    coordinator.noteFreshnessHint();
    await settleMicrotasks();
    expect(coordinator.getSnapshot().draftSource).toBe("external");
  });

  it("keeps a clean disconnected refresh quiet and catches up on reconnect", async () => {
    const { coordinator, read } = fixture();
    read.mockRejectedValueOnce("disconnected");
    coordinator.noteFreshnessHint();
    await settleMicrotasks();
    expect(coordinator.getSnapshot()).toMatchObject({ pending: false, error: null });
    read.mockResolvedValueOnce({ source: "external", revision: "rX" });
    coordinator.setConnected(true);
    await settleMicrotasks();
    expect(coordinator.getSnapshot().draftSource).toBe("external");
  });

  it("retains permanent background read errors and edits made during read failure", async () => {
    const failure = new Error("unreadable file");
    const { coordinator, read } = fixture();
    read.mockRejectedValueOnce(failure);
    coordinator.noteFreshnessHint();
    await settleMicrotasks();
    expect(coordinator.getSnapshot()).toMatchObject({ pending: false, error: failure });
    coordinator.change("B");
    expect(coordinator.getSnapshot()).toMatchObject({
      pending: true,
      error: failure,
      draftSource: "B",
    });
    expect(await coordinator.flushNow()).toBe(false);
  });

  it("does not silence a background read failure once newer typing needs protection", async () => {
    vi.useFakeTimers();
    const { coordinator, read } = fixture();
    read.mockRejectedValue("transient");
    coordinator.noteFreshnessHint();
    coordinator.change("B");
    await vi.runAllTimersAsync();
    expect(coordinator.getSnapshot()).toMatchObject({
      pending: true,
      error: "transient",
      draftSource: "B",
    });
    expect(await coordinator.flushNow()).toBe(false);
  });

  it("does not strand a disk choice when Refresh is pressed during its retry delay", async () => {
    vi.useFakeTimers();
    const { coordinator, read, setDisk } = fixture();
    coordinator.change("B");
    setDisk("external");
    await coordinator.flushNow();
    read.mockRejectedValueOnce("transient");
    const diskChoice = coordinator.resolveWithDisk();
    await settleMicrotasks();
    expect(coordinator.getSnapshot().retrying).toBe(true);
    expect(await coordinator.refresh()).toBe(false);
    expect(await diskChoice).toBe(true);
    expect(coordinator.getSnapshot()).toMatchObject({
      draftSource: "external",
      pending: false,
      recoverySource: "B",
    });
  });

  it("isolates observer failures from persistence and refuses dirty eviction", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { coordinator, disk } = fixture();
    coordinator.subscribe(() => {
      throw new Error("observer");
    });
    coordinator.change("B");
    expect(coordinator.dispose()).toBe(false);
    expect(await coordinator.flushNow()).toBe(true);
    expect(disk().source).toBe("B");
    expect(coordinator.dispose()).toBe(true);
    expect(coordinator.change("C")).toBe(false);
  });

  it("keeps a verified conflict guarded after undo and never unblocks it through refresh", async () => {
    const { coordinator, setDisk, write } = fixture();
    coordinator.change("B");
    setDisk("external");
    expect(await coordinator.flushNow()).toBe(false);
    coordinator.change("A");
    expect(coordinator.getSnapshot().pending).toBe(true);
    setDisk("A");
    expect(await coordinator.refresh()).toBe(false);
    expect(coordinator.getSnapshot()).toMatchObject({
      pending: true,
      conflict: { externalSource: "A", externalRevision: "rA" },
    });
    expect(write).toHaveBeenCalledOnce();
    expect(await coordinator.resolveWithDisk()).toBe(true);
    expect(coordinator.getSnapshot().pending).toBe(false);
  });

  it("makes offline edits actionable and resumes them on reconnect", async () => {
    const { coordinator, write, disk } = fixture();
    coordinator.setConnected(false);
    expect(coordinator.getSnapshot().error).toBeNull();
    coordinator.change("B");
    expect(coordinator.getSnapshot().error).toBeInstanceOf(Error);
    expect(await coordinator.flushNow()).toBe(false);
    expect(write).not.toHaveBeenCalled();
    coordinator.setConnected(true);
    expect(await coordinator.flushNow()).toBe(true);
    expect(disk().source).toBe("B");
    expect(coordinator.getSnapshot().error).toBeNull();
  });

  it("wakes a pending transient retry immediately on reconnect", async () => {
    vi.useFakeTimers();
    const { coordinator, write } = fixture();
    write.mockRejectedValueOnce("transient");
    coordinator.change("B");
    const firstFlush = coordinator.flushNow();
    await settleMicrotasks();
    expect(coordinator.getSnapshot().retrying).toBe(true);
    coordinator.setConnected(false);
    expect(await firstFlush).toBe(false);
    coordinator.setConnected(true);
    expect(await coordinator.flushNow()).toBe(true);
    expect(write).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("clears an offline warning when the already-running write succeeds", async () => {
    const held = deferred<{ revision: string }>();
    const { coordinator, write } = fixture();
    write.mockImplementationOnce(() => held.promise);
    coordinator.change("B");
    const saved = coordinator.flushNow();
    coordinator.setConnected(false);
    expect(await saved).toBe(false);
    held.resolve({ revision: "rB" });
    await settleMicrotasks();
    expect(coordinator.getSnapshot()).toMatchObject({
      pending: false,
      error: null,
      baselineSource: "B",
    });
  });

  it("does not replace a terminal error with an offline warning", async () => {
    const failure = new Error("write denied");
    const { coordinator, write } = fixture();
    write.mockRejectedValue(failure);
    coordinator.change("B");
    await coordinator.flushNow();
    coordinator.setConnected(false);
    coordinator.setConnected(true);
    expect(coordinator.getSnapshot().error).toBe(failure);
    expect(write).toHaveBeenCalledOnce();
  });

  it("retires a successfully renamed clean identity without accepting its late read", async () => {
    const held = deferred<MarkdownPersistenceReadResult>();
    const { coordinator, read } = fixture();
    read.mockImplementationOnce(() => held.promise);
    coordinator.noteFreshnessHint();
    const before = coordinator.getSnapshot();
    expect(coordinator.dispose()).toBe(false);
    expect(coordinator.retireClean()).toBe(true);
    held.resolve({ source: "late", revision: "rlate" });
    await settleMicrotasks();
    expect(coordinator.getSnapshot()).toBe(before);
    expect(coordinator.change("stale view")).toBe(false);
  });

  it("does not re-read an overtaken freshness result until newer typing saves", async () => {
    const held = deferred<MarkdownPersistenceReadResult>();
    const { coordinator, read, write } = fixture();
    read.mockImplementationOnce(() => held.promise);
    coordinator.noteFreshnessHint();
    coordinator.change("B");
    coordinator.noteFreshnessHint();
    held.resolve({ source: "external", revision: "rX" });
    await settleMicrotasks();
    expect(read).toHaveBeenCalledOnce();
    expect(write).not.toHaveBeenCalled();
    await coordinator.flushNow();
    await settleMicrotasks();
    expect(read).toHaveBeenCalledTimes(2);
    expect(coordinator.getSnapshot().draftSource).toBe("B");
  });
});
