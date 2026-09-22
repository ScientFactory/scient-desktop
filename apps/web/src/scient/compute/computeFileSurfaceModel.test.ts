import {
  ComputeLanguageId,
  ComputeToolkitId,
  type ComputeLanguageRuntimeInspection,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  DEFAULT_COMPUTE_FILE_SPLIT,
  DEFAULT_COMPUTE_FILE_SPLIT_LAYOUT,
  DEFAULT_COMPUTE_FILE_RESULTS_VIEW,
  MIN_COMPUTE_FILE_SPLIT,
  clampComputeFileSplit,
  computeFileViewAfterRun,
  normalizeComputeFileSplit,
  normalizeComputeFileSplitLayout,
  normalizeComputeFileResultsView,
  nudgeComputeFileSplit,
  computeFileSplitFromPointer,
  computeRuntimeDisplayLabel,
  resolveComputeRuntimeToolbarState,
  resolveComputePreRunRuntimeChoice,
  defaultComputeRuntime,
  isComputeCapacityReachedError,
} from "./computeFileSurfaceModel";

const pythonRuntime = {
  languageId: ComputeLanguageId.make("python"),
  source: "configured",
  executable: "/opt/python/bin/python",
  languageVersion: "3.12.13",
  architecture: "arm64",
  displayName: "Python 3.12.13 (configured)",
} as const;

function scientificCandidate(source: "managed" | "path", toolkitReady: boolean) {
  const profile = { ...pythonRuntime, source, executable: `/${source}/python` };
  return {
    profile,
    verification: {
      profile,
      readiness: "ready" as const,
      missingRequirements: [],
      packages: [],
      message: null,
    },
    toolkits: [
      {
        toolkitId: ComputeToolkitId.make("python-data-and-figures"),
        runtime: profile,
        readiness: toolkitReady ? ("ready" as const) : ("missing-requirement" as const),
        missingRequirements: toolkitReady ? [] : ["scipy"],
      },
    ],
  };
}

