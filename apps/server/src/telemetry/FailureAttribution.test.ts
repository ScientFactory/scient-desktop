import { describe, expect, it } from "@effect/vitest";
import {
  captureRejectionAttribution,
  computeRunAttribution,
  latexBuildAttribution,
  programRunAttribution,
  toolFailureAttribution,
} from "./FailureAttribution.ts";

describe("failure attribution", () => {
  it.each([
    [{ kind: "runtime-reported", errorName: "ValueError" }, false, "code", "code-error"],
    [{ kind: "runtime-reported", errorName: "SyntaxError" }, false, "code", "syntax"],
    // A user-defined exception is still the code's failure.
    [{ kind: "runtime-reported", errorName: "PrivateProjectError" }, false, "code", "code-error"],
    [
      { kind: "runtime-reported", errorName: "requests.exceptions.ConnectionError" },
      false,
      "external",
      "network",
    ],
    [
      { kind: "runtime-reported", errorName: "ModuleNotFoundError" },
      false,
      "environment",
      "missing-dependency",
    ],
    // Scient-managed Python promises its Toolkits, so a missing module there may be Scient's.
    [
      { kind: "runtime-reported", errorName: "ModuleNotFoundError" },
      true,
      "unknown",
      "missing-dependency",
    ],
    [{ kind: "runtime-reported", errorName: "MemoryError" }, false, "environment", "out-of-memory"],
    [{ kind: "not-admitted" }, false, "scient", "dispatch"],
    [{ kind: "runtime-start" }, true, "scient", "runtime-start"],
    [{ kind: "runtime-start" }, false, "environment", "runtime-start"],
    [{ kind: "lost", reason: "server-restart" }, false, "scient", "app-restart"],
    [{ kind: "lost", reason: "transport-failed" }, false, "scient", "runtime-connection"],
    [{ kind: "lost", reason: "exited" }, false, "unknown", "runtime-exited"],
  ] as const)("compute %j (managed %s) belongs to %s", (facts, managed, owner, category) => {
    expect(computeRunAttribution(facts, managed)).toEqual({
      failureOwner: owner,
      failureCategory: category,
    });
  });

  it.each([
    ["failed", 1, "code", "nonzero-exit"],
    ["failed", 0, "unknown", "failed-after-exit"],
    ["failed", null, "unknown", "not-started"],
    ["lost", null, "unknown", "runtime-exited"],
  ] as const)(
    "a %s program run with exit %s belongs to %s",
    (status, exitCode, owner, category) => {
      expect(programRunAttribution(status, exitCode)).toEqual({
        failureOwner: owner,
        failureCategory: category,
      });
    },
  );

  it.each([
    ["compile_error", "code"],
    ["missing_package", "environment"],
    ["internal", "scient"],
    ["timeout", "unknown"],
  ] as const)("LaTeX %s belongs to %s", (failureClass, owner) => {
    expect(latexBuildAttribution(failureClass).failureOwner).toBe(owner);
  });

  it.each([
    ["persistence-failed", "scient"],
    ["output-limit", "scient"],
    ["invalid-image", "code"],
    [undefined, "unknown"],
  ] as const)("a figure rejected for %s belongs to %s", (reason, owner) => {
    expect(captureRejectionAttribution(reason).failureOwner).toBe(owner);
  });

  it.each([
    ["invalid_selector", "input"],
    ["session_not_found", "input"],
    ["control_interrupted", "cancelled"],
    ["permission_denied", "environment"],
    ["network", "external"],
    ["no_host", "scient"],
    ["timeout", "unknown"],
  ] as const)("a tool error %s belongs to %s", (errorCode, owner) => {
    expect(toolFailureAttribution(errorCode).failureOwner).toBe(owner);
  });
});
