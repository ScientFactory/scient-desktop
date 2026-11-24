import { initializeScientProject, readScientProjectIdentity } from "@scientfactory/project-init";
import {
  ComputeExecutionId,
  ComputeLanguageId,
  ComputeToolkitId,
  ComputeProjectId,
  ComputeSessionId,
  ComputeTransportKind,
  INITIAL_COMPUTE_SESSION_GENERATION,
  type ComputeExecutionRecord,
  type ComputeSessionRecord,
} from "@scientfactory/compute";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { WorkspaceAuthorityGeneration } from "@scientfactory/operations";
import { DEFAULT_SERVER_SETTINGS, NotebookError } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import { extractComputeSourceRange, makeComputeRpcGateway } from "./ComputeRpcGateway.ts";
import { computeWorkspaceResolverForTest } from "./ComputeWorkspaceTestUtils.ts";
import { WorkspaceBindingResolutionError } from "../projectScope/WorkspaceBinding.ts";
import {
  workspaceResolverForTest,
  workspaceScopeForTest,
} from "../projectScope/WorkspaceBindingTestUtils.ts";
import { WorkspacePaths, layer as workspacePathsLayer } from "../../workspace/WorkspacePaths.ts";
import { makeNotebookRunJobs } from "../notebook/NotebookRunJobs.ts";
import { makeNotebookRuns } from "../notebook/notebookRuns.ts";
import { PYTHON_DATA_AND_FIGURES_TOOLKIT, assessPythonToolkit } from "./PythonToolkitCatalog.ts";

const PYTHON = ComputeLanguageId.make("python");
const PROFILE = {
  languageId: PYTHON,
  source: "path" as const,
  executable: "/usr/bin/python3",
  languageVersion: "3.12.0",
  architecture: "arm64",
  displayName: "Python 3.12.0",
};
const DESCRIPTOR = {
  languageId: PYTHON,
  displayName: "Python",
  sourceExtensions: [".py"],
  capabilities: ["execute", "interrupt", "restart", "shutdown", "variables"] as const,
};

type GatewayCompute = Parameters<typeof makeComputeRpcGateway>[0]["compute"];
type GatewayWorkspace = Parameters<typeof makeComputeRpcGateway>[0]["workspaceFileSystem"];

function workspace(contents = "", revision = "sha256:test"): GatewayWorkspace {
  return {
    readFile: (input) =>
      Effect.succeed({
        relativePath: input.relativePath,
        contents,
        byteLength: new TextEncoder().encode(contents).byteLength,
        truncated: false,
        revision,
      }),
  };
}

function record(
  projectId: ComputeProjectId,
  sessionId: ComputeSessionId,
  createdAt = "2026-08-20T12:00:00.000Z",
): ComputeSessionRecord {
  return {
    sessionId,
    projectId,
    label: "Python",
    languageId: PYTHON,
    transportKind: ComputeTransportKind.make("jupyter-bridge"),
    workingDirectory: "/project",
    runtime: PROFILE,
    identity: null,
    environmentFingerprint: null,
    generation: INITIAL_COMPUTE_SESSION_GENERATION,
    status: "ready",
    activity: "idle",
    activeExecutionId: null,
    pendingCount: 0,
    storage: {
      status: "retained",
      outputBytes: 0,
      imageBytes: 0,
      totalBytes: 0,
      removedAt: null,
    },
    createdAt,
    lastActivityAt: createdAt,
    closedAt: null,
    lostReason: null,
  };
}

