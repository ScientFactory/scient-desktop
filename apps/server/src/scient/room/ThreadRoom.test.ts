import { assert, it } from "@effect/vitest";
import {
  CommandId,
  MessageId,
  type OrchestrationV2TurnItem,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  RoomMessageId,
  RoomParticipantId,
  ThreadId,
  ThreadRoomId,
  type RoomRole,
} from "@t3tools/contracts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";

import * as SqlitePersistence from "../../persistence/Sqlite.ts";
import { CodexProviderCapabilitiesV2 } from "../../orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as EffectOutbox from "../../orchestration-v2/EffectOutbox.ts";
import * as Orchestrator from "../../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../../orchestration-v2/ProjectionStore.ts";
import * as ProviderAdapterRegistry from "../../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "../../orchestration-v2/testkit/ProviderReplayHarness.ts";
import { roomMessageItemId } from "./threadRoomDecider.ts";

const instanceId = ProviderInstanceId.make("codex");
const adapter = {
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("No provider process needed for rooms"),
} as ProviderAdapter.ProviderAdapterV2["Service"];
const layerDatabase = SqlitePersistence.layerMemory;
const layerTest = Layer.mergeAll(
  layerDatabase,
  ProjectionStore.layer.pipe(Layer.provide(layerDatabase)),
  EffectOutbox.layer.pipe(Layer.provide(layerDatabase)),
  ProviderReplayHarness.layerWithRegistry(
    { name: "thread-room" },
    ProviderAdapterRegistry.layerFromAdapters([adapter]),
    { databaseLayer: layerDatabase, runEffectWorker: false },
  ),
);

const threadId = ThreadId.make("thread:room");
let commandCount = 0;
const nextCommandId = (label: string) => CommandId.make(`${label}:${(commandCount += 1)}`);

const setup = Effect.gen(function* () {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  yield* orchestrator.dispatch({
    type: "thread.create",
    commandId: nextCommandId("create"),
    threadId,
    projectId: ProjectId.make("project:room"),
    title: "Figure 2",
    modelSelection: { instanceId, model: "gpt-5.1-codex" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    createdBy: "user",
    creationSource: "web",
  });
  const expiresAt = DateTime.formatIso(DateTime.add(yield* DateTime.now, { days: 7 }));
  const invite = (id: string, role: RoomRole) =>
    orchestrator.dispatch({
      type: "thread.room.server",
      commandId: nextCommandId("invite"),
      threadId,
      action: {
        type: "invite",
        roomId: ThreadRoomId.make("room:one"),
        host: "env.scient.test",
        participantId: RoomParticipantId.make(id),
        role,
        expiresAt,
      },
    });
  const join = (id: string, name: string) =>
    orchestrator.dispatch({
      type: "thread.room.server",
      commandId: nextCommandId("join"),
      threadId,
      action: { type: "join", participantId: RoomParticipantId.make(id), name },
    });
  const guestPost = (id: string, messageId: string, text: string, extra: object = {}) =>
    orchestrator.dispatch({
      type: "thread.room.server",
      commandId: nextCommandId("guest-post"),
      threadId,
      action: {
        type: "guest-post",
        participantId: RoomParticipantId.make(id),
        roomMessageId: RoomMessageId.make(messageId),
        text,
        attachments: [],
        suggested: false,
        ...extra,
      },
    });
  const ownerPost = (messageId: string, text: string, extra: object = {}) =>
    orchestrator.dispatch({
      type: "thread.room",
      commandId: nextCommandId("owner-post"),
      threadId,
      action: {
        type: "post",
        roomMessageId: RoomMessageId.make(messageId),
        text,
        attachments: [],
        ...extra,
      },
    });
  const ownerSend = (commandLabel: string, messageId: string) =>
    orchestrator.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make(commandLabel),
      threadId,
      messageId: MessageId.make(commandLabel),
      roomItemId: roomMessageItemId(RoomMessageId.make(messageId)),
      text: "",
      attachments: [],
      dispatchMode: { type: "defer_start" },
      createdBy: "user",
      creationSource: "web",
    });
  const roomItem = (messageId: string) =>
    projections
      .getTurnItem({ threadId, itemId: roomMessageItemId(RoomMessageId.make(messageId)) })
      .pipe(
        Effect.map((item) => {
          assert.equal(item?.type, "room_message");
          return item as Extract<OrchestrationV2TurnItem, { readonly type: "room_message" }>;
        }),
      );
  return { orchestrator, projections, invite, join, guestPost, ownerPost, ownerSend, roomItem };
});

