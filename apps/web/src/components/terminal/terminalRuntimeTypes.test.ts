// FILE: terminalRuntimeTypes.test.ts
// Purpose: Cover stable runtime identity helpers without pulling browser-only runtime modules.
// Layer: Terminal runtime tests

import { describe, expect, it } from "vitest";

import {
  acceptTerminalOutputSequence,
  acceptTerminalSnapshotBarrier,
  buildTerminalRuntimeKey,
  finishTerminalSnapshotReconcile,
  requestTerminalSnapshotReconcile,
  supersedeTerminalSnapshotCapture,
  supersedeTerminalSnapshotCaptureAndTakeBuffered,
} from "./terminalRuntimeTypes";

describe("buildTerminalRuntimeKey", () => {
  it("builds a thread-scoped runtime key for terminal persistence", () => {
    expect(buildTerminalRuntimeKey("thread-123", "terminal-abc")).toBe("thread-123::terminal-abc");
  });
});

describe("terminal snapshot capture", () => {
  it.each(["clear", "restart"])(
    "makes an in-flight snapshot stale when a %s event wins the race",
    () => {
      const capture = {
        snapshotReconcileActive: true,
        snapshotBufferedOutputEvents: [
          {
            type: "output" as const,
            threadId: "thread-1",
            terminalId: "terminal-1",
            createdAt: new Date().toISOString(),
            data: "stale",
            outputEpoch: "epoch-1",
            outputSequence: 1,
          },
        ],
        snapshotReconcileQueued: true,
        snapshotReconcileRequestId: 7,
      };

      expect(supersedeTerminalSnapshotCapture(capture)).toBe(true);
      expect(capture.snapshotReconcileActive).toBe(false);
      expect(capture.snapshotBufferedOutputEvents).toEqual([]);
      expect(capture.snapshotReconcileQueued).toBe(false);
      expect(capture.snapshotReconcileRequestId).toBe(8);
      expect(supersedeTerminalSnapshotCapture(capture)).toBe(false);
    },
  );

  it("queues one replacement when a reconnect signal arrives behind a wedged capture", () => {
    const capture = {
      snapshotReconcileActive: true,
      snapshotBufferedOutputEvents: [],
      snapshotReconcileQueued: false,
      snapshotReconcileRequestId: 1,
    };

    expect(requestTerminalSnapshotReconcile(capture)).toBe(false);
    expect(requestTerminalSnapshotReconcile(capture)).toBe(false);
    expect(capture.snapshotReconcileQueued).toBe(true);
    expect(finishTerminalSnapshotReconcile(capture)).toBe(true);
    expect(capture.snapshotReconcileActive).toBe(false);
    expect(capture.snapshotReconcileQueued).toBe(false);
    expect(requestTerminalSnapshotReconcile(capture)).toBe(true);
  });

  it("returns buffered output when an exit supersedes a capture so callers can flush it first", () => {
    const older = {
      type: "output" as const,
      threadId: "thread-1",
      terminalId: "terminal-1",
      createdAt: new Date().toISOString(),
      data: "before exit",
      byteLength: 11,
      outputEpoch: "epoch-1",
      outputSequence: 2,
    };
    const capture = {
      snapshotReconcileActive: true,
      snapshotBufferedOutputEvents: [older],
      snapshotReconcileQueued: true,
      snapshotReconcileRequestId: 4,
    };

    expect(supersedeTerminalSnapshotCaptureAndTakeBuffered(capture)).toEqual([older]);
    expect(capture).toMatchObject({
      snapshotReconcileActive: false,
      snapshotBufferedOutputEvents: [],
      snapshotReconcileQueued: false,
      snapshotReconcileRequestId: 5,
    });
  });
});

describe("terminal output barriers", () => {
  it("resets the live sequence namespace when the server epoch changes", () => {
    const barrier = { lastOutputEpoch: "server-old", lastOutputSequence: 42 };

    expect(acceptTerminalOutputSequence(barrier, "server-new", 1)).toBe(true);
    expect(barrier).toEqual({ lastOutputEpoch: "server-new", lastOutputSequence: 1 });
    expect(acceptTerminalOutputSequence(barrier, "server-new", 1)).toBe(false);
  });

  it("rejects older snapshots only within the same server epoch", () => {
    const barrier = { lastOutputEpoch: "server-old", lastOutputSequence: 42 };

    expect(acceptTerminalSnapshotBarrier(barrier, "server-old", 41)).toBe(false);
    expect(acceptTerminalSnapshotBarrier(barrier, "server-new", 0)).toBe(true);
    expect(barrier).toEqual({ lastOutputEpoch: "server-new", lastOutputSequence: 0 });
  });
});