function computeStub(overrides: Partial<GatewayCompute> = {}): GatewayCompute {
  const managedRuntime = {
    installed: false,
    selection: "existing" as const,
    updateAvailable: false,
    runtimeVersion: null,
    toolkitRevision: null,
    operation: null,
    failureMessage: null,
  };
  return {
    activeWork: Effect.succeed(0),
    settledRuns: Stream.empty,
    settledRunRecorded: () => Effect.void,
    runtimeDescriptors: [DESCRIPTOR],
    runtimeInventory: () =>
      Effect.succeed({
        languages: [
          {
            descriptor: DESCRIPTOR,
            managedRuntime,
            toolkits: [],
            installations: [],
            failureMessage: null,
          },
        ],
        incomplete: false,
      }),
    inspectRuntimes: () =>
      Effect.succeed([
        {
          descriptor: DESCRIPTOR,
          toolkits: [],
          runtimes: [
            {
              profile: PROFILE,
              verification: {
                profile: PROFILE,
                readiness: "ready",
                missingRequirements: [],
                message: null,
                packages: [],
              },
              toolkits: [],
            },
          ],
        },
      ]),
    verifyRuntime: () =>
      Effect.succeed({
        profile: PROFILE,
        readiness: "ready",
        missingRequirements: [],
        message: null,
        packages: [],
      }),
    managedRuntimeStatus: () => Effect.succeed(managedRuntime),
    manageRuntime: () => Effect.succeed(managedRuntime),
    cancelManagedRuntime: () => Effect.succeed(managedRuntime),
    addPythonLibrary: () => Effect.void,
    startSession: (input) => Effect.succeed(record(input.projectId, input.sessionId)),
    listSessions: () => Effect.succeed([]),
    getSession: () => Effect.succeed(null),
    listExecutions: () => Effect.succeed([]),
    historyExecutionRefs: () => Effect.succeed([]),
    historyExecutions: () => Effect.succeed([]),
    listOutputs: () => Effect.succeed({ outputs: [], corruptLineCount: 0 }),
    inspectVariables: (input) =>
      Effect.succeed({
        generation: input.expectedGeneration,
        variables: [],
        truncated: false,
      }),
    readTable: () => Effect.die(new Error("unused readTable")),
    submitExecutions: () => Effect.die("not used"),
    submitExecution: () => Effect.die(new Error("unused submitExecution")),
    cancelExecution: () => Effect.die(new Error("unused cancelExecution")),
    interruptSession: () => Effect.die(new Error("unused interruptSession")),
    restartSession: () => Effect.die(new Error("unused restartSession")),
    stopSession: () => Effect.die(new Error("unused stopSession")),
    subscribeSessions: () => Effect.succeed(Stream.empty),
    ...overrides,
  };
}

function acceptedExecution(
  input: Parameters<GatewayCompute["submitExecution"]>[0],
): ComputeExecutionRecord {
  return {
    request: {
      executionId: input.executionId,
      sessionId: input.sessionId,
      generation: input.expectedGeneration,
      code: input.code,
      codeHash: `sha256:${"0".repeat(64)}` as ComputeExecutionRecord["request"]["codeHash"],
      source: input.source,
      submittedAt: "2026-08-20T12:00:00.000Z",
      environmentFingerprint: null,
    },
    result: null,
  };
}

const project = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "scient-compute-gateway-" });
  yield* Effect.promise(() => initializeScientProject({ root }));
  const identity = yield* Effect.promise(() => readScientProjectIdentity(root));
  return { root, identity };
});

