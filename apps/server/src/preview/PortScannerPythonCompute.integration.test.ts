// @effect-diagnostics nodeBuiltinImport:off globalFetch:off -- gated qualification uses an explicit native Python and a recording Fetch service restricted to its loopback fixture.
import * as NodeHttp from "node:http";
import * as NodeProcess from "node:process";

import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  ComputeExecutionId,
  ComputeLanguageId,
  ComputeProjectId,
  ComputeSessionId,
  TERMINAL_COMPUTE_EXECUTION_STATUSES,
  type ComputeSessionRecord,
} from "@scientfactory/compute";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import { FetchHttpClient } from "effect/unstable/http";

import * as ServerConfig from "../config.ts";
import * as OwnedLocalEndpoints from "../localEndpoints/OwnedLocalEndpointRegistry.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as LocalDuplexProcess from "../scient/execution/LocalDuplexProcess.ts";
import * as LocalExecutionProcess from "../scient/execution/LocalExecutionProcess.ts";
import { processExists } from "../scient/execution/LocalProcessTestSupport.ts";
import * as LocalComputeStore from "../scient/compute/LocalComputeStore.ts";
import * as PythonComputeRuntime from "../scient/compute/PythonComputeRuntime.ts";
import { ComputeSessionService } from "../scient/compute/ComputeSessionService.ts";
import * as PortScanner from "./PortScanner.ts";

const TEST_PYTHON = NodeProcess.env.SCIENT_TEST_PYTHON;
const PROJECT = ComputeProjectId.make("preview-scanner-python-integration");
const SESSION = ComputeSessionId.make("preview-scanner-python-session");
const PYTHON = ComputeLanguageId.make("python");

interface LocalHtmlServer {
  readonly server: NodeHttp.Server;
  readonly url: string;
  readonly requests: Array<string>;
}

const localHtmlServer = Effect.acquireRelease(
  Effect.callback<LocalHtmlServer>((resume) => {
    const requests: string[] = [];
    const server = NodeHttp.createServer((request, response) => {
      requests.push(`${request.method ?? "GET"} ${request.url ?? "/"}`);
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end("<!doctype html><title>Scient preview fixture</title>");
    });
    let settled = false;
    const finish = (effect: Effect.Effect<LocalHtmlServer>) => {
      if (settled) return;
      settled = true;
      resume(effect);
    };
    server.once("error", (cause) => finish(Effect.die(cause)));
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (typeof address !== "object" || address === null || address.port <= 0) {
        finish(Effect.die(new Error("The preview fixture did not report its loopback port.")));
        return;
      }
      server.unref();
      finish(
        Effect.succeed({
          server,
          url: `http://127.0.0.1:${address.port}/health`,
          requests,
        }),
      );
    });
    return Effect.sync(() => server.close());
  }),
  ({ server }) =>
    Effect.callback<void>((resume) => {
      if (!server.listening) {
        resume(Effect.void);
        return;
      }
      server.close((cause) => resume(cause ? Effect.die(cause) : Effect.void));
    }),
);

const eventually = Effect.fn("PortScannerPythonCompute.eventually")(function* <A, E, R>(
  read: Effect.Effect<A | null, E, R>,
) {
  for (let attempt = 0; attempt < 800; attempt += 1) {
    const value = yield* read;
    if (value !== null) return value;
    yield* Effect.sleep("25 millis");
  }
  return yield* Effect.die(new Error("The scanner/Compute integration condition did not settle."));
});

const recordingProcessRunnerLayer = (lsofSnapshots: Array<string>) =>
  Layer.effect(
    ProcessRunner.ProcessRunner,
    Effect.gen(function* () {
      const delegate = yield* ProcessRunner.ProcessRunner;
      return ProcessRunner.ProcessRunner.of({
        run: (input) =>
          delegate.run(input).pipe(
            Effect.tap((result) =>
              input.command === "lsof"
                ? Effect.sync(() => {
                    lsofSnapshots.push(result.stdout);
                  })
                : Effect.void,
            ),
          ),
      });
    }),
  ).pipe(Layer.provide(ProcessRunner.layer.pipe(Layer.provide(NodeServices.layer))));

const scannerFetchLayer = (requestedUrls: Array<string>) =>
  FetchHttpClient.layer.pipe(
    Layer.provide(
      Layer.succeed(FetchHttpClient.Fetch, ((
        input: Parameters<typeof globalThis.fetch>[0],
        init?: Parameters<typeof globalThis.fetch>[1],
      ) => {
        const url =
          typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        requestedUrls.push(url);
        return globalThis.fetch(input, init);
      }) as typeof globalThis.fetch),
    ),
  );

const lsofObservedProcess = (snapshots: ReadonlyArray<string>, processId: number): boolean =>
  snapshots.some((snapshot) => snapshot.split(/\r?\n/u).includes(`p${processId}`));

