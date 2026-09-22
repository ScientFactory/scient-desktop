import type { AtomCommandResult } from "@t3tools/client-runtime/state/runtime";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/unstable/reactivity";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { WorkspaceFileSessionRegistry } from "./workspaceFileSessionRegistry";

interface WriteResult {
  readonly revision: string;
}

function success(revision: string): AtomCommandResult<WriteResult, Error> {
  return AsyncResult.success({ revision });
}

function failure(message: string): AtomCommandResult<WriteResult, Error> {
  return AsyncResult.failure(Cause.fail(new Error(message)));
}

function deferred<A>() {
  let resolve!: (value: A) => void;
  const promise = new Promise<A>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}

function options(input: {
  readonly key?: string;
  readonly debounceMs?: number;
  readonly initialRevision?: string;
  readonly persist: (
    contents: string,
    expectedRevision: string,
  ) => Promise<AtomCommandResult<WriteResult, Error>>;
  readonly onPendingChange?: (pending: boolean) => void;
  readonly onConfirmed?: (contents: string, value: WriteResult) => void;
  readonly onFailure?: (
    contents: string,
    result: Extract<AtomCommandResult<WriteResult, Error>, { readonly _tag: "Failure" }>,
  ) => void;
  readonly onResolutionApplied?: (action: "discard" | "retry") => void;
  readonly onPersisted?: (contents: string, value: WriteResult) => void;
}) {
  return {
    key: input.key ?? "environment\0/workspace\0file.txt",
    debounceMs: input.debounceMs ?? 500,
    initialRevision: input.initialRevision ?? "revision-1",
    persist: input.persist,
    revisionFromResult: (value: WriteResult) => value.revision,
    ...(input.onPersisted === undefined ? {} : { onPersisted: input.onPersisted }),
    callbacks: {
      ...(input.onPendingChange === undefined ? {} : { onPendingChange: input.onPendingChange }),
      ...(input.onConfirmed === undefined ? {} : { onConfirmed: input.onConfirmed }),
      ...(input.onFailure === undefined ? {} : { onFailure: input.onFailure }),
      ...(input.onResolutionApplied === undefined
        ? {}
        : { onResolutionApplied: input.onResolutionApplied }),
    },
  };
}

