import { EnvironmentId, type ProjectReadFileResult } from "@t3tools/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { MarkdownSaveIntent } from "@scientfactory/scient-markdown";
import type { MarkdownDraftCheckpoint } from "./markdownDraftCheckpoint";

vi.mock("./markdownPersistenceTransport", () => ({ createMarkdownPersistenceTransport: vi.fn() }));

import { documentWasSaved, onDocumentSaved } from "./documentPublication";
import {
  documentKeepsCheckpoint,
  documentReconcileStrategy,
  keepBothVersions,
  MarkdownPersistenceRegistry,
  type MarkdownPersistenceTarget,
} from "./markdownPersistenceRegistry";
import { DocumentPersistenceCoordinator } from "@scientfactory/scient-document";

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
  let checkpoint: MarkdownDraftCheckpoint | undefined;
  const receipts = new Map<string, { intent: MarkdownSaveIntent; revision: string }>();
  const replayStarted = Promise.withResolvers<MarkdownSaveIntent>();
  const replayAcknowledgement = Promise.withResolvers<void>();
  let holdReplay = false;
  let connected!: (value: boolean) => void;
  const write = async (intent: MarkdownSaveIntent) => {
    // A committed receipt answers the exact operation before mutable disk guards.
    const receipt = receipts.get(intent.mutationId);
    if (receipt !== undefined) {
      if (
        receipt.intent.source !== intent.source ||
        receipt.intent.expectedRevision !== intent.expectedRevision ||
        receipt.intent.editVersion !== intent.editVersion ||
        receipt.intent.createOnly !== intent.createOnly
      )
        throw "collision";
      replayStarted.resolve(intent);
      if (holdReplay) await replayAcknowledgement.promise;
      return { revision: receipt.revision };
    }
    if (fail !== null) throw fail;
    if (intent.expectedRevision !== disk.revision) throw "conflict";
    disk = { source: intent.source, revision: `r${intent.source}` };
    receipts.set(intent.mutationId, { intent: { ...intent }, revision: disk.revision });
    if (loseNextAcknowledgement) {
      loseNextAcknowledgement = false;
      throw "lost";
    }
    return { revision: disk.revision };
  };
  const registry = new MarkdownPersistenceRegistry({
    checkpointStore: {
      read: async () => checkpoint,
      replace: async (_key, expected, next) => {
        if (checkpoint?.token !== expected) return false;
        checkpoint = next;
        return true;
      },
    },
    debounceMs: 250,
    reconcile: documentReconcileStrategy,
    createTransport: () => ({
      write,
      read: async () => disk,
      classifyFailure: (error) =>
        error === "conflict" ? "conflict" : error === "lost" ? "transient" : "terminal",
      subscribe: (callbacks) => {
        connected = callbacks.connected;
        return () => {};
      },
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
    write,
    disk: () => disk,
    replayStarted: replayStarted.promise,
    holdReplay() {
      holdReplay = true;
    },
    acknowledgeReplay() {
      replayAcknowledgement.resolve();
    },
    setConnected(value: boolean) {
      connected(value);
    },
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

  it("reports a lost-acknowledgement save only after exact receipt replay and preserves newer typing", async () => {
    const h = setup();
    h.holdReplay();
    h.loseNextAcknowledgement();
    h.lease.change("B", 0);
    const flushed = h.lease.flushNow();
    await vi.advanceTimersByTimeAsync(5_000);
    const intent = await h.replayStarted;
    expect(h.disk()).toEqual({ source: "B", revision: "rB" });
    expect(h.saved).not.toHaveBeenCalled();
    expect(h.lease.getSnapshot()).toMatchObject({
      baselineSource: "A",
      publicationIntent: intent,
    });
    h.lease.change("C", h.lease.getSnapshot().editVersion);
    h.setConnected(false);
    h.acknowledgeReplay();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.lease.getSnapshot()).toMatchObject({
      baselineSource: "B",
      baselineRevision: "rB",
      draftSource: "C",
      publicationIntent: null,
      pending: true,
    });
    expect(h.saved).toHaveBeenCalledExactlyOnceWith({ source: "B", revision: "rB" });
    expect(await flushed).toBe(false);
    // An identical replay cannot produce another consumer Saved event.
    expect(await h.write(intent)).toEqual({ revision: "rB" });
    expect(h.saved).toHaveBeenCalledExactlyOnceWith({ source: "B", revision: "rB" });
    // Equal disk bytes do not permit a different operation or ID-payload collision.
    await expect(h.write({ ...intent, source: "C" })).rejects.toBe("collision");
    await expect(h.write({ ...intent, mutationId: `${intent.mutationId}-other` })).rejects.toBe(
      "conflict",
    );
    expect(h.disk()).toEqual({ source: "B", revision: "rB" });
    expect(h.lease.getSnapshot().draftSource).toBe("C");
    h.setConnected(true);
    expect(await h.lease.flushNow()).toBe(true);
    expect(h.saved).toHaveBeenCalledTimes(2);
    expect(h.saved).toHaveBeenLastCalledWith({ source: "C", revision: "rC" });
  });

  it("reports same-revision exclusive recreation once and never mistakes read-only absence adoption for a save", async () => {
    const coordinator = new DocumentPersistenceCoordinator({
      source: "A",
      revision: "rA",
      initialCurrentMissing: true,
      reconcile: keepBothVersions,
      write: async (intent) => {
        expect(intent.createOnly).toBe(true);
        return { revision: "rA" };
      },
      read: async () => ({ source: "A", revision: "rA" }),
      classifyFailure: () => "terminal",
    });
    const saved: Array<{ readonly source: string; readonly revision: string }> = [];
    const missing = coordinator.getSnapshot();
    const stop = onDocumentSaved(coordinator, (receipt) => saved.push(receipt));
    try {
      expect(await coordinator.recreateMissingCurrent()).toBe(true);
      expect(coordinator.getSnapshot()).toMatchObject({ currentMissing: false, pending: false });
      expect(saved).toEqual([{ source: "A", revision: "rA" }]);
      coordinator.noteFreshnessHint();
      expect(await coordinator.refresh()).toBe(true);
      expect(saved).toEqual([{ source: "A", revision: "rA" }]);
      expect(documentWasSaved(missing, coordinator.getSnapshot())).toBe(false);
    } finally {
      stop();
      coordinator.dispose();
    }
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
  // Everything but Markdown: LaTeX, and whatever else a LaTeX document includes.
  it.each([
    "paper.tex",
    "chapters/intro.TEX",
    "old.latex",
    "notes.ltx",
    "macros.sty",
    "data.txt",
    "README.mdx",
  ])(
    "keeps both versions of %s instead of merging, and leaves its recovery to its editor",
    (relativePath) => {
      const strategy = documentReconcileStrategy({ ...target, relativePath });
      expect(strategy).toBe(keepBothVersions);
      expect(strategy?.("base", "mine", "theirs")).toBeNull();
      expect(documentKeepsCheckpoint({ ...target, relativePath })).toBe(false);
    },
  );

  it.each(["notes.md", "docs/README.MARKDOWN"])(
    "leaves %s to Markdown's merge and checkpoint",
    (relativePath) => {
      expect(documentReconcileStrategy({ ...target, relativePath })).toBeUndefined();
      expect(documentKeepsCheckpoint({ ...target, relativePath })).toBe(true);
    },
  );
});
