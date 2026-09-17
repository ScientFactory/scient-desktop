import { describe, expect, it } from "vite-plus/test";
import {
  ComputeLanguageId,
  ComputeToolkitId,
  type ComputeRuntimeInspection,
  type ComputeSessionRecord,
} from "@t3tools/contracts";
import { computeDependencyRecovery } from "./computeDependencyRecovery";

const python = ComputeLanguageId.make("python");
const runtime: NonNullable<ComputeSessionRecord["runtime"]> = {
  languageId: python,
  source: "path",
  executable: "/system/python",
  languageVersion: "3.14.6",
  architecture: "arm64",
  displayName: "Python 3.14.6",
};
const managed: NonNullable<ComputeSessionRecord["runtime"]> = {
  ...runtime,
  source: "managed",
  executable: "/managed/python",
};
const inspection = (): ComputeRuntimeInspection => ({
  contractVersion: 1,
  scope: "project",
  languages: [
    {
      descriptor: {
        languageId: python,
        displayName: "Python",
        sourceExtensions: [".py"],
        capabilities: [],
      },
      enabled: true,
      configuredExecutable: null,
      managedRuntime: {
        installed: true,
        selection: "existing",
        updateAvailable: false,
        runtimeVersion: "3.12.13",
        toolkitRevision: "synthetic",
        operation: null,
        failureMessage: null,
      },
      toolkits: [
        {
          toolkitId: ComputeToolkitId.make("python-data-and-figures"),
          languageId: python,
          displayName: "Scientific Python",
          summary: "Synthetic",
          required: true,
          packageRequirements: [{ name: "pandas", displayName: "pandas", minimumVersion: null }],
        },
      ],
      runtimes: [
        {
          profile: managed,
          verification: {
            profile: managed,
            readiness: "ready",
            missingRequirements: [],
            message: null,
            packages: [{ name: "pandas", version: "2.3.3" }],
          },
          toolkits: [],
        },
      ],
    },
  ],
});
const diagnostic = { errorName: "ModuleNotFoundError", message: "No module named 'pandas'" };
const session = { languageId: python, runtime };
const recover = (data: ComputeRuntimeInspection | null) =>
  computeDependencyRecovery({ diagnostic, session, inspection: data });

describe("dependency recovery guidance", () => {
  it("offers only an observed alternative, without changing the runtime", () => {
    const data = inspection();
    const before = structuredClone(data);
    expect(recover(data)).toEqual({ moduleName: "pandas", managedHasPackage: true });
    expect(data).toEqual(before);
  });
  it("does not infer package presence from the managed installation alone", () => {
    const data = inspection();
    expect(recover(null)?.managedHasPackage).toBe(false);
    expect(
      recover({ ...data, languages: [{ ...data.languages[0]!, runtimes: [] }] })?.managedHasPackage,
    ).toBe(false);
  });
  it.each([
    "No module named 'my_project'",
    "No module named 'pandas.compat'",
    "No module named 'pandas'; 'pandas' is not a package",
    "install pandas please",
    "No module named 'pandas'\nextra",
    "No module named 'pandas'\n",
    "No module named 'constructor'",
  ])("does not guess a package for %s", (message) => {
    expect(
      computeDependencyRecovery({
        diagnostic: { ...diagnostic, message },
        session,
        inspection: inspection(),
      }),
    ).toBeNull();
  });
  it("does not apply Python recovery to other languages or error types", () => {
    expect(
      computeDependencyRecovery({
        diagnostic,
        session: { ...session, languageId: ComputeLanguageId.make("matlab") },
        inspection: inspection(),
      }),
    ).toBeNull();
    expect(
      computeDependencyRecovery({
        diagnostic: { ...diagnostic, errorName: "ImportError" },
        session,
        inspection: inspection(),
      }),
    ).toBeNull();
  });
  it.each(["yaml", "PIL", "sklearn", "skimage", "Bio"])(
    "recognizes reviewed import spelling %s without claiming an unobserved distribution",
    (moduleName) => {
      expect(
        computeDependencyRecovery({
          diagnostic: { ...diagnostic, message: `No module named '${moduleName}'` },
          session,
          inspection: inspection(),
        }),
      ).toEqual({ moduleName, managedHasPackage: false });
    },
  );
  it("requires a usable, catalogued, different managed environment", () => {
    const data = inspection();
    const language = data.languages[0]!;
    const candidate = language.runtimes[0]!;
    for (const changed of [
      { ...language, enabled: false },
      { ...language, toolkits: [] },
      { ...language, managedRuntime: null },
      {
        ...language,
        managedRuntime: {
          ...language.managedRuntime!,
          operation: {
            operationId: "removal",
            action: "remove" as const,
            phase: "removing" as const,
            startedAt: "2026-09-17T00:00:00Z",
            downloadedBytes: null,
            totalBytes: null,
          },
        },
      },
      {
        ...language,
        managedRuntime: {
          ...language.managedRuntime!,
          toolkitChanges: [
            {
              toolkitId: ComputeToolkitId.make("python-large-data"),
              install: true,
              state: "queued" as const,
              error: null,
            },
          ],
        },
      },
      { ...language, managedRuntime: { ...language.managedRuntime!, installed: false } },
      {
        ...language,
        managedRuntime: { ...language.managedRuntime!, failureMessage: "Needs repair" },
      },
      {
        ...language,
        runtimes: [
          {
            ...candidate,
            verification: { ...candidate.verification, readiness: "unusable" as const },
          },
        ],
      },
      {
        ...language,
        runtimes: [
          {
            ...candidate,
            verification: {
              ...candidate.verification,
              packages: [{ name: "pandas", version: null }],
            },
          },
        ],
      },
      {
        ...language,
        runtimes: [{ ...candidate, verification: { ...candidate.verification, profile: runtime } }],
      },
    ]) {
      expect(recover({ ...data, languages: [changed] })?.managedHasPackage).toBe(false);
    }
    expect(
      computeDependencyRecovery({
        diagnostic,
        session: { ...session, runtime: managed },
        inspection: data,
      })?.managedHasPackage,
    ).toBe(false);
    expect(
      computeDependencyRecovery({
        diagnostic,
        session: { ...session, runtime: null },
        inspection: data,
      })?.managedHasPackage,
    ).toBe(false);
    expect(
      computeDependencyRecovery({
        diagnostic,
        session: { ...session, runtime: { ...runtime, executable: managed.executable } },
        inspection: data,
      })?.managedHasPackage,
    ).toBe(false);
  });

  it.each([
    ["yaml", "pyyaml"],
    ["PIL", "pillow"],
    ["sklearn", "scikit-learn"],
    ["skimage", "scikit-image"],
    ["Bio", "biopython"],
  ])("matches import %s to observed distribution %s", (moduleName, distribution) => {
    const data = inspection();
    const language = data.languages[0]!;
    const candidate = language.runtimes[0]!;
    const result = computeDependencyRecovery({
      diagnostic: { ...diagnostic, message: `No module named '${moduleName}'` },
      session,
      inspection: {
        ...data,
        languages: [
          {
            ...language,
            toolkits: [
              {
                ...language.toolkits[0]!,
                packageRequirements: [
                  { name: distribution, displayName: distribution, minimumVersion: null },
                ],
              },
            ],
            runtimes: [
              {
                ...candidate,
                verification: {
                  ...candidate.verification,
                  packages: [{ name: distribution, version: "1.0" }],
                },
              },
            ],
          },
        ],
      },
    });
    expect(result).toEqual({ moduleName, managedHasPackage: true });
  });
});
