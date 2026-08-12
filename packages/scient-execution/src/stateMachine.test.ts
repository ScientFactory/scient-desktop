import { describe, expect, it } from "@effect/vitest";

import { InvalidExecutionTransitionError, transitionExecutionStatus } from "./stateMachine.ts";

describe("execution state machine", () => {
  it("allows a complete process lifecycle", () => {
    expect(transitionExecutionStatus("queued", "starting")).toBe("starting");
    expect(transitionExecutionStatus("starting", "running")).toBe("running");
    expect(transitionExecutionStatus("running", "succeeded")).toBe("succeeded");
  });

  it("keeps terminal states terminal", () => {
    expect(() => transitionExecutionStatus("succeeded", "running")).toThrow(
      InvalidExecutionTransitionError,
    );
    expect(() => transitionExecutionStatus("cancelled", "failed")).toThrow(
      InvalidExecutionTransitionError,
    );
  });
});