describe("WorkspaceFileSessionRegistry", () => {
  let registry: WorkspaceFileSessionRegistry<WriteResult, Error>;

  beforeEach(() => {
    vi.useFakeTimers();
    registry = new WorkspaceFileSessionRegistry();
  });

  afterEach(() => {
    registry.clear();
    vi.useRealTimers();
  });

  it("serializes multiple views of one file through one debounced writer", async () => {
    const persist = vi.fn().mockResolvedValue(success("revision-2"));
    const firstPending = vi.fn();
    const secondPending = vi.fn();
    const first = registry.acquire(options({ persist, onPendingChange: firstPending }));
    const second = registry.acquire(options({ persist, onPendingChange: secondPending }));

    first.change("first view");
    await vi.advanceTimersByTimeAsync(300);
    second.change("latest shared buffer");
    await vi.advanceTimersByTimeAsync(500);

    expect(persist).toHaveBeenCalledExactlyOnceWith("latest shared buffer", "revision-1");
    expect(firstPending.mock.calls).toEqual([[true], [false]]);
    expect(secondPending.mock.calls).toEqual([[true], [false]]);
    first.release();
    second.release();
    await vi.runAllTimersAsync();
    await Promise.resolve();
    expect(registry.entryCount).toBe(0);
  });

  it("uses the debounce requested by the view that produced the latest edit", async () => {
    const persist = vi.fn().mockResolvedValue(success("revision-2"));
    const slower = registry.acquire(options({ persist, debounceMs: 500 }));
    const faster = registry.acquire(options({ persist, debounceMs: 150 }));

    slower.change("slow checkpoint");
    await vi.advanceTimersByTimeAsync(100);
    faster.change("visual checkpoint");
    await vi.advanceTimersByTimeAsync(149);
    expect(persist).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(persist).toHaveBeenCalledExactlyOnceWith("visual checkpoint", "revision-1");

    slower.release();
    faster.release();
  });

  it("publishes a successful write once while notifying every active view", async () => {
    const persist = vi.fn().mockResolvedValue(success("revision-2"));
    const onPersisted = vi.fn();
    const firstConfirmed = vi.fn();
    const secondConfirmed = vi.fn();
    const first = registry.acquire(options({ persist, onPersisted, onConfirmed: firstConfirmed }));
    const second = registry.acquire(
      options({ persist, onPersisted, onConfirmed: secondConfirmed }),
    );

    first.change("shared");
    await vi.advanceTimersByTimeAsync(500);

    expect(onPersisted).toHaveBeenCalledOnce();
    expect(firstConfirmed).toHaveBeenCalledOnce();
    expect(secondConfirmed).toHaveBeenCalledOnce();
    first.release();
    second.release();
  });

  it("keeps every acquired pending guard until the shared write settles", async () => {
    const persistResult = deferred<AtomCommandResult<WriteResult, Error>>();
    const persist = vi.fn().mockReturnValue(persistResult.promise);
    const firstPending = vi.fn();
    const secondPending = vi.fn();
    const first = registry.acquire(options({ persist, onPendingChange: firstPending }));
    const second = registry.acquire(options({ persist, onPendingChange: secondPending }));

    first.change("pending");
    first.release();
    expect(firstPending.mock.calls.at(-1)).toEqual([true]);
    expect(secondPending.mock.calls.at(-1)).toEqual([true]);

    await vi.advanceTimersByTimeAsync(500);
    persistResult.resolve(success("revision-2"));
    await Promise.resolve();
    expect(firstPending.mock.calls.at(-1)).toEqual([false]);
    expect(secondPending.mock.calls.at(-1)).toEqual([false]);
    second.release();
  });

  it("reuses a session reacquired while its final flush is in flight", async () => {
    const firstWrite = deferred<AtomCommandResult<WriteResult, Error>>();
    const persist = vi
      .fn()
      .mockReturnValueOnce(firstWrite.promise)
      .mockResolvedValueOnce(success("revision-3"));
    const first = registry.acquire(options({ persist }));
    first.change("first checkpoint");
    first.release();
    await Promise.resolve();
    expect(persist).toHaveBeenCalledExactlyOnceWith("first checkpoint", "revision-1");

    const second = registry.acquire(options({ persist }));
    second.change("second checkpoint");
    firstWrite.resolve(success("revision-2"));
    await vi.runAllTimersAsync();

    expect(persist.mock.calls).toEqual([
      ["first checkpoint", "revision-1"],
      ["second checkpoint", "revision-2"],
    ]);
    second.release();
  });

  it("does not let a stale joining view regress the shared confirmed revision", async () => {
    const persist = vi
      .fn()
      .mockResolvedValueOnce(success("revision-2"))
      .mockResolvedValueOnce(success("revision-3"));
    const current = registry.acquire(options({ persist }));
    current.change("first checkpoint");
    await vi.advanceTimersByTimeAsync(500);

    const stale = registry.acquire(options({ persist, initialRevision: "revision-1" }));
    stale.syncConfirmedFileRevision("revision-1");
    stale.change("second checkpoint");
    await vi.advanceTimersByTimeAsync(500);

    expect(persist.mock.calls).toEqual([
      ["first checkpoint", "revision-1"],
      ["second checkpoint", "revision-2"],
    ]);
    current.release();
    stale.release();
  });

  it("adopts an authoritative revision change observed after a lease joins", async () => {
    const persist = vi.fn().mockResolvedValue(success("revision-4"));
    const lease = registry.acquire(options({ persist }));
    lease.syncConfirmedFileRevision("revision-3");
    lease.change("after external refresh");
    await vi.advanceTimersByTimeAsync(500);

    expect(persist).toHaveBeenCalledExactlyOnceWith("after external refresh", "revision-3");
    lease.release();
  });

  it("ignores callbacks retained by a released view", async () => {
    const persist = vi.fn().mockResolvedValue(success("revision-2"));
    const first = registry.acquire(options({ persist }));
    first.release();
    first.change("retired contents");
    const second = registry.acquire(options({ persist }));
    second.change("current contents");
    await vi.runAllTimersAsync();

    expect(persist).toHaveBeenCalledOnce();
    expect(persist.mock.calls[0]?.[0]).toBe("current contents");
    second.release();
  });

  it("does not resume a shared transaction until every suspending view releases it", async () => {
    const persist = vi.fn().mockResolvedValue(success("revision-2"));
    const first = registry.acquire(options({ persist }));
    const second = registry.acquire(options({ persist }));
    first.setSuspended(true);
    second.setSuspended(true);
    first.change("held buffer");

    first.setSuspended(false);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(persist).not.toHaveBeenCalled();

    second.release();
    await vi.runAllTimersAsync();
    expect(persist).toHaveBeenCalledExactlyOnceWith("held buffer", "revision-1");
    first.release();
  });

  it("retains a failed buffer without consumers and replays the failure on reacquire", async () => {
    const persist = vi
      .fn()
      .mockResolvedValueOnce(failure("revision conflict"))
      .mockResolvedValueOnce(success("revision-remote-next"));
    const firstFailure = vi.fn();
    const first = registry.acquire(options({ persist, onFailure: firstFailure }));
    first.change("local buffer");
    first.release();
    await Promise.resolve();
    await Promise.resolve();

    expect(firstFailure).not.toHaveBeenCalled();
    expect(registry.entryCount).toBe(1);
    const secondFailure = vi.fn();
    const second = registry.acquire(options({ persist, onFailure: secondFailure }));
    expect(secondFailure).toHaveBeenCalledOnce();

    second.retryPending("revision-remote");
    await vi.runAllTimersAsync();
    expect(persist.mock.calls).toEqual([
      ["local buffer", "revision-1"],
      ["local buffer", "revision-remote"],
    ]);
    second.release();
    await Promise.resolve();
    await Promise.resolve();
    expect(registry.entryCount).toBe(0);
  });

  it("keeps pending guards active across an unmounted failure until retry succeeds", async () => {
    const persist = vi
      .fn()
      .mockResolvedValueOnce(failure("revision conflict"))
      .mockResolvedValueOnce(success("revision-3"));
    const firstPending = vi.fn();
    const first = registry.acquire(options({ persist, onPendingChange: firstPending }));
    first.change("recoverable buffer");
    first.release();
    await Promise.resolve();
    await Promise.resolve();

    expect(firstPending.mock.calls).toEqual([[true]]);
    const secondPending = vi.fn();
    const second = registry.acquire(options({ persist, onPendingChange: secondPending }));
    expect(secondPending.mock.calls).toEqual([[true]]);
    second.retryPending("revision-2");
    await vi.runAllTimersAsync();

    expect(firstPending.mock.calls).toEqual([[true], [false]]);
    expect(secondPending.mock.calls).toEqual([[true], [false]]);
    second.release();
  });

  it("can discard a retained failed buffer without writing it again", async () => {
    const persist = vi.fn().mockResolvedValue(failure("revision conflict"));
    const first = registry.acquire(options({ persist }));
    first.change("discard me");
    first.release();
    await Promise.resolve();
    await Promise.resolve();

    const resolutionApplied = vi.fn();
    const second = registry.acquire(options({ persist, onResolutionApplied: resolutionApplied }));
    second.discardPending("revision-remote");
    second.release();
    await Promise.resolve();
    await Promise.resolve();

    expect(persist).toHaveBeenCalledOnce();
    expect(resolutionApplied).toHaveBeenCalledExactlyOnceWith("discard");
    expect(registry.entryCount).toBe(0);
  });

  it("applies the same conflict resolution only once across views", async () => {
    const persist = vi
      .fn()
      .mockResolvedValueOnce(failure("revision conflict"))
      .mockResolvedValueOnce(success("revision-3"));
    const firstResolution = vi.fn();
    const secondResolution = vi.fn();
    const first = registry.acquire(options({ persist, onResolutionApplied: firstResolution }));
    const second = registry.acquire(options({ persist, onResolutionApplied: secondResolution }));
    first.change("local buffer");
    await vi.advanceTimersByTimeAsync(500);

    first.retryPending("revision-2");
    second.retryPending("revision-2");
    await vi.runAllTimersAsync();
    expect(persist).toHaveBeenCalledTimes(2);
    expect(firstResolution).toHaveBeenCalledExactlyOnceWith("retry");
    expect(secondResolution).toHaveBeenCalledExactlyOnceWith("retry");
    first.release();
    second.release();
  });

  it("keeps independent workspace file identities fully isolated", async () => {
    const persist = vi.fn().mockResolvedValue(success("revision-2"));
    const first = registry.acquire(options({ key: "workspace-a\0file.txt", persist }));
    const second = registry.acquire(options({ key: "workspace-b\0file.txt", persist }));
    first.change("workspace a");
    second.change("workspace b");
    await vi.advanceTimersByTimeAsync(500);

    expect(persist.mock.calls.map(([contents]) => contents).toSorted()).toEqual([
      "workspace a",
      "workspace b",
    ]);
    expect(registry.entryCount).toBe(2);
    first.release();
    second.release();
  });
});
