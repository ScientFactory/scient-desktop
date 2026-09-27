// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics preferSchemaOverJson:off
import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { ProviderInstanceId, ThreadId, type ProviderRuntimeEvent } from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import type { ResolvedModelConnection } from "../../customModels.ts";
import { makeOmpAdapter } from "../Layers/OmpAdapter.ts";
import * as OmpExecutableGate from "./OmpExecutableGate.ts";
import { makeOmpCustomModelsClientFactory } from "./OmpCustomModels.ts";
import { ompLiveInstance, ompQualifyBinary } from "./OmpLive.testFixtures.ts";

/** Real native async bash and result delivery; all model responses come from loopback. */
describe.runIf(ompQualifyBinary)("real OMP background continuation", () => {
  for (const stop of [false, true]) {
    it.effect(
      stop
        ? "Stop terminates a waiting native job"
        : "a native job wakes the parent into a visible continuation",
      () =>
        Effect.scoped(
          Effect.gen(function* () {
            const root = NodeFS.mkdtempSync(
              NodePath.join(NodeOS.tmpdir(), "scient-omp-background-live-"),
            );
            yield* Effect.addFinalizer(() =>
              Effect.sync(() => NodeFS.rmSync(root, { recursive: true, force: true })),
            );
            const { environment, homePath } = ompLiveInstance(root, {
              blockEgress: true,
              baseEnv: { PATH: process.env.PATH ?? "" },
            });
            const releaseFile = NodePath.join(root, "release");
            const pidFile = NodePath.join(root, "job-pid");
            let calls = 0;
            const server = NodeHttp.createServer((request, response) => {
              request.resume();
              request.on("end", () => {
                calls++;
                const delta = (value: unknown, finish: string | null = null) =>
                  response.write(
                    `data: ${JSON.stringify({ id: "stub", object: "chat.completion.chunk", created: 1, model: "background", choices: [{ index: 0, delta: value, finish_reason: finish }] })}\n\n`,
                  );
                response.writeHead(200, { "content-type": "text/event-stream" });
                delta({ role: "assistant", content: "" });
                if (calls === 1) {
                  delta({
                    tool_calls: [
                      {
                        index: 0,
                        id: "background-call",
                        type: "function",
                        function: {
                          name: "bash",
                          arguments: JSON.stringify({
                            command: `echo $$ > '${pidFile}'; while [ ! -f '${releaseFile}' ]; do sleep 0.1; done; printf 'BACKGROUND_RESULT'`,
                            async: true,
                            timeout: 60,
                          }),
                        },
                      },
                    ],
                  });
                  delta({}, "tool_calls");
                } else {
                  delta({
                    content:
                      calls === 2
                        ? "The job is running in the background."
                        : "I received the background result.",
                  });
                  delta({}, "stop");
                }
                response.end("data: [DONE]\n\n");
              });
            });
            yield* Effect.addFinalizer(() =>
              Effect.promise(
                () =>
                  new Promise<void>((resolve) => {
                    server.closeAllConnections();
                    server.close(() => resolve());
                  }),
              ),
            );
            yield* Effect.promise(
              () => new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve)),
            );
            const address = server.address();
            if (!address || typeof address === "string") throw new Error("Stub did not listen");
            const instanceId = ProviderInstanceId.make("omp-background-live");
            const connection: ResolvedModelConnection = {
              id: "stub",
              name: "Stub",
              protocol: "openai-completions",
              baseUrl: `http://127.0.0.1:${address.port}/v1`,
              credentialId: null,
              apiKey: null,
              models: [
                {
                  id: "background",
                  modelId: "background",
                  name: "Background",
                  configurationMode: "manual",
                  contextWindow: 128_000,
                  maxOutputTokens: 4096,
                  images: false,
                  imageInput: "disabled",
                  reasoning: false,
                  instanceIds: [instanceId],
                },
              ],
            };
            const factory = yield* makeOmpCustomModelsClientFactory(
              {
                resolveCustomModels: () => Effect.succeed([connection]),
                subscribeChanges: Effect.succeed(Stream.never),
              },
              instanceId,
              NodePath.join(root, "state"),
            );
            let reportsSettlement = false;
            const adapter = yield* makeOmpAdapter({
              binaryPath: ompQualifyBinary!,
              providerInstanceId: instanceId,
              stateDir: NodePath.join(root, "state"),
              attachmentsDir: root,
              environment,
              homePath,
              makeProcess: (options) =>
                factory(options).pipe(
                  Effect.map((client) => ({
                    ...client,
                    getState: () =>
                      client.getState().pipe(
                        Effect.tap((state) =>
                          Effect.sync(() => {
                            reportsSettlement ||= state.isSettled !== undefined;
                          }),
                        ),
                      ),
                  })),
                ),
            });
            const events: Array<ProviderRuntimeEvent> = [];
            const queue = yield* Queue.unbounded<ProviderRuntimeEvent>();
            yield* adapter.streamEvents.pipe(
              Stream.runForEach((event) =>
                Effect.sync(() => events.push(event)).pipe(
                  Effect.andThen(Queue.offer(queue, event)),
                ),
              ),
              Effect.forkScoped,
            );
            const until = (predicate: (event: ProviderRuntimeEvent) => boolean) =>
              Effect.gen(function* () {
                for (;;) {
                  const found = events.find(predicate);
                  if (found) return found;
                  yield* Queue.take(queue).pipe(Effect.timeout("30 seconds"));
                }
              });
            const threadId = ThreadId.make("background-live");
            yield* adapter.startSession({ threadId, cwd: root, runtimeMode: "full-access" });
            const first = yield* adapter.sendTurn({
              threadId,
              input: "Run the background job",
              modelSelection: createModelSelection(instanceId, "scient_stub/background"),
            });
            yield* until(
              (event) =>
                event.type === "content.delta" &&
                event.payload.delta.includes("The job is running in the background."),
            );
            if (reportsSettlement) {
              yield* until(
                (event) => event.type === "turn.completed" && event.turnId === first.turnId,
              );
              yield* until(
                (event) => event.type === "task.started" && event.payload.taskType === "monitor",
              );
            } else {
              // 18.2.8 has no yield/settled distinction: its nonterminal end
              // keeps the original turn visibly working until the job returns.
              expect((yield* adapter.listSessions())[0]?.activeTurnId).toBe(first.turnId);
            }
            expect(calls).toBe(2);
            for (let attempt = 0; attempt < 100 && !NodeFS.existsSync(pidFile); attempt++) {
              yield* Effect.sleep("50 millis").pipe(TestClock.withLive);
            }
            expect(
              NodeFS.existsSync(pidFile),
              JSON.stringify(events.filter((event) => event.type === "item.completed")),
            ).toBe(true);
            const jobPid = Number(NodeFS.readFileSync(pidFile, "utf8").trim());
            expect(Number.isSafeInteger(jobPid) && jobPid > 1).toBe(true);
            if (stop) {
              yield* adapter.interruptTurn(threadId, undefined);
              yield* until((event) => event.type === "session.exited");
              expect(yield* adapter.hasSession(threadId)).toBe(false);
              expect(calls).toBe(2);
              // This PID is written only by our synthetic native job, never discovered by name.
              expect(() => process.kill(jobPid, 0)).toThrow();
            } else {
              NodeFS.writeFileSync(releaseFile, "done");
              const completed = yield* until(
                (event) =>
                  event.type === "turn.completed" &&
                  (!reportsSettlement || event.turnId !== first.turnId),
              );
              expect(completed.payload).toMatchObject({ state: "completed" });
              expect(
                events.some(
                  (event) =>
                    event.type === "content.delta" &&
                    event.turnId === completed.turnId &&
                    event.payload.delta.includes("I received the background result."),
                ),
              ).toBe(true);
              if (reportsSettlement)
                yield* until(
                  (event) =>
                    event.type === "task.completed" && event.payload.taskType === "monitor",
                );
              expect(calls).toBe(3);
            }
            yield* adapter.stopAll();
          }),
        ).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, OmpExecutableGate.layer))),
      90_000,
    );
  }
});
