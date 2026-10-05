// @effect-diagnostics nodeBuiltinImport:off
import { assert } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CommandId,
  EventId,
  ProjectId,
  MessageId,
  EnvironmentId,
  ProviderSessionId,
  ThreadId,
  type OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Exit from "effect/Exit";
import * as Deferred from "effect/Deferred";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import * as VcsProcess from "../../vcs/VcsProcess.ts";
import { CheckpointStore } from "../../checkpointing/CheckpointStore.ts";
import * as McpRegistry from "../../mcp/McpSessionRegistry.ts";
import { ProviderSessionManagerV2 } from "../ProviderSessionManager.ts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as FileSystem from "effect/FileSystem";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import * as ProjectStore from "../ProjectStore.ts";
import * as RuntimePolicy from "../RuntimePolicy.ts";
import * as ProviderInstances from "../../provider/Services/ProviderInstanceRegistry.ts";
import { OrchestratorV2 } from "../Orchestrator.ts";
import { makeLayerEffect } from "../ProviderAdapterRegistry.ts";
import {
  ProviderContinuationRequests,
  type ProviderContinuationRequest,
} from "../ProviderContinuationRequests.ts";
import { makeOrchestratorV2ReplayLayerWithRegistry } from "../testkit/ProviderReplayHarness.ts";
import { checkpointWorkspace } from "../testkit/ReplayFixtureWorkspace.ts";
import { makePiAdapterV2 } from "./PiAdapterV2.ts";
import { makePiRpcConnection, type PiRpcRecord } from "./PiRpc.ts";
import { fixture, serve, decodeRecord, json } from "./PiNativeTestHarness.ts";

export type PiNativeInitiatedScenario = "plain" | "captured" | "stop" | "close" | "barrier";

