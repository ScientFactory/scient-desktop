import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import * as CodexReplay from "effect-codex-app-server/replay";
import * as CodexClient from "effect-codex-app-server/client";
import * as Deferred from "effect/Deferred";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as FileSystem from "effect/FileSystem";
import { layerMemory as sqlite } from "../../../persistence/Sqlite.ts";
import { ServerConfig } from "../../../config.ts";
import {
  createDeterministicAttachmentId,
  resolveAttachmentPath,
} from "../../../attachmentStore.ts";
import { CodexOrchestratorReplayHarness } from "../../Adapters/CodexAdapterV2.testkit.ts";
import { EventSinkV2 } from "../../EventSink.ts";
import { OrchestratorV2 } from "../../Orchestrator.ts";
import { OrchestrationEffectWorkerV2 } from "../../EffectWorker.ts";
import { ProjectionStoreV2 } from "../../ProjectionStore.ts";
import { layerWithRegistry } from "../../testkit/ProviderReplayHarness.ts";
import { makeReplayServerConfig } from "../../testkit/ProviderReplayHarness.ts";
import { layer as allocatorLayer } from "@t3tools/provider-core/server/IdAllocator";
import { layerFromDrivers } from "../../ProviderAdapterRegistry.ts";
import * as CodexAdapterV2 from "../../Adapters/CodexAdapterV2.ts";
import { ProviderAdapterOpenSessionError } from "@t3tools/provider-core/server/ProviderAdapter";
import { makeProviderReplayGate } from "@t3tools/provider-testing/replayGate";
import { checkpointWorkspace } from "@t3tools/provider-testing/replayWorkspace";
import { providerMessageTextWithAttachmentPaths } from "@t3tools/provider-core/server/attachmentPrompt";
import { ConversationForkService } from "../ConversationForkService.ts";
import { codexReplayPreamble, makeCodexReplayTurn } from "./codexReplayFixture.ts";
import { runtimeOptions } from "./stressHarness.ts";

const waitFor = Effect.fn("stress.waitFor")(function* (
  threadId: ThreadId,
  predicate: (p: OrchestrationV2ThreadProjection) => boolean,
) {
  const orchestrator = yield* OrchestratorV2;
  const cursor = yield* orchestrator.getThreadEventSequence(threadId);
  const pull = yield* Stream.toPull(
    orchestrator.streamStoredEventsFrom({ threadId, afterSequence: cursor }),
  );
  const found = yield* Stream.concat(
    Stream.fromEffect(orchestrator.getThreadProjection(threadId)),
    Stream.fromPull(Effect.succeed(pull)).pipe(
      Stream.mapEffect(() => orchestrator.getThreadProjection(threadId)),
    ),
  ).pipe(Stream.filter(predicate), Stream.runHead, Effect.timeout("15 seconds"));
  assert.ok(Option.isSome(found));
  return found.value;
});

