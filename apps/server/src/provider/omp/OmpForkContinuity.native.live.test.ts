// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics preferSchemaOverJson:off
import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as ServerConfig from "../../config.ts";
import { layer as allocatorLayer } from "../../orchestration-v2/IdAllocator.ts";
import { EventSinkV2 } from "../../orchestration-v2/EventSink.ts";
import { EventStoreV2 } from "../../orchestration-v2/EventStore.ts";
import { OrchestratorV2 } from "../../orchestration-v2/Orchestrator.ts";
import { applyToProjection, emptyProjection } from "../../orchestration-v2/ProjectionStore.ts";
import { ProviderSessionManagerV2 } from "../../orchestration-v2/ProviderSessionManager.ts";
import { ConversationForkService } from "../../orchestration-v2/scient-fork/ConversationForkService.ts";
import { checkpointWorkspace } from "../../orchestration-v2/testkit/ReplayFixtureWorkspace.ts";
import { nativeOmpOrchestration } from "../testUtils/nativeOmpOrchestration.ts";
import * as OmpExecutableGate from "./OmpExecutableGate.ts";
import { makeOmpCustomModelsClientFactory } from "./OmpCustomModels.ts";
import { ompLiveInstance, ompQualifyBinary, ompQualifyTarget } from "./OmpLive.testFixtures.ts";

const dependencies = Layer.mergeAll(
  NodeServices.layer,
  allocatorLayer,
  OmpExecutableGate.layer,
  ServerConfig.layerTest(process.cwd(), { prefix: "scient-native-continuity-cli-" }).pipe(
    Layer.provide(NodeServices.layer),
  ),
);
const marker = "inherited-context-6b2c9d";
const targetId = ThreadId.make("installed-native-fork-target");
const waitForTarget = (predicate: (p: OrchestrationV2ThreadProjection) => boolean) =>
  Effect.gen(function* () {
    const orchestrator = yield* OrchestratorV2;
    const cursor = yield* orchestrator.getThreadEventSequence(targetId);
    const pull = yield* Stream.toPull(
      orchestrator.streamStoredEventsFrom({ threadId: targetId, afterSequence: cursor }),
    );
    const result = yield* Stream.concat(
      Stream.fromEffect(orchestrator.getThreadProjection(targetId)),
      Stream.fromPull(Effect.succeed(pull)).pipe(
        Stream.mapEffect(() => orchestrator.getThreadProjection(targetId)),
      ),
    ).pipe(Stream.filter(predicate), Stream.runHead);
    if (Option.isNone(result)) return yield* Effect.die("Native target ended before its receipt");
    return result.value;
  }).pipe(Effect.timeout("30 seconds"));

