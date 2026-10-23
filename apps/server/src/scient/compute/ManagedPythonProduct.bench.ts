// @effect-diagnostics nodeBuiltinImport:off -- this opt-in qualification provisions real pinned artifacts.
import * as NodeProcess from "node:process";

import { initializeScientProject } from "@scientfactory/project-init";
import * as HostProcess from "@t3tools/shared/HostProcess";
import {
  ComputeExecutionId,
  ComputeLanguageId,
  ComputeSessionId,
  ComputeToolkitId,
  DEFAULT_SERVER_SETTINGS,
  TERMINAL_COMPUTE_EXECUTION_STATUSES,
  type ComputeManagedRuntimeStatus,
  type ComputeOperationError,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, expect } from "@effect/vitest";
import { describe, it } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as Option from "effect/Option";

import * as ServerConfig from "../../config.ts";
import * as OwnedLocalEndpoints from "../../localEndpoints/OwnedLocalEndpointRegistry.ts";
import { measureEffectBenchmark } from "../../testUtils/benchmark.testkit.ts";
import * as WorkspaceEntries from "../../workspace/WorkspaceEntries.ts";
import * as WorkspaceFileSystem from "../../workspace/WorkspaceFileSystem.ts";
import * as WorkspacePaths from "../../workspace/WorkspacePaths.ts";
import * as LocalDuplexProcess from "../execution/LocalDuplexProcess.ts";
import * as LocalExecutionProcess from "../execution/LocalExecutionProcess.ts";
import * as ComputeSessionService from "./ComputeSessionService.ts";
import * as ComputeProjectOutputObserver from "./ComputeProjectOutputObserver.ts";
import { makeComputeRpcGateway } from "./ComputeRpcGateway.ts";
import { computeWorkspaceResolverForTest } from "./ComputeWorkspaceTestUtils.ts";
import * as LocalComputeStore from "./LocalComputeStore.ts";
import { MANAGED_PYTHON_VERSION } from "./ManagedPythonProvisioner.ts";
import * as PythonComputeRuntime from "./PythonComputeRuntime.ts";
import { ComputeRecipeNetwork } from "./ComputeRecipeSource.ts";
import { managedPythonFileCheck } from "./ManagedPythonScientificChecks.ts";
import { layerKnownWorkspacesAllowAll } from "../workspace/knownWorkspaces.testkit.ts";

const ENABLED = NodeProcess.env.SCIENT_TEST_MANAGED_PYTHON === "1";
const PYTHON = ComputeLanguageId.make("python");
const encodeDiagnostics = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

// Exercise real HTTP locally, without credentials, proxies, or public services.
const HTTP_CLIENT_CHECK = String.raw`
import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import requests

class FixtureHandler(BaseHTTPRequestHandler):
    def do_GET(self):
        body = b'{"values": [1, 2, 3]}'
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)
    def log_message(self, *_):
        pass

server = ThreadingHTTPServer(("127.0.0.1", 0), FixtureHandler)
worker = threading.Thread(target=server.serve_forever, daemon=True)
worker.start()
try:
    with requests.Session() as client:
        client.trust_env = False
        for _ in range(32):
            with client.get("http://127.0.0.1:%d/data" % server.server_port, timeout=5) as response:
                response.raise_for_status()
                assert response.json() == {"values": [1, 2, 3]}
finally:
    server.shutdown()
    server.server_close()
    worker.join(timeout=5)
assert not worker.is_alive()
`;

