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
const A1 = MessageId.make("assistant-1");
const A2 = MessageId.make("assistant-2");

const boundaries = [
  {
    turnId: null,
    conversationTurnCount: 0,
    userMessageId: null,
    assistantMessageId: null,
    completedAt: NOW,
    checkpointTurnCount: null,
    checkpointStatus: null,
  },
  {
    turnId: TurnId.make("turn-1"),
    conversationTurnCount: 1,
    userMessageId: MessageId.make("user-1"),
    assistantMessageId: A1,
    completedAt: NOW,
    checkpointTurnCount: 1,
    checkpointStatus: "ready" as const,
  },
  {
    turnId: T2,
    conversationTurnCount: 2,
    userMessageId: MessageId.make("user-2"),
    assistantMessageId: A2,
    completedAt: NOW,
    checkpointTurnCount: 2,
    checkpointStatus: "ready" as const,
  },
];

function message(input: {
  readonly id: string;
  readonly role: OrchestrationMessage["role"];
  readonly text: string;
  readonly turnId: string | null;
  readonly createdAt: string;
  readonly streaming?: boolean;
  readonly attachments?: OrchestrationMessage["attachments"];
}): OrchestrationMessage {
  return {
    id: MessageId.make(input.id),
    role: input.role,
    text: input.text,
    ...(input.attachments !== undefined ? { attachments: input.attachments } : {}),
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
    conversationForkBoundaries: boundaries,
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
    sourceAssistantMessageId: A2,
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
        "thread.turn-diff-completed",
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
        expect(created.payload.title).toBe("Origin conversation (2)");
      }

      const forked = events.find((event) => event.type === "thread.forked");
      if (forked?.type === "thread.forked") {
        expect(forked.payload).toMatchObject({
          originThreadId: ORIGIN,
          newThreadId: NEW,
          forkAtTurnId: T2,
          forkAtTurnCount: 2,
          sourceCheckpointTurnCount: 2,
          providerMode: "transcript-bootstrap",
          attachmentCopies: [],
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

      // The imported transcript remains provider-neutral, but historical
      // assistant responses need distinct projection turn ids so the UI does
      // not fold them into one turn and hide all but the last answer.
      const emittedTurnIds = events
        .filter((event) => event.type === "thread.message-sent")
        .map((event) => (event.type === "thread.message-sent" ? event.payload.turnId : null))
        .filter((turnId): turnId is TurnId => turnId !== null);
      for (const turnId of emittedTurnIds) {
        expect(turnId).not.toBe("turn-1");
        expect(turnId).not.toBe("turn-2");
      }
      expect(new Set(emittedTurnIds).size).toBe(2);
      const forkedPayload = events.find((event) => event.type === "thread.forked");
      const baselineTurnId =
        forkedPayload?.type === "thread.forked" ? forkedPayload.payload.baselineTurnId : null;
      expect(emittedTurnIds.at(-1)).toBe(baselineTurnId);
      const baseline = events.find((event) => event.type === "thread.turn-diff-completed");
      expect(
        baseline?.type === "thread.turn-diff-completed"
          ? baseline.payload.checkpointTurnCount
          : null,
      ).toBe(0);
      // Event ids are unique.
      const eventIds = events.map((event) => event.eventId);
      expect(new Set(eventIds).size).toBe(eventIds.length);
    }),
  );

  it.effect("numbers fork titles without colliding with sibling threads", () =>
    Effect.gen(function* () {
      const sibling = makeOriginThread({
        id: ThreadId.make("existing-fork"),
        title: "Origin conversation (2)",
      });
      const events = yield* forkThread({
        command: forkCommand(),
        readModel: {
          ...makeReadModel(),
          threads: [makeOriginThread(), sibling],
        },
      });
      const created = events[0];
      expect(created?.type === "thread.created" ? created.payload.title : null).toBe(
        "Origin conversation (3)",
      );
    }),
  );

  it.effect("preserves meaningful numeric parentheticals in source titles", () =>
    Effect.gen(function* () {
      const events = yield* forkThread({
        command: forkCommand(),
        readModel: makeReadModel({
          origin: makeOriginThread({ title: "Study (2024)" }),
        }),
      });
      const created = events[0];
      expect(created?.type === "thread.created" ? created.payload.title : null).toBe(
        "Study (2024) (2)",
      );
    }),
  );

  it.effect("preserves a meaningful suffix on a renamed fork", () =>
    Effect.gen(function* () {
      const events = yield* forkThread({
        command: forkCommand(),
        readModel: makeReadModel({
          origin: makeOriginThread({
            title: "Experiment (2024)",
            conversationForkBoundaries: [
              {
                turnId: T2,
                conversationTurnCount: 0,
                userMessageId: MessageId.make("user-2"),
                assistantMessageId: MessageId.make("assistant-2"),
                completedAt: NOW,
                checkpointTurnCount: null,
                checkpointStatus: null,
              },
            ],
          }),
        }),
      });
      const created = events[0];
      expect(created?.type === "thread.created" ? created.payload.title : null).toBe(
        "Experiment (2024) (2)",
      );
    }),
  );

  it.effect("increments the suffix when reforking a numbered fork", () =>
    Effect.gen(function* () {
      const forkOrigin = makeOriginThread({
        title: "Origin conversation (2)",
        conversationForkBoundaries: [
          {
            turnId: T2,
            conversationTurnCount: 0,
            userMessageId: MessageId.make("user-2"),
            assistantMessageId: MessageId.make("assistant-2"),
            completedAt: NOW,
            checkpointTurnCount: null,
            checkpointStatus: null,
          },
        ],
      });
      const events = yield* forkThread({
        command: forkCommand(),
        readModel: {
          ...makeReadModel({ origin: forkOrigin }),
          threads: [makeOriginThread({ id: ThreadId.make("original-conversation") }), forkOrigin],
        },
      });
      const created = events[0];
      expect(created?.type === "thread.created" ? created.payload.title : null).toBe(
        "Origin conversation (3)",
      );
    }),
  );

  it.effect("rekeys retained attachments so the fork owns an independent file", () =>
    Effect.gen(function* () {
      const origin = makeOriginThread();
      const sourceAttachment = {
        type: "image" as const,
        id: "origin-thread-00000000-0000-4000-8000-000000000001",
        name: "evidence.png",
        mimeType: "image/png",
        sizeBytes: 42,
      };
      const messages = origin.messages.map((entry, index) =>
        index === 1 ? { ...entry, attachments: [sourceAttachment] } : entry,
      );
      const events = yield* forkThread({
        command: forkCommand(),
        readModel: makeReadModel({ origin: { ...origin, messages } }),
      });
      const copiedMessage = events.find(
        (event) => event.type === "thread.message-sent" && event.payload.text === "first answer",
      );
      const forked = events.find((event) => event.type === "thread.forked");

      expect(copiedMessage?.type).toBe("thread.message-sent");
      expect(forked?.type).toBe("thread.forked");
      if (copiedMessage?.type === "thread.message-sent" && forked?.type === "thread.forked") {
        const target = copiedMessage.payload.attachments?.[0];
        expect(target?.id).not.toBe(sourceAttachment.id);
        expect(target?.id).toMatch(/^forked-thread-[0-9a-f-]{36}$/);
        expect(forked.payload.attachmentCopies).toEqual([{ source: sourceAttachment, target }]);
      }
    }),
  );

  it.effect("forking at an earlier boundary re-emits only that prefix", () =>
    Effect.gen(function* () {
      const events = yield* forkThread({
        command: forkCommand({
          sourceAssistantMessageId: A1,
        }),
        readModel: makeReadModel(),
      });
      const texts = events
        .filter((event) => event.type === "thread.message-sent")
        .map((event) => (event.type === "thread.message-sent" ? event.payload.text : ""));
      expect(texts).toEqual(["first prompt", "first answer"]);

      const copiedMessages = events.filter((event) => event.type === "thread.message-sent");
      expect(
        copiedMessages.map((event) =>
          event.type === "thread.message-sent" ? event.payload.role : null,
        ),
      ).toEqual(["user", "assistant"]);
      expect(
        copiedMessages[0]?.type === "thread.message-sent" &&
          copiedMessages[1]?.type === "thread.message-sent"
          ? copiedMessages[0].payload.turnId
          : null,
      ).toBe(
        copiedMessages[1]?.type === "thread.message-sent" ? copiedMessages[1].payload.turnId : null,
      );
    }),
  );

  it.effect("rejects a public request that does not name a completed assistant response", () =>
    Effect.gen(function* () {
      const command: ThreadForkCommand = {
        type: "thread.fork",
        commandId: CommandId.make("cmd-fork-zero"),
        originThreadId: ORIGIN,
        newThreadId: NEW,
        sourceAssistantMessageId: MessageId.make("missing-assistant"),
        workspaceMode: "local",
      };
      const error = yield* forkThread({ command, readModel: makeReadModel() }).pipe(Effect.flip);
      expect(error._tag).toBe("OrchestrationCommandInvariantError");
    }),
  );

  it.effect("allows a real inherited baseline while keeping turn zero internal", () =>
    Effect.gen(function* () {
      const baselineTurnId = TurnId.make("fork-baseline-only");
      const reforkOrigin = makeOriginThread({
        messages: [
          message({
            id: "inherited-user-only",
            role: "user",
            text: "inherited prompt",
            turnId: baselineTurnId,
            createdAt: "2026-01-01T00:00:01.000Z",
          }),
          message({
            id: "inherited-assistant-only",
            role: "assistant",
            text: "inherited answer",
            turnId: baselineTurnId,
            createdAt: "2026-01-01T00:00:02.000Z",
          }),
        ],
        checkpoints: [checkpoint(baselineTurnId, 0)],
        conversationForkBoundaries: [
          {
            turnId: baselineTurnId,
            conversationTurnCount: 0,
            userMessageId: MessageId.make("inherited-user-only"),
            assistantMessageId: MessageId.make("inherited-assistant-only"),
            completedAt: NOW,
            checkpointTurnCount: 0,
            checkpointStatus: "ready",
          },
        ],
      });
      const events = yield* forkThread({
        command: forkCommand({
          sourceAssistantMessageId: MessageId.make("inherited-assistant-only"),
        }),
        readModel: makeReadModel({ origin: reforkOrigin }),
      });
      const forked = events.find((event) => event.type === "thread.forked");
      expect(forked?.type === "thread.forked" ? forked.payload.forkAtTurnCount : undefined).toBe(0);
      expect(
        events.flatMap((event) =>
          event.type === "thread.message-sent" ? [event.payload.text] : [],
        ),
      ).toEqual(["inherited prompt", "inherited answer"]);
    }),
  );

  it.effect("re-forks a fork-owned baseline plus genuine post-fork turns intact", () =>
    Effect.gen(function* () {
      const baselineTurnId = TurnId.make("fork-baseline");
      const postForkTurnId = TurnId.make("fork-turn-1");
      const reforkOrigin = makeOriginThread({
        messages: [
          message({
            id: "inherited-user-1",
            role: "user",
            text: "inherited prompt",
            turnId: baselineTurnId,
            createdAt: "2026-01-01T00:00:01.000Z",
          }),
          message({
            id: "inherited-assistant-1",
            role: "assistant",
            text: "inherited answer",
            turnId: baselineTurnId,
            createdAt: "2026-01-01T00:00:02.000Z",
          }),
          message({
            id: "post-fork-user-1",
            role: "user",
            text: "new prompt",
            turnId: null,
            createdAt: "2026-01-01T00:00:03.000Z",
          }),
          message({
            id: "post-fork-assistant-1",
            role: "assistant",
            text: "new answer",
            turnId: postForkTurnId,
            createdAt: "2026-01-01T00:00:04.000Z",
          }),
        ],
        checkpoints: [checkpoint(baselineTurnId, 0), checkpoint(postForkTurnId, 1)],
        conversationForkBoundaries: [
          {
            turnId: baselineTurnId,
            conversationTurnCount: 0,
            userMessageId: MessageId.make("inherited-user-1"),
            assistantMessageId: MessageId.make("inherited-assistant-1"),
            completedAt: NOW,
            checkpointTurnCount: 0,
            checkpointStatus: "ready",
          },
          {
            turnId: postForkTurnId,
            conversationTurnCount: 1,
            userMessageId: MessageId.make("post-fork-user-1"),
            assistantMessageId: MessageId.make("post-fork-assistant-1"),
            completedAt: NOW,
            checkpointTurnCount: 1,
            checkpointStatus: "ready",
          },
        ],
      });
      const events = yield* forkThread({
        command: forkCommand({
          sourceAssistantMessageId: MessageId.make("post-fork-assistant-1"),
        }),
        readModel: makeReadModel({ origin: reforkOrigin }),
      });
      const texts = events.flatMap((event) =>
        event.type === "thread.message-sent" ? [event.payload.text] : [],
      );
      expect(texts).toEqual(["inherited prompt", "inherited answer", "new prompt", "new answer"]);
    }),
  );

  it.effect("forks the latest completed boundary while a newer turn is running", () =>
    Effect.gen(function* () {
      const origin = makeOriginThread({
        session: {
          ...IDLE_SESSION,
          status: "running",
          activeTurnId: TurnId.make("turn-3"),
        },
        latestTurn: {
          turnId: TurnId.make("turn-3"),
          state: "running",
          requestedAt: NOW,
          startedAt: NOW,
          completedAt: null,
          assistantMessageId: null,
        },
      });
      const events = yield* forkThread({
        command: forkCommand(),
        readModel: makeReadModel({ origin }),
      });
      expect(events.some((event) => event.type === "thread.forked")).toBe(true);
    }),
  );

  it.effect("does not include a newer streaming turn in the selected completed prefix", () =>
    Effect.gen(function* () {
      const streamingOrigin = makeOriginThread();
      const events = yield* forkThread({
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
      });
      const texts = events.flatMap((event) =>
        event.type === "thread.message-sent" ? [event.payload.text] : [],
      );
      expect(texts).not.toContain("streaming…");
    }),
  );

  it.effect("rejects a streaming assistant even if stale boundary data names it", () =>
    Effect.gen(function* () {
      const origin = makeOriginThread({
        messages: makeOriginThread().messages.map((entry) =>
          entry.id === A2 ? { ...entry, streaming: true } : entry,
        ),
      });
      const error = yield* forkThread({
        command: forkCommand(),
        readModel: makeReadModel({ origin }),
      }).pipe(Effect.flip);
      expect(error._tag).toBe("OrchestrationCommandInvariantError");
      if (error._tag === "OrchestrationCommandInvariantError") {
        expect(error.detail).toContain("terminal completed response");
      }
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

  it.effect("rejects a nonexistent or stale conversational boundary", () =>
    Effect.gen(function* () {
      const error = yield* forkThread({
        command: forkCommand({
          sourceAssistantMessageId: MessageId.make("missing-assistant"),
        }),
        readModel: makeReadModel(),
      }).pipe(Effect.flip);
      expect(error._tag).toBe("OrchestrationCommandInvariantError");
      if (error._tag === "OrchestrationCommandInvariantError") {
        expect(error.detail).toContain("completed conversation boundary");
      }
    }),
  );

  it.effect("forks a completed non-Git conversation in the same workspace", () =>
    Effect.gen(function* () {
      const origin = makeOriginThread({
        checkpoints: [],
        conversationForkBoundaries: boundaries.map((boundary) => ({
          ...boundary,
          checkpointTurnCount: null,
          checkpointStatus: null,
        })),
      });
      const events = yield* forkThread({
        command: forkCommand({ workspaceMode: "local" }),
        readModel: makeReadModel({ origin }),
      });
      const forked = events.find((event) => event.type === "thread.forked");
      expect(
        forked?.type === "thread.forked" ? forked.payload.sourceCheckpointTurnCount : undefined,
      ).toBeNull();
      expect(events.some((event) => event.type === "thread.turn-diff-completed")).toBe(false);
    }),
  );

  it.effect("rejects a new worktree when the conversational boundary has no checkpoint", () =>
    Effect.gen(function* () {
      const origin = makeOriginThread({ checkpoints: [] });
      const error = yield* forkThread({
        command: forkCommand({ workspaceMode: "new-worktree" }),
        readModel: makeReadModel({ origin }),
      }).pipe(Effect.flip);
      expect(error._tag).toBe("OrchestrationCommandInvariantError");
      if (error._tag === "OrchestrationCommandInvariantError") {
        expect(error.detail).toContain("no ready Git checkpoint");
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
