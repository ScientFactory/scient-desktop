// FILE: terminalRuntimeTypes.test.ts
// Purpose: Cover stable runtime identity helpers without pulling browser-only runtime modules.
// Layer: Terminal runtime tests

import { describe, expect, it } from "vitest";

import {
  acceptTerminalOutputSequence,
  acceptTerminalSnapshotBarrier,
  buildTerminalRuntimeKey,
} from "./terminalRuntimeTypes";

describe("buildTerminalRuntimeKey", () => {
  it("builds a thread-scoped runtime key for terminal persistence", () => {
    expect(buildTerminalRuntimeKey("thread-123", "terminal-abc")).toBe("thread-123::terminal-abc");
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
