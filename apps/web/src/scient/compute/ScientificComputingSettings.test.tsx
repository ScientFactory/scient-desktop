import { ComputeLanguageId, type ComputeLanguageRuntimeInspection } from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { RuntimeDetails } from "./ScientificComputingSettings";

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
    runtimes: [{ profile, verification }],
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
        })}
      />,
    );

    expect(markup).toContain("Ready");
    expect(markup).not.toContain("Project .venv");
    expect(markup).not.toContain("pip --user");
  });
});
