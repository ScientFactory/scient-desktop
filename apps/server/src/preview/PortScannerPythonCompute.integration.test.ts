// @effect-diagnostics nodeBuiltinImport:off globalFetch:off -- gated qualification uses an explicit native Python and a recording Fetch service restricted to its loopback fixture.
import * as NodeHttp from "node:http";
import * as NodeProcess from "node:process";
import type { DuplexProcessHandle } from "@scientfactory/execution";

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
import * as Stream from "effect/Stream";
import * as Option from "effect/Option";
import { FetchHttpClient } from "effect/http";

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

const afterSessionReceipt = Effect.fn("PortScannerPythonCompute.afterSessionReceipt")(function* <
  A,
  E,
  R,
>(compute: ComputeSessionService["Service"], read: Effect.Effect<A | null, E, R>) {
  const changes = yield* compute.subscribeSessions({ projectId: PROJECT });
  const value = yield* changes.pipe(
    Stream.mapEffect(() => read),
    Stream.filter((value) => value !== null),
    Stream.runHead,
  );
  if (Option.isNone(value)) return yield* Effect.die("Compute receipt stream ended.");
  return value.value;
}, Effect.scoped);

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
    it.live("never probes unconfigured kernel listeners or grows their transcripts", () =>
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
          const exits = new Map<number, DuplexProcessHandle["exitCode"]>();
          const observedDuplex = Layer.effect(
            LocalDuplexProcess.DuplexProcess,
            Effect.gen(function* () {
              const delegate = yield* LocalDuplexProcess.DuplexProcess;
              return LocalDuplexProcess.DuplexProcess.of({
                start: (request) =>
                  delegate.start(request).pipe(
                    Effect.tap((handle) =>
                      Effect.sync(() => {
                        exits.set(handle.pid, handle.exitCode);
                      }),
                    ),
                  ),
              });
            }),
          ).pipe(Layer.provide(LocalDuplexProcess.layer));

          const computeLayer = PythonComputeRuntime.layer.pipe(
            Layer.provide(LocalComputeStore.layer),
            Layer.provide(LocalExecutionProcess.layer),
            Layer.provide(observedDuplex),
            Layer.provide(
              Layer.succeed(OwnedLocalEndpoints.OwnedLocalEndpointRegistry, computeOwnedEndpoints),
            ),
            Layer.provide(ServerConfig.layerTest(cwd, state)),
            Layer.provide(NodeServices.layer),
          );
          const scannerLayer = PortScanner.layer.pipe(
            Layer.provide(recordingProcessRunnerLayer(lsofSnapshots)),
            Layer.provide(
              Layer.succeed(OwnedLocalEndpoints.OwnedLocalEndpointRegistry, scannerOwnedEndpoints),
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
            const waitForLsofProcess = Effect.fn("PortScannerPythonCompute.waitForLsofProcess")(
              function* (processId: number) {
                yield* scanConfiguredFixture(1);
                expect(lsofObservedProcess(lsofSnapshots, processId)).toBe(true);
              },
            );
            const waitForExecution = (executionId: ComputeExecutionId) =>
              afterSessionReceipt(
                compute,
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
                yield* afterSessionReceipt(
                  compute,
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
            const firstTransportProcessId = session.identity?.transportProcessId;
            if (firstRuntimeProcessId == null) {
              return yield* Effect.die("The real Python session did not report its runtime PID.");
            }
            expect((yield* computeOwnedEndpoints.snapshot).protectedLoopbackTcpPorts.size).toBe(5);
            expect((yield* scannerOwnedEndpoints.snapshot).protectedLoopbackTcpPorts.size).toBe(0);
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
            yield* waitForLsofProcess(firstRuntimeProcessId);
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
            if (firstTransportProcessId == null || !exits.has(firstTransportProcessId))
              return yield* Effect.die("The original bridge has no native process handle.");
            // Restart replaces the kernel, not the bridge carrying its acknowledgement.
            expect(session.identity?.transportProcessId).toBe(firstTransportProcessId);
            expect(processExists(firstTransportProcessId)).toBe(true);
            expect(processExists(firstRuntimeProcessId)).toBe(false);
            yield* waitForLsofProcess(restartedRuntimeProcessId);
            expect((yield* computeOwnedEndpoints.snapshot).protectedLoopbackTcpPorts.size).toBe(5);
            expect((yield* scannerOwnedEndpoints.snapshot).protectedLoopbackTcpPorts.size).toBe(0);

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
            if (!exits.has(restartedTransportProcessId))
              return yield* Effect.die("The restarted bridge has no native exit receipt.");
            yield* exits.get(restartedTransportProcessId)!;
            expect((yield* computeOwnedEndpoints.snapshot).protectedLoopbackTcpPorts.size).toBe(0);
            expect(processExists(restartedRuntimeProcessId)).toBe(false);
            expect(processExists(restartedTransportProcessId)).toBe(false);
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
    );
  },
);