describe.runIf(ompQualifyBinary)("installed native OMP fork continuity", () => {
  it.live(
    "delivers history once across ten messages and a process restart",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const root = NodeFS.mkdtempSync(
            NodePath.join(NodeOS.tmpdir(), "scient-omp-fork-continuity-"),
          );
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => NodeFS.rmSync(root, { recursive: true, force: true })),
          );
          const requests: Array<Array<{ role: string; content: unknown }>> = [];
          const server = NodeHttp.createServer((request, response) => {
            let raw = "";
            request.on("data", (chunk) => {
              raw += chunk;
            });
            request.on("end", () => {
              requests.push(JSON.parse(raw).messages);
              response.writeHead(200, { "content-type": "text/event-stream" });
              for (const [delta, finish_reason] of [
                [{ role: "assistant", content: "Recorded." }, null],
                [{}, "stop"],
              ]) {
                response.write(
                  `data: ${JSON.stringify({ id: "stub", object: "chat.completion.chunk", created: 1, model: "continuity", choices: [{ index: 0, delta, finish_reason }] })}\n\n`,
                );
              }
              response.end("data: [DONE]\n\n");
            });
          });
          yield* Effect.promise(
            () => new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve)),
          );
          yield* Effect.addFinalizer(() =>
            Effect.promise(
              () =>
                new Promise<void>((resolve) => {
                  server.closeAllConnections();
                  server.close(() => resolve());
                }),
            ),
          );
          const address = server.address();
          if (!address || typeof address === "string") throw new Error("stub did not listen");
          const instanceId = ProviderInstanceId.make("omp-fork-continuity");
          const { environment } = ompLiveInstance(root, {
            blockEgress: true,
            baseEnv: { PATH: process.env.PATH ?? "" },
          });
          const factory = yield* makeOmpCustomModelsClientFactory(
            ompQualifyTarget,
            {
              resolveCustomModels: () =>
                Effect.succeed([
                  {
                    id: "stub",
                    name: "Stub",
                    protocol: "openai-completions",
                    baseUrl: `http://127.0.0.1:${address.port}/v1`,
                    credentialId: null,
                    apiKey: null,
                    models: [
                      {
                        id: "continuity",
                        modelId: "continuity",
                        name: "Continuity",
                        configurationMode: "manual",
                        contextWindow: 128000,
                        maxOutputTokens: 4096,
                        images: false,
                        reasoning: false,
                        instanceIds: [instanceId],
                      },
                    ],
                  },
                ]),
              subscribeChanges: Effect.succeed(Stream.never),
            },
            instanceId,
            NodePath.join(root, "state"),
          );
          const cwd = yield* checkpointWorkspace("installed-omp-continuity");
          let launches = 0;
          let shutdowns = 0;
          const exits: Array<boolean> = [];
          const switched: Array<string> = [];
          const prompts: Array<string> = [];
          const f = yield* nativeOmpOrchestration({
            cwd,
            instanceId,
            target: ompQualifyTarget,
            modelSelection: { instanceId, model: "scient_stub/continuity" },
            binaryPath: ompQualifyBinary!,
            stateDir: NodePath.join(root, "state"),
            attachmentsDir: NodePath.join(root, "attachments"),
            environment,
            receiptTimeoutMs: 30_000,
            makeProcess: (options) =>
              factory(options).pipe(
                Effect.map((client) => {
                  launches++;
                  return {
                    ...client,
                    prompt: (...args: Parameters<typeof client.prompt>) =>
                      client.prompt(...args).pipe(
                        Effect.tap(() =>
                          Effect.sync(() => {
                            prompts.push(args[0].message);
                          }),
                        ),
                      ),
                    switchSession: (...args: Parameters<typeof client.switchSession>) =>
                      client.switchSession(...args).pipe(
                        Effect.tap(() =>
                          Effect.sync(() => {
                            switched.push(args[0]);
                          }),
                        ),
                      ),
                    shutdown: client.shutdown.pipe(
                      Effect.tap((exit) =>
                        Effect.sync(() => {
                          shutdowns++;
                          exits.push(exit.exited === true || exit.code !== null);
                        }),
                      ),
                    ),
                  };
                }),
              ),
          });
          yield* f.run(({ orchestrator, send, waitFor }) =>
            Effect.gen(function* () {
              const sink = yield* EventSinkV2;
              const now = yield* DateTime.now;
              const projectId = ProjectId.make("background-project");
              const selection = { instanceId, model: "scient_stub/continuity" };
              yield* sink.commitProjectCommand({
                commandId: CommandId.make("installed-fork-project"),
                projectId,
                commandType: "project.create",
                acceptedAt: now,
                event: {
                  eventId: EventId.make("installed-fork-project-created"),
                  type: "project.created",
                  aggregateKind: "project",
                  aggregateId: projectId,
                  occurredAt: DateTime.formatIso(now),
                  commandId: null,
                  causationEventId: null,
                  correlationId: null,
                  metadata: {},
                  payload: {
                    projectId,
                    title: "Installed fork",
                    workspaceRoot: cwd,
                    scripts: [],
                    defaultModelSelection: selection,
                    createdAt: DateTime.formatIso(now),
                    updatedAt: DateTime.formatIso(now),
                  },
                },
              });
              yield* send(marker);
              const source = yield* waitFor(
                (p) =>
                  p.runs[0]?.status === "completed" &&
                  p.checkpoints.some((cp) => cp.runId === p.runs[0]?.id && cp.status === "ready"),
              );
              const answer = source.turnItems.find(
                (item) => item.type === "assistant_message" && item.status === "completed",
              );
              if (!answer || answer.type !== "assistant_message")
                return yield* Effect.die("Missing actual source answer");
              const forks = yield* ConversationForkService;
              yield* forks.dispatch({
                type: "thread.fork",
                commandId: CommandId.make("installed-native-fork"),
                originThreadId: f.threadId,
                newThreadId: targetId,
                sourceAssistantMessageId: answer.messageId,
                workspaceMode: "local",
              });
              const frozen = yield* orchestrator.getThreadProjection(targetId);
              expect(frozen.contextTransfers).toHaveLength(1);
              expect(frozen.contextTransfers[0]?.status).toBe("pending");
              expect(frozen.providerThreads).toHaveLength(0);
              const manager = yield* ProviderSessionManagerV2;
              let nativeId: string | undefined;
              let beforeRestart: unknown;
              let afterTen: OrchestrationV2ThreadProjection | undefined;
              for (let index = 0; index < 10; index++) {
                yield* orchestrator.dispatch({
                  type: "message.dispatch",
                  commandId: CommandId.make(`installed-fork-message-${index}`),
                  threadId: targetId,
                  messageId: MessageId.make(`installed-fork-message-${index}`),
                  text: `Follow-up ${index}`,
                  attachments: [],
                  dispatchMode: { type: "start_immediately" },
                  createdBy: "user",
                  creationSource: "web",
                });
                const complete = yield* waitForTarget(
                  (p) =>
                    p.runs.length === index + 1 &&
                    p.runs.every((run) => run.status === "completed") &&
                    p.providerThreads.some(
                      (thread) => thread.nativeMetadata?.resumeCursor !== undefined,
                    ),
                );
                const thread = complete.providerThreads[0]!;
                const currentId = thread.nativeThreadRef?.nativeId;
                expect(currentId).toBeTruthy();
                if (index === 0) nativeId = currentId ?? undefined;
                expect(currentId).toBe(nativeId);
                expect(thread.nativeMetadata?.resumeCursor).toBeDefined();
                expect(complete.contextTransfers).toHaveLength(1);
                expect(complete.contextTransfers[0]?.status).toBe("consumed");
                expect(complete.contextTransfers[0]?.resolution?.strategy).toBe("portable_context");
                expect(complete.contextHandoffs).toHaveLength(1);
                expect(complete.contextHandoffs[0]?.delivery).toMatchObject({
                  status: "inline",
                  nativeThreadId: nativeId,
                });
                expect(
                  complete.contextHandoffs[0]?.history?.messages.filter((message) =>
                    message.text.includes(marker),
                  ),
                ).toHaveLength(1);
                expect(requests).toHaveLength(index + 2);
                expect(
                  requests
                    .at(-1)
                    ?.filter(
                      (message) =>
                        message.role === "user" && JSON.stringify(message.content).includes(marker),
                    ),
                ).toHaveLength(1);
                if (index === 4) {
                  beforeRestart = thread.nativeMetadata?.resumeCursor;
                  yield* manager.release({
                    providerSessionId: thread.providerSessionId!,
                    reason: "manual_shutdown",
                  });
                  expect(shutdowns).toBe(1);
                  expect(exits).toEqual([true]);
                  expect(Option.isNone(yield* manager.get(thread.providerSessionId!))).toBe(true);
                  expect(NodeFS.existsSync(nativeId!)).toBe(true);
                  const released = yield* orchestrator.getThreadProjection(targetId);
                  expect(released.providerThreads[0]?.nativeMetadata?.resumeCursor).toEqual(
                    beforeRestart,
                  );
                }
                if (index === 5) {
                  expect(launches).toBe(3); // Source, original fork, physically restarted fork.
                  expect(switched).toEqual([nativeId]);
                }
                afterTen = complete;
              }
              expect(requests).toHaveLength(11);
              const targetPrompts = prompts.slice(1);
              expect(targetPrompts).toHaveLength(10);
              expect(targetPrompts.filter((prompt) => prompt.includes(marker))).toHaveLength(1);
              expect(targetPrompts[0]).toContain(marker);
              for (let index = 1; index < targetPrompts.length; index++) {
                expect(targetPrompts[index]).not.toContain(marker);
                expect(targetPrompts[index]).toContain(`Follow-up ${index}`);
              }
              for (const request of requests.slice(1))
                expect(
                  request.filter(
                    (message) =>
                      message.role === "user" && JSON.stringify(message.content).includes(marker),
                  ),
                ).toHaveLength(1);
              expect(afterTen?.runs).toHaveLength(10);
              const store = yield* EventStoreV2;
              const events = yield* store.read({ threadId: targetId }).pipe(
                Stream.map((stored) => stored.event),
                Stream.runCollect,
              );
              const created = events.find((event) => event.type === "thread.created");
              if (!created || created.type !== "thread.created")
                return yield* Effect.die("Missing persisted fork");
              const replayed = events.reduce(
                (p, event) => applyToProjection(p, event),
                emptyProjection(created),
              );
              expect(replayed?.contextTransfers).toEqual(afterTen?.contextTransfers);
              expect(replayed?.contextHandoffs).toEqual(afterTen?.contextHandoffs);
              expect(replayed?.runs).toEqual(afterTen?.runs);
              expect(replayed?.messages).toEqual(afterTen?.messages);
              yield* manager.shutdown;
              expect(launches).toBe(3);
              expect(shutdowns).toBe(3);
              expect(exits).toEqual([true, true, true]);
            }),
          );
        }),
      ).pipe(Effect.provide(dependencies)),
    120_000,
  );
});
