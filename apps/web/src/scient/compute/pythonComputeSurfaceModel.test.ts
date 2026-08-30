import { ComputeLanguageId, type ComputeLanguageRuntimeInspection } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  DEFAULT_PYTHON_COMPUTE_SPLIT,
  DEFAULT_PYTHON_COMPUTE_SPLIT_LAYOUT,
  MIN_PYTHON_COMPUTE_SPLIT,
  clampPythonComputeSplit,
  normalizePythonComputeSplit,
  normalizePythonComputeSplitLayout,
  normalizePythonComputeView,
  nudgePythonComputeSplit,
  pythonComputeSplitFromPointer,
  resolvePythonRuntimeToolbarState,
  defaultComputeRuntime,
} from "./pythonComputeSurfaceModel";

const pythonRuntime = {
  languageId: ComputeLanguageId.make("python"),
  source: "configured",
  executable: "/opt/python/bin/python",
  languageVersion: "3.12.13",
  architecture: "arm64",
  displayName: "Python 3.12.13 (configured)",
} as const;

describe("python compute surface model", () => {
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
  it("normalizes persisted modes and split ratios", () => {
    expect(normalizePythonComputeView("results")).toBe("results");
    expect(normalizePythonComputeView("console")).toBe("code");
    expect(normalizePythonComputeSplit(null)).toBe(DEFAULT_PYTHON_COMPUTE_SPLIT);
    expect(clampPythonComputeSplit(0.01)).toBe(MIN_PYTHON_COMPUTE_SPLIT);
    expect(clampPythonComputeSplit(0.99)).toBe(1 - MIN_PYTHON_COMPUTE_SPLIT);
    expect(normalizePythonComputeSplitLayout("stacked")).toBe("stacked");
    expect(normalizePythonComputeSplitLayout("horizontal")).toBe("side-by-side");
    expect(normalizePythonComputeSplitLayout("vertical")).toBe("stacked");
    expect(normalizePythonComputeSplitLayout("invalid")).toBe(DEFAULT_PYTHON_COMPUTE_SPLIT_LAYOUT);
  });

  it("maps pointer and keyboard movement into accessible divider bounds", () => {
    expect(pythonComputeSplitFromPointer({ pointerX: 500, left: 0, width: 1000 })).toBe(0.5);
    expect(pythonComputeSplitFromPointer({ pointerX: 0, left: 0, width: 0 })).toBe(
      DEFAULT_PYTHON_COMPUTE_SPLIT,
    );
    expect(nudgePythonComputeSplit(0.5, "ArrowLeft")).toBe(0.48);
    expect(nudgePythonComputeSplit(0.5, "ArrowRight")).toBe(0.52);
    expect(nudgePythonComputeSplit(0.5, "ArrowUp")).toBeNull();
    expect(nudgePythonComputeSplit(0.5, "ArrowUp", "y")).toBe(0.48);
    expect(nudgePythonComputeSplit(0.5, "ArrowDown", "y")).toBe(0.52);
    expect(nudgePythonComputeSplit(0.5, "Home")).toBe(MIN_PYTHON_COMPUTE_SPLIT);
    expect(nudgePythonComputeSplit(0.5, "End")).toBe(1 - MIN_PYTHON_COMPUTE_SPLIT);
    expect(nudgePythonComputeSplit(0.5, "Enter")).toBeNull();
  });

  it("keeps runtime readiness in one quiet contextual status", () => {
    expect(
      resolvePythonRuntimeToolbarState({
        liveSession: null,
        runtimeInspectionPending: true,
        readyPythonAvailable: false,
        preferredPythonExecutable: null,
        scientificPackagesMissing: false,
      }),
    ).toEqual({ kind: "status", label: "Checking Python…", canRun: false });
    expect(
      resolvePythonRuntimeToolbarState({
        liveSession: null,
        runtimeInspectionPending: false,
        readyPythonAvailable: true,
        preferredPythonExecutable: pythonRuntime.executable,
        scientificPackagesMissing: false,
      }),
    ).toEqual({ kind: "status", label: "Python ready", canRun: true });
    expect(
      resolvePythonRuntimeToolbarState({
        liveSession: null,
        runtimeInspectionPending: false,
        readyPythonAvailable: false,
        preferredPythonExecutable: null,
        scientificPackagesMissing: false,
      }),
    ).toEqual({ kind: "setup", label: "Set up Python", canRun: false });
  });

  it("uses the active session as authority for Python run availability", () => {
    expect(
      resolvePythonRuntimeToolbarState({
        liveSession: {
          activity: "busy",
          label: "Python",
          languageId: ComputeLanguageId.make("python"),
          runtime: pythonRuntime,
          status: "ready",
        },
        runtimeInspectionPending: false,
        readyPythonAvailable: false,
        preferredPythonExecutable: null,
        scientificPackagesMissing: false,
      }),
    ).toEqual({ kind: "status", label: "Python running", canRun: true });
    expect(
      resolvePythonRuntimeToolbarState({
        liveSession: {
          activity: "idle",
          label: "R",
          languageId: ComputeLanguageId.make("r"),
          runtime: null,
          status: "ready",
        },
        runtimeInspectionPending: false,
        readyPythonAvailable: true,
        preferredPythonExecutable: pythonRuntime.executable,
        scientificPackagesMissing: false,
      }),
    ).toEqual({ kind: "status", label: "R active", canRun: false });
    expect(
      resolvePythonRuntimeToolbarState({
        liveSession: {
          activity: "idle",
          label: "Python",
          languageId: ComputeLanguageId.make("python"),
          runtime: pythonRuntime,
          status: "starting",
        },
        runtimeInspectionPending: false,
        readyPythonAvailable: true,
        preferredPythonExecutable: pythonRuntime.executable,
        scientificPackagesMissing: false,
      }),
    ).toEqual({ kind: "status", label: "Python starting", canRun: false });
  });

  it("offers an explicit switch without blocking a deliberately chosen live runtime", () => {
    expect(
      resolvePythonRuntimeToolbarState({
        liveSession: {
          activity: "idle",
          label: "Python",
          languageId: ComputeLanguageId.make("python"),
          runtime: pythonRuntime,
          status: "ready",
        },
        runtimeInspectionPending: false,
        readyPythonAvailable: true,
        preferredPythonExecutable: "/scient/managed/python",
        scientificPackagesMissing: true,
      }),
    ).toEqual({ kind: "switch", label: "Switch Python", canRun: true });
  });

  it("distinguishes scientific packages from the ability to run ordinary Python", () => {
    expect(
      resolvePythonRuntimeToolbarState({
        liveSession: null,
        runtimeInspectionPending: false,
        readyPythonAvailable: true,
        preferredPythonExecutable: pythonRuntime.executable,
        scientificPackagesMissing: true,
      }),
    ).toEqual({ kind: "status", label: "Python packages missing", canRun: true });
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
      readyPythonAvailable: true,
      preferredPythonExecutable: "/scient/managed/python",
      scientificPackagesMissing: false,
    };
    expect(resolvePythonRuntimeToolbarState(input)).toEqual({
      kind: "status",
      label: "Python ready",
      canRun: true,
    });
    expect(
      resolvePythonRuntimeToolbarState({
        ...input,
        runtimeInspectionPending: false,
        liveSession: { ...liveSession, activity: "busy" },
      }),
    ).toEqual({ kind: "status", label: "Python running", canRun: true });
  });
});