const fails = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.map(Effect.exit(effect), (exit) => Exit.isFailure(exit));

it.effect(
  "keeps people's messages in the room until someone sends one, then gives the agent attributed words",
  () =>
    Effect.gen(function* () {
      const room = yield* setup;
      yield* room.invite("dana", "discuss");
      yield* room.invite("alex", "discuss");
      yield* room.join("dana", "Dana");
      // A second person with the same name gets told apart.
      yield* room.join("alex", "dana");
      assert.isTrue(yield* fails(room.join("dana", "Again")));
      const thread = (yield* room.projections.getThreadProjection(threadId)).thread;
      assert.deepEqual(
        thread.room?.participants.map((participant) => participant.name),
        ["Dana", "dana 2"],
      );

      yield* room.guestPost("dana", "m1", "Could we try a log scale?", { suggested: true });
      const reply = roomMessageItemId(RoomMessageId.make("m1"));
      yield* room.ownerPost("m2", "Good idea, after the outliers.", { replyTo: reply });

      const projection = yield* room.projections.getThreadProjection(threadId);
      // People's messages are not conversation messages, so no provider input can include them.
      assert.lengthOf(projection.messages, 0);
      assert.lengthOf(projection.runs, 0);
      const second = yield* room.roomItem("m2");
      assert.deepEqual(second.replyTo, {
        itemId: reply,
        author: { kind: "guest", participantId: RoomParticipantId.make("dana"), name: "Dana" },
        excerpt: "Could we try a log scale?",
      });
      assert.isTrue((yield* room.roomItem("m1")).ordinal < second.ordinal);

      yield* room.ownerSend("send-1", "m1");
      const sent = (yield* room.projections.getThreadProjection(threadId)).messages.find(
        (message) => message.id === MessageId.make("send-1"),
      );
      assert.equal(
        sent?.text,
        "Message from guest Dana in the discussion, sent by the owner:\n\nCould we try a log scale?",
      );
      assert.equal(sent?.context?.guest?.name, "Dana");
      assert.deepEqual(sent?.context?.room?.sentBy, { kind: "owner" });
      assert.equal(sent?.context?.room?.itemId, reply);
      const delivered = yield* room.roomItem("m1");
      assert.deepEqual(
        delivered.deliveries?.map((delivery) => [delivery.messageId, delivery.status]),
        [[MessageId.make("send-1"), "sent"]],
      );
      // Two people clicking Send at once start one turn.
      assert.isTrue(yield* fails(room.ownerSend("send-2", "m1")));
      assert.lengthOf((yield* room.projections.getThreadProjection(threadId)).runs, 1);

      // The owner's reply names what it answers when it reaches the agent.
      yield* room.ownerSend("send-3", "m2");
      const ownReply = (yield* room.projections.getThreadProjection(threadId)).messages.find(
        (message) => message.id === MessageId.make("send-3"),
      );
      assert.equal(
        ownReply?.text,
        '(In reply to guest Dana: "Could we try a log scale?")\n\nGood idea, after the outliers.',
      );
      assert.isUndefined(ownReply?.context?.guest);
    }).pipe(Effect.provide(layerTest)),
);

