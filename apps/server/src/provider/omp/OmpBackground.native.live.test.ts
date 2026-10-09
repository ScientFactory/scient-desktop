// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics preferSchemaOverJson:off
import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { CommandId, ProviderInstanceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import type { ResolvedModelConnection } from "../../customModels.ts";
import * as ServerConfig from "../../config.ts";
import { layer as allocatorLayer } from "@t3tools/provider-core/server/IdAllocator";
import { ProviderSessionManagerV2 } from "../../orchestration-v2/ProviderSessionManager.ts";
import { EventStoreV2 } from "../../orchestration-v2/EventStore.ts";
import { applyToProjection, emptyProjection } from "../../orchestration-v2/ProjectionStore.ts";
import { nativeOmpOrchestration } from "../testUtils/nativeOmpOrchestration.ts";
import * as OmpExecutableGate from "./OmpExecutableGate.ts";
import { makeOmpCustomModelsClientFactory } from "./OmpCustomModels.ts";
import { ompLiveInstance, ompQualifyBinary, ompQualifyTarget } from "./OmpLive.testFixtures.ts";

const dependencies = Layer.mergeAll(
  NodeServices.layer,
  OmpExecutableGate.layer,
  allocatorLayer,
  ServerConfig.layerTest(process.cwd(), { prefix: "scient-native-background-cli-" }).pipe(
    Layer.provide(NodeServices.layer),
  ),
);
const waitUntil = (predicate: () => boolean) =>
  Effect.gen(function* () {
    while (!predicate()) yield* Effect.sleep("20 millis");
  }).pipe(Effect.timeout("15 seconds"));

/** Actual async shell jobs run under the native worker; SQL owns every visible run/result. */
describe.runIf(ompQualifyBinary)("installed native OMP background continuation", () => {
  it.live.each(
    (["continuation", "stop", "message"] as const).map((mode) => ({
      caseTitle:
        mode === "stop"
          ? "Stop terminates a waiting native job"
          : mode === "message"
            ? "a message sent while a native job waits gets its own answer"
            : "a native job wakes the parent into a visible continuation",
      mode,
    })),
  )(
    "$caseTitle",
    ({ mode }) =>
      Effect.scoped(
        Effect.gen(function* () {
          const root = NodeFS.mkdtempSync(
            NodePath.join(NodeOS.tmpdir(), "scient-omp-background-live-"),
          );
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => NodeFS.rmSync(root, { recursive: true, force: true })),
          );
          const { environment } = ompLiveInstance(root, {
            blockEgress: true,
            baseEnv: { PATH: process.env.PATH ?? "" },
          });
          const releaseFile = NodePath.join(root, "release");
          const pidFile = NodePath.join(root, "job-pid");
          const doneFile = NodePath.join(root, "job-done");
          let calls = 0;
          const requests: Array<string> = [];
          // The message's reply is held until the job has finished, so its
          // result reaches OMP while that reply's run is still open.
          let openAnswer: () => void = () => {};
          const answerGate = new Promise<void>((resolve) => {
            openAnswer = resolve;
          });
          const server = NodeHttp.createServer((request, response) => {
            let body = "";
            request.setEncoding("utf8");
            request.on("data", (chunk: string) => {
              body += chunk;
            });
            request.on("end", () => {
              requests.push(body);
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
                          command: `echo $$ > '${pidFile}'; while [ ! -f '${releaseFile}' ]; do sleep 0.1; done; printf 'BACKGROUND_RESULT'; : > '${doneFile}'`,
                          async: true,
                          timeout: 60,
                        }),
                      },
                    },
                  ],
                });
                delta({}, "tool_calls");
              } else if (mode === "message" && calls === 3) {
                void answerGate.then(() => {
                  delta({ content: "USER_ANSWER" });
                  delta({}, "stop");
                  response.end("data: [DONE]\n\n");
                });
                return;
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
            ompQualifyTarget,
            {
              resolveCustomModels: () => Effect.succeed([connection]),
              subscribeChanges: Effect.succeed(Stream.never),
            },
            instanceId,
            NodePath.join(root, "state"),
          );
          let shutdowns = 0;
          let confirmed = false;
          const f = yield* nativeOmpOrchestration({
            instanceId,
            target: ompQualifyTarget,
            modelSelection: { instanceId, model: "scient_stub/background" },
            binaryPath: ompQualifyBinary!,
            stateDir: NodePath.join(root, "state"),
            attachmentsDir: root,
            environment,
            receiptTimeoutMs: 30_000,
            makeProcess: (options) =>
              factory(options).pipe(
                Effect.map((client) => ({
                  ...client,
                  shutdown: client.shutdown.pipe(
                    Effect.tap((exit) =>
                      Effect.sync(() => {
                        shutdowns++;
                        confirmed = exit.exited === true || exit.code !== null;
                      }),
                    ),
                  ),
                })),
              ),
          });
          yield* f.run(({ orchestrator, send, waitFor, completed }) =>
            Effect.gen(function* () {
              const store = yield* EventStoreV2;
              const manager = yield* ProviderSessionManagerV2;
              yield* send("Run the background job");
              const parent = yield* waitFor(
                (p) =>
                  p.runs[0]?.status === "completed" &&
                  p.providerThreads.some(
                    (thread) => (thread.pendingBackgroundTasks?.length ?? 0) > 0,
                  ),
              );
              const parentId = parent.runs[0]!.id;
              expect(calls).toBe(2);
              yield* waitUntil(() => NodeFS.existsSync(pidFile));
              const jobPid = Number(NodeFS.readFileSync(pidFile, "utf8").trim());
              expect(Number.isSafeInteger(jobPid) && jobPid > 1).toBe(true);
              expect(() => process.kill(jobPid, 0)).not.toThrow();
              if (mode === "stop") {
                yield* orchestrator.dispatch({
                  type: "run.interrupt",
                  commandId: CommandId.make("installed-background-stop"),
                  threadId: f.threadId,
                  runId: parentId,
                  holdQueue: true,
                });
                const stopped = yield* waitFor(
                  (p) =>
                    p.providerSessions.some(
                      (s) => s.status === "stopped" || s.status === "error",
                    ) &&
                    p.providerThreads.every(
                      (thread) => thread.pendingBackgroundTasks?.length === 0,
                    ),
                );
                yield* completed(CommandId.make("installed-background-stop"));
                expect(stopped.runs).toHaveLength(1);
                expect(stopped.runs[0]?.status).toBe("completed");
                expect(calls).toBe(2);
                expect(shutdowns).toBe(1);
                expect(confirmed).toBe(true);
                expect(() => process.kill(jobPid, 0)).toThrow();
                expect(NodeFS.existsSync(doneFile)).toBe(false);
                return;
              }
              let userRunId = parentId;
              if (mode === "message") {
                yield* send("What is the answer?");
                const answering = yield* waitFor(
                  (p) => p.runs.length === 2 && p.runs[1]?.status === "running",
                );
                userRunId = answering.runs[1]!.id;
                expect(userRunId).not.toBe(parentId);
                yield* waitUntil(() => calls >= 3);
                expect(calls).toBe(3);
                expect(requests[2]).toContain("What is the answer?");
              }
              NodeFS.writeFileSync(releaseFile, "done");
              yield* waitUntil(() => NodeFS.existsSync(doneFile));
              // The owned job has actually finished while the user's model response remains held.
              if (mode === "message") openAnswer();
              const settled = yield* waitFor(
                (p) =>
                  p.messages.some(
                    (m) =>
                      m.role === "assistant" &&
                      m.text.includes("I received the background result."),
                  ) &&
                  p.runs.every((run) => run.status === "completed") &&
                  p.providerThreads.every(
                    (thread) => thread.pendingBackgroundTasks?.length === 0,
                  ) &&
                  p.turnItems.some(
                    (item) => item.title === "Background result" && item.status === "completed",
                  ),
              );
              const received = settled.messages.find(
                (m) =>
                  m.role === "assistant" && m.text.includes("I received the background result."),
              )!;
              const marker = settled.turnItems.find(
                (item) => item.type === "dynamic_tool" && item.title === "Background result",
              );
              if (!marker || marker.type !== "dynamic_tool")
                return yield* Effect.die("Missing actual background result item");
              expect(marker.runId).toBe(received.runId);
              expect(marker.output).toContain("BACKGROUND_RESULT");
              expect(received.runId).not.toBe(parentId);
              expect(settled.runs.find((run) => run.id === parentId)?.status).toBe("completed");
              expect(
                settled.messages.filter((m) => m.role === "user" && m.createdBy === "user"),
              ).toHaveLength(mode === "message" ? 2 : 1);
              expect(
                settled.turnItems.filter(
                  (item) => item.type === "user_message" && item.createdBy === "user",
                ),
              ).toHaveLength(mode === "message" ? 2 : 1);
              expect(
                settled.turnItems.filter(
                  (item) => item.type === "user_message" && item.status === "pending",
                ),
              ).toEqual([]);
              expect(
                settled.messages
                  .filter((m) => m.notification?.source.kind === "provider_work")
                  .every((m) => m.createdBy === "agent" && m.creationSource === "provider"),
              ).toBe(true);
              if (mode === "message") {
                const answers = settled.messages.filter(
                  (m) => m.role === "assistant" && m.text.includes("USER_ANSWER"),
                );
                expect(answers).toHaveLength(1);
                expect(answers[0]?.runId).toBe(userRunId);
                expect(settled.runs.find((run) => run.id === userRunId)?.status).toBe("completed");
                expect(calls).toBe(4);
              } else {
                expect(settled.runs).toHaveLength(2);
                expect(calls).toBe(3);
              }
              const events = yield* store.read({ threadId: f.threadId }).pipe(
                Stream.map((stored) => stored.event),
                Stream.runCollect,
              );
              const created = events.find((event) => event.type === "thread.created");
              if (!created || created.type !== "thread.created")
                return yield* Effect.die("Missing persisted thread");
              const replayed = events.reduce(
                (p, event) => applyToProjection(p, event),
                emptyProjection(created),
              );
              const byId = (a: { id: string }, b: { id: string }) => a.id.localeCompare(b.id);
              expect(replayed?.messages.toSorted(byId)).toEqual(settled.messages.toSorted(byId));
              expect(replayed?.turnItems.toSorted(byId)).toEqual(settled.turnItems.toSorted(byId));
              expect(replayed?.runs.toSorted(byId)).toEqual(settled.runs.toSorted(byId));
              yield* manager.shutdown;
              expect(shutdowns).toBe(1);
              expect(confirmed).toBe(true);
            }),
          );
        }),
      ).pipe(Effect.provide(dependencies)),
    90_000,
  );
});