it.live.each([false, true])(
  "running cuts at 9 successive prefixes stay frozen; source deletion with copied attachment=%s",
  (withAttachment) =>
    Effect.scoped(
      Effect.gen(function* () {
        const cwd = yield* checkpointWorkspace(`stress-running-${withAttachment}`);
        const nativeThreadId = "stress-native";
        const nativeTurnId = "stress-native-turn";
        const threadId = ThreadId.make("stress-running-source");
        const projectId = ProjectId.make("stress-running-project");
        const modelSelection = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" };
        const config = yield* makeReplayServerConfig("stress-running");
        const fs = yield* FileSystem.FileSystem;
        yield* Effect.addFinalizer(() =>
          fs.remove(config.baseDir, { recursive: true }).pipe(Effect.orDie),
        );
        const attachments = withAttachment
          ? [
              {
                id: `${createDeterministicAttachmentId(threadId, "stress-running-file")!}-txt`,
                type: "file" as const,
                name: "notes.txt",
                mimeType: "text/plain",
                sizeBytes: 4,
              },
            ]
          : [];
        const attachmentPath =
          attachments[0] === undefined
            ? undefined
            : resolveAttachmentPath({
                attachmentsDir: config.attachmentsDir,
                attachment: attachments[0],
              })!;
        if (attachmentPath !== undefined) {
          yield* fs.makeDirectory(attachmentPath.slice(0, attachmentPath.lastIndexOf("/")), {
            recursive: true,
          });
          yield* fs.writeFileString(attachmentPath, "keep");
        }
        const sentPrompt = providerMessageTextWithAttachmentPaths({
          text: "Partial answer",
          attachments,
          resolveAttachmentPath: (attachment) =>
            resolveAttachmentPath({ attachmentsDir: config.attachmentsDir, attachment }),
        });
        const chunks = ["a", "bc", "\n\n", "```ts\n", "const x=1;", "\n```", "\n\n", "tail"];
        const gate = makeProviderReplayGate(Array.from({ length: 9 }, (_, n) => `cut-${n}`));
        yield* Effect.addFinalizer(() => Effect.sync(() => gate.releaseAll()));
        const transcript = yield* CodexOrchestratorReplayHarness.decodeTranscript({
          provider: "codex",
          protocol: "codex.app-server",
          version: "0.144.0",
          scenario: "stress-running",
          entries: [
            ...codexReplayPreamble({
              nativeThreadId,
              nativeTurnId,
              prompt: "Partial answer",
              sentPrompt,
              cwd,
            }),
            ...chunks.map((delta, index) => ({
              type: "emit_inbound" as const,
              label: `cut-${index}`,
              frame: {
                method: "item/agentMessage/delta",
                params: {
                  threadId: nativeThreadId,
                  turnId: nativeTurnId,
                  itemId: "stress-answer",
                  delta,
                },
              },
            })),
            {
              type: "emit_inbound",
              label: "cut-8",
              frame: {
                method: "turn/completed",
                params: {
                  threadId: nativeThreadId,
                  turn: makeCodexReplayTurn({ id: nativeTurnId, status: "completed" }),
                },
              },
            },
          ],
        });
        const driver = yield* CodexReplay.makeReplayDriver(transcript, {
          beforeEmitInbound: (entry) =>
            Effect.promise((signal) => gate.beforeEmit(entry.label, signal)),
        });
        const received = yield* Effect.forEach(chunks, () => Deferred.make<void>());
        let receipts = 0;
        const factory = Layer.succeed(CodexAdapterV2.CodexAppServerClientFactory, {
          open: (input) =>
            Effect.gen(function* () {
              const context = yield* Layer.build(CodexReplay.layerReplayWithDriver(driver)).pipe(
                Effect.mapError(
                  (cause) =>
                    new ProviderAdapterOpenSessionError({
                      driver: CodexAdapterV2.CODEX_DRIVER_KIND,
                      providerSessionId: input.providerSessionId,
                      cause,
                    }),
                ),
              );
              const client = yield* Effect.service(CodexClient.CodexAppServerClient).pipe(
                Effect.provide(context),
              );
              return {
                ...client,
                handleServerNotification: (method, handler) =>
                  client.handleServerNotification(method, (payload) =>
                    handler(payload).pipe(
                      Effect.tap(() =>
                        method === "item/agentMessage/delta"
                          ? Deferred.succeed(received[receipts++]!, undefined)
                          : Effect.void,
                      ),
                    ),
                  ),
              } satisfies CodexClient.CodexAppServerClient["Service"];
            }),
        });
        const registry = layerFromDrivers({
          drivers: [CodexAdapterV2.CodexAdapterV2Driver],
          configMap: { [modelSelection.instanceId]: { driver: CodexAdapterV2.CODEX_DRIVER_KIND } },
        }).pipe(
          Layer.provide(
            Layer.mergeAll(
              factory,
              Layer.succeed(ServerConfig, config),
              allocatorLayer,
              NodeServices.layer,
            ),
          ),
        );
        const runtime = layerWithRegistry(
          {
            name: "stress-running",
            runtimePolicyOverride: {
              cwd,
              approvalPolicy: "never",
              sandboxPolicy: { type: "dangerFullAccess" },
            },
          },
          registry,
          {
            ...runtimeOptions,
            layerServerConfig: Layer.succeed(ServerConfig, config),
            configureMcp: false,
            runEffectWorker: false,
            responseStreamingMode: "paragraph",
            databaseLayer: sqlite,
          },
        ).pipe(Layer.provideMerge(sqlite));
        yield* Effect.gen(function* () {
          const orchestrator = yield* OrchestratorV2;
          const sink = yield* EventSinkV2;
          const worker = yield* OrchestrationEffectWorkerV2;
          const store = yield* ProjectionStoreV2;
          const now = yield* DateTime.now;
          yield* sink.commitProjectCommand({
            commandId: CommandId.make("running-project"),
            projectId,
            commandType: "project.create",
            acceptedAt: now,
            event: {
              eventId: EventId.make("running-project"),
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
                title: "Stress",
                workspaceRoot: cwd,
                defaultModelSelection: null,
                scripts: [],
                createdAt: DateTime.formatIso(now),
                updatedAt: DateTime.formatIso(now),
              },
            },
          });
          yield* orchestrator.dispatch({
            type: "thread.create",
            commandId: CommandId.make("running-create"),
            threadId,
            projectId,
            title: "Stress",
            modelSelection,
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: null,
            createdBy: "user",
            creationSource: "web",
          });
          yield* orchestrator.dispatch({
            type: "message.dispatch",
            commandId: CommandId.make("running-send"),
            threadId,
            messageId: MessageId.make("running-user"),
            text: "Partial answer",
            attachments,
            dispatchMode: { type: "start_immediately" },
            createdBy: "user",
            creationSource: "web",
          });
          const starting = yield* worker.drain(12).pipe(Effect.forkScoped);
          assert.isTrue(yield* Effect.promise(() => gate.waitForReached("cut-0")));
          const source = yield* waitFor(
            threadId,
            (p) =>
              p.runs[0]?.status === "running" &&
              p.providerTurns[0]?.nativeAcceptance === "accepted",
          );
          const children = [];
          for (let cut = 0; cut <= chunks.length; cut++) {
            assert.isTrue(yield* Effect.promise(() => gate.waitForReached(`cut-${cut}`)));
            if (cut > 0) yield* Deferred.await(received[cut - 1]!);
            const newThreadId = ThreadId.make(`running-cut-${cut}`);
            yield* (yield* ConversationForkService).dispatch({
              type: "thread.fork",
              commandId: CommandId.make(`running-cut-${cut}`),
              originThreadId: threadId,
              newThreadId,
              sourceRunningTurnId: TurnId.make(source.runs[0]!.id),
              workspaceMode: "local",
            });
            const child = yield* store.getThreadProjection(newThreadId);
            const prefix = chunks.slice(0, cut).join("");
            assert.deepEqual(
              child.messages.filter((m) => m.role === "assistant").map((m) => m.text),
              cut === 0 ? [] : [prefix],
            );
            for (const older of children)
              assert.deepEqual(
                (yield* store.getThreadProjection(older.thread.id)).visibleTurnItems,
                older.visibleTurnItems,
              );
            if (attachments.length > 0) {
              assert.deepEqual(
                child.messages.find((m) => m.role === "user")?.attachments,
                attachments,
              );
              assert.ok(
                child.visibleTurnItems.some(
                  (r) => r.item.type === "user_message" && r.sourceThreadId === child.thread.id,
                ),
                "The active run user item must be a fork-owned copy",
              );
            }
            children.push(child);
            gate.release(`cut-${cut}`);
          }
          yield* Fiber.join(starting);
          yield* waitFor(threadId, (p) => p.providerTurns[0]?.status === "completed");
          yield* worker.drain(12);
          yield* waitFor(threadId, (p) => p.runs[0]?.status === "completed");
          for (const child of children)
            assert.deepEqual(
              (yield* store.getThreadProjection(child.thread.id)).visibleTurnItems,
              child.visibleTurnItems,
            );
          if (attachmentPath !== undefined) {
            yield* orchestrator.dispatch({
              type: "thread.delete",
              commandId: CommandId.make("delete-running-source"),
              threadId,
            });
            yield* worker.drain(12);
            assert.isTrue(
              yield* fs.exists(attachmentPath),
              "A live running-cut fork still shows the copied user message's attachment",
            );
            for (const child of children) {
              yield* orchestrator.dispatch({
                type: "thread.delete",
                commandId: CommandId.make(`delete-${child.thread.id}`),
                threadId: child.thread.id,
              });
              yield* worker.drain(12);
            }
            assert.isFalse(yield* fs.exists(attachmentPath));
          }
        }).pipe(Effect.provide(runtime));
      }).pipe(Effect.provide(NodeServices.layer), Effect.timeout("60 seconds")),
    ),
  90000,
);
