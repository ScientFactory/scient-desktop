import {
  MarkdownPersistenceCoordinator,
  type MarkdownSaveIntent,
} from "@scientfactory/scient-markdown";
import { undo } from "prosemirror-history";
import { describe, expect, it, vi } from "vite-plus/test";

import { ScientProseMirrorSession } from "./session";

function harness(persist = vi.fn(async (_intent: MarkdownSaveIntent) => ({ revision: "r1" }))) {
  const read = vi.fn(async () => ({ source: "Original", revision: "r0" }));
  const coordinator = new MarkdownPersistenceCoordinator({
    source: "Original",
    revision: "r0",
    debounceMs: 60_000,
    write: persist,
    read,
    classifyFailure: (error) => (error === "conflict" ? "conflict" : "terminal"),
  });
  const session = new ScientProseMirrorSession({
    source: "Original",
    revision: "r0",
    onUserSourceChange: (source) => coordinator.change(source),
  });
  coordinator.subscribe(() => session.synchronizePersistence(coordinator.getSnapshot()));
  const edit = (source: string) => session.replaceUserSource(source);
  return { session, coordinator, persist, read, edit };
}

describe("Markdown draft and persistence coherence", () => {
  it("confirms metadata without replacing selection or undo history", async () => {
    const h = harness();
    h.session.applyTransaction(h.session.state.tr.insertText("!", 9), "user");
    const state = h.session.state;
    expect(await h.coordinator.flushNow()).toBe(true);
    expect(h.session.state).toBe(state);
    expect(h.session.session.baselineRevision).toBe("r1");
    undo(h.session.state, (transaction) => h.session.applyTransaction(transaction, "user"));
    expect(h.session.session.draftSource).toBe("Original");
    await h.coordinator.flushNow();
  });

  it("cancels an obsolete debounced edit when undo returns to baseline", async () => {
    const h = harness();
    h.edit("Original!");
    h.edit("Original");
    expect(await h.coordinator.flushNow()).toBe(true);
    expect(h.persist).not.toHaveBeenCalled();
    expect(h.coordinator.getSnapshot().pending).toBe(false);
    expect(h.session.createSaveIntent()).toBeNull();
  });

  it("compensates an in-flight write after undo", async () => {
    let resolve!: (value: { revision: string }) => void;
    const first = new Promise<{ revision: string }>((complete) => {
      resolve = complete;
    });
    const persist = vi
      .fn(async (_intent: MarkdownSaveIntent) => ({ revision: "r2" }))
      .mockImplementationOnce(() => first);
    const h = harness(persist);
    h.edit("Original!");
    const flushed = h.coordinator.flushNow();
    h.edit("Original");
    resolve({ revision: "r1" });
    expect(await flushed).toBe(true);
    expect(persist.mock.calls.map(([intent]) => [intent.source, intent.expectedRevision])).toEqual([
      ["Original!", "r0"],
      ["Original", "r1"],
    ]);
    expect(h.session.createSaveIntent()).toBeNull();
  });

  it("keeps editing during conflict and resolves only against a rechecked disk snapshot", async () => {
    const persist = vi
      .fn(async (_intent: MarkdownSaveIntent) => ({ revision: "r2" }))
      .mockRejectedValueOnce("conflict");
    const h = harness(persist);
    h.read.mockResolvedValue({ source: "External", revision: "r-agent" });
    h.edit("Original!");
    expect(await h.coordinator.flushNow()).toBe(false);
    h.edit("Original!new");
    expect(h.session.session.conflict?.externalRevision).toBe("r-agent");
    expect(await h.coordinator.resolveWithLocal("r-agent")).toBe(true);
    expect(h.persist).toHaveBeenLastCalledWith({
      source: "Original!new",
      expectedRevision: "r-agent",
      editVersion: 2,
    });
    expect(h.session.createSaveIntent()).toBeNull();
    expect(h.read).toHaveBeenCalledTimes(2);
  });

  it("adopts a clean ordered refresh without creating a save loop", async () => {
    const h = harness();
    h.read.mockResolvedValue({ source: "External", revision: "r-agent" });
    await h.coordinator.refresh();
    expect(h.session.state.doc.textContent).toBe("External");
    expect(h.persist).not.toHaveBeenCalled();
    h.session.applyTransaction(h.session.state.tr.insertText("next ", 1), "user");
    await h.coordinator.flushNow();
    expect(h.persist.mock.calls[0]?.[0]).toMatchObject({
      source: "next External",
      expectedRevision: "r-agent",
    });
  });

  it("keeps a discarded draft recoverable after explicitly choosing disk", async () => {
    const persist = vi
      .fn(async (_intent: MarkdownSaveIntent) => ({ revision: "r2" }))
      .mockRejectedValueOnce("conflict");
    const h = harness(persist);
    h.read.mockResolvedValue({ source: "External", revision: "r-agent" });
    h.edit("Mine");
    await h.coordinator.flushNow();
    await h.coordinator.resolveWithDisk();
    expect(h.session.state.doc.textContent).toBe("External");
    expect(h.coordinator.restoreRecovery()).toBe(true);
    expect(h.session.state.doc.textContent).toBe("Mine");
    await h.coordinator.flushNow();
  });

  it("retains editor state while verification rebases unchanged disk bytes", async () => {
    const persist = vi
      .fn(async (_intent: MarkdownSaveIntent) => ({ revision: "r1" }))
      .mockRejectedValueOnce("conflict");
    const h = harness(persist);
    h.read.mockResolvedValue({ source: "Original", revision: "r-refreshed" });
    h.edit("Original!");
    const state = h.session.state;
    await h.coordinator.flushNow();
    expect(h.session.state).toBe(state);
    expect(h.persist.mock.calls[1]?.[0].expectedRevision).toBe("r-refreshed");
  });
});
