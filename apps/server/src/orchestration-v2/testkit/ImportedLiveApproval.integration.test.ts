import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  RuntimeRequestId,
  ThreadId,
  type OrchestrationV2ThreadProjection,
  type ProviderApprovalDecision,
  type RuntimeMode,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";
import { layerMemory as SqlitePersistenceMemory } from "../../persistence/Sqlite.ts";
import { AcpProviderCapabilitiesV2 } from "@t3tools/provider-acp/server/adapter";
import {
  makeNativeSessionAdapterV2,
  type NativeSession,
  type NativeSessionUpdate,
} from "../Adapters/NativeSessionAdapterV2.ts";
import { CommandReceiptStoreV2 } from "../CommandReceiptStore.ts";
import {
  IdAllocatorV2,
  layer as idAllocatorLayer,
} from "@t3tools/provider-core/server/IdAllocator";
import { OrchestratorV2 } from "../Orchestrator.ts";
import { ProjectStoreV2 } from "../ProjectStore.ts";
import { ProviderSessionManagerV2 } from "../ProviderSessionManager.ts";
import { layerFromAdapters as makeLayer } from "../ProviderAdapterRegistry.ts";
import { LegacyV1ThreadImporter } from "../legacy/LegacyV1ThreadImporter.ts";
import { layerWithRegistry as makeOrchestratorV2ReplayLayerWithRegistry } from "./ProviderReplayHarness.ts";
import { checkpointWorkspace } from "@t3tools/provider-testing/replayWorkspace";

const instanceId = ProviderInstanceId.make("acp");
const modelSelection = { instanceId, model: "approval-fixture" };
const waitFor = Effect.fnUntraced(function* (
  threadId: ThreadId,
  predicate: (projection: OrchestrationV2ThreadProjection) => boolean,
) {
  const orchestrator = yield* OrchestratorV2;
  const cursor = yield* orchestrator.getThreadEventSequence(threadId);
  const pull = yield* Stream.toPull(
    orchestrator.streamStoredEventsFrom({ threadId, afterSequence: cursor }),
  );
  const initial = yield* orchestrator.getThreadProjection(threadId);
  const found = yield* Stream.concat(
    Stream.succeed(initial),
    Stream.fromPull(Effect.succeed(pull)).pipe(
      Stream.mapEffect(() => orchestrator.getThreadProjection(threadId)),
    ),
  ).pipe(Stream.filter(predicate), Stream.runHead, Effect.timeout("15 seconds"));
  if (Option.isNone(found)) return yield* Effect.die("Imported live approval did not converge");
  return found.value;
});

