import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EnvironmentId,
  EventId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import { AcpProviderCapabilitiesV2 } from "@t3tools/provider-acp/server/adapter";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import { checkpointWorkspace } from "@t3tools/provider-testing/replayWorkspace";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

import {
  makeNativeSessionAdapterV2,
  type NativeSessionUpdate,
} from "../../../orchestration-v2/Adapters/NativeSessionAdapterV2.ts";
import { OrchestratorV2 } from "../../../orchestration-v2/Orchestrator.ts";
import { ProjectStoreV2 } from "../../../orchestration-v2/ProjectStore.ts";
import * as Registry from "../../../orchestration-v2/ProviderAdapterRegistry.ts";
import * as Threads from "../../../orchestration-v2/ThreadManagementService.ts";
import { awaitThreadProjection } from "../../../orchestration-v2/testkit/awaitThreadProjection.testkit.ts";
import * as ProviderReplayHarness from "../../../orchestration-v2/testkit/ProviderReplayHarness.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import * as Handlers from "./handlers.ts";
import { ThreadToolkit } from "./tools.ts";

it.live.each(["single", "repeated", "publication"] as const)(
  "reads and answers a pending native ask during its running turn: %s",
  (scenario) =>
    Effect.scoped(
      Effect.gen(function* () {
        const cwd = yield* checkpointWorkspace("pending-native-ask");
        const instanceId = ProviderInstanceId.make("scient-pending-ask");
        const modelSelection = { instanceId, model: "fixture" };
        const threadId = ThreadId.make("pending-ask-thread");
        const projectId = ProjectId.make("pending-ask-project");
        const callbacks =
          yield* Queue.unbounded<(update: NativeSessionUpdate) => Effect.Effect<void>>();
        const answered = yield* Deferred.make<{
          id: string;
          answers: Readonly<Record<string, unknown>> | undefined;
        }>();
        const exposed = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const question = {
          type: "question",
          id: "native-ask",
          method: "ask",
          title: "Dataset",
          message: "Choose datasets",
          options: [],
          questions: [
            {
              id: "dataset",
              header: "Dataset",
              question: "Which dataset?",
              options: [{ label: "Blue", description: "First dataset", value: "Blue" }],
              multiSelect: false,
            },
          ],
        } as const satisfies NativeSessionUpdate;
        const adapter = makeNativeSessionAdapterV2({
          instanceId,
          driver: ProviderDriverKind.make("scient"),
          capabilities: AcpProviderCapabilitiesV2,
          defaultCwd: cwd,
          idAllocator: yield* IdAllocator.IdAllocatorV2,
          mcpSessionInjection: false,
          continuations: { offer: () => Effect.void },
          open: (_input, publish) =>
            Effect.succeed({
              nativeId: "pending-ask-session",
              nativeThreadKnown: true,
              send: () => Queue.offer(callbacks, publish).pipe(Effect.asVoid),
              resume: () => Effect.void,
              interrupt: publish({ type: "terminal", status: "cancelled" }),
              respond: (id, response) =>
                publish({ type: "question-resolved", id }).pipe(
                  Effect.andThen(Deferred.succeed(answered, { id, answers: response.answers })),
                  Effect.asVoid,
                ),
            }),
        });
        const orchestration = ProviderReplayHarness.layerWithRegistry(
          { name: "pending-native-ask", runtimePolicyOverride: { cwd } },
          Registry.layerFromAdapters([adapter]),
          {
            configureMcp: false,
            decorateEventSink: (sink) => ({
              ...sink,
              write: (input) =>
                sink
                  .write(input)
                  .pipe(
                    Effect.tap((stored) =>
                      scenario === "publication" &&
                      stored.some(
                        (row) =>
                          row.event.type === "runtime-request.updated" &&
                          row.event.payload.status === "pending",
                      )
                        ? Deferred.succeed(exposed, undefined).pipe(
                            Effect.andThen(Deferred.await(release)),
                          )
                        : Effect.void,
                    ),
                  ),
            }),
          },
        );
        const services = Threads.layer.pipe(Layer.provideMerge(orchestration));
        yield* Effect.gen(function* () {
          const orchestrator = yield* OrchestratorV2;
          const now = "2026-01-01T00:00:00.000Z";
          yield* (yield* ProjectStoreV2).apply({
            sequence: 1,
            eventId: EventId.make("pending-ask-project-created"),
            type: "project.created",
            aggregateKind: "project",
            aggregateId: projectId,
            occurredAt: now,
            commandId: null,
            causationEventId: null,
            correlationId: null,
            metadata: {},
            payload: {
              projectId,
              title: "Pending ask",
              workspaceRoot: cwd,
              scripts: [],
              defaultModelSelection: modelSelection,
              createdAt: now,
              updatedAt: now,
            },
          });
          yield* orchestrator.dispatch({
            type: "thread.create",
            commandId: CommandId.make("pending-ask-create"),
            threadId,
            projectId,
            title: "Pending ask",
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
            commandId: CommandId.make("pending-ask-start"),
            threadId,
            messageId: MessageId.make("pending-ask-prompt"),
            text: "Ask me",
            attachments: [],
            createdBy: "user",
            creationSource: "web",
            dispatchMode: { type: "start_immediately" },
          });
          const publish = yield* Queue.take(callbacks);
          yield* publish(question);
          const first =
            scenario === "publication"
              ? yield* Deferred.await(exposed).pipe(
                  Effect.andThen(orchestrator.getThreadProjection(threadId)),
                )
              : yield* awaitThreadProjection(threadId, (p) =>
                  p.runtimeRequests.some((request) =>
                    p.turnItems.some(
                      (item) => item.type === "user_input_request" && item.requestId === request.id,
                    ),
                  ),
                );
          if (scenario === "repeated") {
            yield* publish(question);
            // A following completed item receipts the preceding question update.
            yield* publish({ type: "text", id: "receipt", delta: "Question repeated.\n\n" });
            yield* publish({ type: "text-completed", id: "receipt" });
            yield* awaitThreadProjection(threadId, (p) =>
              p.turnItems.some(
                (item) => item.type === "assistant_message" && item.text.includes("repeated"),
              ),
            );
          }
          const scope: McpInvocationContext.McpInvocationScope = {
            environmentId: EnvironmentId.make("pending-ask-environment"),
            requestNamespace: "pending-ask-test",
            thread: undefined,
            client: {
              sessionId: "pending-ask-client",
              label: "Pending ask test",
              access: "full-access",
            },
            capabilities: new Set(["orchestration"]),
            issuedAt: 0,
          };
          yield* Effect.gen(function* () {
            const toolkit = yield* ThreadToolkit.pipe(
              Effect.provide(McpToolAccess.HandlersLayer.layer(Handlers.layer)),
            );
            const call = (input: Parameters<typeof toolkit.handle<"scient_pending_request">>[1]) =>
              toolkit.handle("scient_pending_request", input).pipe(
                Stream.unwrap,
                Stream.runCollect,
                Effect.map((responses) => responses.at(-1)!.result),
              );
            const listed = yield* call({ action: "list", threadId });
            assert.isTrue("requestIds" in listed);
            if (!("requestIds" in listed)) return assert.fail("Expected pending request IDs");
            const requestId = listed.requestIds[0]!;
            const read = yield* call({ action: "read", threadId, requestId });
            assert.deepEqual(read, {
              requestId,
              questions: question.questions.map((q) => ({ ...q, allowCustomAnswer: true })),
            });
            assert.deepEqual(
              listed.requestIds,
              first.runtimeRequests.map((r) => r.id),
            );
            yield* Deferred.succeed(release, undefined);
            const running = yield* orchestrator.getThreadProjection(threadId);
            assert.equal(running.runs[0]?.status, "running");
            assert.equal(running.providerTurns[0]?.status, "running");
            const answers = { dataset: ["Blue"] };
            const response = yield* call({ action: "respond", threadId, requestId, answers });
            assert.isTrue("sequence" in response);
            assert.deepEqual(yield* Deferred.await(answered), { id: question.id, answers });
            const resolved = yield* awaitThreadProjection(threadId, (p) =>
              p.runtimeRequests.every((r) => r.status === "resolved"),
            );
            assert.deepEqual(
              resolved.runtimeRequests.map((r) => r.id),
              [requestId],
            );
            if (scenario === "repeated") {
              yield* publish(question);
              yield* publish({ type: "text", id: "settled-receipt", delta: "Still answered." });
              yield* publish({ type: "text-completed", id: "settled-receipt" });
              const settled = yield* awaitThreadProjection(threadId, (p) =>
                p.turnItems.some(
                  (item) => item.type === "assistant_message" && item.text === "Still answered.",
                ),
              );
              assert.deepEqual(
                settled.runtimeRequests.map(({ id, status, answers }) => ({ id, status, answers })),
                [{ id: requestId, status: "resolved", answers }],
              );
              assert.equal(
                settled.turnItems.find((item) => item.type === "user_input_request")?.status,
                "completed",
              );
              assert.deepEqual(yield* call({ action: "list", threadId }), { requestIds: [] });
            }
            yield* publish({ type: "terminal", status: "completed" });
            yield* awaitThreadProjection(threadId, (p) => p.runs[0]?.status === "completed");
          }).pipe(
            Effect.provideService(McpInvocationContext.McpInvocationContext, scope),
            Effect.ensuring(
              Deferred.succeed(release, undefined).pipe(
                Effect.andThen(publish({ type: "terminal", status: "completed" })),
              ),
            ),
          );
        }).pipe(Effect.provide(services));
      }).pipe(
        Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer, IdAllocator.layer)),
      ),
    ),
);
