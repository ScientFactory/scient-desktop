import {
  ComputeLanguageId,
  ComputeToolkitAssessment,
  type ComputeLanguageRuntimeInventory,
  type ComputeLanguageRuntimeInspection,
  type ComputeManagedRuntimeStatus,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import {
  RuntimeDetails,
  RuntimeInventoryDetails,
  inventoryStatusLabel,
  managedRuntimeOperationLabel,
} from "./ScientificComputingSettings";

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
  it("keeps filesystem detection distinct from explicit verification", () => {
    const inventory: ComputeLanguageRuntimeInventory = {
      descriptor: {
        languageId: ComputeLanguageId.make("matlab"),
        displayName: "MATLAB",
        sourceExtensions: [".m"],
        capabilities: [],
      },
      enabled: true,
      configuredExecutable: null,
      managedRuntime: null,
      toolkits: [],
      installations: [
        {
          executable: "/Applications/MATLAB.app/bin/matlab",
          source: "conventional",
          version: "R2026a",
          problem: null,
        },
      ],
      failureMessage: null,
    };

    expect(inventoryStatusLabel(inventory, true, null)).toBe("Detected");
    expect(
      inventoryStatusLabel(inventory, true, {
        pending: false,
        error: null,
        result: {
          profile: {
            languageId: ComputeLanguageId.make("matlab"),
            source: "conventional",
            executable: "/Applications/MATLAB.app/bin/matlab",
            languageVersion: "R2026a",
            architecture: "arm64",
            displayName: "MATLAB R2026a",
          },
          readiness: "ready",
          connection: "verified",
          missingRequirements: [],
          message: null,
          packages: [],
        },
      }),
    ).toBe("Verified");

    const markup = renderToStaticMarkup(
      <RuntimeInventoryDetails
        language={inventory}
        onVerify={() => undefined}
        verificationState={null}
      />,
    );
    expect(markup).toContain("System installation");
    expect(markup).toContain("Copy runtime path");
    expect(markup).toContain(">Detected<");
    expect(markup).toContain(">Verify<");
  });

  it("does not present passive MATLAB detection as a verified connection", () => {
    const markup = renderToStaticMarkup(
      <RuntimeDetails
        enabled
        onVerify={() => undefined}
        language={language({
          profile,
          readiness: "ready",
          connection: "detected",
          missingRequirements: [],
          message: null,
          packages: [],
        })}
      />,
    );
    expect(markup).toContain("Detected");
    expect(markup).toContain("Verify connection");
    expect(markup).not.toContain(">Ready<");
    expect(markup).not.toContain(">Verified<");
  });

  it("shows alternative installations once with a single use action", () => {
    const inventory: ComputeLanguageRuntimeInventory = {
      descriptor: {
        languageId: ComputeLanguageId.make("python"),
        displayName: "Python",
        sourceExtensions: [".py"],
        capabilities: [],
      },
      enabled: true,
      configuredExecutable: null,
      managedRuntime: null,
      toolkits: [],
      installations: [
        {
          executable: "/managed/python",
          source: "managed",
          version: "3.12.13",
          problem: null,
        },
        {
          executable: "/usr/bin/python3",
          source: "path",
          version: null,
          problem: null,
        },
      ],
      failureMessage: null,
    };

    const markup = renderToStaticMarkup(
      <RuntimeInventoryDetails
        language={inventory}
        onVerify={() => undefined}
        onUse={() => undefined}
        verificationState={null}
        excludedExecutables={["/managed/python"]}
      />,
    );

    expect(markup).not.toContain("/managed/python");
    expect(markup).toContain("/usr/bin/python3");
    expect(markup).toContain(">Use<");
    expect(markup).not.toContain(">Verify<");
  });

  it("shows explicit verification failures without dropping their recovery guidance", () => {
    const detected = {
      profile,
      readiness: "ready",
      connection: "detected",
      missingRequirements: [],
      message: null,
      packages: [],
    } as const;
    const markup = renderToStaticMarkup(
      <RuntimeDetails
        enabled
        language={language(detected)}
        verificationState={{
          executable: profile.executable,
          pending: false,
          error: null,
          result: {
            ...detected,
            readiness: "unusable",
            message: "Check your MATLAB license, then verify again.",
          },
        }}
      />,
    );
    expect(markup).toContain("Check your MATLAB license");
    expect(markup).not.toContain(">Ready<");
    expect(markup).not.toContain(">Verified<");
  });

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
