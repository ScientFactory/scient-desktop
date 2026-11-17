import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  RunId,
  ThreadId,
  ThreadRoomId,
} from "@t3tools/contracts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { CodexProviderCapabilitiesV2 } from "../Adapters/CodexAdapterV2.ts";
import { CommandReceiptStoreV2 } from "../CommandReceiptStore.ts";
import * as EventSink from "../EventSink.ts";
import * as Orchestrator from "../Orchestrator.ts";
import { ProjectionStoreV2 } from "../ProjectionStore.ts";
import * as ProviderAdapterRegistry from "../ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "../testkit/ProviderReplayHarness.ts";
import { conversationForkOf } from "../testkit/ConversationForkCommand.ts";

const instanceId = ProviderInstanceId.make("codex");
const modelSelection = { instanceId, model: "test-model" };
const adapter: ProviderAdapter.ProviderAdapterV2["Service"] = {
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
  openSession: () => Effect.die("A fork does not start its provider"),
};
const layer = ProviderReplayHarness.layerWithRegistry(
  { name: "conversation-fork-dispatch" },
  ProviderAdapterRegistry.layerFromAdapters([adapter]),
  { runEffectWorker: false },
);

/** A source thread with one completed run, as mobile and MCP fork it. */
const seedSource = Effect.fn("seedSource")(function* (threadId: ThreadId, title: string) {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const sink = yield* EventSink.EventSinkV2;
  const now = yield* DateTime.now;
  const runId = RunId.make(`${threadId}:run`);
  yield* orchestrator.dispatch({
    type: "thread.create",
    commandId: CommandId.make(`${threadId}:create`),
    threadId,
    projectId: ProjectId.make("project:fork-dispatch"),
    title,
    modelSelection,
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    createdBy: "user",
    creationSource: "web",
  });
  yield* sink.write({
    events: [
      {
        id: EventId.make(`${threadId}:run`),
        type: "run.created",
        threadId,
        runId,
        occurredAt: now,
        payload: {
          id: runId,
          threadId,
          ordinal: 1,
          providerInstanceId: instanceId,
          modelSelection,
          providerThreadId: null,
          userMessageId: MessageId.make(`${threadId}:message`),
          rootNodeId: null,
          activeAttemptId: null,
          status: "completed",
          requestedAt: now,
          startedAt: now,
          completedAt: now,
          checkpointId: null,
          contextHandoffId: null,
        },
      },
    ],
  });
  return runId;
});

const forkFromRun = (input: {
  readonly source: ThreadId;
  readonly target: ThreadId;
  readonly runId: RunId;
  readonly title?: string;
  readonly sideChat?: boolean;
}) =>
  Effect.flatMap(Orchestrator.OrchestratorV2, (orchestrator) =>
    orchestrator.dispatch({
      type: "thread.fork",
      commandId: CommandId.make(`${input.target}:fork`),
      sourceThreadId: input.source,
      targetThreadId: input.target,
      sourcePoint: input.sideChat ? { type: "latest_stable" } : { type: "run", runId: input.runId },
      createdBy: "user",
      creationSource: "mobile",
      ...(input.title === undefined ? {} : { title: input.title }),
      ...(input.sideChat ? { sideChat: true } : {}),
    }),
  );

it.effect("a mobile or MCP fork freezes its history and takes a collision-safe title", () =>
  Effect.gen(function* () {
    const store = yield* ProjectionStoreV2;
    const source = ThreadId.make("dispatch:mobile-source");
    const runId = yield* seedSource(source, "Research notes");

    yield* forkFromRun({ source, target: ThreadId.make("dispatch:mobile-a"), runId });
    yield* forkFromRun({ source, target: ThreadId.make("dispatch:mobile-b"), runId });
    yield* forkFromRun({
      source,
      target: ThreadId.make("dispatch:mobile-titled"),
      runId,
      title: "Chosen title",
    });

    const first = yield* store.getThread(ThreadId.make("dispatch:mobile-a"));
    assert.equal(first.title, "Research notes (2)");
    assert.equal(first.historyOrigin, "scient_fork");
    assert.isNull(first.forkedFrom);
    assert.equal(first.forkLineage?.originThreadId, source);
    assert.equal((yield* conversationForkOf(first.id))?.status, "ready");
    assert.equal((yield* conversationForkOf(first.id))?.workspaceMode, "local");
    assert.equal(first.lineage.parentThreadId, source);
    assert.equal(
      (yield* store.getThread(ThreadId.make("dispatch:mobile-b"))).title,
      "Research notes (3)",
    );
    assert.equal(
      (yield* store.getThread(ThreadId.make("dispatch:mobile-titled"))).title,
      "Chosen title",
    );
  }).pipe(Effect.provide(layer)),
);

it.effect("a side chat of a fork keeps T3's live view, without its parent's fork state", () =>
  Effect.gen(function* () {
    const store = yield* ProjectionStoreV2;
    const source = ThreadId.make("dispatch:side-source");
    const fork = ThreadId.make("dispatch:side-fork");
    const sideChat = ThreadId.make("dispatch:side-chat");
    const runId = yield* seedSource(source, "Side source");
    yield* forkFromRun({ source, target: fork, runId });

    yield* forkFromRun({ source: fork, target: sideChat, runId, sideChat: true });

    const side = yield* store.getThread(sideChat);
    assert.isTrue(side.lineage.sideChat);
    assert.equal(side.historyOrigin, "native");
    assert.isNull(side.forkLineage);
    assert.isNull(yield* conversationForkOf(side.id));
  }).pipe(Effect.provide(layer)),
);

it.effect("a fork leaves its source's room and people behind", () =>
  Effect.gen(function* () {
    const store = yield* ProjectionStoreV2;
    const source = ThreadId.make("dispatch:room-source");
    const target = ThreadId.make("dispatch:room-fork");
    const runId = yield* seedSource(source, "Shared discussion");
    const now = yield* DateTime.now;
    yield* store.apply({
      id: EventId.make("dispatch:room-source:room"),
      type: "thread.metadata-updated",
      threadId: source,
      occurredAt: now,
      payload: {
        ...(yield* store.getThread(source)),
        room: {
          id: ThreadRoomId.make("room:dispatch"),
          host: "env.scient.test",
          createdAt: DateTime.formatIso(now),
          participants: [],
        },
      },
    });

    yield* forkFromRun({ source, target, runId });

    assert.isNotNull((yield* store.getThread(source)).room);
    assert.isNull((yield* store.getThread(target)).room);
  }).pipe(Effect.provide(layer)),
);

it.effect("a fork with no stable run is refused without a destination or receipt", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const store = yield* ProjectionStoreV2;
    const receipts = yield* CommandReceiptStoreV2;
    const source = ThreadId.make("dispatch:no-run-source");
    yield* seedSource(source, "No stable run");
    const target = ThreadId.make("dispatch:no-run-fork");

    const refused = yield* orchestrator
      .dispatch({
        type: "thread.fork",
        commandId: CommandId.make("dispatch:no-run-fork"),
        sourceThreadId: source,
        targetThreadId: target,
        sourcePoint: { type: "run", runId: RunId.make("dispatch:missing-run") },
        createdBy: "agent",
        creationSource: "mcp",
      })
      .pipe(Effect.flip);

    assert.equal(refused._tag, "OrchestratorCommandRejectedError");
    assert.isTrue(
      Option.isNone(yield* receipts.getByCommandId(CommandId.make("dispatch:no-run-fork"))),
    );
    assert.equal((yield* Effect.result(store.getThread(target)))._tag, "Failure");
  }).pipe(Effect.provide(layer)),
);
