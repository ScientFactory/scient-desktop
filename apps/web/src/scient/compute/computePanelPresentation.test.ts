import { describe, expect, it } from "vite-plus/test";

import { resolveComputeEmptyResultsState } from "./computePanelPresentation";

describe("empty compute result presentation", () => {
  const base = {
    contextLifecycle: "live" as const,
    sessionStatus: "ready",
    sessionActivity: "idle",
    historyPending: false,
    focusExecutionPending: false,
    sourceFile: true,
  };

  it.each([
    [{ ...base, contextLifecycle: "closing" as const }, "stopping-session"],
    [{ ...base, contextLifecycle: "starting" as const }, "starting-session"],
    [{ ...base, sessionStatus: "starting" }, "starting-session"],
    [{ ...base, sessionActivity: "busy" }, "running"],
    [{ ...base, focusExecutionPending: true }, "running"],
    [{ ...base, historyPending: true }, "loading-history"],
    [base, "idle-file"],
    [{ ...base, sourceFile: false }, "idle-session"],
  ] as const)("maps lifecycle truth to %s", (input, expected) => {
    expect(resolveComputeEmptyResultsState(input)).toBe(expected);
  });

  it("never lets history loading hide an active lifecycle", () => {
    expect(
      resolveComputeEmptyResultsState({
        ...base,
        contextLifecycle: "starting",
        historyPending: true,
      }),
    ).toBe("starting-session");
  });
});
