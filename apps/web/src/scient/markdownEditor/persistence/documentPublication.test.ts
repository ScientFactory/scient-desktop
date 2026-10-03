import { EnvironmentId, type ProjectReadFileResult } from "@t3tools/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { MarkdownSaveIntent } from "@scientfactory/scient-markdown";

vi.mock("./markdownPersistenceTransport", () => ({ createMarkdownPersistenceTransport: vi.fn() }));

import { onDocumentSaved } from "./documentPublication";
import {
  documentReconcileStrategy,
  keepBothVersions,
  MarkdownPersistenceRegistry,
  type MarkdownPersistenceTarget,
} from "./markdownPersistenceRegistry";

const target: MarkdownPersistenceTarget = {
  environmentId: EnvironmentId.make("synthetic-environment"),
  cwd: "/synthetic-workspace",
  relativePath: "paper.tex",
};
const initial: ProjectReadFileResult = {
  relativePath: target.relativePath,
  contents: "A",
  revision: "rA",
  byteLength: 1,
  truncated: false,
};

function setup() {
  let disk = { source: "A", revision: "rA" };
  let fail: unknown = null;
  let loseNextAcknowledgement = false;
  const registry = new MarkdownPersistenceRegistry({
    debounceMs: 250,
    reconcile: documentReconcileStrategy,
    createTransport: () => ({
      write: async (intent: MarkdownSaveIntent) => {
        if (fail !== null) throw fail;
        if (intent.expectedRevision !== disk.revision) throw "conflict";
        disk = { source: intent.source, revision: `r${intent.source}` };
        if (loseNextAcknowledgement) {
          loseNextAcknowledgement = false;
          throw "lost";
        }
        return { revision: disk.revision };
      },
      read: async () => disk,
      classifyFailure: (error) =>
        error === "conflict" ? "conflict" : error === "lost" ? "transient" : "terminal",
      subscribe: () => () => {},
      project: () => {},
    }),
  });
  const lease = registry.acquire(target, initial)!;
  const saved = vi.fn();
  const stop = onDocumentSaved(lease, saved);
  return {
    lease,
    saved,
    stop,
    outside(source: string) {
      disk = { source, revision: `r${source}` };
    },
    failWith(error: unknown) {
      fail = error;
    },
    loseNextAcknowledgement() {
      loseNextAcknowledgement = true;
    },
  };
}

describe("onDocumentSaved", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("reports each acknowledged save with what is now on disk", async () => {
    const h = setup();
    h.lease.change("B", 0);
    expect(h.saved).not.toHaveBeenCalled();
    expect(await h.lease.flushNow()).toBe(true);
    expect(h.saved).toHaveBeenCalledExactlyOnceWith({ source: "B", revision: "rB" });
    h.lease.change("C", h.lease.getSnapshot().editVersion);
    expect(await h.lease.flushNow()).toBe(true);
    expect(h.saved).toHaveBeenCalledTimes(2);
    expect(h.saved).toHaveBeenLastCalledWith({ source: "C", revision: "rC" });
  });

  it("reports a save whose acknowledgement was lost once a read finds it on disk", async () => {
    const h = setup();
    h.loseNextAcknowledgement();
    h.lease.change("B", 0);
    const flushed = h.lease.flushNow();
    await vi.runAllTimersAsync();
    expect(await flushed).toBe(true);
    expect(h.lease.getSnapshot()).toMatchObject({
      baselineSource: "B",
      baselineRevision: "rB",
      pending: false,
    });
    expect(h.saved).toHaveBeenCalledExactlyOnceWith({ source: "B", revision: "rB" });
  });

  it("stays silent when an outside change is adopted", async () => {
    const h = setup();
    h.outside("Agent");
    expect(await h.lease.refresh()).toBe(true);
    expect(h.lease.getSnapshot()).toMatchObject({
      draftSource: "Agent",
      baselineRevision: "rAgent",
    });
    expect(h.saved).not.toHaveBeenCalled();
  });

  it("stays silent for a failed save and for a conflict", async () => {
    const failing = setup();
    failing.failWith(new Error("disk full"));
    failing.lease.change("B", 0);
    expect(await failing.lease.flushNow()).toBe(false);
    expect(failing.saved).not.toHaveBeenCalled();

    const conflicting = setup();
    conflicting.lease.change("B", 0);
    conflicting.outside("Agent");
    expect(await conflicting.lease.flushNow()).toBe(false);
    expect(conflicting.lease.getSnapshot().conflict).not.toBeNull();
    expect(conflicting.saved).not.toHaveBeenCalled();
  });

  it("stops reporting once unsubscribed", async () => {
    const h = setup();
    h.stop();
    h.lease.change("B", 0);
    expect(await h.lease.flushNow()).toBe(true);
    expect(h.saved).not.toHaveBeenCalled();
  });
});

describe("the strategy per kind of file", () => {
  it.each(["paper.tex", "chapters/intro.TEX", "old.latex", "notes.ltx"])(
    "keeps both versions of %s instead of merging",
    (relativePath) => {
      const strategy = documentReconcileStrategy({ ...target, relativePath });
      expect(strategy).toBe(keepBothVersions);
      expect(strategy?.("base", "mine", "theirs")).toBeNull();
    },
  );

  it.each(["notes.md", "README.mdx", "data.txt"])(
    "leaves %s to the default merge",
    (relativePath) => {
      expect(documentReconcileStrategy({ ...target, relativePath })).toBeUndefined();
    },
  );
});
