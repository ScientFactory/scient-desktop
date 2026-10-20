import { describe, expect, it } from "vite-plus/test";
import type { KeepAwakeExecution } from "@t3tools/contracts";
import { executionKeepsAwake, observeKeepAwakeExecution } from "./keepAwakeExecution.ts";

const abandoned: KeepAwakeExecution = {
  key: "root",
  progressToken: "run:running:attempt-1",
  health: "unowned",
  needsAwake: true,
};

describe("keep-awake execution health", () => {
  it("does not renew abandoned execution when repeated backend polls report running", () => {
    const first = observeKeepAwakeExecution([], [abandoned], 1000);
    const repeated = observeKeepAwakeExecution(first, [abandoned], 120_000);
    expect(executionKeepsAwake(repeated, 120_999)).toBe(true);
    expect(executionKeepsAwake(repeated, 121_000)).toBe(false);
  });

  it("renews protection for actual progress and restores it for a recovered owner", () => {
    const first = observeKeepAwakeExecution([], [abandoned], 1000);
    const progress = observeKeepAwakeExecution(
      first,
      [{ ...abandoned, progressToken: "tool:completed" }],
      120_000,
    );
    expect(executionKeepsAwake(progress, 130_000)).toBe(true);
    expect(executionKeepsAwake(progress, 240_000)).toBe(false);
    const recovered = observeKeepAwakeExecution(
      progress,
      [{ ...abandoned, health: "connected" }],
      240_000,
    );
    expect(executionKeepsAwake(recovered, 1_000_000)).toBe(true);
  });

  it("keeps silent connected work protected without a maximum duration", () => {
    const first = observeKeepAwakeExecution([], [{ ...abandoned, health: "connected" }], 1000);
    const later = observeKeepAwakeExecution(
      first,
      [{ ...abandoned, health: "connected" }],
      86_400_000,
    );
    expect(executionKeepsAwake(later, 86_400_000)).toBe(true);
    const disconnected = observeKeepAwakeExecution(later, [abandoned], 86_401_000);
    expect(executionKeepsAwake(disconnected, 86_401_000)).toBe(false);
  });

  it("preserves uncertain work but lets a paused operation sleep", () => {
    const unknown = observeKeepAwakeExecution([], [{ ...abandoned, health: "unknown" }], 1000);
    expect(executionKeepsAwake(unknown, 1_000_000)).toBe(true);
    const paused = observeKeepAwakeExecution(
      unknown,
      [{ ...abandoned, health: "connected", needsAwake: false }],
      2000,
    );
    expect(executionKeepsAwake(paused, 2000)).toBe(false);
  });

  it("tracks subagents independently and drops protection after the last eligible operation ends", () => {
    const child: KeepAwakeExecution = { ...abandoned, key: "child", health: "connected" };
    const group = observeKeepAwakeExecution([], [abandoned, child], 1000);
    expect(executionKeepsAwake(group, 1_000_000)).toBe(true);
    const childEnded = observeKeepAwakeExecution(group, [abandoned], 1_000_001);
    expect(executionKeepsAwake(childEnded, 1_000_001)).toBe(false);
  });
});
