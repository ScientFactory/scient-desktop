import type { ScientOverleafOperationSnapshot } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { overleafAuthorEmailError, overleafOperationFailureMessage } from "./validation";

function operation(
  phase: ScientOverleafOperationSnapshot["phase"],
  message: string,
): ScientOverleafOperationSnapshot {
  return {
    operationId: "00000000-0000-4000-8000-000000000001",
    connectionId: null,
    kind: "connect",
    connectStage: "preflight",
    generation: 1,
    phase,
    message,
    review: null,
    conflicts: [],
    errorCode: phase === "failed" ? "authentication_failed" : null,
    retryable: phase === "failed",
    startedAtEpochMs: 1,
    updatedAtEpochMs: 1,
  };
}

describe("Overleaf settings validation", () => {
  it("requires a complete author email address", () => {
    expect(overleafAuthorEmailError("")).toContain("email address");
    expect(overleafAuthorEmailError("Polatov")).toContain("complete email address");
    expect(overleafAuthorEmailError("yishay@example.com")).toBeNull();
  });

  it("keeps asynchronous preflight failures visible", () => {
    expect(overleafOperationFailureMessage(operation("failed", "Git access is unavailable."))).toBe(
      "Git access is unavailable.",
    );
    expect(overleafOperationFailureMessage(operation("interrupted", "Server restarted."))).toBe(
      "Server restarted.",
    );
    expect(overleafOperationFailureMessage(operation("succeeded", "Connected."))).toBeNull();
  });
});
