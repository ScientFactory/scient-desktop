// @effect-diagnostics nodeBuiltinImport:off -- opt-in qualification of an explicitly selected native runtime.
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
import * as ServerConfig from "../../config.ts";
import * as LocalDuplexProcess from "../execution/LocalDuplexProcess.ts";
import * as LocalExecutionProcess from "../execution/LocalExecutionProcess.ts";
import { processExists } from "../execution/LocalProcessTestSupport.ts";
import * as LocalComputeStore from "./LocalComputeStore.ts";
import * as PythonComputeRuntime from "./PythonComputeRuntime.ts";
import { ComputeSessionService } from "./ComputeSessionService.ts";

const PYTHON = NodeProcess.env.SCIENT_TEST_PYTHON;
const PROJECT = ComputeProjectId.make("fresh-native-test");

const eventually = Effect.fn("FreshCompute.eventually")(function* <A, E, R>(
  read: Effect.Effect<A | null, E, R>,
) {
  for (let attempt = 0; attempt < 600; attempt += 1) {
    const value = yield* read;
    if (value !== null) return value;
    yield* Effect.sleep("50 millis");
  }
  return yield* Effect.die(new Error("Native fresh execution did not settle."));
});

describe.runIf(Boolean(PYTHON))("native Run fresh", () => {
  it.live(
    "keeps the interactive namespace, retains fresh output and errors, and reaps fresh bridges",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "scient-fresh-project-" });
        const state = yield* fs.makeTempDirectoryScoped({ prefix: "scient-fresh-state-" });
        const layer = PythonComputeRuntime.layer.pipe(
          Layer.provide(LocalComputeStore.layer),
          Layer.provide(LocalExecutionProcess.layer),
          Layer.provide(LocalDuplexProcess.layer),
          Layer.provide(ServerConfig.layerTest(cwd, state)),
          Layer.provide(NodeServices.layer),
        );
        yield* Effect.gen(function* () {
          const service = yield* ComputeSessionService;
          const input = (id: string) => ({
            projectId: PROJECT,
            sessionId: ComputeSessionId.make(id),
            languageId: ComputeLanguageId.make("python"),
            label: id,
            workingDirectory: cwd,
            configuredExecutable: PYTHON!,
          });
          const persistent = yield* service.startSession(input("interactive"));
          const submit = Effect.fn("FreshCompute.submit")(function* (
            session: ComputeSessionRecord,
            id: string,
            code: string,
          ) {
            const executionId = ComputeExecutionId.make(id);
            yield* service.submitExecution({
              projectId: PROJECT,
              sessionId: session.sessionId,
              expectedGeneration: session.generation,
              executionId,
              code,
              source: { _tag: "console" },
            });
            return yield* eventually(
              service.listExecutions({ projectId: PROJECT, sessionId: session.sessionId }).pipe(
                Effect.map((executions) => {
                  const execution = executions.find(
                    (entry) => entry.request.executionId === executionId,
                  );
                  return execution?.result &&
                    TERMINAL_COMPUTE_EXECUTION_STATUSES.has(execution.result.status)
                    ? execution
                    : null;
                }),
              ),
            );
          });
          expect((yield* submit(persistent, "seed", "scient_kept = 73")).result?.status).toBe(
            "succeeded",
          );
          const requests = [
            {
              ...input("fresh-ok"),
              runOnce: {
                executionId: ComputeExecutionId.make("fresh-ok-result"),
                code: "import time\nassert 'scient_kept' not in globals()\nscient_kept = 99\nprint('FRESH_OK', flush=True)\ntime.sleep(0.2)",
                source: { _tag: "console" as const },
              },
            },
            {
              ...input("fresh-error"),
              runOnce: {
                executionId: ComputeExecutionId.make("fresh-error-result"),
                code: "raise ValueError('EXPECTED_FRESH_FAILURE')",
                source: { _tag: "console" as const },
              },
            },
          ];
          yield* Effect.forEach(requests, (request) => service.startSession(request), {
            concurrency: 2,
          });
          const finished = yield* Effect.forEach(
            requests,
            (request) =>
              eventually(
                service
                  .getSession({ projectId: PROJECT, sessionId: request.sessionId })
                  .pipe(Effect.map((session) => (session?.status === "stopped" ? session : null))),
              ),
            { concurrency: 2 },
          );
          for (const [index, session] of finished.entries()) {
            const executions = yield* service.listExecutions({
              projectId: PROJECT,
              sessionId: session.sessionId,
            });
            expect(executions).toHaveLength(1);
            expect(executions[0]?.result?.status).toBe(index === 0 ? "succeeded" : "failed");
            expect(session.identity?.transportProcessId).toBeTypeOf("number");
            expect(processExists(session.identity!.transportProcessId!)).toBe(false);
            expect(session.identity?.runtimeProcessId).toBeTypeOf("number");
            expect(processExists(session.identity!.runtimeProcessId!)).toBe(false);
          }
          const output = yield* service.listOutputs({
            projectId: PROJECT,
            sessionId: requests[0]!.sessionId,
            executionId: requests[0]!.runOnce.executionId,
          });
          expect(
            output.outputs.some((item) => item._tag === "stream" && item.text.includes("FRESH_OK")),
          ).toBe(true);
          expect(
            (yield* submit(persistent, "retained", "assert scient_kept == 73")).result?.status,
          ).toBe("succeeded");
          yield* service.stopSession({
            projectId: PROJECT,
            sessionId: persistent.sessionId,
            expectedGeneration: persistent.generation,
          });
          expect(processExists(persistent.identity!.transportProcessId!)).toBe(false);
          expect(processExists(persistent.identity!.runtimeProcessId!)).toBe(false);
        }).pipe(Effect.provide(layer), Effect.scoped);
      }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
    120_000,
  );
});
