import {
  ComputeLanguageId,
  ComputeToolkitAssessment,
  type ComputeLanguageRuntimeInspection,
  type ComputeManagedRuntimeStatus,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { RuntimeDetails, managedRuntimeOperationLabel } from "./ScientificComputingSettings";

const decodeToolkitAssessment = Schema.decodeUnknownSync(ComputeToolkitAssessment);

const profile = {
  languageId: ComputeLanguageId.make("python"),
  source: "path",
  executable: "/usr/bin/python3",
  languageVersion: "3.14.0",
  architecture: "arm64",
  displayName: "Python 3.14.0 (path)",
} as const;

function language(
  verification: ComputeLanguageRuntimeInspection["runtimes"][number]["verification"],
): ComputeLanguageRuntimeInspection {
  return {
    descriptor: {
      languageId: ComputeLanguageId.make("python"),
      displayName: "Python",
      sourceExtensions: [".py"],
      capabilities: ["execute", "interrupt", "restart", "shutdown"],
    },
    enabled: true,
    configuredExecutable: null,
    managedRuntime: null,
    toolkits: [],
    runtimes: [{ profile, verification, toolkits: [] }],
  };
}

describe("scientific computing runtime details", () => {
  it("shows actionable guidance without hiding the missing requirements", () => {
    const message =
      "Create or select a Python environment that satisfies: jupyter_client, ipykernel. " +
      "Project .venv environments are detected when that project is open. " +
      "Scient's isolated compute bridge does not load packages installed with pip --user.";
    const markup = renderToStaticMarkup(
      <RuntimeDetails
        enabled
        language={language({
          profile,
          readiness: "missing-requirement",
          missingRequirements: ["jupyter_client", "ipykernel"],
          message,
          packages: [],
        })}
      />,
    );

    expect(markup).toContain("Missing: jupyter_client, ipykernel");
    expect(markup).toContain("Project .venv environments are detected when that project is open.");
    expect(markup).toContain("pip --user");
  });

  it("keeps a ready runtime quiet", () => {
    const markup = renderToStaticMarkup(
      <RuntimeDetails
        enabled
        language={language({
          profile,
          readiness: "ready",
          missingRequirements: [],
          message: null,
          packages: [],
        })}
      />,
    );

    expect(markup).toContain("Ready");
    expect(markup).not.toContain("Project .venv");
    expect(markup).not.toContain("pip --user");
  });

  it("shows scientific package gaps separately from a runnable Python", () => {
    const inspected = language({
      profile,
      readiness: "ready",
      missingRequirements: [],
      message: null,
      packages: [{ name: "pandas", version: null }],
    });
    const assessment = decodeToolkitAssessment({
      toolkitId: "python-data-and-figures",
      runtime: profile,
      readiness: "missing-requirement",
      missingRequirements: ["pandas"],
    });
    const markup = renderToStaticMarkup(
      <RuntimeDetails
        enabled
        language={{
          ...inspected,
          runtimes: [{ ...inspected.runtimes[0]!, toolkits: [assessment] }],
        }}
      />,
    );

    expect(markup).toContain("Ready");
    expect(markup).toContain("Scientific packages: missing pandas");
  });

  it("labels the managed runtime without hiding its exact executable", () => {
    const managedLanguage = language({
      profile: { ...profile, source: "managed" },
      readiness: "ready",
      missingRequirements: [],
      message: null,
      packages: [],
    });
    const markup = renderToStaticMarkup(
      <RuntimeDetails
        enabled
        language={{
          ...managedLanguage,
          runtimes: [
            {
              ...managedLanguage.runtimes[0]!,
              profile: { ...profile, source: "managed" },
            },
          ],
        }}
      />,
    );

    expect(markup).toContain("Scient-managed");
    expect(markup).toContain("/usr/bin/python3");
  });

  it("shows bounded truthful lifecycle progress", () => {
    const status = (
      phase: NonNullable<ComputeManagedRuntimeStatus["operation"]>["phase"],
    ): ComputeManagedRuntimeStatus => ({
      installed: false,
      selection: "existing",
      updateAvailable: false,
      runtimeVersion: null,
      toolkitRevision: null,
      operation: {
        operationId: "operation-1",
        action: "install",
        phase,
        startedAt: "2026-08-30T00:00:00.000Z",
        downloadedBytes: phase === "downloading" ? 5 * 1024 * 1024 : null,
        totalBytes: phase === "downloading" ? 20 * 1024 * 1024 : null,
      },
      failureMessage: null,
    });

    expect(managedRuntimeOperationLabel(status("downloading"))).toBe(
      "Downloading the verified installer · 5.0 of 20.0 MB",
    );
    expect(managedRuntimeOperationLabel(status("installing-python"))).toBe(
      "Installing private Python…",
    );
    expect(managedRuntimeOperationLabel(status("installing-packages"))).toContain(
      "locked scientific packages",
    );
    expect(managedRuntimeOperationLabel(status("verifying"))).toContain("Verifying Python");
  });
});