it.effect("lets each role do only what it allows", () =>
  Effect.gen(function* () {
    const room = yield* setup;
    yield* room.invite("watcher", "watch");
    yield* room.invite("talker", "discuss");
    yield* room.invite("driver", "agent");
    yield* room.join("watcher", "Wes");
    yield* room.join("talker", "Tal");
    yield* room.join("driver", "Dru");
    assert.isTrue(yield* fails(room.guestPost("watcher", "w1", "hi")));
    yield* room.guestPost("talker", "t1", "A point for people");

    const guestDispatch = (participant: string, label: string, send: object) =>
      room.orchestrator.dispatch({
        type: "thread.room.guest-dispatch",
        commandId: CommandId.make(label),
        threadId,
        participantId: RoomParticipantId.make(participant),
        messageId: MessageId.make(label),
        send: send as never,
      });
    assert.isTrue(
      yield* fails(
        guestDispatch("talker", "talker-send", { type: "new", text: "hi", attachments: [] }),
      ),
    );
    yield* guestDispatch("driver", "driver-send", {
      type: "new",
      text: "/compact everything",
      attachments: [],
    });
    yield* guestDispatch("driver", "driver-forward", {
      type: "room-message",
      itemId: roomMessageItemId(RoomMessageId.make("t1")),
    });
    const messages = (yield* room.projections.getThreadProjection(threadId)).messages;
    const direct = messages.find((message) => message.id === MessageId.make("driver-send"));
    // The attribution line comes first, so a guest can never start a slash command.
    assert.equal(direct?.text, "Message from guest Dru:\n\n/compact everything");
    assert.deepEqual(direct?.context?.room?.author, {
      kind: "guest",
      participantId: RoomParticipantId.make("driver"),
      name: "Dru",
    });
    const forwarded = messages.find((message) => message.id === MessageId.make("driver-forward"));
    assert.equal(
      forwarded?.text,
      "Message from guest Tal in the discussion, sent by guest Dru:\n\nA point for people",
    );
    assert.deepEqual((yield* room.roomItem("t1")).deliveries?.[0]?.by, {
      kind: "guest",
      participantId: RoomParticipantId.make("driver"),
      name: "Dru",
    });

    // Removing someone stops them at once; their messages stay.
    yield* room.orchestrator.dispatch({
      type: "thread.room",
      commandId: nextCommandId("remove"),
      threadId,
      action: { type: "remove", participantId: RoomParticipantId.make("talker") },
    });
    assert.isTrue(yield* fails(room.guestPost("talker", "t2", "still here?")));
    assert.equal((yield* room.roomItem("t1")).text, "A point for people");
    // A role change takes effect on the next request.
    yield* room.orchestrator.dispatch({
      type: "thread.room",
      commandId: nextCommandId("demote"),
      threadId,
      action: { type: "set-role", participantId: RoomParticipantId.make("driver"), role: "watch" },
    });
    assert.isTrue(
      yield* fails(
        guestDispatch("driver", "driver-again", { type: "new", text: "x", attachments: [] }),
      ),
    );
  }).pipe(Effect.provide(layerTest)),
);

it.effect("deletes only a guest's own messages, and closing keeps every message", () =>
  Effect.gen(function* () {
    const room = yield* setup;
    yield* room.invite("a", "discuss");
    yield* room.invite("b", "discuss");
    yield* room.join("a", "Ann");
    yield* room.join("b", "Ben");
    yield* room.guestPost("a", "a1", "Mine");
    const guestDelete = (participant: string, messageId: string) =>
      room.orchestrator.dispatch({
        type: "thread.room.server",
        commandId: nextCommandId("guest-delete"),
        threadId,
        action: {
          type: "guest-delete",
          participantId: RoomParticipantId.make(participant),
          itemId: roomMessageItemId(RoomMessageId.make(messageId)),
        },
      });
    assert.isTrue(yield* fails(guestDelete("b", "a1")));
    yield* guestDelete("a", "a1");
    const deleted = yield* room.roomItem("a1");
    assert.equal(deleted.text, "");
    assert.isDefined(deleted.deletedAt);
    // A deleted message cannot be sent to the agent.
    assert.isTrue(yield* fails(room.ownerSend("send-deleted", "a1")));

    yield* room.guestPost("b", "b1", "Kept");
    yield* room.orchestrator.dispatch({
      type: "thread.room",
      commandId: nextCommandId("close"),
      threadId,
      action: { type: "close" },
    });
    assert.isNull((yield* room.projections.getThreadProjection(threadId)).thread.room);
    assert.equal((yield* room.roomItem("b1")).text, "Kept");
    assert.isTrue(yield* fails(room.guestPost("b", "b2", "after close")));
  }).pipe(Effect.provide(layerTest)),
);

