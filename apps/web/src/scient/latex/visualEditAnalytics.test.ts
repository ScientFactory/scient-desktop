import { EnvironmentId } from "@t3tools/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { createVisualEditAnalytics } from "./visualEditAnalytics";
import { MarkdownPersistenceRegistry } from "../markdownEditor/persistence/markdownPersistenceRegistry";

vi.mock("../markdownEditor/persistence/markdownPersistenceTransport", () => ({
  createMarkdownPersistenceTransport: vi.fn(),
}));

function setup() {
  let fail = false;
  let revision = 0;
  const registry = new MarkdownPersistenceRegistry({
    checkpointStore: { read: async () => undefined, replace: async () => true },
    debounceMs: 250,
    createTransport: () => ({
      write: async () => {
        if (fail) throw new Error("PRIVATE document contents and /private/path.tex");
        return { revision: `r${++revision}` };
      },
      read: async () => ({ source: "initial", revision: "r0" }),
      classifyFailure: () => "terminal",
      subscribe: () => () => {},
      project: () => {},
    }),
  });
  const lease = registry.acquire(
    { environmentId: EnvironmentId.make("test"), cwd: "/private", relativePath: "private.tex" },
    {
      relativePath: "private.tex",
      contents: "initial",
      revision: "r0",
      byteLength: 7,
      truncated: false,
    },
  )!;
  const finish = vi.fn();
  const begin = vi.fn(() => finish);
  const observer = createVisualEditAnalytics(begin);
  return {
    lease,
    observer,
    begin,
    finish,
    edit(source: string) {
      const version = lease.getSnapshot().editVersion;
      expect(lease.change(source, version)).toBe(true);
      observer.accepted(lease, version);
    },
    fail() {
      fail = true;
    },
  };
}

describe("Visual LaTeX edit analytics", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("ignores clean views and only completes after a real acknowledged save", async () => {
    const h = setup();
    h.observer.accepted(h.lease, h.lease.getSnapshot().editVersion);
    expect(h.begin).not.toHaveBeenCalled();
    h.edit("PRIVATE draft");
    h.edit("PRIVATE newer draft");
    expect(h.begin).toHaveBeenCalledExactlyOnceWith();
    expect(h.finish).not.toHaveBeenCalled();
    expect(await h.lease.flushNow()).toBe(true);
    expect(h.finish).toHaveBeenCalledExactlyOnceWith("completed");
    h.edit("another batch");
    expect(await h.lease.flushNow()).toBe(true);
    expect(h.begin).toHaveBeenCalledTimes(2);
    expect(h.finish.mock.calls).toEqual([["completed"], ["completed"]]);
    h.observer.dispose();
  });

  it("reports save failures once without exporting the exception or source", async () => {
    const h = setup();
    h.fail();
    h.edit("PRIVATE draft");
    expect(await h.lease.flushNow()).toBe(false);
    expect(h.finish.mock.calls).toEqual([["failed"]]);
    expect(h.begin.mock.calls).toEqual([[]]);
    h.observer.dispose();
    expect(h.finish).toHaveBeenCalledOnce();
  });

  it("does not track source-only saves or fabricate outcomes after the view closes", async () => {
    const h = setup();
    h.lease.change("source-only edit", 0);
    await h.lease.flushNow();
    expect(h.begin).not.toHaveBeenCalled();
    h.edit("visual edit");
    h.observer.dispose();
    expect(h.finish.mock.calls).toEqual([[null]]);
    await h.lease.flushNow();
    expect(h.finish).toHaveBeenCalledOnce();
  });

  it("records refused edits as failures, never forwarding the refusal reason", () => {
    const h = setup();
    for (let i = 0; i < 1000; i++) h.observer.refused();
    expect(h.begin.mock.calls).toEqual([[]]);
    expect(h.finish.mock.calls).toEqual([["failed"]]);
  });

  function publicationProbe() {
    const h = setup();
    let snapshot = {
      ...h.lease.getSnapshot(),
      draftSource: "Visual B",
      publicationSource: "Visual B" as string | null,
      editVersion: 1,
      pending: true,
    };
    const listeners = new Set<() => void>();
    const lease = {
      getSnapshot: () => snapshot,
      subscribe: (listener: () => void) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
    };
    return {
      ...h,
      lease,
      listeners,
      push(next: Partial<typeof snapshot>) {
        snapshot = { ...snapshot, ...next };
        for (const listener of listeners) listener();
      },
    };
  }

  it("completes the Visual version on publication even when newer Source-only work remains", () => {
    const h = publicationProbe();
    h.observer.accepted(h.lease, 0);
    h.push({ editVersion: 2, draftSource: "Source C" });
    h.push({
      publicationSource: null,
      baselineSource: "Visual B",
      baselineRevision: "r1",
      confirmedEditVersion: 1,
    });
    expect(h.finish.mock.calls).toEqual([["completed"]]);
    expect(h.listeners.size).toBe(0);
    h.push({ error: "PRIVATE newer source failure" });
    expect(h.finish).toHaveBeenCalledOnce();
  });

  it("waits for a newer accepted Visual version, not an older save acknowledgment", () => {
    const h = publicationProbe();
    h.observer.accepted(h.lease, 0);
    h.push({ editVersion: 2, draftSource: "Visual C" });
    h.observer.accepted(h.lease, 1);
    h.push({
      publicationSource: null,
      baselineSource: "Visual B",
      baselineRevision: "r1",
      confirmedEditVersion: 1,
    });
    expect(h.finish).not.toHaveBeenCalled();
    h.push({ publicationSource: "Visual C" });
    h.push({
      publicationSource: null,
      baselineSource: "Visual C",
      baselineRevision: "r2",
      confirmedEditVersion: 2,
      pending: false,
    });
    expect(h.begin).toHaveBeenCalledOnce();
    expect(h.finish.mock.calls).toEqual([["completed"]]);
  });

  it("evaluates errors already present at acceptance and cancels discards without false success", () => {
    const failed = publicationProbe();
    failed.push({ error: "PRIVATE disconnected error" });
    failed.observer.accepted(failed.lease, 0);
    expect(failed.finish.mock.calls).toEqual([["failed"]]);
    expect(failed.listeners.size).toBe(0);
    const discarded = publicationProbe();
    discarded.observer.accepted(discarded.lease, 0);
    discarded.push({ pending: false, publicationSource: null });
    expect(discarded.finish.mock.calls).toEqual([["cancelled"]]);
    const noop = publicationProbe();
    noop.observer.accepted(noop.lease, 1);
    expect(noop.begin).not.toHaveBeenCalled();
  });
});
