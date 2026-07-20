import { EventEmitter } from "node:events";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  DesktopBackendSupervisor,
  type DesktopBackendChild,
  type DesktopBackendSupervisorOptions,
} from "./desktopBackendSupervisor";

class FakeBackendChild extends EventEmitter implements DesktopBackendChild {
  readonly pid: number;
  connected = true;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  readonly sent: unknown[] = [];

  constructor(pid: number) {
    super();
    this.pid = pid;
  }

  send(message: unknown): boolean {
    this.sent.push(message);
    return this.connected;
  }

  spawn(): void {
    this.emit("spawn");
  }

  fail(error: Error): void {
    this.emit("error", error);
  }

  exit(code: number | null = 0, signal: NodeJS.Signals | null = null): void {
    this.exitCode = code;
    this.signalCode = signal;
    this.emit("exit", code, signal);
  }
}

function makeHarness(overrides: Partial<DesktopBackendSupervisorOptions> = {}) {
  const children: FakeBackendChild[] = [];
  const prepared: number[] = [];
  const exits: Array<{ generation: number; reason: string; expected: boolean }> = [];
  const restarts: Array<{ attempt: number; delayMs: number; reason: string }> = [];
  const forceTerminateTree = vi.fn(async (child: DesktopBackendChild) => {
    (child as FakeBackendChild).exit(null, "SIGKILL");
  });
  const supervisor = new DesktopBackendSupervisor({
    prepareStart: async (generation) => {
      prepared.push(generation);
    },
    spawn: (generation) => {
      const child = new FakeBackendChild(1_000 + generation);
      children.push(child);
      return child;
    },
    requestGracefulShutdown: (child, reason) =>
      child.send?.({ type: "scient.backend.shutdown", reason }) ?? false,
    forceTerminateTree,
    onGenerationExited: (event) => exits.push(event),
    onRestartScheduled: (event) => restarts.push(event),
    ...overrides,
  });
  return { children, exits, forceTerminateTree, prepared, restarts, supervisor };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("DesktopBackendSupervisor", () => {
  it("serializes duplicate starts into one backend generation", async () => {
    const harness = makeHarness();

    await Promise.all([harness.supervisor.start(), harness.supervisor.start()]);

    expect(harness.prepared).toEqual([1]);
    expect(harness.children).toHaveLength(1);
    expect(harness.supervisor.currentGeneration?.number).toBe(1);
  });

  it("handles an error followed by exit exactly once", async () => {
    const harness = makeHarness();
    await harness.supervisor.start();
    const child = harness.children[0]!;

    child.fail(new Error("spawn failed"));
    child.exit(1);

    expect(harness.exits).toEqual([
      { generation: 1, pid: 1001, reason: "error=spawn failed", expected: false },
    ]);
    expect(harness.restarts).toEqual([{ attempt: 0, delayMs: 500, reason: "error=spawn failed" }]);
    await vi.advanceTimersByTimeAsync(500);
    expect(harness.children).toHaveLength(2);
  });

  it("backs off across unstable generations and resets only after readiness", async () => {
    const harness = makeHarness();
    await harness.supervisor.start();

    harness.children[0]!.exit(1);
    await vi.advanceTimersByTimeAsync(500);
    harness.children[1]!.exit(1);
    await vi.advanceTimersByTimeAsync(1_000);
    harness.supervisor.markReady(3);
    harness.children[2]!.exit(1);

    expect(harness.restarts.map(({ attempt, delayMs }) => ({ attempt, delayMs }))).toEqual([
      { attempt: 0, delayMs: 500 },
      { attempt: 1, delayMs: 1_000 },
      { attempt: 0, delayMs: 500 },
    ]);
  });

  it("ignores late events from a closed generation", async () => {
    const harness = makeHarness();
    await harness.supervisor.start();
    const first = harness.children[0]!;
    first.fail(new Error("first failure"));
    await vi.advanceTimersByTimeAsync(500);

    first.exit(1);

    expect(harness.supervisor.currentGeneration?.number).toBe(2);
    expect(harness.exits).toHaveLength(1);
    expect(harness.restarts).toHaveLength(1);
  });

  it("uses graceful IPC and does not force-kill a backend that exits", async () => {
    const harness = makeHarness();
    await harness.supervisor.start();
    const child = harness.children[0]!;

    const stopping = harness.supervisor.stop("app quit");
    await Promise.resolve();
    child.exit(0);
    await stopping;

    expect(child.sent).toEqual([{ type: "scient.backend.shutdown", reason: "app quit" }]);
    expect(harness.forceTerminateTree).not.toHaveBeenCalled();
    expect(harness.exits[0]?.expected).toBe(true);
    expect(harness.restarts).toHaveLength(0);
  });

  it("coalesces repeated stops and force-terminates the tree after timeout", async () => {
    const harness = makeHarness({
      gracefulShutdownTimeoutMs: 100,
      forcedExitTimeoutMs: 50,
    });
    await harness.supervisor.start();
    const child = harness.children[0]!;

    const firstStop = harness.supervisor.stop("first quit");
    const secondStop = harness.supervisor.stop("second quit");
    await vi.advanceTimersByTimeAsync(100);
    await Promise.all([firstStop, secondStop]);

    expect(child.sent).toEqual([{ type: "scient.backend.shutdown", reason: "first quit" }]);
    expect(harness.forceTerminateTree).toHaveBeenCalledOnce();
    expect(harness.restarts).toHaveLength(0);
  });

  it("force-terminates immediately when the IPC channel is unavailable", async () => {
    const harness = makeHarness({
      requestGracefulShutdown: () => false,
      gracefulShutdownTimeoutMs: 10_000,
    });
    await harness.supervisor.start();

    await harness.supervisor.stop("lost IPC");

    expect(harness.forceTerminateTree).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not restart a start failure classified as fatal", async () => {
    const fatalError = new Error("backend bundle missing");
    const onFatalStartFailure = vi.fn();
    const harness = makeHarness({
      prepareStart: async () => {
        throw fatalError;
      },
      classifyStartFailure: () => "fatal",
      onFatalStartFailure,
    });

    await harness.supervisor.start();

    expect(harness.supervisor.desiredRunning).toBe(false);
    expect(harness.restarts).toHaveLength(0);
    expect(onFatalStartFailure).toHaveBeenCalledWith(fatalError);
  });

  it("honors a start queued while graceful shutdown is still finishing", async () => {
    const harness = makeHarness();
    await harness.supervisor.start();
    const first = harness.children[0]!;

    const stopping = harness.supervisor.stop("updater handoff");
    const restarting = harness.supervisor.start();
    await Promise.resolve();
    first.exit(0);
    await Promise.all([stopping, restarting]);

    expect(harness.children).toHaveLength(2);
    expect(harness.supervisor.currentGeneration?.number).toBe(2);
    expect(harness.restarts).toHaveLength(0);
  });
});
