import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import type { MarkdownSaveIntent } from "./session.ts";
import { MarkdownSaveQueue } from "./saveQueue.ts";

const intent = (source: string, editVersion: number, expectedRevision = "r0") =>
  ({ source, editVersion, expectedRevision }) satisfies MarkdownSaveIntent;

describe("MarkdownSaveQueue", () => {
  afterEach(() => vi.useRealTimers());

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

  it("pauses a queued write when an external conflict arrives before debounce", async () => {
    vi.useFakeTimers();
    const persist = vi.fn(async () => ({ revision: "unexpected" }));
    const queue = new MarkdownSaveQueue({
      debounceMs: 250,
      persist,
      onPendingChange: vi.fn(),
      onConfirmed: vi.fn(),
      onFailure: vi.fn(),
    });
    queue.enqueue(intent("local", 1));
    queue.pause();
    await vi.advanceTimersByTimeAsync(500);
    await queue.flush();

    expect(queue.failureBlocked).toBe(true);
    expect(queue.pending).toBe(true);
    expect(persist).not.toHaveBeenCalled();
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
