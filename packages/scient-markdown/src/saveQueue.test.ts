import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import type { MarkdownSaveIntent } from "./session.ts";
import { MarkdownSaveQueue } from "./saveQueue.ts";

const intent = (source: string, editVersion: number, expectedRevision = "r0") =>
  ({ source, editVersion, expectedRevision }) satisfies MarkdownSaveIntent;

describe("MarkdownSaveQueue", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("coalesces rapid edits and persists only the latest intent after debounce", async () => {
    vi.useFakeTimers();
    const persist = vi.fn(async (value: MarkdownSaveIntent) => ({
      revision: `saved:${value.editVersion}`,
    }));
    const pending: boolean[] = [];
    const confirmed = vi.fn();
    const queue = new MarkdownSaveQueue({
      debounceMs: 250,
      persist,
      onPendingChange: (value) => pending.push(value),
      onConfirmed: confirmed,
      onFailure: vi.fn(),
    });

    queue.enqueue(intent("one", 1));
    queue.enqueue(intent("two", 2));
    queue.enqueue(intent("three", 3));
    await vi.advanceTimersByTimeAsync(250);
    await queue.flush();

    expect(persist).toHaveBeenCalledOnce();
    expect(persist).toHaveBeenCalledWith(intent("three", 3));
    expect(confirmed).toHaveBeenCalledWith(intent("three", 3), { revision: "saved:3" });
    expect(pending.at(-1)).toBe(false);
  });

  it("serializes an edit queued during a write against the confirmed revision", async () => {
    let resolveFirst: ((value: { readonly revision: string }) => void) | null = null;
    const first = new Promise<{ readonly revision: string }>((resolve) => {
      resolveFirst = resolve;
    });
    const persist = vi
      .fn<(value: MarkdownSaveIntent) => Promise<{ readonly revision: string }>>()
      .mockImplementationOnce(() => first)
      .mockResolvedValueOnce({ revision: "r2" });
    const queue = new MarkdownSaveQueue({
      debounceMs: 0,
      persist,
      onPendingChange: vi.fn(),
      onConfirmed: vi.fn(),
      onFailure: vi.fn(),
    });

    queue.enqueue(intent("one", 1));
    const flushing = queue.flush();
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    expect(persist).toHaveBeenCalledOnce();
    queue.enqueue(intent("two", 2));
    expect(queue.acknowledgePersisted("one")).toBe(false);
    expect(queue.acknowledgePersisted("two")).toBe(false);
    expect(queue.pending).toBe(true);
    resolveFirst!({ revision: "r1" });
    await flushing;

    expect(persist).toHaveBeenCalledTimes(2);
    expect(persist.mock.calls[1]?.[0]).toEqual(intent("two", 2, "r1"));
  });

  it("stops after failure and retries only when explicitly requested", async () => {
    const failure = new Error("revision conflict");
    const persist = vi
      .fn<(value: MarkdownSaveIntent) => Promise<{ readonly revision: string }>>()
      .mockRejectedValueOnce(failure)
      .mockResolvedValueOnce({ revision: "r-agent-local" });
    const onFailure = vi.fn();
    const queue = new MarkdownSaveQueue({
      debounceMs: 0,
      persist,
      onPendingChange: vi.fn(),
      onConfirmed: vi.fn(),
      onFailure,
    });

    queue.enqueue(intent("local", 1));
    await queue.flush();
    expect(queue.failureBlocked).toBe(true);
    expect(queue.pending).toBe(true);
    expect(onFailure).toHaveBeenCalledWith(intent("local", 1), failure);
    expect(persist).toHaveBeenCalledOnce();

    queue.retry("r-agent");
    await queue.flush();
    expect(persist).toHaveBeenCalledTimes(2);
    expect(persist.mock.calls[1]?.[0]).toEqual(intent("local", 1, "r-agent"));
    expect(queue.failureBlocked).toBe(false);
    expect(queue.pending).toBe(false);
  });

  it("discards a blocked pending edit without another write", async () => {
    const persist = vi.fn(async () => {
      throw new Error("offline");
    });
    const pending: boolean[] = [];
    const queue = new MarkdownSaveQueue({
      debounceMs: 0,
      persist,
      onPendingChange: (value) => pending.push(value),
      onConfirmed: vi.fn(),
      onFailure: vi.fn(),
    });
    queue.enqueue(intent("local", 1));
    await queue.flush();
    queue.discard();

    expect(queue.pending).toBe(false);
    expect(queue.failureBlocked).toBe(false);
    expect(persist).toHaveBeenCalledOnce();
    expect(pending.at(-1)).toBe(false);
  });

  it("honors discard chosen while a failing write is still in flight", async () => {
    let rejectWrite: ((error: Error) => void) | null = null;
    const write = new Promise<{ readonly revision: string }>((_resolve, reject) => {
      rejectWrite = reject;
    });
    const pending: boolean[] = [];
    const onFailure = vi.fn();
    const queue = new MarkdownSaveQueue({
      debounceMs: 0,
      persist: vi.fn(() => write),
      onPendingChange: (value) => pending.push(value),
      onConfirmed: vi.fn(),
      onFailure,
    });

    queue.enqueue(intent("local", 1));
    const flushing = queue.flush();
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    queue.discard();
    rejectWrite!(new Error("revision conflict"));
    await flushing;

    expect(queue.pending).toBe(false);
    expect(queue.failureBlocked).toBe(false);
    expect(onFailure).not.toHaveBeenCalled();
    expect(pending.at(-1)).toBe(false);
  });

  it("honors retry chosen while a failing write is still in flight", async () => {
    let rejectWrite: ((error: Error) => void) | null = null;
    const first = new Promise<{ readonly revision: string }>((_resolve, reject) => {
      rejectWrite = reject;
    });
    const persist = vi
      .fn<(value: MarkdownSaveIntent) => Promise<{ readonly revision: string }>>()
      .mockImplementationOnce(() => first)
      .mockResolvedValueOnce({ revision: "r-agent-local" });
    const onFailure = vi.fn();
    const queue = new MarkdownSaveQueue({
      debounceMs: 0,
      persist,
      onPendingChange: vi.fn(),
      onConfirmed: vi.fn(),
      onFailure,
    });

    queue.enqueue(intent("local", 1));
    const flushing = queue.flush();
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    queue.retry("r-agent");
    rejectWrite!(new Error("revision conflict"));
    await flushing;

    expect(persist).toHaveBeenCalledTimes(2);
    expect(persist.mock.calls[1]?.[0]).toEqual(intent("local", 1, "r-agent"));
    expect(queue.pending).toBe(false);
    expect(queue.failureBlocked).toBe(false);
    expect(onFailure).not.toHaveBeenCalled();
  });

  it("retires an unsettled command after the authoritative file observes its draft", async () => {
    let resolveWrite: ((value: { readonly revision: string }) => void) | null = null;
    const first = new Promise<{ readonly revision: string }>((resolve) => {
      resolveWrite = resolve;
    });
    const persist = vi
      .fn<(value: MarkdownSaveIntent) => Promise<{ readonly revision: string }>>()
      .mockImplementationOnce(() => first)
      .mockResolvedValueOnce({ revision: "r2" });
    const pending: boolean[] = [];
    const confirmed = vi.fn();
    const queue = new MarkdownSaveQueue({
      debounceMs: 0,
      persist,
      onPendingChange: (value) => pending.push(value),
      onConfirmed: confirmed,
      onFailure: vi.fn(),
    });

    queue.enqueue(intent("one", 1));
    const firstFlush = queue.flush();
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    expect(persist).toHaveBeenCalledOnce();

    expect(queue.acknowledgePersisted("one")).toBe(true);
    expect(queue.pending).toBe(false);
    expect(pending.at(-1)).toBe(false);

    // A subsequent edit starts a new serial lane immediately. The retired
    // command's late response cannot confirm or clear that newer edit.
    // Acknowledgement itself releases waiters; no command settlement is needed.
    await firstFlush;
    queue.enqueue(intent("two", 2, "r1"));
    const flushing = queue.flush();
    await flushing;
    expect(persist).toHaveBeenCalledTimes(2);
    expect(persist.mock.calls[1]?.[0]).toEqual(intent("two", 2, "r1"));
    expect(confirmed).toHaveBeenCalledExactlyOnceWith(intent("two", 2, "r1"), {
      revision: "r2",
    });

    resolveWrite!({ revision: "late-r1" });
    await firstFlush;
    expect(confirmed).toHaveBeenCalledTimes(1);
    expect(queue.pending).toBe(false);
  });

  it("ignores a retired command failure while a newer edit is still saving", async () => {
    let rejectFirst: ((error: Error) => void) | null = null;
    let resolveSecond: ((value: { readonly revision: string }) => void) | null = null;
    const first = new Promise<{ readonly revision: string }>((_resolve, reject) => {
      rejectFirst = reject;
    });
    const second = new Promise<{ readonly revision: string }>((resolve) => {
      resolveSecond = resolve;
    });
    const persist = vi
      .fn<(value: MarkdownSaveIntent) => Promise<{ readonly revision: string }>>()
      .mockImplementationOnce(() => first)
      .mockImplementationOnce(() => second);
    const pending = vi.fn();
    const onFailure = vi.fn();
    const queue = new MarkdownSaveQueue({
      debounceMs: 0,
      persist,
      onPendingChange: pending,
      onConfirmed: vi.fn(),
      onFailure,
    });

    queue.enqueue(intent("one", 1));
    const firstFlush = queue.flush();
    queue.acknowledgePersisted("one");
    queue.enqueue(intent("two", 2, "r1"));
    const secondFlush = queue.flush();

    rejectFirst!(new Error("late transport interruption"));
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    expect(onFailure).not.toHaveBeenCalled();
    expect(queue.pending).toBe(true);
    expect(queue.failureBlocked).toBe(false);
    expect(pending).toHaveBeenLastCalledWith(true);

    resolveSecond!({ revision: "r2" });
    await Promise.all([firstFlush, secondFlush]);
    expect(persist).toHaveBeenCalledTimes(2);
    expect(queue.pending).toBe(false);
    expect(pending).toHaveBeenLastCalledWith(false);
  });

  it("does not let a host callback exception strand the save lane", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const pending: boolean[] = [];
    const queue = new MarkdownSaveQueue({
      debounceMs: 0,
      persist: vi.fn(async () => ({ revision: "r1" })),
      onPendingChange: (value) => pending.push(value),
      onConfirmed: () => {
        throw new Error("host callback failed");
      },
      onFailure: vi.fn(),
    });

    queue.enqueue(intent("saved", 1));
    await queue.flush();

    expect(queue.pending).toBe(false);
    expect(queue.failureBlocked).toBe(false);
    expect(pending.at(-1)).toBe(false);
    expect(consoleError).toHaveBeenCalledWith(
      "MarkdownSaveQueue onConfirmed callback failed:",
      expect.any(Error),
    );
  });

  it("holds a queued write while paused, and a flush still attempts the latest draft", async () => {
    vi.useFakeTimers();
    const persist = vi.fn(async () => ({ revision: "r1" }));
    const onConfirmed = vi.fn();
    const queue = new MarkdownSaveQueue({
      debounceMs: 250,
      persist,
      onPendingChange: vi.fn(),
      onConfirmed,
      onFailure: vi.fn(),
    });
    queue.enqueue(intent("local", 1));
    queue.pause();
    await vi.advanceTimersByTimeAsync(500);

    expect(persist).not.toHaveBeenCalled();
    expect(queue.pending).toBe(true);

    // A final flush (unmount) is decisive: the user's draft is never dropped
    // on a paused lane; a conflicting disk state is resolved downstream.
    await queue.flush();

    expect(persist).toHaveBeenCalledTimes(1);
    expect(onConfirmed).toHaveBeenCalledTimes(1);
    expect(queue.pending).toBe(false);
    expect(queue.failureBlocked).toBe(false);
  });

  it("flushes the latest debounced edit before disposal completes", async () => {
    vi.useFakeTimers();
    const persist = vi.fn(async () => ({ revision: "r1" }));
    const confirmed = vi.fn();
    const queue = new MarkdownSaveQueue({
      debounceMs: 60_000,
      persist,
      onPendingChange: vi.fn(),
      onConfirmed: confirmed,
      onFailure: vi.fn(),
    });
    queue.enqueue(intent("close-safe", 1));

    await queue.dispose({ flush: true });

    expect(persist).toHaveBeenCalledOnce();
    expect(confirmed).toHaveBeenCalledWith(intent("close-safe", 1), { revision: "r1" });
    expect(queue.pending).toBe(false);
    expect(() => queue.enqueue(intent("too-late", 2))).toThrow(
      "Cannot enqueue a disposed Markdown save queue.",
    );
  });
});
