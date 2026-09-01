import { MarkdownSaveQueue, type MarkdownSaveIntent } from "@scientfactory/scient-markdown";
import { describe, expect, it, vi } from "vite-plus/test";

import { ScientProseMirrorSession } from "./session";

function harness(persist = vi.fn(async (_intent: MarkdownSaveIntent) => ({ revision: "r1" }))) {
  const pending = vi.fn();
  const session = new ScientProseMirrorSession({
    source: "Original",
    revision: "r0",
    onUserSourceChange: () => queue.synchronize(session.session),
  });
  const queue = new MarkdownSaveQueue({
    debounceMs: 60_000,
    persist,
    onPendingChange: pending,
    onFailure: vi.fn(),
    onConfirmed: (intent, result) => {
      session.confirmSave(intent, result.revision);
      queue.synchronize(session.session);
    },
  });
  const edit = (source: string) => session.replaceUserSource(source);
  return { session, queue, persist, pending, edit };
}

describe("Markdown draft and persistence coherence", () => {
  it("does not clear a newer external conflict when an older save acknowledges", async () => {
    let resolve!: (result: { revision: string }) => void;
    const first = new Promise<{ revision: string }>((done) => {
      resolve = done;
    });
    const persist = vi
      .fn(async (_intent: MarkdownSaveIntent) => ({ revision: "r3" }))
      .mockImplementationOnce(() => first);
    const h = harness(persist);
    h.edit("Mine");
    const flushed = h.queue.flush();
    h.session.receiveExternalSource({ source: "Agent after my save", revision: "r2" });
    h.queue.pause();
    h.edit("Mine with more edits");
    resolve({ revision: "r1" });
    await flushed;
    expect(persist).toHaveBeenCalledTimes(1);
    expect(h.session.session.conflict?.externalRevision).toBe("r2");
    expect(h.queue.pending).toBe(true);
    h.session.resolveExternalConflict("local");
    h.queue.synchronize(h.session.session);
    h.queue.resume();
    await h.queue.flush();
    expect(persist.mock.calls[1]?.[0]).toMatchObject({
      source: "Mine with more edits",
      expectedRevision: "r2",
    });
    await h.queue.dispose();
  });

  it("refreshes the revision of unchanged disk bytes without replacing selection or history", async () => {
    const h = harness();
    h.edit("Original!");
    const state = h.session.state;
    expect(h.session.receiveExternalSource({ source: "Original", revision: "r-refreshed" })).toBe(
      "unchanged",
    );
    expect(h.session.state).toBe(state);
    h.queue.synchronize(h.session.session);
    await h.queue.flush();
    expect(h.persist.mock.calls[0]?.[0].expectedRevision).toBe("r-refreshed");
    await h.queue.dispose();
  });
  it("cancels an obsolete debounced edit when undo returns to baseline", async () => {
    const h = harness();
    h.edit("Original!");
    h.edit("Original");
    await h.queue.flush();
    expect(h.persist).not.toHaveBeenCalled();
    expect(h.pending).toHaveBeenLastCalledWith(false);
    expect(h.session.createSaveIntent()).toBeNull();
    await h.queue.dispose();
  });

  it.each(["undo", "discard"])("compensates an in-flight write after %s", async (action) => {
    let resolveFirst!: (value: { revision: string }) => void;
    const first = new Promise<{ revision: string }>((resolve) => {
      resolveFirst = resolve;
    });
    const persist = vi
      .fn(async (_intent: MarkdownSaveIntent) => ({ revision: "r2" }))
      .mockImplementationOnce(() => first);
    const h = harness(persist);
    h.edit("Original!");
    const flushed = h.queue.flush();
    if (action === "undo") h.edit("Original");
    else {
      h.session.discardLocalChanges({ source: "Original", revision: "r0" });
      h.queue.synchronize(h.session.session);
      h.queue.resume();
    }
    resolveFirst({ revision: "r1" });
    await flushed;
    expect(persist.mock.calls.map(([intent]) => [intent.source, intent.expectedRevision])).toEqual([
      ["Original!", "r0"],
      ["Original", "r1"],
    ]);
    expect(h.session.createSaveIntent()).toBeNull();
    expect(h.queue.pending).toBe(false);
    await h.queue.dispose();
  });

  it("retries the latest draft including edits made during a conflict", async () => {
    const h = harness();
    h.edit("Original!");
    h.session.receiveExternalSource({ source: "External", revision: "r-agent" });
    h.queue.pause();
    h.edit("Original!new");
    h.session.resolveExternalConflict("local");
    h.queue.synchronize(h.session.session);
    h.queue.resume();
    await h.queue.flush();
    expect(h.persist).toHaveBeenCalledExactlyOnceWith({
      source: "Original!new",
      expectedRevision: "r-agent",
      editVersion: 2,
    });
    expect(h.session.createSaveIntent()).toBeNull();
    expect(h.queue.pending).toBe(false);
    await h.queue.dispose();
  });

  it("discards local edits even without an external conflict", async () => {
    const h = harness();
    h.edit("Original!");
    h.session.discardLocalChanges({ source: "Original", revision: "r0" });
    h.queue.synchronize(h.session.session);
    await h.queue.flush();
    expect(h.session.state.doc.textContent).toBe("Original");
    expect(h.persist).not.toHaveBeenCalled();
    h.session.applyTransaction(h.session.state.tr.insertText("next ", 1), "user");
    await h.queue.flush();
    expect(h.persist.mock.calls[0]?.[0].source).toBe("next Original");
    await h.queue.dispose();
  });
});