describe.runIf(ENABLED)("Scient-managed Python product", () => {
  it(
    "provisions, selects, executes scientific work, and removes only its private environment",
    async ({ bench }) =>
      Effect.runPromise(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const projectRoot = yield* fs.makeTempDirectoryScoped({
            prefix: "scient-managed-python-project-",
          });
          const stateRoot = yield* fs.makeTempDirectoryScoped({
            prefix: "scient-managed-python-state-",
          });
          yield* Effect.promise(() => initializeScientProject({ root: projectRoot }));

          let settle: Effect.Effect<ComputeManagedRuntimeStatus, ComputeOperationError> =
            Effect.die("The Python runtime has no local operation completion signal.");
          const awaitStatus = Effect.fn("ManagedPythonProduct.awaitStatus")(function* (
            gateway: ComputeGateway,
            accepted: (status: ComputeManagedRuntimeStatus) => boolean,
          ) {
            yield* settle;
            const status = yield* gateway.managedRuntimeStatus({ languageId: PYTHON });
            if (status.operation === null && status.failureMessage !== null) {
              return yield* Effect.die(new Error(status.failureMessage));
            }
            assert.isTrue(accepted(status));
            return status;
          });
          const computeLayer = ComputeSessionService.layerWithRuntimeBindings(
            PythonComputeRuntime.pythonRuntimeBinding.pipe(
              Effect.map((binding) => {
                settle = binding.managedRuntime?.awaitSettled() ?? settle;
                return [binding];
              }),
              Effect.catch((cause) =>
                Effect.as(
                  Effect.logWarning("compute is unavailable: no Python runtime could be prepared", {
                    reason: cause.message,
                  }),
                  [],
                ),
              ),
            ),
            ComputeSessionService.DEFAULT_COMPUTE_SESSION_SERVICE_OPTIONS,
            ComputeProjectOutputObserver.liveLayer,
          ).pipe(
            Layer.provide(Layer.succeed(ComputeRecipeNetwork)(false)),
            Layer.provide(LocalComputeStore.layer),
            Layer.provide(LocalExecutionProcess.layer),
            Layer.provide(LocalDuplexProcess.layer),
            Layer.provide(OwnedLocalEndpoints.layer),
            Layer.provide(ServerConfig.layerTest(projectRoot, stateRoot)),
            Layer.provide(NodeServices.layer),
          );
          const workspaceLayer = WorkspaceFileSystem.layer.pipe(
            Layer.provide(layerKnownWorkspacesAllowAll),
            Layer.provide(WorkspacePaths.layer),
            Layer.provide(WorkspaceEntries.layer.pipe(Layer.provide(WorkspacePaths.layer))),
            Layer.provide(ServerConfig.layerTest(projectRoot, stateRoot)),
            Layer.provide(NodeServices.layer),
          );

          yield* Effect.gen(function* () {
            const compute = yield* ComputeSessionService.ComputeSessionService;
            const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
            const gateway = makeComputeRpcGateway({
              workspaceResolver: computeWorkspaceResolverForTest,
              compute,
              workspaceFileSystem,
              serverSettings: {
                getSettings: Effect.succeed({
                  ...DEFAULT_SERVER_SETTINGS,
                  scientificComputing: {
                    schemaVersion: 1,
                    languages: { [PYTHON]: { enabled: true, executable: "" } },
                  },
                }),
              },
            });

            const initial = yield* awaitStatus(gateway, (status) => status.operation === null);
            expect(initial).toMatchObject({
              installed: false,
              selection: "existing",
            });
            const [installed, initialDuration] = yield* measureEffectBenchmark(
              bench,
              "cold-install",
              Effect.gen(function* () {
                const started = yield* gateway.manageRuntime({
                  languageId: PYTHON,
                  action: "install",
                });
                expect(started.operation).not.toBeNull();
                const installed = yield* awaitStatus(
                  gateway,
                  (status) => status.operation === null && status.installed,
                );
                expect(installed).toMatchObject({
                  installed: true,
                  selection: "managed",
                  updateAvailable: false,
                  failureMessage: null,
                });
                expect(installed.toolkitIds).toEqual(["python-data-and-figures"]);
                return installed;
              }),
            );
            yield* Effect.logInfo("Managed Python benchmark", {
              phase: "cold-install",
              durationMs: Math.round(initialDuration),
            });

            const inventoried = (yield* gateway.runtimeInventory()).languages[0]?.installations[0];
            expect(inventoried).toMatchObject({ source: "managed", problem: null });
            expect(inventoried?.version).toBe(MANAGED_PYTHON_VERSION);

            const inspection = yield* gateway.inspectRuntimes({ cwd: projectRoot, refresh: true });
            const managed = inspection.languages
              .find((language) => language.descriptor.languageId === PYTHON)
              ?.runtimes.find((runtime) => runtime.profile.source === "managed");
            expect(managed?.verification.readiness).toBe("ready");
            const installedToolkitIds = new Set(installed.toolkitIds);
            expect(
              managed?.toolkits
                .filter((toolkit) => installedToolkitIds.has(toolkit.toolkitId))
                .every((toolkit) => toolkit.readiness === "ready"),
            ).toBe(true);
            if (managed === undefined)
              return yield* Effect.die("Managed Python was not discovered.");

            const sessionId = ComputeSessionId.make("managed-python-live-session");
            const session = yield* gateway.startSession({
              cwd: projectRoot,
              sessionId,
              languageId: PYTHON,
              executable: managed.profile.executable,
            });
            const executionId = ComputeExecutionId.make("managed-python-scientific-check");
            yield* gateway.submitExecution({
              cwd: projectRoot,
              sessionId,
              executionId,
              expectedGeneration: session.generation,
              code: [
                managedPythonFileCheck(installed.toolkitIds ?? []),
                HTTP_CLIENT_CHECK,
                "import matplotlib.pyplot as plt",
                "import numpy as np",
                "import pandas as pd",
                "import plotly.graph_objects as go",
                "from IPython.display import display",
                "from scipy import stats",
                "x = np.arange(6, dtype=float)",
                "frame = pd.DataFrame({'x': x, 'z': stats.zscore(x)})",
                "display(frame)",
                "figure, axis = plt.subplots()",
                "axis.plot(frame['x'], frame['z'])",
                "display(figure)",
                "plt.close(figure)",
                "go.Figure(data=go.Scatter(x=frame['x'], y=frame['z'])).show()",
              ].join("\n"),
              source: { _tag: "console" },
            });
            const execution = yield* awaitExecution(gateway, projectRoot, sessionId, executionId);
            expect(execution.result?.status).toBe("succeeded");
            const outputs = yield* gateway.listOutputs({
              cwd: projectRoot,
              sessionId,
              executionId,
            });
            expect(outputs.outputs.some((output) => output._tag === "display-data")).toBe(true);
            expect(
              outputs.outputs.some(
                (output) =>
                  output._tag === "display-data" &&
                  output.bundle.representations.some(
                    (representation) =>
                      representation.mediaType === "application/vnd.plotly.v1+json",
                  ),
              ),
            ).toBe(true);

            // Gray-code order covers every combination and changes one optional
            // Toolkit at a time, ending back at base. The original kernel stays
            // alive throughout to exercise generation ownership during removal.
            const optional = [
              "python-large-data",
              "python-image-analysis",
              "python-bioinformatics",
            ];
            let retainedToolkitSession: typeof session | undefined;
            for (const mask of [1, 3, 2, 6, 7, 5, 4, 0]) {
              const toolkitIds = [
                ComputeToolkitId.make("python-data-and-figures"),
                ...optional.flatMap((id, index) =>
                  mask & (1 << index) ? [ComputeToolkitId.make(id)] : [],
                ),
              ];
              const [, duration] = yield* measureEffectBenchmark(
                bench,
                `toolkit-combination-${mask}`,
                Effect.gen(function* () {
                  yield* gateway.manageRuntime({
                    languageId: PYTHON,
                    action: "update",
                    toolkitIds,
                  });
                  const updated = yield* awaitStatus(
                    gateway,
                    (status) =>
                      status.operation === null &&
                      !(status.toolkitChanges ?? []).some(
                        (entry) => entry.state === "running" || entry.state === "queued",
                      ),
                  );
                  expect(updated.toolkitChanges).toEqual([]);
                  expect(updated.toolkitIds).toEqual(toolkitIds);
                }),
              );
              yield* Effect.logInfo("Managed Python benchmark", {
                phase: `toolkit-combination-${mask}`,
                durationMs: Math.round(duration),
              });
              expect(yield* fs.exists(managed.profile.executable)).toBe(true);
              const checkSessionId = ComputeSessionId.make(`toolkit-session-${mask}`);
              const checkSession = yield* gateway.startSession({
                cwd: projectRoot,
                sessionId: checkSessionId,
                languageId: PYTHON,
                executable: null,
              });
              const checkExecutionId = ComputeExecutionId.make(`toolkit-execution-${mask}`);
              yield* gateway.submitExecution({
                cwd: projectRoot,
                sessionId: checkSessionId,
                executionId: checkExecutionId,
                expectedGeneration: checkSession.generation,
                source: { _tag: "console" },
                code: [
                  managedPythonFileCheck(toolkitIds),
                  "import importlib.util",
                  // A base-only install must not accidentally borrow optional
                  // libraries from a previous generation or a user environment.
                  ...[
                    ["xarray", 1],
                    ["pyarrow", 1],
                    ["cftime", 1],
                    ["skimage", 2],
                    ["imagecodecs", 2],
                    ["Bio", 4],
                    ["pyfaidx", 4],
                  ].map(
                    ([name, flag]) =>
                      `assert (importlib.util.find_spec('${name}') is not None) == ${mask & Number(flag) ? "True" : "False"}`,
                  ),
                ].join("\n"),
              });
              const checked = yield* awaitExecution(
                gateway,
                projectRoot,
                checkSessionId,
                checkExecutionId,
              );
              const checkedOutputs = yield* gateway.listOutputs({
                cwd: projectRoot,
                sessionId: checkSessionId,
                executionId: checkExecutionId,
              });
              expect(checked.result?.status, yield* encodeDiagnostics(checkedOutputs)).toBe(
                "succeeded",
              );
              if (mask === 7) {
                retainedToolkitSession = checkSession;
              } else {
                yield* gateway.stopSession({
                  cwd: projectRoot,
                  sessionId: checkSessionId,
                  expectedGeneration: checkSession.generation,
                });
              }
            }
            // New kernels are now base-only, but a kernel which acquired every
            // Toolkit before removal must retain working native libraries/files.
            if (retainedToolkitSession === undefined) {
              return yield* Effect.die("The all-Toolkit session was not retained.");
            }
            const retainedToolkitExecution = ComputeExecutionId.make("retained-optional-toolkits");
            yield* gateway.submitExecution({
              cwd: projectRoot,
              sessionId: retainedToolkitSession.sessionId,
              executionId: retainedToolkitExecution,
              expectedGeneration: retainedToolkitSession.generation,
              code: managedPythonFileCheck(optional.map((id) => ComputeToolkitId.make(id))),
              source: { _tag: "console" },
            });
            expect(
              (yield* awaitExecution(
                gateway,
                projectRoot,
                retainedToolkitSession.sessionId,
                retainedToolkitExecution,
              )).result?.status,
            ).toBe("succeeded");
            yield* gateway.stopSession({
              cwd: projectRoot,
              sessionId: retainedToolkitSession.sessionId,
              expectedGeneration: retainedToolkitSession.generation,
            });
            const retainedExecution = ComputeExecutionId.make("retained-after-toolkit-removal");
            yield* gateway.submitExecution({
              cwd: projectRoot,
              sessionId,
              executionId: retainedExecution,
              expectedGeneration: session.generation,
              code: managedPythonFileCheck([]),
              source: { _tag: "console" },
            });
            expect(
              (yield* awaitExecution(gateway, projectRoot, sessionId, retainedExecution)).result
                ?.status,
            ).toBe("succeeded");
            const blocked = yield* Effect.flip(
              gateway.manageRuntime({ languageId: PYTHON, action: "remove" }),
            );
            expect(blocked.message).toContain("Stop sessions using Scient-managed Python");
            yield* gateway.stopSession({
              cwd: projectRoot,
              sessionId,
              expectedGeneration: session.generation,
            });
            yield* gateway.manageRuntime({ languageId: PYTHON, action: "remove" });
            const removed = yield* awaitStatus(
              gateway,
              (status) => status.operation === null && !status.installed,
            );
            expect(removed.failureMessage).toBeNull();
            expect(
              (yield* gateway.runtimeInventory()).languages[0]?.installations.some(
                (runtime) => runtime.source === "managed",
              ),
            ).toBe(false);
          }).pipe(Effect.provide(Layer.merge(computeLayer, workspaceLayer)), Effect.scoped);
        }).pipe(
          Effect.provide(NodeServices.layer),
          // One base kernel, one retained all-Toolkit kernel, and one current
          // verification kernel. Runner RAM must not choose this test's budget.
          Effect.provideService(HostProcess.Environment, {
            ...NodeProcess.env,
            SCIENT_COMPUTE_MAX_LIVE_SESSIONS: "3",
          }),
          Effect.scoped,
          // A completely cold interpreter/package download plus all eight
          // Gray-code Toolkit generations can legitimately exceed 20 minutes.
          // Per-process and per-operation ceilings still detect a stalled phase.
          Effect.timeout("30 minutes"),
        ),
      ),
    1_860_000,
  );
});

type ComputeGateway = ReturnType<typeof makeComputeRpcGateway>;

const awaitExecution = Effect.fn("ManagedPythonProduct.awaitExecution")(function* (
  gateway: ComputeGateway,
  cwd: string,
  sessionId: ComputeSessionId,
  executionId: ComputeExecutionId,
) {
  const changes = yield* gateway.subscribeSessions({ cwd });
  const result = yield* changes.pipe(
    Stream.mapEffect(() => gateway.listExecutions({ cwd, sessionId, limit: 100 })),
    Stream.map((executions) =>
      executions.find((candidate) => candidate.request.executionId === executionId),
    ),
    Stream.filter(
      (execution) =>
        execution?.result != null &&
        TERMINAL_COMPUTE_EXECUTION_STATUSES.has(execution.result.status),
    ),
    Stream.runHead,
  );
  if (Option.isNone(result))
    return yield* Effect.die("Managed Python execution receipt stream ended.");
  return result.value!;
}, Effect.scoped);
