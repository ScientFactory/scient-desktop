import {
  CheckpointRef,
  CommandId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type OrchestrationCheckpointSummary,
  type OrchestrationMessage,
  type OrchestrationReadModel,
  type OrchestrationSession,
  type OrchestrationThread,
  type ThreadForkCommand,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { forkThread } from "./forkDecider.ts";

const NOW = "2026-01-01T00:00:00.000Z";
const ORIGIN = ThreadId.make("origin-thread");
const NEW = ThreadId.make("forked-thread");
const PROJECT = ProjectId.make("project-1");

const T2 = TurnId.make("turn-2");

function message(input: {
  readonly id: string;
  readonly role: OrchestrationMessage["role"];
  readonly text: string;
  readonly turnId: string | null;
  readonly createdAt: string;
  readonly streaming?: boolean;
}): OrchestrationMessage {
  return {
    id: MessageId.make(input.id),
    role: input.role,
    text: input.text,
    turnId: input.turnId === null ? null : TurnId.make(input.turnId),
    streaming: input.streaming ?? false,
    createdAt: input.createdAt,
    updatedAt: input.createdAt,
  };
}

function checkpoint(turnId: string, turnCount: number): OrchestrationCheckpointSummary {
  return {
    turnId: TurnId.make(turnId),
    checkpointTurnCount: turnCount,
    checkpointRef: CheckpointRef.make(`ref-${turnCount}`),
    status: "ready",
    files: [],
    assistantMessageId: null,
    completedAt: NOW,
  };
}

const IDLE_SESSION: OrchestrationSession = {
  threadId: ORIGIN,
  status: "idle",
  providerName: null,
  runtimeMode: "full-access",
  activeTurnId: null,
  lastError: null,
  updatedAt: NOW,
};

function makeOriginThread(overrides: Partial<OrchestrationThread> = {}): OrchestrationThread {
  return {
    id: ORIGIN,
    projectId: PROJECT,
    title: "Origin conversation",
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: "feat/work",
    worktreePath: "/tmp/worktrees/origin",
    latestTurn: {
      turnId: T2,
      state: "completed",
      requestedAt: NOW,
      startedAt: NOW,
      completedAt: NOW,
      assistantMessageId: MessageId.make("assistant-2"),
    },
    createdAt: NOW,
    updatedAt: NOW,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    snoozedUntil: null,
    snoozedAt: null,
    pinnedAt: null,
    deletedAt: null,
    messages: [
      message({
        id: "user-1",
        role: "user",
        text: "first prompt",
        turnId: null,
        createdAt: "2026-01-01T00:00:01.000Z",
      }),
      message({
        id: "assistant-1",
        role: "assistant",
        text: "first answer",
        turnId: "turn-1",
        createdAt: "2026-01-01T00:00:02.000Z",
      }),
      message({
        id: "user-2",
        role: "user",
        text: "second prompt",
        turnId: null,
        createdAt: "2026-01-01T00:00:03.000Z",
      }),
      message({
        id: "assistant-2",
        role: "assistant",
        text: "second answer",
        turnId: "turn-2",
        createdAt: "2026-01-01T00:00:04.000Z",
      }),
    ],
    proposedPlans: [],
    activities: [],
    checkpoints: [checkpoint("turn-1", 1), checkpoint("turn-2", 2)],
    session: IDLE_SESSION,
    ...overrides,
  };
}

function makeReadModel(
  input: {
    readonly origin?: OrchestrationThread | null;
    readonly includeNewThread?: boolean;
  } = {},
): OrchestrationReadModel {
  const threads: OrchestrationThread[] = [];
  const origin = input.origin === undefined ? makeOriginThread() : input.origin;
  if (origin !== null) {
    threads.push(origin);
  }
  if (input.includeNewThread) {
    threads.push(makeOriginThread({ id: NEW, title: "Already exists" }));
  }
  return {
    snapshotSequence: 10,
    projects: [],
    threads,
    updatedAt: NOW,
  };
}

function forkCommand(overrides: Partial<ThreadForkCommand> = {}): ThreadForkCommand {
  return {
    type: "thread.fork",
    commandId: CommandId.make("cmd-fork"),
    originThreadId: ORIGIN,
    newThreadId: NEW,
    forkAtTurnCount: 2,
    workspaceMode: "local",
    ...overrides,
  };
}

it.layer(NodeServices.layer)("scient fork decider", (it) => {
  it.effect("emits thread.created + re-emitted prefix + thread.forked for the new thread", () =>
    Effect.gen(function* () {
      const events = yield* forkThread({ command: forkCommand(), readModel: makeReadModel() });

      expect(events.map((event) => event.type)).toEqual([
        "thread.created",
        "thread.message-sent",
        "thread.message-sent",
        "thread.message-sent",
        "thread.message-sent",
        "thread.forked",
      ]);

      // Every emitted event targets the NEW thread — never the origin.
      for (const event of events) {
        expect(event.aggregateKind).toBe("thread");
        expect(event.aggregateId).toBe(NEW);
      }

      const created = events[0];
      if (created?.type === "thread.created") {
        expect(created.payload.threadId).toBe(NEW);
        expect(created.payload.projectId).toBe(PROJECT);
        // A fork is an independent chat thread: no shared worktree/branch.
        expect(created.payload.branch).toBeNull();
        expect(created.payload.worktreePath).toBeNull();
        expect(created.payload.title).toBe("Origin conversation");
      }

      const forked = events.at(-1);
      if (forked?.type === "thread.forked") {
        expect(forked.payload).toMatchObject({
          originThreadId: ORIGIN,
          newThreadId: NEW,
          forkAtTurnCount: 2,
          fidelityMode: "chat-only",
        });
      }

      // Prefix transcript preserved in order, with FRESH message ids and no
      // origin message id reused (projection message_id is a global PK).
      const originIds = new Set(["user-1", "assistant-1", "user-2", "assistant-2"]);
      const texts: string[] = [];
      for (const event of events) {
        if (event.type === "thread.message-sent") {
          expect(originIds.has(event.payload.messageId)).toBe(false);
          expect(event.payload.streaming).toBe(false);
          texts.push(event.payload.text);
        }
      }
      expect(texts).toEqual(["first prompt", "first answer", "second prompt", "second answer"]);

      // Assistant turn ids are re-keyed (not the origin turn ids).
      const emittedTurnIds = events
        .filter((event) => event.type === "thread.message-sent")
        .map((event) => (event.type === "thread.message-sent" ? event.payload.turnId : null))
        .filter((turnId): turnId is TurnId => turnId !== null);
      for (const turnId of emittedTurnIds) {
        expect(turnId).not.toBe("turn-1");
        expect(turnId).not.toBe("turn-2");
      }
      // Event ids are unique.
      const eventIds = events.map((event) => event.eventId);
      expect(new Set(eventIds).size).toBe(eventIds.length);
    }),
  );

  it.effect("forking at an earlier boundary re-emits only that prefix", () =>
    Effect.gen(function* () {
      const events = yield* forkThread({
        command: forkCommand({ forkAtTurnCount: 1 }),
        readModel: makeReadModel(),
      });
      const texts = events
        .filter((event) => event.type === "thread.message-sent")
        .map((event) => (event.type === "thread.message-sent" ? event.payload.text : ""));
      expect(texts).toEqual(["first prompt", "first answer"]);
    }),
  );

  it.effect("applies a custom title when provided", () =>
    Effect.gen(function* () {
      const events = yield* forkThread({
        command: forkCommand({ title: "Fork of origin" }),
        readModel: makeReadModel(),
      });
      const created = events[0];
      expect(created?.type === "thread.created" ? created.payload.title : null).toBe(
        "Fork of origin",
      );
    }),
  );

  it.effect("rejects forking a mid-turn (running session) thread", () =>
    Effect.gen(function* () {
      const error = yield* forkThread({
        command: forkCommand(),
        readModel: makeReadModel({
          origin: makeOriginThread({ session: { ...IDLE_SESSION, status: "running" } }),
        }),
      }).pipe(Effect.flip);
      expect(error._tag).toBe("OrchestrationCommandInvariantError");
      if (error._tag === "OrchestrationCommandInvariantError") {
        expect(error.detail).toContain("mid-turn");
      }
    }),
  );

  it.effect("rejects forking while a message is still streaming", () =>
    Effect.gen(function* () {
      const streamingOrigin = makeOriginThread();
      const error = yield* forkThread({
        command: forkCommand(),
        readModel: makeReadModel({
          origin: {
            ...streamingOrigin,
            messages: [
              ...streamingOrigin.messages,
              message({
                id: "assistant-3",
                role: "assistant",
                text: "streaming…",
                turnId: "turn-3",
                createdAt: "2026-01-01T00:00:05.000Z",
                streaming: true,
              }),
            ],
          },
        }),
      }).pipe(Effect.flip);
      expect(error._tag).toBe("OrchestrationCommandInvariantError");
    }),
  );

  it.effect("rejects a non-existent origin thread", () =>
    Effect.gen(function* () {
      const error = yield* forkThread({
        command: forkCommand(),
        readModel: makeReadModel({ origin: null }),
      }).pipe(Effect.flip);
      expect(error._tag).toBe("OrchestrationCommandInvariantError");
    }),
  );

  it.effect("rejects an out-of-range forkAtTurnCount", () =>
    Effect.gen(function* () {
      const error = yield* forkThread({
        command: forkCommand({ forkAtTurnCount: 99 }),
        readModel: makeReadModel(),
      }).pipe(Effect.flip);
      expect(error._tag).toBe("OrchestrationCommandInvariantError");
      if (error._tag === "OrchestrationCommandInvariantError") {
        expect(error.detail).toContain("completed turn boundary");
      }
    }),
  );

  it.effect("rejects when the new thread id already exists", () =>
    Effect.gen(function* () {
      const error = yield* forkThread({
        command: forkCommand(),
        readModel: makeReadModel({ includeNewThread: true }),
      }).pipe(Effect.flip);
      expect(error._tag).toBe("OrchestrationCommandInvariantError");
    }),
  );

  it.effect("leaves the origin thread untouched (immutability)", () =>
    Effect.gen(function* () {
      const readModel = makeReadModel();
      const originBefore = structuredClone(
        readModel.threads.find((thread) => thread.id === ORIGIN),
      );
      const snapshotBefore = readModel.snapshotSequence;

      const events = yield* forkThread({ command: forkCommand(), readModel });

      // The decider is pure: it must not mutate the read model's origin thread.
      const originAfter = readModel.threads.find((thread) => thread.id === ORIGIN);
      expect(originAfter).toEqual(originBefore);
      expect(readModel.snapshotSequence).toBe(snapshotBefore);

      // No emitted event mutates the origin aggregate; the origin appears only
      // as immutable lineage metadata inside the thread.forked payload.
      for (const event of events) {
        expect(event.aggregateId).not.toBe(ORIGIN);
      }
    }),
  );
});
