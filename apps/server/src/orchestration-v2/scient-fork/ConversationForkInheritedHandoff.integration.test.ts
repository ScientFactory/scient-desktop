import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { layerMemory as SqlitePersistenceMemory } from "../../persistence/Sqlite.ts";
import { AcpProviderCapabilitiesV2 } from "@t3tools/provider-acp/server/adapter";
import { makeNativeSessionAdapterV2 } from "../Adapters/NativeSessionAdapterV2.ts";
import { EventSinkV2 } from "../EventSink.ts";
import { IdAllocatorV2, layer as allocatorLayer } from "@t3tools/provider-core/server/IdAllocator";
import { OrchestratorV2 } from "../Orchestrator.ts";
import * as ProjectionMaintenance from "../ProjectionMaintenance.ts";
import { layerFromAdapters as makeLayer } from "../ProviderAdapterRegistry.ts";
import { layerWithRegistry as makeOrchestratorV2ReplayLayerWithRegistry } from "../testkit/ProviderReplayHarness.ts";
import { checkpointWorkspace } from "@t3tools/provider-testing/replayWorkspace";
import { ConversationForkService } from "./ConversationForkService.ts";

it.live.each(
  (["stamped", "legacy-unannotated"] as const).map((mode) => ({
    caseTitle: `preserves ${mode} fork initialization through repeated SQL-frozen forks and source deletion`,
    mode,
  })),
)("$caseTitle", ({ mode }) =>
  Effect.scoped(
    Effect.gen(function* () {
      const name = `inherited-fork-handoff-${mode}`;
      const cwd = yield* checkpointWorkspace(name);
      const allocator = yield* IdAllocatorV2;
      const first = ProviderInstanceId.make("omp");
      const second = ProviderInstanceId.make("omp-secondary");
      const model = (instanceId: ProviderInstanceId) => ({
        instanceId,
        model: "handoff-model",
      });
      const offers: Array<{ instanceId: ProviderInstanceId; text: string }> = [];
      const adapter = (instanceId: ProviderInstanceId) =>
        makeNativeSessionAdapterV2({
          instanceId,
          driver: ProviderDriverKind.make("omp"),
          capabilities: AcpProviderCapabilitiesV2,
          idAllocator: allocator,
          defaultCwd: cwd,
          continuations: {
            offer: () => Effect.die("No background continuation in fork fixture"),
          },
          open: (input, publish) =>
            Effect.succeed({
              nativeId: `handoff-chain:${input.providerSessionId}`,
              nativeThreadKnown: true,
              resume: () => Effect.void,
              respond: () => Effect.die("No native question in fork fixture"),
              interrupt: publish({ type: "terminal", status: "cancelled" }),
              send: (turn, nativeTurnId) =>
                Effect.gen(function* () {
                  offers.push({ instanceId, text: turn.message.text });
                  yield* publish({ type: "accepted", nativeTurnId });
                  const id = `answer:${nativeTurnId}`;
                  yield* publish({
                    type: "text",
                    id,
                    delta: `ANSWER ${turn.message.messageId}`,
                  });
                  yield* publish({ type: "text-completed", id });
                  yield* publish({
                    type: "terminal",
                    status: "completed",
                    stopReason: "end_turn",
                  });
                }),
            }),
        });
      const runtime = makeOrchestratorV2ReplayLayerWithRegistry(
        { name, runtimePolicyOverride: { cwd } },
        makeLayer([adapter(first), adapter(second)]),
        { configureMcp: false },
      ).pipe(Layer.provideMerge(SqlitePersistenceMemory));
      yield* Effect.gen(function* () {
        const orchestrator = yield* OrchestratorV2;
        const sink = yield* EventSinkV2;
        const forks = yield* ConversationForkService;
        const projectId = ProjectId.make("project:handoff-chain");
        const sourceId = ThreadId.make("thread:handoff-source");
        const childId = ThreadId.make("thread:handoff-child");
        const grandId = ThreadId.make("thread:handoff-grand");
        const greatId = ThreadId.make("thread:handoff-great");
        const now = yield* DateTime.now;
        yield* sink.commitProjectCommand({
          commandId: CommandId.make("handoff-chain:project"),
          projectId,
          commandType: "project.create",
          acceptedAt: now,
          event: {
            eventId: EventId.make("handoff-chain:project-event"),
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
              title: name,
              workspaceRoot: cwd,
              scripts: [],
              defaultModelSelection: model(first),
              createdAt: DateTime.formatIso(now),
              updatedAt: DateTime.formatIso(now),
            },
          },
        });
        yield* orchestrator.dispatch({
          type: "thread.create",
          commandId: CommandId.make("handoff-chain:create"),
          threadId: sourceId,
          projectId,
          title: name,
          modelSelection: model(first),
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          createdBy: "user",
          creationSource: "web",
        });
        const waitFor = Effect.fn(function* (threadId: ThreadId, ordinal: number) {
          const cursor = yield* orchestrator.getThreadEventSequence(threadId);
          const pull = yield* Stream.toPull(
            orchestrator.streamStoredEventsFrom({ threadId, afterSequence: cursor }),
          );
          const initial = yield* orchestrator.getThreadProjection(threadId);
          const result = yield* Stream.concat(
            Stream.succeed(initial),
            Stream.fromPull(Effect.succeed(pull)).pipe(
              Stream.mapEffect(() => orchestrator.getThreadProjection(threadId)),
            ),
          ).pipe(
            Stream.filter((projection) =>
              projection.runs.some((run) => run.ordinal === ordinal && run.status === "completed"),
            ),
            Stream.runHead,
            Effect.timeout("15 seconds"),
          );
          assert.ok(Option.isSome(result), "Native completion must reach actual SQL");
          return result.value;
        });
        const send = Effect.fn(function* (
          threadId: ThreadId,
          text: string,
          instanceId: ProviderInstanceId,
          ordinal: number,
        ) {
          yield* orchestrator.dispatch({
            type: "message.dispatch",
            commandId: CommandId.make(`handoff-chain:send:${text}`),
            threadId,
            messageId: MessageId.make(text),
            text,
            attachments: [],
            modelSelection: model(instanceId),
            dispatchMode: { type: "start_immediately" },
            createdBy: "user",
            creationSource: "web",
          });
          return yield* waitFor(threadId, ordinal);
        });
        const fork = Effect.fn(function* (
          source: OrchestrationV2ThreadProjection,
          target: ThreadId,
        ) {
          const answer = source.visibleTurnItems.findLast(
            (row) => row.item.type === "assistant_message",
          );
          assert.ok(answer?.item.type === "assistant_message");
          yield* forks.dispatch({
            type: "thread.fork",
            commandId: CommandId.make(`handoff-chain:fork:${target}`),
            originThreadId: source.thread.id,
            newThreadId: target,
            sourceAssistantMessageId: answer.item.messageId,
            workspaceMode: "local",
          });
          return yield* orchestrator.getThreadProjection(target);
        });
        const source = yield* send(sourceId, "SOURCE", first, 1);
        yield* fork(source, childId);
        const initialized = yield* send(childId, "CHILD", first, 1);
        const initialization = initialized.turnItems.find((item) => item.type === "handoff");
        assert.ok(initialization?.type === "handoff");
        const transfer = initialized.contextTransfers.find((transfer) => transfer.type === "fork");
        assert.ok(transfer);
        assert.deepEqual(initialization.forkInitialization, {
          transferId: transfer.id,
          contextHandoffId: initialization.contextHandoffId,
          threadId: childId,
          runId: initialized.runs[0]!.id,
        });
        if (mode === "legacy-unannotated") {
          // An older local row still has its exact durable transfer at first freeze.
          const { forkInitialization: _proof, ...oldItem } = initialization;
          yield* sink.write({
            events: [
              {
                id: EventId.make("handoff-chain:legacy-row"),
                type: "turn-item.updated",
                threadId: childId,
                occurredAt: yield* DateTime.now,
                payload: oldItem,
              },
            ],
          });
        }
        const child = yield* send(childId, "SWITCH", second, 2);
        const childHandoffs = child.turnItems.filter((item) => item.type === "handoff");
        assert.lengthOf(
          childHandoffs,
          2,
          "Initial fork and later genuine provider switch remain stored",
        );
        const grand = yield* fork(child, grandId);
        const copiedHandoffs = grand.turnItems.filter((item) => item.type === "handoff");
        assert.lengthOf(copiedHandoffs, 2);
        assert.property(
          copiedHandoffs[0],
          "forkInitialization",
          "Frozen history must preserve exact initialization cause",
        );
        assert.deepEqual(copiedHandoffs[0]?.forkInitialization, initialization.forkInitialization);
        assert.notProperty(
          copiedHandoffs[1],
          "forkInitialization",
          "Later genuine provider switch must remain visible",
        );
        assert.deepEqual(
          grand.messages.map((message) => message.text),
          child.messages.map((message) => message.text),
        );
        assert.ok(
          copiedHandoffs.every(
            (item) =>
              item.runId === null &&
              item.nodeId === null &&
              item.providerThreadId === null &&
              item.providerTurnId === null &&
              item.nativeItemRef === null,
          ),
        );
        yield* orchestrator.dispatch({
          type: "thread.delete",
          commandId: CommandId.make("handoff-chain:delete-source"),
          threadId: sourceId,
        });
        yield* orchestrator.dispatch({
          type: "thread.delete",
          commandId: CommandId.make("handoff-chain:delete-child"),
          threadId: childId,
        });
        const great = yield* fork(yield* orchestrator.getThreadProjection(grandId), greatId);
        assert.deepEqual(
          great.messages.map((message) => message.text),
          grand.messages.map((message) => message.text),
        );
        const before = great.turnItems.filter((item) => item.type === "handoff");
        assert.deepEqual(before[0]?.forkInitialization, initialization.forkInitialization);
        assert.deepEqual(before[0]?.inheritedFrom, copiedHandoffs[0]?.inheritedFrom);
        assert.notProperty(before[1], "forkInitialization");
        const rebuilt = yield* Effect.gen(function* () {
          return yield* (yield* ProjectionMaintenance.ProjectionMaintenanceV2).rebuild;
        }).pipe(Effect.provide(ProjectionMaintenance.layer));
        assert.equal(rebuilt.valid, true);
        const reloaded = yield* orchestrator.getThreadProjection(greatId);
        assert.deepEqual(
          reloaded.turnItems.filter((item) => item.type === "handoff"),
          before,
        );
        yield* send(greatId, "GREAT", second, 1);
        const delivered = offers.at(-1)!;
        assert.equal(delivered.instanceId, second);
        for (const text of ["SOURCE", "CHILD", "SWITCH", "GREAT"])
          assert.include(delivered.text, text);
      }).pipe(Effect.provide(runtime));
    }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, allocatorLayer))),
  ),
);