it.effect("never takes room attribution from a client", () =>
  Effect.gen(function* () {
    const room = yield* setup;
    yield* room.orchestrator.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make("forged"),
      threadId,
      messageId: MessageId.make("forged"),
      text: "hello",
      attachments: [],
      context: {
        version: 1,
        records: [],
        room: {
          author: { kind: "guest", participantId: RoomParticipantId.make("x"), name: "Mallory" },
          sentBy: { kind: "owner" },
          postedAt: "2026-11-13T00:00:00.000Z",
        },
      },
      dispatchMode: { type: "defer_start" },
      createdBy: "user",
      creationSource: "web",
    });
    const message = (yield* room.projections.getThreadProjection(threadId)).messages.find(
      (candidate) => candidate.id === MessageId.make("forged"),
    );
    assert.isUndefined(message?.context?.room);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("archiving ends the room", () =>
  Effect.gen(function* () {
    const room = yield* setup;
    yield* room.invite("a", "discuss");
    yield* room.orchestrator.dispatch({
      type: "thread.archive",
      commandId: nextCommandId("archive"),
      threadId,
    });
    assert.isNull((yield* room.projections.getThreadProjection(threadId)).thread.room);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("places a room message after what the thread showed when it was posted", () =>
  Effect.gen(function* () {
    const room = yield* setup;
    yield* room.invite("a", "discuss");
    yield* room.join("a", "Ann");
    yield* room.guestPost("a", "before", "Before any run");
    yield* room.orchestrator.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make("owner-1"),
      threadId,
      messageId: MessageId.make("owner-1"),
      text: "Run the analysis",
      attachments: [],
      dispatchMode: { type: "defer_start" },
      createdBy: "user",
      creationSource: "web",
    });
    yield* room.guestPost("a", "after", "After the first message");
    const items = (yield* room.projections.getThreadProjection(threadId)).turnItems;
    const ordinalOf = (predicate: (item: OrchestrationV2TurnItem) => boolean) =>
      items.find(predicate)?.ordinal ?? Number.NaN;
    const before = (yield* room.roomItem("before")).ordinal;
    const owner = ordinalOf((item) => item.type === "user_message");
    const after = (yield* room.roomItem("after")).ordinal;
    // Before the run, inside the run's range after its message, and before any later run.
    assert.isTrue(before < owner, `${before} < ${owner}`);
    assert.isTrue(owner < after && after < 2_000_000, `${owner} < ${after} < 2000000`);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("counts guests' messages as waiting on the owner until the owner looks or answers", () =>
  Effect.gen(function* () {
    const room = yield* setup;
    yield* room.invite("a", "discuss");
    yield* room.join("a", "Ann");
    const waiting = Effect.map(
      room.projections.getThreadShell(threadId),
      (shell) => shell?.pendingGuestMessageCount,
    );
    yield* room.guestPost("a", "w1", "First");
    yield* room.guestPost("a", "w2", "Second");
    assert.equal(yield* waiting, 2);
    // Sending one to the agent answers it.
    yield* room.ownerSend("send-w1", "w1");
    assert.equal(yield* waiting, 1);
    // Opening the thread is seeing the rest.
    yield* room.orchestrator.dispatch({
      type: "thread.visit",
      commandId: nextCommandId("visit"),
      threadId,
      visitedAt: DateTime.formatIso(yield* DateTime.now),
    });
    assert.equal(yield* waiting, 0);
    yield* room.guestPost("a", "w3", "Third");
    yield* room.ownerPost("w4", "Got it");
    assert.equal(yield* waiting, 0);
  }).pipe(Effect.provide(layerTest)),
);

// regression: a guest's Stop is checked against their role under the thread lock.
it.effect("stops the thread only for a guest whose role still allows it", () =>
  Effect.gen(function* () {
    const room = yield* setup;
    yield* room.invite("w", "watch");
    yield* room.invite("d", "agent");
    yield* room.join("w", "Wes");
    yield* room.join("d", "Dru");
    const stop = (participant: string, label: string) =>
      room.orchestrator.dispatch({
        type: "thread.room.guest-dispatch",
        commandId: CommandId.make(label),
        threadId,
        participantId: RoomParticipantId.make(participant),
        messageId: MessageId.make(label),
        send: { type: "stop" },
      });
    assert.isTrue(yield* fails(stop("w", "stop-watch")));
    assert.isFalse(yield* fails(stop("d", "stop-agent")));
  }).pipe(Effect.provide(layerTest)),
);