describe.runIf(Boolean(TEST_PYTHON) && NodeProcess.platform !== "win32")(
  "preview scanner with a real Python Compute session",
  () => {
    it.live(
      "never probes unconfigured kernel listeners or grows their transcripts",
      () =>
        Effect.scoped(
          Effect.gen(function* () {
            if (!TEST_PYTHON) return yield* Effect.die("SCIENT_TEST_PYTHON is not set.");
            const fs = yield* FileSystem.FileSystem;
            const cwd = yield* fs.makeTempDirectoryScoped({
              prefix: "scient-scanner-compute-project-",
            });
            const state = yield* fs.makeTempDirectoryScoped({
              prefix: "scient-scanner-compute-state-",
            });
            const computeOwnedEndpoints = yield* OwnedLocalEndpoints.make();
            const scannerOwnedEndpoints = yield* OwnedLocalEndpoints.make();
            const requestedUrls: string[] = [];
            const lsofSnapshots: string[] = [];

            const computeLayer = PythonComputeRuntime.layer.pipe(
              Layer.provide(LocalComputeStore.layer),
              Layer.provide(LocalExecutionProcess.layer),
              Layer.provide(LocalDuplexProcess.layer),
              Layer.provide(
                Layer.succeed(
                  OwnedLocalEndpoints.OwnedLocalEndpointRegistry,
                  computeOwnedEndpoints,
                ),
              ),
              Layer.provide(ServerConfig.layerTest(cwd, state)),
              Layer.provide(NodeServices.layer),
            );
            const scannerLayer = PortScanner.layer.pipe(
              Layer.provide(recordingProcessRunnerLayer(lsofSnapshots)),
              Layer.provide(
                Layer.succeed(
                  OwnedLocalEndpoints.OwnedLocalEndpointRegistry,
                  scannerOwnedEndpoints,
                ),
              ),
              Layer.provide(scannerFetchLayer(requestedUrls)),
            );

            yield* Effect.gen(function* () {
              const compute = yield* ComputeSessionService;
              const scanner = yield* PortScanner.PortDiscovery;
              const fixture = yield* localHtmlServer;
              const expectOnlyFixtureTraffic = () => {
                expect(requestedUrls.length).toBeGreaterThan(0);
                expect(new Set(requestedUrls)).toEqual(new Set([fixture.url]));
                expect(fixture.requests).toEqual(requestedUrls.map(() => "GET /health"));
              };
              const scanWithoutConfiguredUrls = Effect.fn(
                "PortScannerPythonCompute.scanWithoutConfiguredUrls",
              )(function* (repetitions: number) {
                for (let attempt = 0; attempt < repetitions; attempt += 1) {
                  const requestCount = requestedUrls.length;
                  expect(yield* scanner.scan()).toEqual([]);
                  expect(requestedUrls).toHaveLength(requestCount);
                }
              });
              const scanConfiguredFixture = Effect.fn(
                "PortScannerPythonCompute.scanConfiguredFixture",
              )(function* (repetitions: number) {
                for (let attempt = 0; attempt < repetitions; attempt += 1) {
                  expect(yield* scanner.scan([fixture.url])).toEqual([
                    expect.objectContaining({
                      host: "127.0.0.1",
                      port: Number(new URL(fixture.url).port),
                      url: fixture.url,
                    }),
                  ]);
                }
              });
              const waitForExecution = (executionId: ComputeExecutionId) =>
                eventually(
                  compute.listExecutions({ projectId: PROJECT, sessionId: SESSION }).pipe(
                    Effect.map((executions) => {
                      const execution = executions.find(
                        (candidate) => candidate.request.executionId === executionId,
                      );
                      return execution?.result !== null &&
                        execution?.result !== undefined &&
                        TERMINAL_COMPUTE_EXECUTION_STATUSES.has(execution.result.status)
                        ? execution
                        : null;
                    }),
                  ),
                );
              const submitAndScan = Effect.fn("PortScannerPythonCompute.submitAndScan")(
                function* (input: {
                  readonly executionId: ComputeExecutionId;
                  readonly generation: ComputeSessionRecord["generation"];
                  readonly label: string;
                }) {
                  yield* compute.submitExecution({
                    projectId: PROJECT,
                    sessionId: SESSION,
                    expectedGeneration: input.generation,
                    executionId: input.executionId,
                    code: [
                      "import time",
                      `print('${input.label}_BEGIN', flush=True)`,
                      "time.sleep(0.75)",
                      `print('${input.label}_END', flush=True)`,
                    ].join("\n"),
                    source: { _tag: "console" },
                  });
                  yield* eventually(
                    compute
                      .listOutputs({
                        projectId: PROJECT,
                        sessionId: SESSION,
                        executionId: input.executionId,
                      })
                      .pipe(
                        Effect.map((transcript) => (transcript.outputs.length > 0 ? true : null)),
                      ),
                  );
                  yield* scanWithoutConfiguredUrls(2);
                  yield* scanConfiguredFixture(6);
                  const execution = yield* waitForExecution(input.executionId);
                  expect(execution.result?.status).toBe("succeeded");
                  const transcript = yield* compute.listOutputs({
                    projectId: PROJECT,
                    sessionId: SESSION,
                    executionId: input.executionId,
                  });
                  expect(
                    transcript.outputs
                      .filter((output) => output._tag === "stream")
                      .map((output) => output.text)
                      .join(""),
                  ).toBe(`${input.label}_BEGIN\n${input.label}_END\n`);
                  return transcript;
                },
              );

              let session = yield* compute.startSession({
                projectId: PROJECT,
                sessionId: SESSION,
                languageId: PYTHON,
                label: "Preview scanner Python integration",
                workingDirectory: cwd,
                configuredExecutable: TEST_PYTHON,
              });
              const firstRuntimeProcessId = session.identity?.runtimeProcessId;
              if (firstRuntimeProcessId == null) {
                return yield* Effect.die("The real Python session did not report its runtime PID.");
              }
              expect((yield* computeOwnedEndpoints.snapshot).protectedLoopbackTcpPorts.size).toBe(
                5,
              );
              expect((yield* scannerOwnedEndpoints.snapshot).protectedLoopbackTcpPorts.size).toBe(
                0,
              );
              yield* scanWithoutConfiguredUrls(2);
              const sessionTranscriptBeforeScans = yield* compute.listOutputs({
                projectId: PROJECT,
                sessionId: SESSION,
                executionId: null,
              });

              const firstExecutionId = ComputeExecutionId.make("scanner-first-execution");
              const firstTranscript = yield* submitAndScan({
                executionId: firstExecutionId,
                generation: session.generation,
                label: "FIRST",
              });
              yield* scanConfiguredFixture(3);
              expect(lsofObservedProcess(lsofSnapshots, firstRuntimeProcessId)).toBe(true);
              expectOnlyFixtureTraffic();
              expect(
                yield* compute.listOutputs({
                  projectId: PROJECT,
                  sessionId: SESSION,
                  executionId: firstExecutionId,
                }),
              ).toEqual(firstTranscript);

              [session] = yield* Effect.all(
                [
                  compute.restartSession({
                    projectId: PROJECT,
                    sessionId: SESSION,
                    expectedGeneration: session.generation,
                  }),
                  scanConfiguredFixture(6),
                ],
                { concurrency: "unbounded" },
              );
              const restartedRuntimeProcessId = session.identity?.runtimeProcessId;
              if (restartedRuntimeProcessId == null) {
                return yield* Effect.die(
                  "The restarted Python session did not report its runtime PID.",
                );
              }
              expect(restartedRuntimeProcessId).not.toBe(firstRuntimeProcessId);
              yield* eventually(
                Effect.sync(() => (!processExists(firstRuntimeProcessId) ? true : null)),
              );
              yield* scanConfiguredFixture(2);
              expect(lsofObservedProcess(lsofSnapshots, restartedRuntimeProcessId)).toBe(true);
              expect((yield* computeOwnedEndpoints.snapshot).protectedLoopbackTcpPorts.size).toBe(
                5,
              );
              expect((yield* scannerOwnedEndpoints.snapshot).protectedLoopbackTcpPorts.size).toBe(
                0,
              );

              const secondExecutionId = ComputeExecutionId.make("scanner-second-execution");
              const secondTranscript = yield* submitAndScan({
                executionId: secondExecutionId,
                generation: session.generation,
                label: "SECOND",
              });
              const restartedTransportProcessId = session.identity?.transportProcessId;
              if (restartedTransportProcessId == null) {
                return yield* Effect.die(
                  "The restarted Python session did not report its transport PID.",
                );
              }
              yield* Effect.all(
                [
                  compute.stopSession({
                    projectId: PROJECT,
                    sessionId: SESSION,
                    expectedGeneration: session.generation,
                  }),
                  scanConfiguredFixture(6),
                ],
                { concurrency: "unbounded" },
              );
              yield* scanWithoutConfiguredUrls(2);
              yield* scanConfiguredFixture(2);
              yield* eventually(
                computeOwnedEndpoints.snapshot.pipe(
                  Effect.map((snapshot) =>
                    snapshot.protectedLoopbackTcpPorts.size === 0 ? true : null,
                  ),
                ),
              );
              yield* eventually(
                Effect.sync(() =>
                  !processExists(restartedRuntimeProcessId) &&
                  !processExists(restartedTransportProcessId)
                    ? true
                    : null,
                ),
              );
              expectOnlyFixtureTraffic();
              expect(
                yield* compute.listOutputs({
                  projectId: PROJECT,
                  sessionId: SESSION,
                  executionId: null,
                }),
              ).toEqual(sessionTranscriptBeforeScans);
              expect(
                yield* compute.listOutputs({
                  projectId: PROJECT,
                  sessionId: SESSION,
                  executionId: firstExecutionId,
                }),
              ).toEqual(firstTranscript);
              expect(
                yield* compute.listOutputs({
                  projectId: PROJECT,
                  sessionId: SESSION,
                  executionId: secondExecutionId,
                }),
              ).toEqual(secondTranscript);
            }).pipe(Effect.provide(Layer.merge(computeLayer, scannerLayer)), Effect.scoped);
          }),
        ).pipe(Effect.provide(NodeServices.layer), Effect.timeout("120 seconds")),
      { timeout: 130_000 },
    );
  },
);
