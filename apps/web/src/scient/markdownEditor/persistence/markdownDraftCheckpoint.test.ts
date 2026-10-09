import "fake-indexeddb/auto";
import { MarkdownPersistenceCoordinator } from "@scientfactory/scient-markdown";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
  indexedDbMarkdownDrafts,
  MarkdownDraftCheckpointWriter,
  type MarkdownDraftCheckpoint,
  type MarkdownDraftCheckpointStore,
} from "./markdownDraftCheckpoint";

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
  return { store, value: () => value };
}
function snapshot(draftSource = "A", baselineSource = "A") {
  return new MarkdownPersistenceCoordinator({
    source: baselineSource,
    revision: `r${baselineSource}`,
    draftSource,
    write: async () => ({ revision: "unused" }),
    read: async () => ({ source: "A", revision: "rA" }),
    classifyFailure: () => "terminal",
    debounceMs: 60_000,
  }).getSnapshot();
}
function conflicted(draftSource: string, baselineSource: string, external: string) {
  return {
    ...snapshot(draftSource, baselineSource),
    conflict: { externalSource: external, externalRevision: `r${external}` },
    pending: true,
  };
}
describe("Markdown recovery checkpoint", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });
  it("coalesces typing, does no idle work and removes only its acknowledged draft", async () => {
    const { store, value } = memoryStore();
    const writer = new MarkdownDraftCheckpointWriter("file", store);
    writer.update(snapshot("B"));
    writer.update(snapshot("C"));
    await vi.advanceTimersByTimeAsync(200);
    expect(value()?.draftSource).toBe("C");
    expect(store.replace).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(store.replace).toHaveBeenCalledTimes(1);
    writer.update(snapshot("C", "C"));
    await vi.advanceTimersByTimeAsync(200);
    expect(value()).toBeUndefined();
  });
  it("keeps a newer draft when an older file write is acknowledged", async () => {
    const { store, value } = memoryStore();
    const writer = new MarkdownDraftCheckpointWriter("file", store);
    writer.update(snapshot("B"));
    await vi.advanceTimersByTimeAsync(200);
    writer.update(snapshot("C", "B"));
    await vi.advanceTimersByTimeAsync(200);
    expect(value()).toMatchObject({ baselineSource: "B", draftSource: "C" });
  });
  it("records whether a conflict was open, including a conflict-only change", async () => {
    const { store, value } = memoryStore();
    const writer = new MarkdownDraftCheckpointWriter("file", store);
    writer.update(snapshot("B"));
    await vi.advanceTimersByTimeAsync(200);
    expect(value()).toMatchObject({ draftSource: "B", conflict: false });
    // Same sources; only the conflict appears. It must still be written.
    writer.update(conflicted("B", "A", "C"));
    await vi.advanceTimersByTimeAsync(200);
    expect(value()).toMatchObject({ draftSource: "B", conflict: true });
    // Undo back to the baseline while the conflict stays open: still a conflict copy.
    writer.update(conflicted("A", "A", "C"));
    await vi.advanceTimersByTimeAsync(200);
    expect(value()).toMatchObject({ baselineSource: "A", draftSource: "A", conflict: true });
  });
  it("writes nothing for a document pending only because a rename holds it", async () => {
    const { store, value } = memoryStore();
    const writer = new MarkdownDraftCheckpointWriter("file", store);
    writer.update({ ...snapshot("A"), pending: true }, true);
    await vi.advanceTimersByTimeAsync(1000);
    expect(store.replace).not.toHaveBeenCalled();
    expect(value()).toBeUndefined();
  });
  it("retires after a copy already being written, then removes only its own copy", async () => {
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
    const writer = new MarkdownDraftCheckpointWriter("file", store);
    writer.update(snapshot("B"));
    await vi.advanceTimersByTimeAsync(200);
    // The write is paused inside the store when the document is renamed.
    let retired = false;
    const retiring = writer.retire().then(() => (retired = true));
    await vi.advanceTimersByTimeAsync(0);
    expect(retired).toBe(false);
    finish();
    await retiring;
    expect(stored).toBeUndefined();
    // Nothing more is written for the old path.
    writer.update(snapshot("C"));
    await vi.advanceTimersByTimeAsync(1000);
    expect(store.replace).toHaveBeenCalledTimes(2);
  });
  it("leaves a copy another editor replaced when retiring", async () => {
    const first: MarkdownDraftCheckpoint = {
      token: "old",
      baselineSource: "A",
      baselineRevision: "rA",
      draftSource: "B",
    };
    const { store, value } = memoryStore(first);
    const writer = new MarkdownDraftCheckpointWriter("file", store, first);
    await store.replace("file", "old", { ...first, token: "other", draftSource: "C" });
    await writer.retire();
    expect(value()?.draftSource).toBe("C");
  });
  it("cannot remove or overwrite a checkpoint another editor has replaced", async () => {
    const first: MarkdownDraftCheckpoint = {
      token: "old",
      baselineSource: "A",
      baselineRevision: "rA",
      draftSource: "B",
    };
    const { store, value } = memoryStore(first);
    const writer = new MarkdownDraftCheckpointWriter("file", store, first);
    await store.replace("file", "old", { ...first, token: "other", draftSource: "C" });
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    writer.update(snapshot("B", "B"));
    await vi.advanceTimersByTimeAsync(200);
    expect(value()?.draftSource).toBe("C");
    expect(logged).toHaveBeenCalledOnce();
    logged.mockRestore();
  });
});

it("commits IndexedDB compare-and-replace atomically across competing writers", async () => {
  const value = { token: "one", baselineSource: "A", baselineRevision: "rA", draftSource: "B" };
  expect(await indexedDbMarkdownDrafts.replace("atomic-test", undefined, value)).toBe(true);
  const outcomes = await Promise.all([
    indexedDbMarkdownDrafts.replace("atomic-test", "one", {
      ...value,
      token: "two",
      draftSource: "C",
    }),
    indexedDbMarkdownDrafts.replace("atomic-test", "one", undefined),
  ]);
  expect(outcomes.filter(Boolean)).toHaveLength(1);
  expect(await indexedDbMarkdownDrafts.read("atomic-test")).toMatchObject({
    token: "two",
    draftSource: "C",
  });
});

it("round-trips the conflict field and reads its absence as unknown", async () => {
  const value = {
    token: "conflict-field",
    baselineSource: "A",
    baselineRevision: "rA",
    draftSource: "A",
    conflict: true,
  };
  expect(await indexedDbMarkdownDrafts.replace("conflict-field", undefined, value)).toBe(true);
  expect(await indexedDbMarkdownDrafts.read("conflict-field")).toMatchObject({ conflict: true });
  const { conflict: _conflict, ...legacy } = { ...value, token: "legacy" };
  expect(await indexedDbMarkdownDrafts.replace("legacy-field", undefined, legacy)).toBe(true);
  expect(await indexedDbMarkdownDrafts.read("legacy-field")).not.toHaveProperty("conflict");
});
