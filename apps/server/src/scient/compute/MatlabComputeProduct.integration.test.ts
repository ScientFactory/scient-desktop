// @effect-diagnostics nodeBuiltinImport:off -- gated integration uses a selected MATLAB install.
import * as NodeProcess from "node:process";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { initializeScientProject } from "@scientfactory/project-init";
import {
  ComputeExecutionId,
  ComputeLanguageId,
  type ComputeSessionGeneration,
  ComputeSessionId,
  DEFAULT_SERVER_SETTINGS,
  INITIAL_COMPUTE_SESSION_GENERATION,
  TERMINAL_COMPUTE_EXECUTION_STATUSES,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";

import * as ServerConfig from "../../config.ts";
import * as ServerSettings from "../../serverSettings.ts";
import * as LocalAnalysisStore from "../analysis/LocalAnalysisStore.ts";
import * as ScientificRuntimePreferences from "./ScientificRuntimePreferences.ts";
import * as WorkspaceEntries from "../../workspace/WorkspaceEntries.ts";
import * as WorkspaceFileSystem from "../../workspace/WorkspaceFileSystem.ts";
import * as WorkspacePaths from "../../workspace/WorkspacePaths.ts";
import * as LocalDuplexProcess from "../execution/LocalDuplexProcess.ts";
import * as LocalExecutionProcess from "../execution/LocalExecutionProcess.ts";
import * as ComputeSessionService from "./ComputeSessionService.ts";
import { makeComputeRpcGateway } from "./ComputeRpcGateway.ts";
import * as LocalComputeStore from "./LocalComputeStore.ts";
import { matlabRuntimeBinding } from "./MatlabComputeRuntime.ts";

const TEST_MATLAB = NodeProcess.env.SCIENT_TEST_MATLAB;
const TEST_HELPER = NodeProcess.env.SCIENT_TEST_MATLAB_HELPER === "1";
const MATLAB = ComputeLanguageId.make("matlab");

const waitForTerminal = Effect.fn("MatlabCompute.waitForTerminal")(function* (
  gateway: ReturnType<typeof makeComputeRpcGateway>,
  cwd: string,
  sessionId: ComputeSessionId,
  executionId: ComputeExecutionId,
) {
  for (let attempt = 0; attempt < 6_000; attempt += 1) {
    const execution = (yield* gateway.listExecutions({ cwd, sessionId, limit: 100 })).find(
      (candidate) => candidate.request.executionId === executionId,
    );
    if (
      execution !== undefined &&
      execution.result !== null &&
      TERMINAL_COMPUTE_EXECUTION_STATUSES.has(execution.result.status)
    ) {
      return execution.result.status;
    }
    yield* Effect.sleep("10 millis");
  }
  return yield* Effect.die(new Error(`MATLAB execution '${executionId}' did not finish.`));
});

const submit = Effect.fn("MatlabCompute.submit")(function* (
  gateway: ReturnType<typeof makeComputeRpcGateway>,
  cwd: string,
  sessionId: ComputeSessionId,
  generation: ComputeSessionGeneration,
  id: string,
  code: string,
) {
  const executionId = ComputeExecutionId.make(id);
  yield* gateway.submitExecution({
    cwd,
    sessionId,
    executionId,
    expectedGeneration: generation,
    code,
    source: { _tag: "console" },
  });
  return executionId;
});

const waitForBusy = Effect.fn("MatlabCompute.waitForBusy")(function* (
  gateway: ReturnType<typeof makeComputeRpcGateway>,
  cwd: string,
  sessionId: ComputeSessionId,
) {
  for (let attempt = 0; attempt < 1_000; attempt += 1) {
    const session = (yield* gateway.listSessions({ cwd })).find(
      (candidate) => candidate.sessionId === sessionId,
    );
    if (session?.activity === "busy") return;
    yield* Effect.sleep("10 millis");
  }
  return yield* Effect.die(new Error("MATLAB session did not become busy."));
});

describe.runIf(Boolean(TEST_MATLAB))("MATLAB compute product backend", () => {
  it.live(
    "runs statefully, captures changed figures, recovers from errors and survives stress",
    () =>
      Effect.gen(function* () {
        if (!TEST_MATLAB) return yield* Effect.die("SCIENT_TEST_MATLAB is not set.");
        const fs = yield* FileSystem.FileSystem;
        const projectRoot = yield* fs.makeTempDirectoryScoped({
          prefix: "scient-matlab-compute-project-",
        });
        const stateRoot = yield* fs.makeTempDirectoryScoped({
          prefix: "scient-matlab-compute-state-",
        });
        yield* Effect.promise(() => initializeScientProject({ root: projectRoot }));

        const computeLayer = ComputeSessionService.layerWithRuntimeBindings(
          matlabRuntimeBinding.pipe(Effect.map((binding) => [binding])),
        ).pipe(
          Layer.provide(
            ScientificRuntimePreferences.layer.pipe(
              Layer.provide(
                ServerSettings.layerTest({
                  scientificComputing: {
                    languages: { [MATLAB]: { enabled: true, executable: TEST_MATLAB } },
                  },
                }),
              ),
              Layer.provide(LocalAnalysisStore.layer),
            ),
          ),
          Layer.provide(LocalComputeStore.layer),
          Layer.provide(LocalExecutionProcess.layer),
          Layer.provide(LocalDuplexProcess.layer),
          Layer.provide(ServerConfig.layerTest(projectRoot, stateRoot)),
          Layer.provide(NodeServices.layer),
        );
        const workspaceLayer = WorkspaceFileSystem.layer.pipe(
          Layer.provide(WorkspacePaths.layer),
          Layer.provide(WorkspaceEntries.layer.pipe(Layer.provide(WorkspacePaths.layer))),
          Layer.provide(NodeServices.layer),
        );

        yield* Effect.gen(function* () {
          const compute = yield* ComputeSessionService.ComputeSessionService;
          const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
          const gateway = makeComputeRpcGateway({
            compute,
            workspaceFileSystem,
            serverSettings: {
              getSettings: Effect.succeed({
                ...DEFAULT_SERVER_SETTINGS,
                scientificComputing: {
                  schemaVersion: 1,
                  languages: { matlab: { enabled: true, executable: TEST_MATLAB } },
                },
              }),
            },
          });

          if (TEST_HELPER) {
            yield* gateway.manageRuntime({ languageId: MATLAB, action: "install" });
            for (;;) {
              const status = yield* gateway.managedRuntimeStatus({ languageId: MATLAB });
              if (status.operation === null) {
                expect(status.failureMessage).toBeNull();
                expect(status.installed).toBe(true);
                expect(status.selection).toBe("managed");
                break;
              }
              yield* Effect.sleep("100 millis");
            }
          }
          const inspection = yield* gateway.inspectRuntimes({ cwd: projectRoot, refresh: true });
          const runtime = inspection.languages
            .find((language) => language.descriptor.languageId === MATLAB)
            ?.runtimes.find((candidate) => candidate.verification.readiness === "ready");
          if (runtime === undefined)
            return yield* Effect.die(
              `No ready MATLAB runtime was found: ${inspection.languages.flatMap((language) => language.runtimes.map((runtime) => runtime.verification.message)).join("; ")}`,
            );
          expect(runtime.profile.languageVersion).toMatch(/^R\d{4}[ab]$/u);
          expect(runtime.verification.connection).toBe("detected");
          for (let attempt = 0; attempt < 2; attempt += 1) {
            const verified = yield* gateway.verifyRuntime({
              cwd: projectRoot,
              languageId: MATLAB,
              executable: runtime.profile.executable,
            });
            expect(verified).toMatchObject({ readiness: "ready", connection: "verified" });
            expect(yield* gateway.listSessions({ cwd: projectRoot })).toEqual([]);
          }

          for (const name of [
            "scient_compute_eval",
            "scient_compute_figures",
            "scient_compute_variables",
          ]) {
            yield* workspaceFileSystem.writeFile({
              cwd: projectRoot,
              relativePath: `${name}.m`,
              contents: [
                `function value = ${name}(varargin)`,
                "error('Scient:ShadowedHelper', 'Project helper must never run.');",
                "value = '';",
                "end",
              ].join("\n"),
            });
          }

          const sessionId = ComputeSessionId.make("matlab-stateful-session");
          const session = yield* gateway.startSession({
            cwd: projectRoot,
            sessionId,
            languageId: MATLAB,
            executable: runtime.profile.executable,
          });
          expect(session.status).toBe("ready");
          if (TEST_HELPER) {
            const removal = yield* gateway
              .manageRuntime({ languageId: MATLAB, action: "remove" })
              .pipe(Effect.exit);
            expect(removal._tag).toBe("Failure");
            expect((yield* gateway.managedRuntimeStatus({ languageId: MATLAB })).installed).toBe(
              true,
            );
          }

          const writeId = yield* submit(
            gateway,
            projectRoot,
            sessionId,
            session.generation,
            "matlab-state-write",
            [
              "answer = 41; disp(answer + 1);",
              "local_answer = scient_local_double(answer);",
              "fid = fopen('scient-matlab-output.txt', 'w');",
              "fprintf(fid, 'workspace output'); fclose(fid);",
              "function value = scient_local_double(input)",
              "value = input * 2;",
              "end",
            ].join("\n"),
          );
          const writeStatus = yield* waitForTerminal(gateway, projectRoot, sessionId, writeId);
          const writeOutput = yield* gateway.listOutputs({
            cwd: projectRoot,
            sessionId,
            executionId: writeId,
          });
          expect(writeStatus).toBe("succeeded");
          expect(
            writeOutput.outputs.some(
              (output) => output._tag === "stream" && output.text.includes("42"),
            ),
          ).toBe(true);
          expect(
            (yield* workspaceFileSystem.readFile({
              cwd: projectRoot,
              relativePath: "scient-matlab-output.txt",
            })).contents,
          ).toBe("workspace output");
          expect(
            yield* gateway.inspectVariables({
              cwd: projectRoot,
              sessionId,
              expectedGeneration: session.generation,
            }),
          ).toMatchObject({
            variables: expect.arrayContaining([
              expect.objectContaining({ name: "answer", typeName: "double", preview: "41" }),
              expect.objectContaining({ name: "local_answer", preview: "82" }),
            ]),
          });

          const figureId = yield* submit(
            gateway,
            projectRoot,
            sessionId,
            session.generation,
            "matlab-figure-first",
            "figure('Visible','off'); plot(1:4, [1 4 2 3]); title('Scient MATLAB');",
          );
          expect(yield* waitForTerminal(gateway, projectRoot, sessionId, figureId)).toBe(
            "succeeded",
          );
          const figureOutput = yield* gateway.listOutputs({
            cwd: projectRoot,
            sessionId,
            executionId: figureId,
          });
          const figure = figureOutput.outputs.find(
            (output) => output._tag === "image" && output.mediaType === "image/png",
          );
          expect(figure?._tag).toBe("image");
          if (figure?._tag === "image") {
            const retained = yield* compute.resolveOutputImage({
              projectId: session.projectId,
              sessionId,
              executionId: figureId,
              contentHash: figure.contentHash,
            });
            if (retained === null) return yield* Effect.die("MATLAB figure was not retained.");
            expect((yield* fs.readFile(retained.path)).byteLength).toBeGreaterThan(100);
          }

          const unchangedId = yield* submit(
            gateway,
            projectRoot,
            sessionId,
            session.generation,
            "matlab-figure-unchanged",
            "disp('unchanged figure');",
          );
          yield* waitForTerminal(gateway, projectRoot, sessionId, unchangedId);
          expect(
            (yield* gateway.listOutputs({
              cwd: projectRoot,
              sessionId,
              executionId: unchangedId,
            })).outputs.some((output) => output._tag === "image"),
          ).toBe(false);
          const changedFigureId = yield* submit(
            gateway,
            projectRoot,
            sessionId,
            session.generation,
            "matlab-figure-changed",
            "plot(1:4, [4 3 2 1]); title('Scient MATLAB changed');",
          );
          expect(yield* waitForTerminal(gateway, projectRoot, sessionId, changedFigureId)).toBe(
            "succeeded",
          );
          const changedFigure = (yield* gateway.listOutputs({
            cwd: projectRoot,
            sessionId,
            executionId: changedFigureId,
          })).outputs.find((output) => output._tag === "image");
          expect(changedFigure?._tag).toBe("image");
          if (changedFigure?._tag === "image" && figure?._tag === "image") {
            expect(changedFigure.contentHash).not.toBe(figure.contentHash);
          }
          const closeFiguresId = yield* submit(
            gateway,
            projectRoot,
            sessionId,
            session.generation,
            "matlab-close-figures",
            "close all force;",
          );
          yield* waitForTerminal(gateway, projectRoot, sessionId, closeFiguresId);

          const diagnosticCode = [
            "retained_after_failure = 7;",
            "error('Scient:Expected', 'expected failure');",
          ].join("\n");
          const diagnosticFile = yield* workspaceFileSystem.writeFile({
            cwd: projectRoot,
            relativePath: "diagnostic_test.m",
            contents: diagnosticCode,
          });
          const failedId = ComputeExecutionId.make("matlab-expected-error");
          yield* gateway.submitExecution({
            cwd: projectRoot,
            sessionId,
            executionId: failedId,
            expectedGeneration: session.generation,
            code: diagnosticCode,
            source: {
              _tag: "document",
              origin: "file",
              path: diagnosticFile.relativePath,
              bufferState: "saved",
              revision: diagnosticFile.revision,
              range: null,
            },
          });
          expect(yield* waitForTerminal(gateway, projectRoot, sessionId, failedId)).toBe("failed");
          expect(
            (yield* gateway.listOutputs({ cwd: projectRoot, sessionId, executionId: failedId }))
              .outputs,
          ).toEqual(
            expect.arrayContaining([
              expect.objectContaining({
                _tag: "diagnostic",
                diagnostic: expect.objectContaining({
                  errorName: "Scient:Expected",
                  frames: expect.arrayContaining([
                    expect.objectContaining({ relativePath: "diagnostic_test.m", line: 2 }),
                  ]),
                }),
              }),
            ]),
          );
          expect(
            (yield* gateway.inspectVariables({
              cwd: projectRoot,
              sessionId,
              expectedGeneration: session.generation,
            })).variables,
          ).toEqual(
            expect.arrayContaining([
              expect.objectContaining({ name: "retained_after_failure", preview: "7" }),
            ]),
          );

          const seedId = yield* submit(
            gateway,
            projectRoot,
            sessionId,
            session.generation,
            "matlab-rapid-seed",
            "rapid_counter = 0;",
          );
          expect(yield* waitForTerminal(gateway, projectRoot, sessionId, seedId)).toBe("succeeded");
          for (let batch = 0; batch < 4; batch += 1) {
            const rapidIds = yield* Effect.forEach(
              Array.from({ length: 10 }, (_, index) => batch * 10 + index + 1),
              (index) =>
                submit(
                  gateway,
                  projectRoot,
                  sessionId,
                  session.generation,
                  `matlab-rapid-${String(index)}`,
                  "rapid_counter = rapid_counter + 1;",
                ),
              { concurrency: "unbounded" },
            );
            for (const executionId of rapidIds) {
              expect(yield* waitForTerminal(gateway, projectRoot, sessionId, executionId)).toBe(
                "succeeded",
              );
            }
          }
          expect(
            (yield* gateway.inspectVariables({
              cwd: projectRoot,
              sessionId,
              expectedGeneration: session.generation,
            })).variables,
          ).toEqual(
            expect.arrayContaining([
              expect.objectContaining({ name: "rapid_counter", preview: "40" }),
            ]),
          );

          const floodId = yield* submit(
            gateway,
            projectRoot,
            sessionId,
            session.generation,
            "matlab-output-flood",
            "fprintf(repmat('flood-line\\n', 1, 20000));",
          );
          expect(yield* waitForTerminal(gateway, projectRoot, sessionId, floodId)).toBe(
            "succeeded",
          );

          const interruptedId = yield* submit(
            gateway,
            projectRoot,
            sessionId,
            session.generation,
            "matlab-interrupt",
            "pause(60);",
          );
          yield* waitForBusy(gateway, projectRoot, sessionId);
          yield* gateway.interruptSession({
            cwd: projectRoot,
            sessionId,
            expectedGeneration: session.generation,
          });
          expect(yield* waitForTerminal(gateway, projectRoot, sessionId, interruptedId)).toBe(
            "cancelled",
          );
          const afterInterruptId = yield* submit(
            gateway,
            projectRoot,
            sessionId,
            session.generation,
            "matlab-after-interrupt",
            "disp('after interrupt');",
          );
          expect(yield* waitForTerminal(gateway, projectRoot, sessionId, afterInterruptId)).toBe(
            "succeeded",
          );

          const restarted = yield* gateway.restartSession({
            cwd: projectRoot,
            sessionId,
            expectedGeneration: INITIAL_COMPUTE_SESSION_GENERATION,
          });
          expect(restarted.generation).not.toBe(session.generation);
          expect(
            (yield* gateway.inspectVariables({
              cwd: projectRoot,
              sessionId,
              expectedGeneration: restarted.generation,
            })).variables,
          ).toEqual([]);
          expect(
            (yield* gateway.stopSession({
              cwd: projectRoot,
              sessionId,
              expectedGeneration: restarted.generation,
            })).status,
          ).toBe("stopped");
          if (TEST_HELPER) {
            yield* gateway.manageRuntime({ languageId: MATLAB, action: "remove" });
            for (;;) {
              const status = yield* gateway.managedRuntimeStatus({ languageId: MATLAB });
              if (status.operation === null) {
                expect(status.failureMessage).toBeNull();
                expect(status.installed).toBe(false);
                break;
              }
              yield* Effect.sleep("100 millis");
            }
          }
        }).pipe(Effect.provide(Layer.merge(computeLayer, workspaceLayer)), Effect.scoped);
      }).pipe(
        Effect.provide(NodeServices.layer),
        Effect.scoped,
        Effect.timeout(TEST_HELPER ? "15 minutes" : "6 minutes"),
      ),
  );
});
