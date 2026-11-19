// @effect-diagnostics nodeBuiltinImport:off -- reads the bridge source to pin its fixed reasons.
import * as NodeFS from "node:fs";

import { describe, expect, it } from "@effect/vitest";
import {
  captureRejectionAttribution,
  COMPUTE_BRIDGE_LOSS_PREFIXES,
  computeRunAttribution,
  latexBuildAttribution,
  pdfExportAttribution,
  programRunAttribution,
  toolFailureAttribution,
} from "./FailureAttribution.ts";

describe("failure attribution", () => {
  it.each([
    ["admission-timeout", "scient", "admission-timeout"],
    ["protocol-error", "scient", "protocol-error"],
    ["missing-capability", "scient", "missing-capability"],
    ["persistence-failed", "scient", "persistence-failed"],
    // A kernel can die of the user's code, memory or an extension.
    ["kernel-exited", "unknown", "kernel-exited"],
    ["kernel-connection", "unknown", "kernel-connection"],
    ["exited", "unknown", "runtime-exited"],
  ] as const)("attributes a run lost for %s", (reason, owner, category) => {
    expect(computeRunAttribution({ kind: "lost", reason }, false)).toEqual({
      failureOwner: owner,
      failureCategory: category,
    });
  });

  it("attributes a run Scient refused because its source changed to the input", () => {
    expect(
      computeRunAttribution(
        { kind: "runtime-reported", errorName: "Scient:SourceConflict" },
        false,
      ),
    ).toEqual({ failureOwner: "input", failureCategory: "source-conflict" });
  });

  it("reads loss reasons the compute bridge still writes", () => {
    const bridge = NodeFS.readFileSync(
      new URL("../scient/compute/bridge/scient_compute_bridge.py", import.meta.url),
      "utf8",
    );
    for (const [prefix] of COMPUTE_BRIDGE_LOSS_PREFIXES) expect(bridge).toContain(prefix);
  });

  it("says why a run file did not start", () => {
    expect(programRunAttribution("failed", null, "runtime-missing")).toEqual({
      failureOwner: "environment",
      failureCategory: "runtime-missing",
    });
    expect(programRunAttribution("failed", null, "source-changed")).toEqual({
      failureOwner: "input",
      failureCategory: "source-changed",
    });
    expect(programRunAttribution("failed", null)).toEqual({
      failureOwner: "unknown",
      failureCategory: "not-started",
    });
  });

  it("attributes a PDF export by its typed code only", () => {
    expect(pdfExportAttribution("renderer-unavailable")).toEqual({
      failureOwner: "scient",
      failureCategory: "renderer-unavailable",
    });
    expect(pdfExportAttribution("source-not-found")).toEqual({
      failureOwner: "input",
      failureCategory: "source-not-found",
    });
    expect(pdfExportAttribution("/private/path")).toBeUndefined();
    expect(pdfExportAttribution(undefined)).toBeUndefined();
  });

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
    // A skill save that could not write is Scient's; a name already used is the agent's.
    ["storage_failed", "scient"],
    ["name_taken", "input"],
    ["timeout", "unknown"],
  ] as const)("a tool error %s belongs to %s", (errorCode, owner) => {
    expect(toolFailureAttribution(errorCode).failureOwner).toBe(owner);
  });
});
