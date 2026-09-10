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
