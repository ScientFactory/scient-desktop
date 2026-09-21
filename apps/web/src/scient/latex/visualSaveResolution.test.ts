import type { AtomCommandResult } from "@t3tools/client-runtime/state/runtime";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/unstable/reactivity";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  FileSaveCoordinator,
  type FileSaveResolutionAction,
} from "~/components/files/fileSaveCoordinator";

import {
  visualStateAfterSaveResolution,
  type VisualSaveResolutionState,
} from "./visualSaveResolution";

function deferred<E>() {
  let resolve!: (result: AtomCommandResult<void, E>) => void;
  const promise = new Promise<AtomCommandResult<void, E>>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe("Visual save resolution", () => {
  afterEach(() => vi.useRealTimers());

  it("releases the awaiting-save build hold when Discard follows a stale conflict", async () => {
    vi.useFakeTimers();
    const staleWrite = deferred<Error>();
    const persist = vi.fn().mockReturnValue(staleWrite.promise);
    let currentSource = "source A";
    let gate: VisualSaveResolutionState = { awaitingSave: false, buildHeld: false };
    let conflicted = false;
    const applied: FileSaveResolutionAction[] = [];
    const coordinator = new FileSaveCoordinator({
      debounceMs: 10,
      initialRevision: "disk-one",
      persist,
      revisionFromResult: () => "local-revision",
      onPendingChange: vi.fn(),
      onConfirmed: vi.fn(),
      onFailure: (contents) => {
        conflicted = true;
        // Surface failure handling must not let stale A clear newer B.
        if (contents === currentSource) gate = { awaitingSave: false, buildHeld: false };
      },
      onResolutionApplied: (action) => {
        applied.push(action);
        gate = visualStateAfterSaveResolution(
          { editing: false, awaitingSave: gate.awaitingSave },
          action,
        );
      },
    });

    coordinator.change("source A");
    await vi.advanceTimersByTimeAsync(10);
    coordinator.setSuspended(true);
    currentSource = "source B from Visual";
    gate = { awaitingSave: true, buildHeld: true };
    coordinator.change(currentSource);
    coordinator.setSuspended(false);

    staleWrite.resolve(AsyncResult.failure(Cause.fail(new Error("revision conflict"))));
    await vi.advanceTimersByTimeAsync(0);
    expect(conflicted).toBe(true);
    expect(gate).toEqual({ awaitingSave: true, buildHeld: true });

    coordinator.discardPending("remote-revision");
    await vi.runAllTimersAsync();

    expect(persist).toHaveBeenCalledExactlyOnceWith("source A", "disk-one");
    expect(applied).toEqual(["discard"]);
    expect(gate).toEqual({ awaitingSave: false, buildHeld: false });
  });

  it("keeps Retry held until the exact newer Visual source is confirmed", async () => {
    vi.useFakeTimers();
    const staleWrite = deferred<Error>();
    const conflict: AtomCommandResult<void, Error> = AsyncResult.failure(
      Cause.fail(new Error("revision conflict")),
    );
    const persist = vi
      .fn()
      .mockReturnValueOnce(staleWrite.promise)
      .mockResolvedValueOnce(AsyncResult.success(undefined));
    let currentSource = "source A";
    let gate: VisualSaveResolutionState = { awaitingSave: false, buildHeld: false };
    let conflicted = false;
    let gateAtRetry: VisualSaveResolutionState | null = null;
    const coordinator = new FileSaveCoordinator({
      debounceMs: 10,
      initialRevision: "disk-one",
      persist,
      revisionFromResult: () => "local-revision",
      onPendingChange: vi.fn(),
      onFailure: (contents) => {
        conflicted = true;
        if (contents === currentSource) gate = { awaitingSave: false, buildHeld: false };
      },
      onResolutionApplied: (action) => {
        gate = visualStateAfterSaveResolution(
          { editing: false, awaitingSave: gate.awaitingSave },
          action,
        );
        gateAtRetry = gate;
      },
      onConfirmed: (contents) => {
        if (contents === currentSource) gate = { awaitingSave: false, buildHeld: false };
      },
    });

    coordinator.change("source A");
    await vi.advanceTimersByTimeAsync(10);
    coordinator.setSuspended(true);
    currentSource = "source B from Visual";
    gate = { awaitingSave: true, buildHeld: true };
    coordinator.change(currentSource);
    coordinator.setSuspended(false);

    staleWrite.resolve(conflict);
    await vi.advanceTimersByTimeAsync(0);
    expect(conflicted).toBe(true);
    expect(gate).toEqual({ awaitingSave: true, buildHeld: true });

    coordinator.retryPending("remote-revision");
    await vi.runAllTimersAsync();

    expect(gateAtRetry).toEqual({ awaitingSave: true, buildHeld: true });
    expect(persist.mock.calls).toEqual([
      ["source A", "disk-one"],
      ["source B from Visual", "remote-revision"],
    ]);
    expect(gate).toEqual({ awaitingSave: false, buildHeld: false });
  });
});