describe("python compute surface model", () => {
  it("offers an explicit installed managed runtime when automatic Python lacks the scientific toolkit", () => {
    const current = scientificCandidate("path", false);
    const managed = scientificCandidate("managed", true);
    const language: ComputeLanguageRuntimeInspection = {
      descriptor: {
        languageId: pythonRuntime.languageId,
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
        toolkitRevision: "scientific-1",
        toolkitIds: [ComputeToolkitId.make("python-data-and-figures")],
        operation: null,
        failure: null,
        failureMessage: null,
      },
      toolkits: [],
      runtimes: [current, managed],
    };

    expect(resolveComputePreRunRuntimeChoice(language)).toEqual({ current, managed });
    expect(
      resolveComputePreRunRuntimeChoice({ ...language, runtimes: [managed, current] }),
    ).toBeNull();
    expect(
      resolveComputePreRunRuntimeChoice({
        ...language,
        managedRuntime: { ...language.managedRuntime!, installed: false },
      }),
    ).toBeNull();
    expect(
      resolveComputePreRunRuntimeChoice({
        ...language,
        managedRuntime: {
          ...language.managedRuntime!,
          operation: {
            operationId: "repair-1",
            action: "repair",
            phase: "verifying",
            startedAt: "2026-09-22T00:00:00.000Z",
            downloadedBytes: null,
            totalBytes: null,
          },
        },
      }),
    ).toBeNull();
    expect(
      resolveComputePreRunRuntimeChoice({
        ...language,
        managedRuntime: { ...language.managedRuntime!, failureMessage: "Repair failed" },
      }),
    ).toBeNull();
    expect(
      resolveComputePreRunRuntimeChoice({
        ...language,
        runtimes: [scientificCandidate("path", true), managed],
      }),
    ).toBeNull();
    expect(
      resolveComputePreRunRuntimeChoice({
        ...language,
        runtimes: [current, scientificCandidate("managed", false)],
      }),
    ).toBeNull();
    expect(
      resolveComputePreRunRuntimeChoice({
        ...language,
        descriptor: { ...language.descriptor, languageId: ComputeLanguageId.make("matlab") },
      }),
    ).toBeNull();
  });

  it("names runtimes by version and source without exposing executable paths", () => {
    expect(computeRuntimeDisplayLabel(pythonRuntime)).toBe("Python 3.12.13 · Custom");
    expect(computeRuntimeDisplayLabel({ ...pythonRuntime, source: "managed" })).toBe(
      "Python 3.12.13 · Scient-managed",
    );
    expect(computeRuntimeDisplayLabel({ ...pythonRuntime, source: "path" })).toBe(
      "Python 3.12.13 · System",
    );
  });

  it("does not skip an unavailable default in favor of an unrelated ready Python", () => {
    const candidate = (source: "managed" | "path", ready: boolean) => ({
      profile: { ...pythonRuntime, source, executable: `/${source}/python` },
      verification: {
        profile: { ...pythonRuntime, source, executable: `/${source}/python` },
        readiness: ready ? ("ready" as const) : ("missing-requirement" as const),
        missingRequirements: ready ? [] : ["ipykernel"],
        packages: [],
        message: null,
      },
      toolkits: [],
    });
    const language: ComputeLanguageRuntimeInspection = {
      descriptor: {
        languageId: pythonRuntime.languageId,
        displayName: "Python",
        sourceExtensions: [".py"],
        capabilities: [],
      },
      enabled: true,
      configuredExecutable: null,
      managedRuntime: null,
      toolkits: [],
      runtimes: [candidate("managed", false), candidate("path", true)],
    };
    expect(defaultComputeRuntime([language])).toBeNull();
    expect(
      defaultComputeRuntime([
        { ...language, runtimes: [candidate("managed", true), candidate("path", true)] },
      ])?.profile.source,
    ).toBe("managed");
    // Deliberate removal restores existing-runtime precedence.
    expect(
      defaultComputeRuntime([{ ...language, runtimes: [candidate("path", true)] }])?.profile.source,
    ).toBe("path");
    expect(defaultComputeRuntime([{ ...language, enabled: false }])).toBeNull();
  });
  it("remembers only a results layout and keeps the split readable", () => {
    expect(normalizeComputeFileResultsView("split")).toBe("split");
    expect(normalizeComputeFileResultsView("results")).toBe("results");
    expect(normalizeComputeFileResultsView("code")).toBe(DEFAULT_COMPUTE_FILE_RESULTS_VIEW);
    expect(normalizeComputeFileResultsView("console")).toBe(DEFAULT_COMPUTE_FILE_RESULTS_VIEW);
    expect(MIN_COMPUTE_FILE_SPLIT).toBe(0.3);
    expect(computeFileViewAfterRun("code", "results")).toBe("results");
    expect(computeFileViewAfterRun("code", "split")).toBe("split");
    expect(computeFileViewAfterRun("results", "split")).toBe("results");
    expect(computeFileViewAfterRun("split", "results")).toBe("split");
    expect(normalizeComputeFileSplit(null)).toBe(DEFAULT_COMPUTE_FILE_SPLIT);
    expect(clampComputeFileSplit(0.01)).toBe(MIN_COMPUTE_FILE_SPLIT);
    expect(clampComputeFileSplit(0.99)).toBe(1 - MIN_COMPUTE_FILE_SPLIT);
    expect(normalizeComputeFileSplitLayout("stacked")).toBe("stacked");
    expect(normalizeComputeFileSplitLayout("horizontal")).toBe("side-by-side");
    expect(normalizeComputeFileSplitLayout("vertical")).toBe("stacked");
    expect(normalizeComputeFileSplitLayout("invalid")).toBe(DEFAULT_COMPUTE_FILE_SPLIT_LAYOUT);
  });

  it("maps pointer and keyboard movement into accessible divider bounds", () => {
    expect(computeFileSplitFromPointer({ pointerX: 500, left: 0, width: 1000 })).toBe(0.5);
    expect(computeFileSplitFromPointer({ pointerX: 0, left: 0, width: 0 })).toBe(
      DEFAULT_COMPUTE_FILE_SPLIT,
    );
    expect(nudgeComputeFileSplit(0.5, "ArrowLeft")).toBe(0.48);
    expect(nudgeComputeFileSplit(0.5, "ArrowRight")).toBe(0.52);
    expect(nudgeComputeFileSplit(0.5, "ArrowUp")).toBeNull();
    expect(nudgeComputeFileSplit(0.5, "ArrowUp", "y")).toBe(0.48);
    expect(nudgeComputeFileSplit(0.5, "ArrowDown", "y")).toBe(0.52);
    expect(nudgeComputeFileSplit(0.5, "Home")).toBe(MIN_COMPUTE_FILE_SPLIT);
    expect(nudgeComputeFileSplit(0.5, "End")).toBe(1 - MIN_COMPUTE_FILE_SPLIT);
    expect(nudgeComputeFileSplit(0.5, "Enter")).toBeNull();
  });

  it("keeps runtime readiness in one quiet contextual status", () => {
    expect(
      resolveComputeRuntimeToolbarState({
        liveSession: null,
        runtimeInspectionPending: true,
        readyRuntimeAvailable: false,
        preferredRuntimeExecutable: null,
        scientificPackagesMissing: false,
      }),
    ).toEqual({ kind: "status", label: "Checking Python…", canRun: false });
    expect(
      resolveComputeRuntimeToolbarState({
        liveSession: null,
        runtimeInspectionPending: false,
        readyRuntimeAvailable: true,
        preferredRuntimeExecutable: pythonRuntime.executable,
        scientificPackagesMissing: false,
        runtimeVersion: pythonRuntime.languageVersion,
        runtimeSource: pythonRuntime.source,
      }),
    ).toEqual({ kind: "status", label: "Python 3.12.13 · Custom", canRun: true });
    expect(
      resolveComputeRuntimeToolbarState({
        liveSession: null,
        runtimeInspectionPending: false,
        readyRuntimeAvailable: false,
        preferredRuntimeExecutable: null,
        scientificPackagesMissing: false,
      }),
    ).toEqual({ kind: "setup", label: "Set up Python", canRun: false });
    expect(
      resolveComputeRuntimeToolbarState({
        languageId: "matlab",
        languageName: "MATLAB",
        liveSession: null,
        runtimeInspectionPending: false,
        readyRuntimeAvailable: false,
        preferredRuntimeExecutable: null,
        scientificPackagesMissing: false,
      }),
    ).toEqual({ kind: "setup", label: "Connect MATLAB", canRun: false });
    expect(isComputeCapacityReachedError({ reason: "capacity-reached" })).toBe(true);
    expect(isComputeCapacityReachedError(new Error("capacity-reached"))).toBe(false);
    expect(
      resolveComputeRuntimeToolbarState({
        contextLifecycle: "starting",
        capacityRecoveryAvailable: true,
        liveSession: null,
        runtimeInspectionPending: false,
        readyRuntimeAvailable: true,
        preferredRuntimeExecutable: pythonRuntime.executable,
        scientificPackagesMissing: false,
      }),
    ).toEqual({ kind: "status", label: "Python capacity reached", canRun: true });
    expect(
      resolveComputeRuntimeToolbarState({
        contextLifecycle: "starting",
        startingRetryAvailable: true,
        liveSession: null,
        runtimeInspectionPending: false,
        readyRuntimeAvailable: true,
        preferredRuntimeExecutable: pythonRuntime.executable,
        scientificPackagesMissing: false,
      }),
    ).toEqual({ kind: "status", label: "Python retry start", canRun: true });
  });

  it("uses the active session as authority for Python run availability", () => {
    expect(
      resolveComputeRuntimeToolbarState({
        liveSession: {
          activity: "busy",
          label: "Python",
          languageId: ComputeLanguageId.make("python"),
          runtime: pythonRuntime,
          status: "ready",
        },
        runtimeInspectionPending: false,
        readyRuntimeAvailable: false,
        preferredRuntimeExecutable: null,
        scientificPackagesMissing: false,
      }),
    ).toEqual({ kind: "status", label: "Python · Custom · Running", canRun: true });
    expect(
      resolveComputeRuntimeToolbarState({
        liveSession: {
          activity: "idle",
          label: "R",
          languageId: ComputeLanguageId.make("r"),
          runtime: null,
          status: "ready",
        },
        runtimeInspectionPending: false,
        readyRuntimeAvailable: true,
        preferredRuntimeExecutable: pythonRuntime.executable,
        scientificPackagesMissing: false,
      }),
    ).toEqual({ kind: "status", label: "R active", canRun: false });
    expect(
      resolveComputeRuntimeToolbarState({
        liveSession: {
          activity: "idle",
          label: "Python",
          languageId: ComputeLanguageId.make("python"),
          runtime: pythonRuntime,
          status: "starting",
        },
        runtimeInspectionPending: false,
        readyRuntimeAvailable: true,
        preferredRuntimeExecutable: pythonRuntime.executable,
        scientificPackagesMissing: false,
      }),
    ).toEqual({ kind: "status", label: "Python starting", canRun: false });
  });

  it("offers an explicit switch without blocking a deliberately chosen live runtime", () => {
    expect(
      resolveComputeRuntimeToolbarState({
        liveSession: {
          activity: "idle",
          label: "Python",
          languageId: ComputeLanguageId.make("python"),
          runtime: pythonRuntime,
          status: "ready",
        },
        runtimeInspectionPending: false,
        readyRuntimeAvailable: true,
        preferredRuntimeExecutable: "/scient/managed/python",
        scientificPackagesMissing: true,
      }),
    ).toEqual({ kind: "switch", label: "Python · Custom", canRun: true });
  });

  it("distinguishes scientific packages from the ability to run ordinary Python", () => {
    expect(
      resolveComputeRuntimeToolbarState({
        liveSession: null,
        runtimeInspectionPending: false,
        readyRuntimeAvailable: true,
        preferredRuntimeExecutable: pythonRuntime.executable,
        scientificPackagesMissing: true,
        runtimeVersion: pythonRuntime.languageVersion,
      }),
    ).toEqual({
      kind: "status",
      label: "Python 3.12.13",
      canRun: true,
      note: "Some scientific packages are missing",
    });
  });

  it("does not call a metadata probe Python ready or MATLAB ready", () => {
    expect(
      resolveComputeRuntimeToolbarState({
        languageId: "matlab",
        languageName: "MATLAB",
        runtimeVersion: "R2026a",
        liveSession: null,
        runtimeInspectionPending: false,
        readyRuntimeAvailable: true,
        preferredRuntimeExecutable: "/MATLAB/bin/matlab",
        scientificPackagesMissing: false,
      }),
    ).toEqual({ kind: "status", label: "MATLAB R2026a", canRun: true });
    expect(
      resolveComputeRuntimeToolbarState({
        languageId: "matlab",
        languageName: "MATLAB",
        runtimeVersion: "R2026a",
        liveSession: {
          activity: "idle",
          label: "MATLAB",
          languageId: ComputeLanguageId.make("matlab"),
          runtime: {
            ...pythonRuntime,
            languageId: ComputeLanguageId.make("matlab"),
            executable: "/MATLAB/bin/matlab",
            languageVersion: "R2026a",
            displayName: "MATLAB R2026a",
          },
          status: "ready",
        },
        runtimeInspectionPending: false,
        readyRuntimeAvailable: true,
        preferredRuntimeExecutable: "/MATLAB/bin/matlab",
        scientificPackagesMissing: false,
      }),
    ).toEqual({ kind: "status", label: "MATLAB · Custom", canRun: true });
    expect(
      resolveComputeRuntimeToolbarState({
        languageId: "matlab",
        languageName: "MATLAB",
        runtimeVersion: "R2026a",
        liveSession: {
          activity: "idle",
          label: "MATLAB",
          languageId: ComputeLanguageId.make("matlab"),
          runtime: {
            ...pythonRuntime,
            languageId: ComputeLanguageId.make("matlab"),
            executable: "/MATLAB/bin/matlab",
            languageVersion: "R2026a",
            displayName: "MATLAB R2026a",
          },
          status: "ready",
        },
        runtimeInspectionPending: false,
        readyRuntimeAvailable: true,
        preferredRuntimeExecutable: "/MATLAB/bin/matlab",
        scientificPackagesMissing: false,
      }),
    ).toEqual({ kind: "status", label: "MATLAB · Custom", canRun: true });
  });

  it("does not offer a switch from stale inspection data or while work is running", () => {
    const liveSession = {
      activity: "idle",
      label: "Python",
      languageId: ComputeLanguageId.make("python"),
      runtime: pythonRuntime,
      status: "ready",
    } as const;
    const input = {
      liveSession,
      runtimeInspectionPending: true,
      readyRuntimeAvailable: true,
      preferredRuntimeExecutable: "/scient/managed/python",
      scientificPackagesMissing: false,
    };
    expect(resolveComputeRuntimeToolbarState(input)).toEqual({
      kind: "status",
      label: "Python · Custom",
      canRun: true,
    });
    expect(
      resolveComputeRuntimeToolbarState({
        ...input,
        runtimeInspectionPending: false,
        liveSession: { ...liveSession, activity: "busy" },
      }),
    ).toEqual({ kind: "status", label: "Python · Custom · Running", canRun: true });
  });
});