describe("compute RPC gateway", () => {
  it.effect("keeps a 400-cell Run All on one page and reads individual cells separately", () =>
    Effect.gen(function* () {
      const { root, identity } = yield* project;
      if (identity === null) return yield* Effect.die("Expected project identity.");
      const sessionId = ComputeSessionId.make("notebook-session");
      const session = record(ComputeProjectId.make(identity.projectId), sessionId);
      const executions: ComputeExecutionRecord[] = [];
      const hydrated: string[] = [];
      const gateway = makeComputeRpcGateway({
        workspaceResolver: computeWorkspaceResolverForTest,
        compute: computeStub({
          getSession: () => Effect.succeed(session),
          listSessions: () => Effect.succeed([session]),
          historyExecutionRefs: () => Effect.succeed(executions.map(({ request }) => request)),
          historyExecutions: ({ executionIds }) => {
            hydrated.push(...executionIds);
            return Effect.succeed(
              executions.filter(({ request }) => executionIds.includes(request.executionId)),
            );
          },
          submitExecutions: ({ submissions }) => {
            const accepted = submissions.map(acceptedExecution);
            executions.push(...accepted);
            return Effect.succeed(accepted);
          },
        }),
        serverSettings: { getSettings: Effect.succeed(DEFAULT_SERVER_SETTINGS) },
        workspaceFileSystem: workspace(),
      });
      const path = "analysis.ipynb";
      const cells = Array.from({ length: 400 }, (_, index) => ({
        cellId: `cell-${index}`,
        executionId: ComputeExecutionId.make(`batch-${String(index).padStart(3, "0")}`),
        code: `print(${index})`,
      }));
      const input = { cwd: root, sessionId, path, expectedGeneration: session.generation };
      yield* gateway.submitCells({ ...input, runAll: true, cells });
      const single = { ...cells[0]!, executionId: ComputeExecutionId.make("single") };
      yield* gateway.submitCells({ ...input, cells: [single] });
      const page = yield* gateway.runHistory({ cwd: root, filter: path, limit: 1 });
      expect(page.runs[0]?.execution.request.executionId).toBe(single.executionId);
      expect(page.runs[0]?.notebookBatch).toBeUndefined();
      expect(hydrated.splice(0)).toEqual([single.executionId]);
      if (!page.next) return yield* Effect.die("Expected a cursor to the grouped run.");
      const older = yield* gateway.runHistory({
        cwd: root,
        filter: path,
        limit: 1,
        before: page.next,
      });
      expect(older.runs[0]?.notebookBatch).toMatchObject({
        count: 400,
        mode: "all",
        status: "queued",
      });
      expect(older.next).toBeNull();
      expect(hydrated.splice(0)).toHaveLength(400);
      const details = yield* gateway.runHistory({
        cwd: root,
        sessionId,
        notebookBatchId: cells[0]!.executionId,
        limit: 1,
      });
      expect(details.runs[0]?.execution.request.executionId).toBe(cells[0]?.executionId);
      expect(details.runs[0]?.notebookBatch).toBeUndefined();
      expect(details.next).not.toBeNull();
      if (!details.next) return yield* Effect.die("Expected a cursor to the next cell.");
      const secondCell = yield* gateway.runHistory({
        cwd: root,
        sessionId,
        notebookBatchId: cells[0]!.executionId,
        limit: 1,
        before: details.next,
      });
      expect(secondCell.runs[0]?.execution.request.executionId).toBe(cells[1]?.executionId);
      expect(hydrated.splice(0)).toEqual([cells[0]!.executionId, cells[1]!.executionId]);
      const quoted = yield* gateway.runHistory({
        cwd: root,
        sessionId,
        executionId: cells[399]!.executionId,
        limit: 1,
      });
      expect(quoted.runs[0]?.execution.request.executionId).toBe(cells[399]!.executionId);
      expect(hydrated.splice(0)).toEqual([cells[399]!.executionId]);

      // Only two receipts are visible while the rest of the batch is being admitted.
      executions.splice(2);
      const first = executions[0]!;
      executions[0] = {
        ...first,
        result: { ...first.result!, status: "succeeded", startedAt: first.request.submittedAt },
      };
      let running = yield* gateway.runHistory({ cwd: root, filter: path, limit: 1 });
      expect(running.runs[0]?.notebookBatch).toMatchObject({
        count: 400,
        status: "running",
        currentCell: 1,
      });
      const second = executions[1]!;
      executions[1] = { ...second, result: { ...second.result!, status: "submitting" } };
      running = yield* gateway.runHistory({ cwd: root, filter: path, limit: 1 });
      expect(running.runs[0]?.notebookBatch).toMatchObject({
        count: 400,
        status: "running",
        currentCell: 2,
      });
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect("preserves idle-only stop admission through the workspace gateway", () =>
    Effect.gen(function* () {
      const initialized = yield* project;
      let idleOnly: boolean | undefined;
      const gateway = makeComputeRpcGateway({
        workspaceResolver: computeWorkspaceResolverForTest,
        compute: computeStub({
          stopSession: (input) => {
            idleOnly = input.onlyIfIdle;
            return Effect.succeed(record(input.projectId, input.sessionId));
          },
        }),
        serverSettings: { getSettings: Effect.succeed(DEFAULT_SERVER_SETTINGS) },
        workspaceFileSystem: workspace(),
      });
      yield* gateway.stopSession({
        cwd: initialized.root,
        sessionId: ComputeSessionId.make("session"),
        expectedGeneration: INITIAL_COMPUTE_SESSION_GENERATION,
        onlyIfIdle: true,
      });
      expect(idleOnly).toBe(true);
    }).pipe(Effect.provide(NodeServices.layer)),
  );
  it.effect(
    "does not turn an initialized cwd into authority when the host resolver is absent",
    () =>
      Effect.gen(function* () {
        const initialized = yield* project;
        const gateway = makeComputeRpcGateway({
          compute: computeStub({
            listSessions: () => Effect.die("unverified workspace reached Compute"),
          }),
          serverSettings: { getSettings: Effect.succeed(DEFAULT_SERVER_SETTINGS) },
          workspaceFileSystem: workspace(),
        });
        const error = yield* gateway.listSessions({ cwd: initialized.root }).pipe(Effect.flip);
        expect(error.message).toContain("Workspace authority is unavailable");
      }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("rejects a workspace that changes after resolution, before any domain operation", () =>
    Effect.gen(function* () {
      const initialized = yield* project;
      const gateway = makeComputeRpcGateway({
        workspaceResolver: {
          ...computeWorkspaceResolverForTest,
          assertCurrentWorkspaceScope: () =>
            Effect.fail(
              new WorkspaceBindingResolutionError({ operation: "test", kind: "stale-authority" }),
            ),
        },
        compute: computeStub({ listSessions: () => Effect.die("stale workspace reached Compute") }),
        serverSettings: { getSettings: Effect.succeed(DEFAULT_SERVER_SETTINGS) },
        workspaceFileSystem: workspace(),
      });
      const error = yield* gateway.listSessions({ cwd: initialized.root }).pipe(Effect.flip);
      expect(error.reason).toBe("workspace-changed");
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("shares notebook run aliases only within the current workspace generation", () =>
    Effect.gen(function* () {
      const initialized = yield* project;
      const cwd = initialized.root;
      const projectId = initialized.identity.projectId;
      const scope = workspaceScopeForTest("notebook-workspace", cwd);
      const bindings = new Map([[cwd, { projectId, scope }]]);
      const gateway = makeComputeRpcGateway({
        workspaceResolver: workspaceResolverForTest(bindings),
        compute: computeStub(),
        serverSettings: { getSettings: Effect.succeed(DEFAULT_SERVER_SETTINGS) },
        workspaceFileSystem: workspace(),
      });
      const release = yield* Deferred.make<void>();
      const dependencies = {
        computeDir: cwd,
        jobs: yield* makeNotebookRunJobs,
        workspacePaths: yield* WorkspacePaths,
        gateway,
        notebooks: {
          reserveFreshRun: () =>
            Deferred.await(release).pipe(
              Effect.andThen(Effect.fail(new NotebookError({ message: "Fixture finished." }))),
            ),
          freshSnapshot: () => Effect.die("fixture run should have been stopped"),
          saveFreshRun: () => Effect.die("fixture run should have been stopped"),
        },
        notebookOutputs: () => Effect.die("fixture run should have been stopped"),
      };
      const desktop = makeNotebookRuns(dependencies);
      const agent = makeNotebookRuns(dependencies);
      const address = { cwd, scriptPath: "threshold.ipynb" };
      const alias = { cwd, scriptPath: "./sub/../threshold.ipynb" };
      const stream = yield* desktop.watch(address);
      const idle = yield* Deferred.make<void>();
      const seen = yield* Deferred.make<ComputeSessionId>();
      const oldSubscription = yield* stream.pipe(
        Stream.runForEach(({ job }) =>
          job === null
            ? Deferred.succeed(idle, undefined)
            : job.outcome === undefined
              ? Deferred.succeed(seen, job.runId)
              : Effect.die("revoked subscription received a settled run"),
        ),
        Effect.forkChild,
      );
      yield* Deferred.await(idle);
      const oldRun = yield* agent.start(alias);
      expect(yield* Deferred.await(seen)).toBe(oldRun.runId);
      expect(yield* desktop.status({ ...address, runId: oldRun.runId })).toEqual(oldRun);
      expect(yield* desktop.start(address).pipe(Effect.flip)).toMatchObject({
        message: "This notebook already has a fresh run.",
      });

      bindings.set(cwd, {
        projectId,
        scope: { ...scope, authorityGeneration: WorkspaceAuthorityGeneration.make(2) },
      });
      expect(yield* desktop.stop({ ...address, runId: oldRun.runId })).toBeNull();
      expect(yield* desktop.status(address)).toBeNull();
      const current = yield* desktop.watch(address);
      expect(yield* current.pipe(Stream.runHead)).toEqual(
        Option.some({ job: null, settledRunId: null }),
      );
      // Let the former generation settle, then confirm its stream has been fenced.
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(oldSubscription);
    }).pipe(Effect.provide(workspacePathsLayer.pipe(Layer.provideMerge(NodeServices.layer)))),
  );

  it.effect("forwards individual Toolkit intent without inventing a replacement selection", () =>
    Effect.gen(function* () {
      const toolkitChange = {
        toolkitId: ComputeToolkitId.make("python-image-analysis"),
        action: "install" as const,
      };
      let forwarded: unknown;
      const compute = computeStub({
        manageRuntime: (language, action, options) => {
          forwarded = options;
          return computeStub().manageRuntime(language, action, options);
        },
      });
      const gateway = makeComputeRpcGateway({
        workspaceResolver: computeWorkspaceResolverForTest,
        compute,
        serverSettings: { getSettings: Effect.succeed(DEFAULT_SERVER_SETTINGS) },
        workspaceFileSystem: workspace(),
      });
      yield* gateway.manageRuntime({ languageId: PYTHON, action: "update", toolkitChange });
      expect(forwarded).toEqual({ toolkitChange });
    }),
  );
  it.effect("discovers Python without inspecting or verifying runtimes", () =>
    Effect.gen(function* () {
      const gateway = makeComputeRpcGateway({
        workspaceResolver: computeWorkspaceResolverForTest,
        compute: computeStub({
          runtimeInventory: () =>
            Effect.succeed({
              languages: [
                {
                  descriptor: DESCRIPTOR,
                  managedRuntime: null,
                  toolkits: [],
                  installations: [],
                  failureMessage: null,
                },
              ],
              incomplete: false,
            }),
          inspectRuntimes: () => Effect.die("Settings must not inspect runtimes"),
          verifyRuntime: () => Effect.die("Settings must not verify runtimes"),
        }),
        serverSettings: { getSettings: Effect.succeed(DEFAULT_SERVER_SETTINGS) },
        workspaceFileSystem: workspace(),
      });
      expect((yield* gateway.runtimeInventory()).languages[0]).toMatchObject({
        // Older clients reject a language without it.
        enabled: true,
        configuredExecutable: null,
        installations: [],
      });
    }),
  );
  it.effect("preserves Toolkit readiness from each exact verified runtime", () =>
    Effect.gen(function* () {
      const initialized = yield* project;
      const verification = {
        profile: PROFILE,
        readiness: "ready" as const,
        missingRequirements: [],
        message: null,
        packages: [
          { name: "ipykernel", version: "6.29.5" },
          { name: "jupyter_client", version: "8.6.3" },
          { name: "matplotlib", version: "3.9.1" },
          { name: "nbformat", version: "5.10.4" },
          { name: "numpy", version: "2.0.1" },
          { name: "pandas", version: "2.2.2" },
          { name: "plotly", version: "6.3.0" },
          { name: "scipy", version: null },
          { name: "scikit-learn", version: "1.9.1" },
          { name: "seaborn", version: "0.13.2" },
          { name: "statsmodels", version: "0.15.0" },
          { name: "sympy", version: "1.14.0" },
          { name: "openpyxl", version: "3.1.5" },
          { name: "pyyaml", version: "6.0.3" },
          { name: "pillow", version: "12.3.0" },
          { name: "requests", version: "2.34.2" },
          { name: "pypdf", version: "6.19.0" },
          { name: "tabulate", version: "0.10.0" },
          { name: "jinja2", version: "3.1.6" },
          { name: "defusedxml", version: "0.7.1" },
        ],
      };
      const compute = computeStub({
        inspectRuntimes: () =>
          Effect.succeed([
            {
              descriptor: DESCRIPTOR,
              toolkits: [PYTHON_DATA_AND_FIGURES_TOOLKIT],
              runtimes: [
                {
                  profile: PROFILE,
                  verification,
                  toolkits: [assessPythonToolkit(PYTHON_DATA_AND_FIGURES_TOOLKIT, verification)],
                },
              ],
            },
          ]),
      });
      const gateway = makeComputeRpcGateway({
        workspaceResolver: computeWorkspaceResolverForTest,
        compute,
        serverSettings: {
          getSettings: Effect.succeed({
            ...DEFAULT_SERVER_SETTINGS,
            scientificComputing: {
              schemaVersion: 1,
              languages: { python: { executable: "" } },
            },
          }),
        },
        workspaceFileSystem: workspace(),
      });

      const inspection = yield* gateway.inspectRuntimes({
        cwd: initialized.root,
        refresh: false,
      });

      expect(inspection.languages[0]?.toolkits).toMatchObject([
        {
          toolkitId: "python-data-and-figures",
          displayName: "Scientific Python",
        },
      ]);
      expect(inspection.languages[0]?.runtimes[0]?.toolkits).toMatchObject([
        {
          toolkitId: "python-data-and-figures",
          readiness: "missing-requirement",
          missingRequirements: ["SciPy"],
          runtime: { executable: PROFILE.executable },
        },
      ]);
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect("derives project identity and applies the preferred executable server-side", () =>
    Effect.gen(function* () {
      const initialized = yield* project;
      let started: Parameters<GatewayCompute["startSession"]>[0] | null = null;
      const compute = computeStub({
        startSession: (input) => {
          started = input;
          return Effect.succeed(record(input.projectId, input.sessionId));
        },
      });
      const gateway = makeComputeRpcGateway({
        workspaceResolver: computeWorkspaceResolverForTest,
        compute,
        serverSettings: {
          getSettings: Effect.succeed({
            ...DEFAULT_SERVER_SETTINGS,
            scientificComputing: {
              schemaVersion: 1,
              languages: {
                python: { executable: "/preferred/python" },
              },
            },
          }),
        },
        workspaceFileSystem: workspace(),
      });

      yield* gateway.startSession({
        cwd: initialized.root,
        sessionId: ComputeSessionId.make("session-1"),
        languageId: PYTHON,
        executable: null,
      });
      const fs = yield* FileSystem.FileSystem;
      expect(started).toMatchObject({
        projectId: initialized.identity.projectId,
        workingDirectory: yield* fs.realPath(initialized.root),
        configuredExecutable: "/preferred/python",
      });

      yield* gateway.startSession({
        cwd: initialized.root,
        sessionId: ComputeSessionId.make("explicit-session"),
        languageId: PYTHON,
        executable: "/chosen/python",
      });
      expect(started).toMatchObject({
        configuredExecutable: "/preferred/python",
        requestedExecutable: "/chosen/python",
      });
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect("bounds history without hiding older live sessions at the product boundary", () =>
    Effect.gen(function* () {
      const initialized = yield* project;
      const projectId = ComputeProjectId.make(initialized.identity.projectId);
      const history = Array.from({ length: 130 }, (_, index) => ({
        ...record(
          projectId,
          ComputeSessionId.make(`session-${index}`),
          `2026-08-20T${String(12 + Math.floor(index / 60)).padStart(2, "0")}:${String(
            index % 60,
          ).padStart(2, "0")}:00.000Z`,
        ),
        status: index === 0 ? ("ready" as const) : ("stopped" as const),
      }));
      const gateway = makeComputeRpcGateway({
        workspaceResolver: computeWorkspaceResolverForTest,
        compute: computeStub({ listSessions: () => Effect.succeed(history) }),
        serverSettings: { getSettings: Effect.succeed(DEFAULT_SERVER_SETTINGS) },
        workspaceFileSystem: workspace(),
      });

      const listed = yield* gateway.listSessions({ cwd: initialized.root });
      expect(listed).toHaveLength(101);
      expect(listed[0]?.sessionId).toBe("session-129");
      expect(listed.at(-2)?.sessionId).toBe("session-30");
      expect(listed.at(-1)?.sessionId).toBe("session-0");
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect("runs an ordinary folder under its workspace binding", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "scient-compute-ordinary-" });
      let listCalls = 0;
      const gateway = makeComputeRpcGateway({
        workspaceResolver: computeWorkspaceResolverForTest,
        compute: computeStub({
          listSessions: () => {
            listCalls += 1;
            return Effect.succeed([]);
          },
        }),
        serverSettings: { getSettings: Effect.succeed(DEFAULT_SERVER_SETTINGS) },
        workspaceFileSystem: workspace(),
      });
      expect(yield* gateway.listSessions({ cwd: root })).toEqual([]);
      expect(listCalls).toBe(1);
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect("derives project identity before inspecting the live namespace", () =>
    Effect.gen(function* () {
      const initialized = yield* project;
      let inspected: Parameters<GatewayCompute["inspectVariables"]>[0] | null = null;
      const gateway = makeComputeRpcGateway({
        workspaceResolver: computeWorkspaceResolverForTest,
        compute: computeStub({
          inspectVariables: (input) => {
            inspected = input;
            return Effect.succeed({
              generation: input.expectedGeneration,
              variables: [],
              truncated: false,
            });
          },
        }),
        serverSettings: { getSettings: Effect.succeed(DEFAULT_SERVER_SETTINGS) },
        workspaceFileSystem: workspace(),
      });

      yield* gateway.inspectVariables({
        cwd: initialized.root,
        sessionId: ComputeSessionId.make("session-1"),
        expectedGeneration: INITIAL_COMPUTE_SESSION_GENERATION,
      });
      expect(inspected).toMatchObject({
        projectId: initialized.identity.projectId,
        sessionId: "session-1",
        expectedGeneration: INITIAL_COMPUTE_SESSION_GENERATION,
      });
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );
});

describe("compute saved-source validation", () => {
  it.effect("validates fresh-run source before admitting its native lifetime", () =>
    Effect.gen(function* () {
      const initialized = yield* project;
      let startCalls = 0;
      const gateway = makeComputeRpcGateway({
        workspaceResolver: computeWorkspaceResolverForTest,
        compute: computeStub({
          startSession: (input) => {
            startCalls += 1;
            return Effect.succeed(record(input.projectId, input.sessionId));
          },
        }),
        serverSettings: {
          getSettings: Effect.succeed({
            ...DEFAULT_SERVER_SETTINGS,
            scientificComputing: {
              ...DEFAULT_SERVER_SETTINGS.scientificComputing,
              languages: { [PYTHON]: { executable: "" } },
            },
          }),
        },
        workspaceFileSystem: workspace("actual", "sha256:saved"),
      });
      const input = {
        cwd: initialized.root,
        sessionId: ComputeSessionId.make("fresh"),
        languageId: PYTHON,
        executable: null,
        runOnce: {
          executionId: ComputeExecutionId.make("fresh-code"),
          code: "different",
          source: {
            _tag: "document" as const,
            origin: "file" as const,
            path: "analysis.py",
            bufferState: "saved" as const,
            revision: "sha256:saved",
            range: null,
          },
        },
      };
      expect((yield* Effect.flip(gateway.startSession(input))).reason).toBe("source-invalid");
      expect(startCalls).toBe(0);
      yield* gateway.startSession({ ...input, runOnce: { ...input.runOnce, code: "actual" } });
      expect(startCalls).toBe(1);
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );
  it("extracts exact LF and CRLF editor ranges and rejects invalid coordinates", () => {
    expect(
      extractComputeSourceRange("first\r\nsecond\r\nthird", {
        startLine: 0,
        startColumn: 2,
        endLine: 1,
        endColumn: 3,
      }),
    ).toBe("rst\r\nsec");
    expect(
      extractComputeSourceRange("first\nsecond", {
        startLine: 1,
        startColumn: 0,
        endLine: 1,
        endColumn: 99,
      }),
    ).toBeNull();
  });

  it.effect("rejects a false saved-source claim before compute accepts it", () =>
    Effect.gen(function* () {
      const initialized = yield* project;
      let submitCalls = 0;
      const gateway = makeComputeRpcGateway({
        workspaceResolver: computeWorkspaceResolverForTest,
        compute: computeStub({
          submitExecution: () => {
            submitCalls += 1;
            return Effect.die(new Error("A false saved claim reached compute."));
          },
        }),
        serverSettings: { getSettings: Effect.succeed(DEFAULT_SERVER_SETTINGS) },
        workspaceFileSystem: workspace("first\nsecond\n", "sha256:saved"),
      });

      const error = yield* Effect.flip(
        gateway.submitExecution({
          cwd: initialized.root,
          sessionId: ComputeSessionId.make("session-1"),
          executionId: ComputeExecutionId.make("execution-1"),
          expectedGeneration: INITIAL_COMPUTE_SESSION_GENERATION,
          code: "different",
          source: {
            _tag: "document",
            origin: "selection",
            path: "analysis.py",
            bufferState: "saved",
            revision: "sha256:saved",
            range: { startLine: 1, startColumn: 0, endLine: 1, endColumn: 6 },
          },
        }),
      );
      expect(error.reason).toBe("source-invalid");
      expect(submitCalls).toBe(0);
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect("accepts matching saved bytes and preserves different dirty bytes honestly", () =>
    Effect.gen(function* () {
      const initialized = yield* project;
      const accepted: Array<Parameters<GatewayCompute["submitExecution"]>[0]> = [];
      const gateway = makeComputeRpcGateway({
        workspaceResolver: computeWorkspaceResolverForTest,
        compute: computeStub({
          submitExecution: (input) => {
            accepted.push(input);
            return Effect.succeed(acceptedExecution(input));
          },
        }),
        serverSettings: { getSettings: Effect.succeed(DEFAULT_SERVER_SETTINGS) },
        workspaceFileSystem: workspace("first\nsecond\n", "sha256:saved"),
      });
      const source = {
        _tag: "document" as const,
        origin: "selection" as const,
        path: "analysis.py",
        revision: "sha256:saved",
        range: { startLine: 1, startColumn: 0, endLine: 1, endColumn: 6 },
      };

      yield* gateway.submitExecution({
        cwd: initialized.root,
        sessionId: ComputeSessionId.make("session-1"),
        executionId: ComputeExecutionId.make("execution-saved"),
        expectedGeneration: INITIAL_COMPUTE_SESSION_GENERATION,
        code: "second",
        source: { ...source, bufferState: "saved" },
      });
      yield* gateway.submitExecution({
        cwd: initialized.root,
        sessionId: ComputeSessionId.make("session-1"),
        executionId: ComputeExecutionId.make("execution-dirty"),
        expectedGeneration: INITIAL_COMPUTE_SESSION_GENERATION,
        code: "unsaved editor bytes",
        source: { ...source, bufferState: "dirty" },
      });

      expect(accepted).toHaveLength(2);
      expect(accepted.map((input) => input.projectId)).toEqual([
        initialized.identity.projectId,
        initialized.identity.projectId,
      ]);
      expect(accepted.map((input) => input.source)).toMatchObject([
        { bufferState: "saved" },
        { bufferState: "dirty" },
      ]);
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );
});