it.live.each(
  (["accept", "decline"] as const).map((decision) => ({
    caseTitle: `imported inert approvals stay inert while restarted Full access executes live ${decision} once`,
    decision,
  })),
)("$caseTitle", ({ decision }) =>
  Effect.scoped(
    Effect.gen(function* () {
      const name = `imported-live-approval-${decision}`;
      const cwd = yield* checkpointWorkspace(name);
      const firstClosed = yield* Deferred.make<void>();
      const opened: Array<{ readonly mode: RuntimeMode; readonly sessionId: string }> = [];
      const responses: Array<{
        readonly id: string;
        readonly decision: ProviderApprovalDecision | undefined;
      }> = [];
      const executed: number[] = [];
      const offers: Array<{ readonly ordinal: number; readonly mode: RuntimeMode }> = [];
      const adapter = makeNativeSessionAdapterV2({
        instanceId,
        driver: ProviderDriverKind.make("acp"),
        capabilities: AcpProviderCapabilitiesV2,
        defaultCwd: cwd,
        idAllocator: yield* IdAllocatorV2,
        mcpSessionInjection: false,
        continuations: {
          offer: () => Effect.die("No background continuation in approval fixture"),
        },
        open: (opening, publish) =>
          Effect.gen(function* () {
            opened.push({
              mode: opening.runtimePolicy.runtimeMode,
              sessionId: opening.providerSessionId,
            });
            const ordinal = opened.length;
            if (ordinal === 1)
              yield* Effect.addFinalizer(() =>
                Deferred.succeed(firstClosed, undefined).pipe(Effect.asVoid),
              );
            const finish = (runOrdinal: number, accepted: boolean) =>
              Effect.gen(function* () {
                if (accepted) {
                  executed.push(runOrdinal);
                  yield* publish({
                    type: "text",
                    id: `answer:${runOrdinal}`,
                    delta: `Executed ${runOrdinal}`,
                  });
                  yield* publish({ type: "text-completed", id: `answer:${runOrdinal}` });
                }
                yield* publish({
                  type: "terminal",
                  status: accepted ? "completed" : "cancelled",
                });
              });
            const native: NativeSession = {
              nativeId: `approval-session:${opening.providerSessionId}:${ordinal}`,
              nativeThreadKnown: true,
              resume: () => Effect.void,
              ensureFresh: () => Effect.void,
              interrupt: publish({
                type: "terminal",
                status: "cancelled",
              } satisfies NativeSessionUpdate),
              send: (input) =>
                Effect.gen(function* () {
                  offers.push({
                    ordinal: input.runOrdinal,
                    mode: input.runtimePolicy.runtimeMode,
                  });
                  if (input.message.text.endsWith("full-access-normal")) {
                    yield* finish(input.runOrdinal, true);
                    return;
                  }
                  yield* publish({
                    type: "question",
                    id: `approval:${input.runOrdinal}`,
                    method: "confirm",
                    title:
                      input.runtimePolicy.runtimeMode === "full-access"
                        ? "Provider-required authorization"
                        : "Supervised authorization",
                    message: "Allow the controlled operation?",
                    options: [],
                  });
                }),
              respond: (id, response) =>
                Effect.gen(function* () {
                  responses.push({ id, decision: response.decision });
                  const runOrdinal = Number(id.slice("approval:".length));
                  yield* publish({ type: "question-resolved", id });
                  yield* finish(runOrdinal, response.decision === "accept");
                }),
            };
            return native;
          }),
      });
      yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const orchestrator = yield* OrchestratorV2;
        const importer = yield* LegacyV1ThreadImporter;
        const projectId = ProjectId.make(`project:${name}`);
        const threadId = ThreadId.make(`thread:${name}`);
        const historicalId = RuntimeRequestId.make(`historical:${name}`);
        const now = "2026-01-01T00:00:00.000Z";
        yield* (yield* ProjectStoreV2).apply({
          sequence: 1,
          eventId: EventId.make(`${name}:project`),
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
            title: name,
            workspaceRoot: cwd,
            scripts: [],
            defaultModelSelection: modelSelection,
            createdAt: now,
            updatedAt: now,
          },
        });
        yield* sql`INSERT INTO projection_threads
          (thread_id, project_id, title, model_selection_json, runtime_mode, interaction_mode, created_at, updated_at)
          VALUES (${threadId}, ${projectId}, 'Imported Supervised conversation',
            '{"instanceId":"acp","model":"approval-fixture"}', 'approval-required', 'default', ${now}, ${now})`;
        yield* sql`INSERT INTO projection_thread_messages
          (message_id, thread_id, role, text, is_streaming, created_at, updated_at)
          VALUES (${`history-message:${name}`}, ${threadId}, 'assistant', 'Historical answer', 0, ${now}, ${now})`;
        yield* sql`INSERT INTO projection_pending_approvals
          (request_id, thread_id, status, decision, created_at, resolved_at)
          VALUES (${historicalId}, ${threadId}, 'pending', NULL, ${now}, NULL)`;
        yield* importer.reconcileShells;
        yield* importer.ensureTranscript(threadId);
        const imported = yield* orchestrator.getThreadProjection(threadId);
        assert.equal(imported.thread.runtimeMode, "approval-required");
        assert.equal(imported.runtimeRequests.length, 0);
        assert.equal(imported.providerSessions.length, 0);
        const inert = imported.turnItems.find(
          (item) => item.type === "dynamic_tool" && item.toolName === "historical_approval",
        );
        assert.ok(inert);
        assert.equal(inert.status, "interrupted");
        assert.isNull(inert.runId);
        assert.isNull(inert.nodeId);
        assert.isNull(inert.nativeItemRef);
        assert.equal(opened.length, 0);
        assert.equal(responses.length, 0);
        assert.equal(
          (yield* Effect.result(
            orchestrator.dispatch({
              type: "runtime-request.respond",
              threadId,
              requestId: historicalId,
              decision: "accept",
              commandId: CommandId.make(`${name}:historical-response`),
            }),
          ))._tag,
          "Failure",
        );
        const send = (text: string) =>
          orchestrator.dispatch({
            type: "message.dispatch",
            threadId,
            commandId: CommandId.make(`${name}:send:${text}`),
            messageId: MessageId.make(`${name}:message:${text}`),
            text,
            attachments: [],
            dispatchMode: { type: "start_immediately" },
            createdBy: "user",
            creationSource: "web",
          });
        yield* send("supervised");
        const supervised = yield* waitFor(threadId, (projection) =>
          projection.runtimeRequests.some(
            (request) =>
              request.status === "pending" &&
              projection.nodes.some(
                (node) => node.id === request.nodeId && node.runId === projection.runs.at(-1)?.id,
              ) &&
              projection.turnItems.some(
                (item) => item.type === "approval_request" && item.requestId === request.id,
              ),
          ),
        );
        const first = supervised.runtimeRequests.find((request) => request.status === "pending");
        assert.ok(first);
        assert.equal(opened[0]?.mode, "approval-required");
        const firstResponse = {
          type: "runtime-request.respond" as const,
          threadId,
          requestId: first.id,
          decision: "accept" as const,
          commandId: CommandId.make(`${name}:supervised-accept`),
        };
        yield* orchestrator.dispatch(firstResponse);
        yield* orchestrator.dispatch(firstResponse);
        yield* waitFor(threadId, (projection) => projection.runs.at(-1)?.status === "completed");
        assert.deepEqual(
          responses.map((response) => response.decision),
          ["accept"],
        );
        yield* orchestrator.dispatch({
          type: "thread.runtime-mode.set",
          threadId,
          runtimeMode: "full-access",
          commandId: CommandId.make(`${name}:full-access`),
        });
        yield* Deferred.await(firstClosed).pipe(Effect.timeout("15 seconds"));
        const persisted = yield* orchestrator.getThreadProjection(threadId);
        assert.equal(persisted.thread.runtimeMode, "full-access");
        if (first.responseCapability.type !== "live")
          return assert.fail("Expected live response capability");
        assert.isTrue(
          Option.isNone(
            yield* (yield* ProviderSessionManagerV2).get(
              first.responseCapability.providerSessionId,
            ),
          ),
        );
        // Reconciliation is a real refresh/reopen read and must not restore the
        // original imported mode or reactivate its historical approval.
        yield* importer.reconcileShells;
        yield* importer.ensureTranscript(threadId);
        assert.equal(
          (yield* orchestrator.getThreadProjection(threadId)).thread.runtimeMode,
          "full-access",
        );
        yield* send("full-access-normal");
        const unrestricted = yield* waitFor(
          threadId,
          (projection) => projection.runs.at(-1)?.status === "completed",
        );
        assert.equal(
          opened.length,
          2,
          "Mode change must close and actually reopen the native session",
        );
        assert.equal(opened[1]?.mode, "full-access");
        assert.isFalse(
          unrestricted.runtimeRequests.some((request) => request.status === "pending"),
        );
        assert.deepEqual(
          offers.map((offer) => offer.mode),
          ["approval-required", "full-access"],
        );
        yield* send("provider-required");
        const pending = yield* waitFor(threadId, (projection) =>
          projection.runtimeRequests.some(
            (request) =>
              request.status === "pending" &&
              projection.nodes.some(
                (node) => node.id === request.nodeId && node.runId === projection.runs.at(-1)?.id,
              ) &&
              projection.turnItems.some(
                (item) => item.type === "approval_request" && item.requestId === request.id,
              ),
          ),
        );
        const live = pending.runtimeRequests.find((request) => request.status === "pending");
        assert.ok(live);
        assert.notEqual(live.id, first.id);
        assert.notEqual(live.id, historicalId);
        assert.equal(
          pending.nodes.find((node) => node.id === live.nodeId)?.runId,
          pending.runs.at(-1)?.id,
        );
        if (live.responseCapability.type !== "live")
          return assert.fail("Expected provider-owned live approval");
        const liveSessionId = live.responseCapability.providerSessionId;
        assert.ok(pending.providerSessions.some((session) => session.id === liveSessionId));
        assert.equal(pending.runs.at(-1)?.runtimeMode, "full-access");
        const foreign = ThreadId.make(`foreign:${name}`);
        yield* orchestrator.dispatch({
          type: "thread.create",
          threadId: foreign,
          projectId,
          commandId: CommandId.make(`${name}:foreign-create`),
          title: "Foreign owner",
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          createdBy: "user",
          creationSource: "web",
        });
        const deniedCommand = CommandId.make(`${name}:foreign-response`);
        assert.equal(
          (yield* Effect.result(
            orchestrator.dispatch({
              type: "runtime-request.respond",
              threadId: foreign,
              requestId: live.id,
              decision,
              commandId: deniedCommand,
            }),
          ))._tag,
          "Failure",
        );
        assert.equal(responses.length, 1, "Foreign response must never reach the native callback");
        const reply = {
          type: "runtime-request.respond" as const,
          threadId,
          requestId: live.id,
          decision,
          commandId: CommandId.make(`${name}:live-response`),
        };
        const accepted = yield* orchestrator.dispatch(reply);
        const replayed = yield* orchestrator.dispatch(reply);
        assert.equal(replayed.sequence, accepted.sequence);
        const completed = yield* waitFor(
          threadId,
          (projection) =>
            projection.runs.at(-1)?.status ===
              (decision === "accept" ? "completed" : "cancelled") &&
            projection.runtimeRequests.some(
              (request) =>
                request.id === live.id &&
                request.status === "resolved" &&
                request.decision === decision,
            ),
        );
        assert.deepEqual(
          responses.map((response) => response.decision),
          ["accept", decision],
        );
        assert.deepEqual(executed, decision === "accept" ? [1, 2, 3] : [1, 2]);
        const settled = completed.runtimeRequests.find((request) => request.id === live.id);
        assert.ok(settled);
        assert.equal(settled.status, "resolved");
        assert.equal(settled.decision, decision);
        const receipts = yield* CommandReceiptStoreV2;
        const receipt = yield* receipts.getByCommandId(reply.commandId);
        assert.isTrue(Option.isSome(receipt));
        if (Option.isSome(receipt)) assert.equal(receipt.value.status, "accepted");
        const foreignReceipt = yield* receipts.getByCommandId(deniedCommand);
        assert.isTrue(Option.isSome(foreignReceipt));
        if (Option.isSome(foreignReceipt)) assert.equal(foreignReceipt.value.status, "rejected");
        assert.deepEqual(
          completed.turnItems.find((item) => item.id === inert.id),
          inert,
        );
      }).pipe(
        Effect.provide(
          makeOrchestratorV2ReplayLayerWithRegistry(
            { name, runtimePolicyOverride: { cwd } },
            makeLayer([adapter]),
            { configureMcp: false },
          ).pipe(Layer.provideMerge(SqlitePersistenceMemory)),
        ),
      );
    }).pipe(
      Effect.provide(Layer.mergeAll(NodeServices.layer, idAllocatorLayer)),
      Effect.timeout("45 seconds"),
    ),
  ),
);