export const runNativeInitiatedWorkScenario = (scenario: PiNativeInitiatedScenario) => {
  const restricted = scenario === "captured" || scenario === "stop" || scenario === "close";
  return Effect.scoped(
    Effect.gen(function* () {
      const cwd = yield* checkpointWorkspace("pi-initiated-real", {
        "native-answer.txt": "Initial A\n",
      });
      const h = yield* fixture(`initiated-${scenario}`, cwd);
      const workspaceB = yield* checkpointWorkspace("pi-initiated-other", {
        "native-answer.txt": "Initial B\n",
      });
      const selection = {
        ...h.modelSelection,
        ...(restricted ? { options: [{ id: "thinkingLevel", value: "high" }] } : {}),
      };
      const offered = yield* Deferred.make<ProviderContinuationRequest>();
      const offerEvents = yield* Queue.unbounded<ProviderContinuationRequest>();
      const releaseOffer = yield* Deferred.make<void>();
      const captureEntered = yield* Deferred.make<void>();
      const releaseCapture = yield* Deferred.make<void>();
      let heldCapture = false;
      let captureCwd: string | undefined;
      let beforePrompt: (record: PiRpcRecord) => Effect.Effect<void> = () => Effect.void;
      let queuedWireChecks = 0;
      let beforeAdmission: (request: ProviderContinuationRequest) => Effect.Effect<void> = () =>
        Effect.void;
      const wireFailure = yield* Deferred.make<Cause.Cause<never>>();
      const fs = yield* FileSystem.FileSystem;
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const git = (root: string, args: readonly string[]) =>
        spawner.string(ChildProcess.make("git", args, { cwd: root }));
      const snapshotB = Effect.gen(function* () {
        return {
          refs: yield* git(workspaceB, ["for-each-ref"]),
          objects: yield* git(workspaceB, ["count-objects", "-v"]),
          index: Array.from(yield* fs.readFile(`${workspaceB}/.git/index`)),
          untracked: yield* git(workspaceB, ["ls-files", "--others", "--exclude-standard"]),
          text: yield* fs.readFileString(`${workspaceB}/native-answer.txt`),
        };
      });
      const untouchedB = scenario === "captured" ? yield* snapshotB : undefined;
      const requests: Array<Record<string, unknown>> = [];
      const offers: ProviderContinuationRequest[] = [];
      const wire: PiRpcRecord[] = [];
      let opens = 0;
      let loads = 0;
      const base = yield* serve(async (request, response) => {
        let body = "";
        for await (const chunk of request) body += String(chunk);
        const parsed = decodeRecord(body);
        if (request.url === "/mcp") {
          assert.equal(request.headers.authorization, "Bearer synthetic-only");
          if (parsed.method === "notifications/initialized") {
            response.writeHead(202).end();
            return;
          }
          const result =
            parsed.method === "initialize"
              ? {
                  protocolVersion: "2025-06-18",
                  capabilities: { tools: {} },
                  serverInfo: { name: "synthetic", version: "1" },
                }
              : { tools: [] };
          response.writeHead(200, {
            "content-type": "text/event-stream",
            "mcp-session-id": "synthetic-session",
          });
          response.end(
            `event: message\ndata: ${json({ jsonrpc: "2.0", id: parsed.id, result })}\n\n`,
          );
          return;
        }
        requests.push(parsed);
        if (restricted && requests.length === 1) {
          response.writeHead(200, { "content-type": "text/event-stream" });
          response.end(
            `data: ${json({ id: "native-tool", object: "chat.completion.chunk", model: "synthetic", choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: "native-write", type: "function", function: { name: "bash", arguments: json({ command: "pwd > native-cwd.txt; printf 'Captured native work in A\\n' > native-answer.txt" }) } }] }, finish_reason: null }] })}\n\ndata: ${json({ id: "native-tool", object: "chat.completion.chunk", model: "synthetic", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 10, completion_tokens: 8, total_tokens: 18 } })}\n\ndata: [DONE]\n\n`,
          );
          return;
        }
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.end(
          `data: ${json({ id: "native-work", object: "chat.completion.chunk", model: "synthetic", choices: [{ index: 0, delta: { role: "assistant", content: "Actual extension answer: שלום π." }, finish_reason: null }] })}\n\ndata: ${json({ id: "native-work", object: "chat.completion.chunk", model: "synthetic", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 8, total_tokens: 18 } })}\n\ndata: [DONE]\n\n`,
        );
      });
      yield* h.models(`${base}/v1`, restricted, 32000, 1024, ["synthetic", "future"]);
      yield* fs.makeDirectory(`${h.profile}/extensions`);
      yield* fs.writeFileString(
        `${h.profile}/extensions/native-work.ts`,
        `
import fs from "node:fs/promises";
export default function(pi) {
  pi.registerCommand("synthetic-arm", { description: "Synthetic native work", handler: async (_args, ctx) => {
    ctx.ui.notify("Native extension armed.", "info");
    void (async () => {
      while (true) {
        try { await fs.access(${json(`${cwd}/wake`)}); break; } catch {}
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      pi.sendMessage({ customType: "synthetic-native-work", content: "Finish the native extension task.", display: true }, { triggerTurn: true });
    })();
  }});
}`,
      );
      const database = SqlitePersistenceMemory;
      const projectsLayer = ProjectStore.layer.pipe(Layer.provide(database));
      const policyLayer = RuntimePolicy.layerFromProjectStore.pipe(
        Layer.provide(
          Layer.mergeAll(
            projectsLayer,
            Layer.mock(ProviderInstances.ProviderInstanceRegistry)({
              getInstance: () => Effect.succeed(undefined),
            }),
          ),
        ),
        Layer.orDie,
      );
      const registry = makeLayerEffect(
        Effect.gen(function* () {
          const bus = yield* ProviderContinuationRequests;
          const adapter = makePiAdapterV2({
            ...h.adapterOptions,
            continuationRequests: {
              ...bus,
              offer: (request) =>
                Effect.sync(() => offers.push(request)).pipe(
                  Effect.andThen(Deferred.succeed(offered, request)),
                  Effect.andThen(Queue.offer(offerEvents, request)),
                  Effect.andThen(restricted ? Deferred.await(releaseOffer) : Effect.void),
                  Effect.andThen(
                    bus.offer({
                      ...request,
                      dispatchIfCurrent: (effect) =>
                        request.dispatchIfCurrent!(
                          beforeAdmission(request).pipe(
                            Effect.andThen(effect),
                            Effect.tapCause((c) =>
                              scenario === "barrier"
                                ? Effect.logError(Cause.pretty(c))
                                : Effect.void,
                            ),
                          ),
                        ),
                    }),
                  ),
                ),
            },
            makeConnection: (input) =>
              makePiRpcConnection(input).pipe(
                Effect.map((connection) => ({
                  ...connection,
                  send: (record) =>
                    Effect.sync(() => wire.push(record)).pipe(
                      Effect.andThen(
                        Effect.suspend(() =>
                          record.type === "prompt" ? beforePrompt(record) : Effect.void,
                        ),
                      ),
                      Effect.andThen(connection.send(record)),
                    ),
                  request: (record, timeout) =>
                    Effect.sync(() => wire.push(record)).pipe(
                      Effect.andThen(connection.request(record, timeout)),
                    ),
                })),
              ),
          });
          return [
            {
              ...adapter,
              openSession: (input) =>
                Effect.sync(() => opens++).pipe(
                  Effect.andThen(adapter.openSession(input)),
                  Effect.map((runtime) => ({
                    ...runtime,
                    startTurn: (input) =>
                      runtime
                        .startTurn(input)
                        .pipe(Effect.tapCause((c) => Effect.logError(Cause.pretty(c)))),
                    get providerSession() {
                      return runtime.providerSession;
                    },
                    ensureThread: (input) =>
                      Effect.sync(() => loads++).pipe(Effect.andThen(runtime.ensureThread(input))),
                    resumeThread: (input) =>
                      Effect.sync(() => loads++).pipe(Effect.andThen(runtime.resumeThread(input))),
                  })),
                ),
            },
          ];
        }),
      );
      const runtime = makeOrchestratorV2ReplayLayerWithRegistry(
        { name: "pi-real-initiated" },
        registry,
        {
          databaseLayer: database,
          runtimePolicyLayer: policyLayer,
          configureMcp: restricted,
          mcpSessionRegistryLayer: Layer.succeed(
            McpRegistry.McpSessionRegistry,
            McpRegistry.McpSessionRegistry.of({
              issue: ({ threadId, providerInstanceId, capabilities }) =>
                Effect.succeed({
                  config: {
                    threadId,
                    providerInstanceId,
                    capabilities: capabilities ?? new Set(),
                    environmentId: EnvironmentId.make("pi-native-synthetic"),
                    providerSessionId: `mcp:${threadId}`,
                    endpoint: `${base}/mcp`,
                    authorizationHeader: "Bearer synthetic-only",
                  },
                }),
              resolve: () => Effect.succeed(undefined),
              touch: () => Effect.void,
              replaceSkillScope: () => Effect.void,
              revokeProviderSession: () => Effect.void,
              revokeThread: () => Effect.void,
              revokeAll: Effect.void,
            }),
          ),
          vcsProcessLayer: Layer.effect(
            VcsProcess.VcsProcess,
            Effect.gen(function* () {
              const real = yield* VcsProcess.VcsProcess;
              return {
                run: (input: VcsProcess.VcsProcessInput) =>
                  Effect.gen(function* () {
                    if (
                      (scenario === "captured" || scenario === "barrier") &&
                      !heldCapture &&
                      input.operation === VcsProcess.CHECKPOINT_CAPTURE_OPERATION &&
                      input.args.includes("fetch") &&
                      input.args.some((arg) =>
                        arg.endsWith(scenario === "barrier" ? "/ordinal/1" : "/ordinal/2"),
                      )
                    ) {
                      heldCapture = true;
                      captureCwd = input.cwd;
                      yield* Deferred.succeed(captureEntered, undefined);
                      yield* Deferred.await(releaseCapture);
                    }
                    return yield* real.run(input);
                  }),
              };
            }),
          ).pipe(Layer.provide(VcsProcess.layer), Layer.provide(NodeServices.layer)),
          runContinuationWorker: true,
        },
      );
      yield* Effect.gen(function* () {
        const orchestrator = yield* OrchestratorV2;
        const projects = yield* ProjectStore.ProjectStoreV2;
        const admissionManager = yield* ProviderSessionManagerV2;
        if (scenario === "barrier")
          beforeAdmission = (request) =>
            Effect.gen(function* () {
              const p = yield* orchestrator.getThreadProjection(h.threadId);
              const native = p.providerThreads.find((row) => row.id === request.providerThreadId);
              const session = yield* admissionManager.get(request.initiated!.providerSessionId);
              yield* Effect.logInfo("pi-native-pre-admission", {
                offer: request.initiated,
                thread: {
                  archivedAt: p.thread.archivedAt,
                  deletedAt: p.thread.deletedAt,
                  activeProviderThreadId: p.thread.activeProviderThreadId,
                  providerInstanceId: p.thread.providerInstanceId,
                },
                native,
                liveSession: Option.isSome(session)
                  ? {
                      driver: session.value.driver,
                      instanceId: session.value.instanceId,
                      session: session.value.providerSession,
                    }
                  : null,
                sessions: p.providerSessions,
                runs: p.runs.map((run) => ({
                  id: run.id,
                  status: run.status,
                  checkpointId: run.checkpointId,
                })),
                checkpoints: p.checkpoints.map((checkpoint) => ({
                  id: checkpoint.id,
                  status: checkpoint.status,
                })),
                messages: p.messages.map((message) => ({
                  role: message.role,
                  streaming: message.streaming,
                })),
              });
            }).pipe(Effect.orDie);
        const projectId = ProjectId.make("pi-real-initiated-project");
        const now = DateTime.formatIso(yield* DateTime.now);
        yield* projects.apply({
          sequence: 1,
          eventId: EventId.make("pi-real-project:1"),
          aggregateKind: "project",
          aggregateId: projectId,
          occurredAt: now,
          commandId: null,
          causationEventId: null,
          correlationId: null,
          metadata: {},
          type: "project.created",
          payload: {
            projectId,
            title: "Native Pi",
            workspaceRoot: cwd,
            defaultModelSelection: h.modelSelection,
            scripts: [],
            createdAt: now,
            updatedAt: now,
          },
        });
        const waitFor = (predicate: (p: OrchestrationV2ThreadProjection) => boolean) =>
          Effect.scoped(
            Effect.gen(function* () {
              const cursor = yield* orchestrator.getThreadEventSequence(h.threadId);
              const pull = yield* Stream.toPull(
                orchestrator.streamStoredEventsFrom({
                  threadId: h.threadId,
                  afterSequence: cursor,
                }),
              );
              const p = yield* orchestrator.getThreadProjection(h.threadId);
              const found = yield* Stream.concat(
                Stream.succeed(p),
                Stream.fromPull(Effect.succeed(pull)).pipe(
                  Stream.mapEffect(() => orchestrator.getThreadProjection(h.threadId)),
                ),
              ).pipe(
                Stream.filter(predicate),
                Stream.runHead,
                Effect.timeout("20 seconds"),
                Effect.tapCause(() =>
                  scenario === "barrier"
                    ? orchestrator.getThreadProjection(h.threadId).pipe(
                        Effect.flatMap((projection) =>
                          Effect.logInfo("pi-native-post-barrier", {
                            runs: projection.runs.map((run) => ({
                              id: run.id,
                              status: run.status,
                              checkpointId: run.checkpointId,
                            })),
                            checkpoints: projection.checkpoints.map((checkpoint) => ({
                              id: checkpoint.id,
                              status: checkpoint.status,
                            })),
                            providerTurns: projection.providerTurns.map((turn) => ({
                              ordinal: turn.ordinal,
                              status: turn.status,
                              nativeAcceptance: turn.nativeAcceptance,
                            })),
                            offers: offers.length,
                            wirePrompts: wire.filter((record) => record.type === "prompt").length,
                          }),
                        ),
                        Effect.orDie,
                      )
                    : Effect.void,
                ),
              );
              if (Option.isNone(found))
                return yield* Effect.die(
                  `Native Pi receipt missing; offers=${offers.length}; models=${requests.length}; wire=${wire.map((r) => r.type)}`,
                );
              return found.value;
            }),
          );
        let projectSequence = 1;
        const relocate = (workspaceRoot: string) =>
          projects.apply({
            sequence: ++projectSequence,
            eventId: EventId.make(`pi-native-project:${projectSequence}`),
            aggregateKind: "project",
            aggregateId: projectId,
            occurredAt: now,
            commandId: null,
            causationEventId: null,
            correlationId: null,
            metadata: {},
            type: "project.meta-updated",
            payload: { projectId, workspaceRoot, updatedAt: now },
          });
        yield* orchestrator.dispatch({
          type: "thread.create",
          commandId: CommandId.make("pi-real-create"),
          threadId: h.threadId,
          projectId,
          title: "Native extension",
          modelSelection: selection,
          runtimeMode: restricted ? "approval-required" : "full-access",
          interactionMode: restricted ? "plan" : "default",
          branch: null,
          worktreePath: null,
          createdBy: "user",
          creationSource: "web",
        });
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make("pi-real-arm"),
          messageId: MessageId.make("pi-real-arm"),
          threadId: h.threadId,
          text: "/synthetic-arm",
          dispatchMode: { type: "start_immediately" },
          attachments: [],
          createdBy: "user",
          creationSource: "web",
        });
        const foreground =
          scenario === "barrier"
            ? (yield* Deferred.await(captureEntered).pipe(Effect.timeout("10 seconds")),
              yield* orchestrator.getThreadProjection(h.threadId))
            : yield* waitFor((p) => p.runs[0]?.status === "completed");
        assert.lengthOf(requests, 0);
        yield* fs.writeFileString(`${cwd}/wake`, "start");
        if (scenario === "barrier") {
          const first = yield* Queue.take(offerEvents).pipe(Effect.timeout("10 seconds"));
          const repeated = yield* Queue.take(offerEvents).pipe(Effect.timeout("10 seconds"));
          assert.equal(first.initiated?.workId, repeated.initiated?.workId);
          const waiting = yield* orchestrator.getThreadProjection(h.threadId);
          assert.lengthOf(waiting.runs, 1);
          assert.equal(waiting.runs[0]?.status, "waiting");
          assert.lengthOf(
            wire.filter((r) => r.type === "prompt"),
            1,
          );
          yield* Deferred.succeed(releaseCapture, undefined);
        }
        if (restricted) {
          const packet = yield* Deferred.await(offered).pipe(Effect.timeout("15 seconds"));
          assert.deepEqual(packet.initiated?.modelSelection, selection);
          assert.equal(packet.initiated?.runtimePolicy.cwd, cwd);
          yield* orchestrator.dispatch({
            type: "thread.model-selection.set",
            commandId: CommandId.make("future:model"),
            threadId: h.threadId,
            modelSelection: {
              ...h.modelSelection,
              model: "scient-test/future",
              options: [{ id: "thinkingLevel", value: "low" }],
            },
          });
          yield* relocate(workspaceB);
          if (scenario === "captured") assert.deepEqual(yield* snapshotB, untouchedB);
          yield* Deferred.succeed(releaseOffer, undefined);
          const waiting = yield* waitFor(
            (p) => p.runs.length === 2 && p.runtimeRequests.some((r) => r.status === "pending"),
          );
          const nativeRun = waiting.runs[1]!;
          assert.equal(
            waiting.checkpointScopes.find(
              (s) =>
                s.id ===
                waiting.nodes.find((n) => n.id === nativeRun.rootNodeId)?.checkpointScopeId,
            )?.cwd,
            cwd,
          );
          const nativeSessionId = waiting.providerThreads.find(
            (t) => t.id === nativeRun.providerThreadId,
          )!.providerSessionId!;
          assert.equal(opens, 1);
          assert.equal(loads, 1);
          assert.lengthOf(
            wire.filter((r) => r.type === "prompt"),
            1,
          );
          assert.equal(nativeRun.runtimeMode, "approval-required");
          assert.equal(nativeRun.interactionMode, "plan");
          assert.deepEqual(nativeRun.modelSelection, selection);
          yield* orchestrator.dispatch({
            type: "thread.runtime-mode.set",
            commandId: CommandId.make("future:runtime"),
            threadId: h.threadId,
            runtimeMode: "full-access",
          });
          yield* orchestrator.dispatch({
            type: "thread.interaction-mode.set",
            commandId: CommandId.make("future:interaction"),
            threadId: h.threadId,
            interactionMode: "default",
          });
          yield* relocate(cwd);
          yield* relocate(workspaceB);
          const manager = yield* ProviderSessionManagerV2;
          assert.deepEqual(
            yield* manager.resolveMcpInvocationPolicy({
              threadId: h.threadId,
              providerInstanceId: h.instanceId,
              providerSessionId: `mcp:${h.threadId}`,
            }),
            Option.some({ runtimeMode: "approval-required", interactionMode: "plan" }),
          );
          assert.equal(yield* fs.readFileString(`${cwd}/native-answer.txt`), "Initial A\n");
          assert.lengthOf(requests, 1);
          if (scenario === "stop" || scenario === "close") {
            const file = waiting.providerThreads.find((t) => t.id === nativeRun.providerThreadId)
              ?.nativeThreadRef?.nativeId;
            assert.isDefined(file);
            yield* fs.symlink(file!, `${h.profile}/lease-alias.jsonl`);
            const competing = yield* manager
              .open({
                threadId: ThreadId.make("pi-native-competitor"),
                providerSessionId: ProviderSessionId.make("pi-native-competitor"),
                modelSelection: selection,
                runtimePolicy: {
                  runtimeMode: "full-access",
                  interactionMode: "default",
                  cwd,
                },
                initialNativeThreadId: `${h.profile}/lease-alias.jsonl`,
              })
              .pipe(Effect.exit);
            assert.isTrue(Exit.isFailure(competing));
            if (Exit.isFailure(competing))
              assert.include(Cause.pretty(competing.cause), "already has a live writer");
            assert.equal(opens, 1);
          }
          const approval = waiting.runtimeRequests.find((r) => r.status === "pending")!;
          if (scenario === "stop" || scenario === "close") {
            yield* orchestrator.dispatch({
              type: "run.interrupt",
              commandId: CommandId.make("native:stop"),
              threadId: h.threadId,
              runId: nativeRun.id,
              holdQueue: true,
            });
            const stopped = yield* waitFor((p) => p.runs[1]?.status === "interrupted");
            assert.equal(stopped.providerTurns[1]?.status, "interrupted");
            assert.equal(stopped.providerTurns[1]?.nativeAcceptance, "accepted");
            assert.lengthOf(requests, 1);
            assert.equal(yield* fs.readFileString(`${cwd}/native-answer.txt`), "Initial A\n");
            yield* manager.close(nativeSessionId);
            const closed = yield* waitFor(
              (p) => p.providerSessions.find((r) => r.id === nativeSessionId)?.status === "stopped",
            );
            assert.equal(closed.runs[1]?.status, "interrupted");
            yield* relocate(cwd);
            const file = waiting.providerThreads.find((t) => t.id === nativeRun.providerThreadId)
              ?.nativeThreadRef?.nativeId;
            if (file == null) return yield* Effect.die("Missing actual native lease file");
            const otherId = ThreadId.make("pi-native-competitor");
            yield* orchestrator.dispatch({
              type: "thread.create",
              commandId: CommandId.make("competitor:create"),
              threadId: otherId,
              projectId,
              title: "Synthetic lease successor",
              modelSelection: h.modelSelection,
              runtimeMode: "full-access",
              interactionMode: "default",
              branch: null,
              worktreePath: cwd,
              createdBy: "user",
              creationSource: "web",
            });
            const successor = yield* manager.open({
              threadId: otherId,
              providerSessionId: ProviderSessionId.make("pi-native-competitor"),
              modelSelection: h.modelSelection,
              runtimePolicy: { runtimeMode: "full-access", interactionMode: "default", cwd },
              initialNativeThreadId: file,
            });
            const successorThread = yield* successor.ensureThread({
              threadId: otherId,
              modelSelection: h.modelSelection,
              runtimePolicy: { runtimeMode: "full-access", interactionMode: "default", cwd },
            });
            assert.equal(successorThread.nativeThreadRef?.nativeId, file);
            assert.equal(opens, 2);
            yield* manager.close(successor.providerSession.id);
            yield* orchestrator.dispatch({
              type: "message.dispatch",
              commandId: CommandId.make("native:retry"),
              messageId: MessageId.make("native:retry"),
              threadId: h.threadId,
              text: "Fresh owned retry.",
              attachments: [],
              dispatchMode: { type: "start_immediately" },
              createdBy: "user",
              creationSource: "web",
            });
            const recovered = yield* waitFor(
              (p) => p.runs.length === 3 && p.runs[2]?.status === "completed",
            );
            assert.equal(recovered.runs[1]?.status, "interrupted");
            assert.equal(opens, 3);
            assert.lengthOf(
              wire.filter((r) => r.type === "prompt"),
              2,
            );
            assert.lengthOf(offers, 1);
            return;
          }
          yield* orchestrator.dispatch({
            type: "message.dispatch",
            commandId: CommandId.make("native:queued"),
            messageId: MessageId.make("native:queued"),
            threadId: h.threadId,
            text: "Queued after captured answer.",
            attachments: [],
            dispatchMode: { type: "queue_after_active" },
            createdBy: "user",
            creationSource: "web",
          });
          assert.deepEqual(yield* snapshotB, untouchedB);
          const store = yield* CheckpointStore;
          beforePrompt = () =>
            Effect.gen(function* () {
              const p = yield* orchestrator.getThreadProjection(h.threadId).pipe(Effect.orDie);
              const predecessor = p.runs.find((r) => r.id === nativeRun.id)!;
              const answer = p.messages.find(
                (m) => m.runId === nativeRun.id && m.role === "assistant",
              );
              assert.equal(predecessor.status, "completed");
              assert.equal(answer?.text, "Actual extension answer: שלום π.");
              assert.isFalse(answer?.streaming);
              const checkpoint = p.checkpoints.find((c) => c.id === predecessor.checkpointId)!;
              assert.equal(checkpoint.status, "ready");
              assert.equal(captureCwd, cwd);
              const parent = p.checkpoints.find((c) => c.id === checkpoint.parentCheckpointId)!;
              assert.equal(parent.status, "ready");
              assert.equal(parent.scopeId, checkpoint.scopeId);
              assert.include(
                yield* store
                  .diffCheckpoints({
                    cwd,
                    fromCheckpointRef: parent.ref,
                    toCheckpointRef: checkpoint.ref,
                    fallbackFromToHead: false,
                    ignoreWhitespace: false,
                    format: "patch",
                  })
                  .pipe(Effect.orDie),
                "+Captured native work in A",
              );
              const refInA = yield* store
                .hasCheckpointRef({ cwd, checkpointRef: checkpoint.ref })
                .pipe(Effect.orDie);
              const refInB = yield* store
                .hasCheckpointRef({ cwd: workspaceB, checkpointRef: checkpoint.ref })
                .pipe(Effect.orDie);
              assert.equal(
                p.checkpointScopes.find((s) => s.id === checkpoint.scopeId)?.cwd,
                cwd,
                json({
                  captureInA: captureCwd === cwd,
                  captureInB: captureCwd === workspaceB,
                  refInA,
                  refInB,
                }),
              );
              assert.isTrue(
                yield* store
                  .hasCheckpointRef({ cwd, checkpointRef: checkpoint.ref })
                  .pipe(Effect.orDie),
              );
              assert.isFalse(
                yield* store
                  .hasCheckpointRef({ cwd: workspaceB, checkpointRef: checkpoint.ref })
                  .pipe(Effect.orDie),
              );
              assert.equal(
                yield* git(cwd, ["show", `${checkpoint.ref}:native-answer.txt`]).pipe(Effect.orDie),
                "Captured native work in A\n",
              );
              assert.equal(
                yield* fs.readFileString(`${cwd}/native-cwd.txt`).pipe(Effect.orDie),
                `${yield* fs.realPath(cwd).pipe(Effect.orDie)}\n`,
              );
              queuedWireChecks++;
            }).pipe(Effect.tapCause((c) => Deferred.succeed(wireFailure, c).pipe(Effect.asVoid)));
          yield* orchestrator.dispatch({
            type: "runtime-request.respond",
            commandId: CommandId.make("native:approve"),
            threadId: h.threadId,
            requestId: approval.id,
            decision: "accept",
          });
          yield* Deferred.await(captureEntered).pipe(Effect.timeout("15 seconds"));
          const parked = yield* orchestrator.getThreadProjection(h.threadId);
          assert.equal(parked.runs[1]?.status, "waiting");
          assert.equal(parked.runs[2]?.status, "queued");
          assert.lengthOf(
            wire.filter((r) => r.type === "prompt"),
            1,
          );
          assert.equal(queuedWireChecks, 0);
          assert.deepEqual(yield* snapshotB, untouchedB);
          yield* Deferred.succeed(releaseCapture, undefined);
        }
        const completed = yield* waitFor((p) =>
          restricted
            ? p.runs.length === 3 && p.runs[2]?.status === "completed"
            : p.runs.length === 2 && p.runs[1]?.status === "completed",
        ).pipe(
          Effect.raceFirst(Deferred.await(wireFailure).pipe(Effect.flatMap(Effect.failCause))),
        );
        if (restricted) {
          assert.equal(completed.runs[2]?.status, "completed");
          assert.equal(queuedWireChecks, 1);
          assert.deepEqual(
            requests.map((request) => request.model),
            ["synthetic", "synthetic", "future"],
          );
          assert.equal(yield* fs.readFileString(`${workspaceB}/native-answer.txt`), "Initial B\n");
        }
        const nativeRun = completed.runs[1]!;
        if (scenario === "barrier") {
          assert.isAtLeast(offers.length, 2);
          assert.equal(new Set(offers.map((o) => o.initiated?.workId)).size, 1);
        } else assert.lengthOf(offers, 1);
        assert.lengthOf(requests, restricted ? 3 : 1);
        assert.equal(opens, restricted ? 2 : 1);
        assert.equal(loads, restricted ? 2 : 1);
        assert.lengthOf(
          wire.filter((r) => r.type === "prompt"),
          restricted ? 2 : 1,
        );
        assert.lengthOf(
          wire.filter((r) => r.type === "switch_session" || r.type === "new_session"),
          0,
        );
        assert.equal(nativeRun.providerInstanceId, h.instanceId);
        assert.equal(nativeRun.runtimeMode, restricted ? "approval-required" : "full-access");
        assert.equal(nativeRun.interactionMode, restricted ? "plan" : "default");
        assert.equal(offers[0]?.initiated?.runtimePolicy.cwd, cwd);
        assert.equal(offers[0]?.initiated?.modelSelection.model, "scient-test/synthetic");
        assert.equal(completed.providerTurns.length, restricted ? 3 : 2);
        assert.isDefined(completed.providerTurns[1]?.acceptedAt);
        assert.equal(completed.providerTurns[1]?.nativeAcceptance, "accepted");
        assert.lengthOf(
          completed.messages.filter((m) => m.createdBy === "user"),
          restricted ? 2 : 1,
        );
        assert.equal(
          completed.messages.find((m) => m.runId === nativeRun.id && m.role === "assistant")?.text,
          "Actual extension answer: שלום π.",
        );
        assert.isTrue(
          completed.messages.some(
            (m) => m.runId === nativeRun.id && m.notification?.source.kind === "provider_work",
          ),
        );
        assert.equal(
          completed.providerThreads[0]?.nativeThreadRef?.nativeId,
          foreground.providerThreads[0]?.nativeThreadRef?.nativeId,
        );
      }).pipe(Effect.provide(runtime.pipe(Layer.provideMerge(policyLayer))));
    }),
  ).pipe(Effect.provide(NodeServices.layer));
};
