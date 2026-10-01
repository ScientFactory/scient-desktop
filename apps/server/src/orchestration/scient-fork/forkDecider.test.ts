import {
  CheckpointRef,
  EventId,
  type OrchestrationThreadActivity,
  CommandId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  ThreadSectionId,
  TurnId,
  type OrchestrationCheckpointSummary,
  type OrchestrationForkBoundary,
  type OrchestrationMessage,
  type OrchestrationReadModel,
  type OrchestrationSession,
  type OrchestrationThread,
  type ThreadForkCommand,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { decideOrchestrationCommand } from "../decider.ts";
import {
  resolveForkBoundariesFromList,
  resolveUserForkBoundariesFromList,
} from "./forkBoundaryTypes.ts";
import { decideForkComplete, forkThread as forkThreadAuthoritative } from "./forkDecider.ts";
import { questionAnswerActivity } from "./questionAnswer.test-fixtures.ts";
import { retainQuestionAnswers, questionAnswerAttachments } from "./retainedQuestionAnswers.ts";

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
    pullRequests: [],
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

/** Test-only adapter for explicit boundary fixtures. Production uses the SQL resolver. */
function forkThreadForTest(input: {
  readonly command: ThreadForkCommand;
  readonly readModel: OrchestrationReadModel;
  readonly resolvedBoundaries?: ReadonlyArray<OrchestrationForkBoundary>;
}) {
  const boundaryList = input.resolvedBoundaries ?? boundaries;
  const sourceAssistantMessageId = input.command.sourceAssistantMessageId;
  const sourceUserMessageId = input.command.sourceUserMessageId;
  const origin = input.readModel.threads.find(
    (thread) => thread.id === input.command.originThreadId,
  );
  const resolved =
    sourceAssistantMessageId !== undefined
      ? resolveForkBoundariesFromList({
          originThreadId: input.command.originThreadId,
          sourceAssistantMessageId,
          boundaries: boundaryList,
        })
      : sourceUserMessageId !== undefined && origin !== undefined
        ? resolveUserForkBoundariesFromList({
            originThreadId: input.command.originThreadId,
            sourceUserMessageId,
            sourceUserCreatedAt:
              origin.messages.find((message) => message.id === sourceUserMessageId)?.createdAt ??
              origin.createdAt,
            orderedTurns: boundaryList.flatMap((boundary) =>
              boundary.turnId === null
                ? []
                : [
                    {
                      turnId: boundary.turnId,
                      userMessageId: boundary.userMessageId,
                      requestedAt: boundary.completedAt,
                    },
                  ],
            ),
            boundaries: boundaryList,
          })
        : null;
  if (resolved === null) {
    throw new Error(
      `No explicit boundary fixture matches '${sourceAssistantMessageId ?? sourceUserMessageId ?? "missing-source"}'.`,
    );
  }
  return forkThreadAuthoritative({ ...input, resolvedBoundaries: resolved });
}

/** Constructs deliberately inconsistent resolver evidence for rejection tests. */
function forkThreadWithUnmatchedResolution(input: {
  readonly command: ThreadForkCommand;
  readonly readModel: OrchestrationReadModel;
  readonly resolvedBoundaries: ReadonlyArray<OrchestrationForkBoundary>;
}) {
  const selectedBoundary = input.resolvedBoundaries[0];
  if (!selectedBoundary) {
    throw new Error("An unmatched-resolution test requires at least one boundary.");
  }
  return forkThreadAuthoritative({
    command: input.command,
    readModel: input.readModel,
    resolvedBoundaries: {
      originThreadId: input.command.originThreadId,
      forkPoint: {
        kind: "assistant-response",
        messageId: input.command.sourceAssistantMessageId ?? MessageId.make("missing-assistant"),
      },
      boundaries: input.resolvedBoundaries,
      selectedBoundary,
    },
  });
}

it.layer(NodeServices.layer)("scient fork decider", (it) => {
  it.effect("requires authoritative boundaries at the generic decider seam", () =>
    Effect.gen(function* () {
      const error = yield* decideOrchestrationCommand({
        command: forkCommand(),
        readModel: makeReadModel(),
      }).pipe(Effect.flip);

      expect(error._tag).toBe("OrchestrationCommandInvariantError");
      if (error._tag === "OrchestrationCommandInvariantError") {
        expect(error.detail).toContain("Authoritative fork boundaries are required");
      }
    }),
  );

  it.effect("files the fork into its origin's section right after creating it", () =>
    Effect.gen(function* () {
      const sectionId = ThreadSectionId.make("section-research");
      const events = yield* forkThreadForTest({
        command: forkCommand(),
        readModel: makeReadModel({ origin: makeOriginThread({ sectionId }) }),
      });

      expect(events.map((event) => event.type).slice(0, 2)).toEqual([
        "thread.created",
        "thread.meta-updated",
      ]);
      const filed = events[1];
      expect(filed?.aggregateId).toBe(NEW);
      if (filed?.type === "thread.meta-updated") {
        expect(filed.payload).toMatchObject({ threadId: NEW, sectionId });
      }
    }),
  );

  it.effect("leaves the fork of an unsectioned origin unsectioned", () =>
    Effect.gen(function* () {
      const events = yield* forkThreadForTest({
        command: forkCommand(),
        readModel: makeReadModel({ origin: makeOriginThread({ sectionId: null }) }),
      });
      expect(events.some((event) => event.type === "thread.meta-updated")).toBe(false);
    }),
  );

  it.effect("emits thread.created + re-emitted prefix + thread.forked for the new thread", () =>
    Effect.gen(function* () {
      const events = yield* forkThreadForTest({
        command: forkCommand(),
        readModel: makeReadModel(),
      });

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
      // The turn-zero checkpoint waits for provisioning (decideForkComplete).
      expect(events.some((event) => event.type === "thread.turn-diff-completed")).toBe(false);
      const completeCommand = {
        type: "thread.fork.complete" as const,
        commandId: CommandId.make("cmd-fork-complete"),
        threadId: NEW,
        workspaceStatus: "worktree" as const,
        createdAt: NOW,
      };
      const ready = yield* decideForkComplete({
        command: {
          ...completeCommand,
          checkpointStatus: "ready",
          checkpointBaseline: { turnId: baselineTurnId!, assistantMessageId: null },
        },
      });
      expect(ready.map((event) => event.type)).toEqual([
        "thread.fork-completed",
        "thread.turn-diff-completed",
      ]);
      const baseline = ready[1];
      expect(
        baseline?.type === "thread.turn-diff-completed"
          ? [baseline.payload.checkpointTurnCount, baseline.payload.turnId]
          : null,
      ).toEqual([0, baselineTurnId]);
      const unavailable = yield* decideForkComplete({
        command: { ...completeCommand, checkpointStatus: "unavailable" },
      });
      expect(unavailable.map((event) => event.type)).toEqual(["thread.fork-completed"]);
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
      const events = yield* forkThreadForTest({
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

  it.effect("uses an explicit title override without changing the resolved boundary", () =>
    Effect.gen(function* () {
      const events = yield* forkThreadForTest({
        command: forkCommand({ titleOverride: "Deliberate fork title" }),
        readModel: {
          ...makeReadModel(),
          threads: [
            makeOriginThread(),
            makeOriginThread({
              id: ThreadId.make("existing-fork"),
              title: "Deliberate fork title",
            }),
          ],
        },
      });
      const created = events[0];
      expect(created?.type === "thread.created" ? created.payload.title : null).toBe(
        "Deliberate fork title",
      );
      const forked = events.find((event) => event.type === "thread.forked");
      expect(forked?.type === "thread.forked" ? forked.payload.forkAtTurnId : null).toBe(T2);
      expect(forked?.type === "thread.forked" ? forked.payload.forkAtTurnCount : null).toBe(2);
    }),
  );

  it.effect("preserves meaningful numeric parentheticals in source titles", () =>
    Effect.gen(function* () {
      const events = yield* forkThreadForTest({
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
      const events = yield* forkThreadForTest({
        command: forkCommand(),
        readModel: makeReadModel({
          origin: makeOriginThread({
            title: "Experiment (2024)",
            forkLineage: {
              originThreadId: ORIGIN,
              baselineAssistantMessageId: A2,
            },
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
        forkLineage: {
          originThreadId: ORIGIN,
          baselineAssistantMessageId: A2,
        },
      });
      const events = yield* forkThreadForTest({
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

  it.effect("uses resolved boundaries and the narrow lineage marker for refork titles", () =>
    Effect.gen(function* () {
      const forkOrigin = makeOriginThread({
        title: "Origin conversation (2)",
        conversationForkBoundaries: undefined,
        forkLineage: {
          originThreadId: ORIGIN,
          baselineAssistantMessageId: MessageId.make("assistant-1"),
        },
      });
      const events = yield* forkThreadForTest({
        command: forkCommand(),
        readModel: {
          ...makeReadModel({ origin: forkOrigin }),
          threads: [makeOriginThread({ id: ThreadId.make("original-conversation") }), forkOrigin],
        },
        resolvedBoundaries: boundaries,
      });
      const created = events[0];
      expect(created?.type === "thread.created" ? created.payload.title : null).toBe(
        "Origin conversation (3)",
      );
    }),
  );

  for (const fixture of [
    { type: "image" as const, name: "evidence.png", mimeType: "image/png", suffix: "" },
    { type: "file" as const, name: "report.PDF", mimeType: "application/pdf", suffix: "-pdf" },
    { type: "file" as const, name: "diagram.svg", mimeType: "image/svg+xml", suffix: "-svg" },
    { type: "file" as const, name: "README", mimeType: "application/octet-stream", suffix: "-bin" },
  ]) {
    it.effect(`rekeys retained ${fixture.name} so the fork owns a resolvable file`, () =>
      Effect.gen(function* () {
        const origin = makeOriginThread();
        const sourceAttachment = {
          type: fixture.type,
          id: "origin-thread-00000000-0000-4000-8000-000000000001",
          name: fixture.name,
          mimeType: fixture.mimeType,
          sizeBytes: 42,
        };
        const messages = origin.messages.map((entry, index) =>
          index === 1 ? { ...entry, attachments: [sourceAttachment] } : entry,
        );
        const events = yield* forkThreadForTest({
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
          expect(target?.id).toMatch(new RegExp(`^forked-thread-[0-9a-f-]{36}${fixture.suffix}$`));
          expect(forked.payload.attachmentCopies).toEqual([{ source: sourceAttachment, target }]);
        }
      }),
    );
  }

  it.effect("forking at an earlier boundary re-emits only that prefix", () =>
    Effect.gen(function* () {
      const events = yield* forkThreadForTest({
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

  it.effect(
    "copies native answer history and files without replaying a response or changing messages",
    () =>
      Effect.gen(function* () {
        const original = makeOriginThread({
          activities: [questionAnswerActivity("turn-1"), questionAnswerActivity("turn-2", "later")],
        });
        const events = yield* forkThreadForTest({
          command: forkCommand({ sourceAssistantMessageId: A1 }),
          readModel: makeReadModel({ origin: original }),
        });
        const histories = events.filter((event) => event.type === "thread.activity-appended");
        expect(histories).toHaveLength(1);
        const history = histories[0]!.payload.activity;
        const forked = events.find((event) => event.type === "thread.forked")!;
        const copiedAssistant = events.find(
          (event) => event.type === "thread.message-sent" && event.payload.text === "first answer",
        )!;
        expect(copiedAssistant.type).toBe("thread.message-sent");
        if (copiedAssistant.type !== "thread.message-sent") return;
        expect(history.turnId).toBe(copiedAssistant.payload.turnId);
        expect(history.id).not.toBe(original.activities[0]!.id);
        const decoded = retainQuestionAnswers([history], new Set([history.turnId!]));
        expect(decoded.error).toBeNull();
        expect(decoded.answers[0]!.answer.requestId).not.toBe("request-1");
        expect(decoded.answers[0]!.answer.answers).toEqual({ dataset: "Use the measured data" });
        const files = questionAnswerAttachments(decoded.answers);
        expect(files[0]!.id).toMatch(/^forked-thread-.*-csv$/);
        expect(forked.payload.attachmentCopies.map((copy) => copy.target)).toEqual(files);
        expect(events.some((event) => event.type === "thread.user-input-response-requested")).toBe(
          false,
        );
        expect(events.every((event) => event.aggregateId === NEW)).toBe(true);
        expect(original.activities).toHaveLength(2);
      }),
  );

  it.effect("does not retain later system messages or messages after the selected response", () =>
    Effect.gen(function* () {
      const origin = makeOriginThread();
      const messages = [
        ...origin.messages,
        message({
          id: "later-system",
          role: "system",
          text: "Future instructions",
          turnId: null,
          createdAt: NOW,
        }),
      ];
      const events = yield* forkThreadForTest({
        command: forkCommand({ sourceAssistantMessageId: A1 }),
        readModel: makeReadModel({ origin: { ...origin, messages } }),
      });
      expect(
        events
          .filter((event) => event.type === "thread.message-sent")
          .map((event) => event.payload.text),
      ).toEqual(["first prompt", "first answer"]);
    }),
  );

  it.effect(
    "uses authoritative SQL message identity for historical messages without a turn id",
    () =>
      Effect.gen(function* () {
        const origin = makeOriginThread();
        const messages = origin.messages.map((message) =>
          message.id === A1 ? { ...message, turnId: null } : message,
        );
        const events = yield* forkThreadForTest({
          command: forkCommand({ sourceAssistantMessageId: A1 }),
          readModel: makeReadModel({ origin: { ...origin, messages } }),
        });
        const copied = events.filter((event) => event.type === "thread.message-sent");
        expect(copied.map((event) => event.payload.text)).toEqual(["first prompt", "first answer"]);
        expect(copied[1]?.payload.turnId).not.toBeNull();
      }),
  );

  it.effect("forking from a user message retains only the prior completed boundary", () =>
    Effect.gen(function* () {
      const sourceAttachment = {
        type: "image" as const,
        id: "origin-thread-00000000-0000-4000-8000-000000000002",
        name: "question.png",
        mimeType: "image/png",
        sizeBytes: 52,
      };
      const origin = makeOriginThread({
        messages: makeOriginThread().messages.map((entry) =>
          entry.id === "user-2" ? { ...entry, attachments: [sourceAttachment] } : entry,
        ),
      });
      const assistantCommand = forkCommand();
      const command: ThreadForkCommand = {
        type: assistantCommand.type,
        commandId: assistantCommand.commandId,
        originThreadId: assistantCommand.originThreadId,
        newThreadId: assistantCommand.newThreadId,
        sourceUserMessageId: MessageId.make("user-2"),
        workspaceMode: assistantCommand.workspaceMode,
      };
      const events = yield* forkThreadForTest({
        command,
        readModel: makeReadModel({ origin }),
      });

      const retainedTexts = events
        .filter((event) => event.type === "thread.message-sent")
        .map((event) => (event.type === "thread.message-sent" ? event.payload.text : ""));
      expect(retainedTexts).toEqual(["first prompt", "first answer"]);

      const forked = events.find((event) => event.type === "thread.forked");
      expect(forked?.type).toBe("thread.forked");
      if (forked?.type === "thread.forked") {
        expect(forked.payload.forkPointKind).toBe("user-message");
        expect(forked.payload.sourceUserMessageId).toBe("user-2");
        expect(forked.payload.baselineAssistantMessageId).toBeTruthy();
        expect(forked.payload.copiedBoundaries).toHaveLength(1);
        expect(forked.payload.copiedBoundaries[0]?.assistantMessageId).toBe(
          forked.payload.baselineAssistantMessageId,
        );
        expect(forked.payload.attachmentCopies).toHaveLength(0);
      }
      expect(retainedTexts).not.toContain("second answer");
    }),
  );

  it.effect("forking from the first user message starts from an empty transcript", () =>
    Effect.gen(function* () {
      const assistantCommand = forkCommand();
      const command: ThreadForkCommand = {
        type: assistantCommand.type,
        commandId: assistantCommand.commandId,
        originThreadId: assistantCommand.originThreadId,
        newThreadId: assistantCommand.newThreadId,
        sourceUserMessageId: MessageId.make("user-1"),
        workspaceMode: "local",
      };
      const events = yield* forkThreadForTest({
        command,
        readModel: makeReadModel(),
      });

      expect(events.map((event) => event.type)).toEqual(["thread.created", "thread.forked"]);
      const forked = events.find((event) => event.type === "thread.forked");
      expect(forked?.type).toBe("thread.forked");
      if (forked?.type === "thread.forked") {
        expect(forked.payload.forkAtTurnId).toBeNull();
        expect(forked.payload.forkAtTurnCount).toBe(0);
        expect(forked.payload.baselineAssistantMessageId).toBeNull();
        expect(forked.payload.copiedBoundaries).toEqual([]);
      }
    }),
  );

  it.effect(
    "forks an existing fork from copied logical boundaries without retaining later turns",
    () =>
      Effect.gen(function* () {
        const copiedTurn1 = TurnId.make("copied-turn-1");
        const copiedTurn2 = TurnId.make("copied-turn-2");
        const copiedUser1 = MessageId.make("copied-user-1");
        const copiedUser2 = MessageId.make("copied-user-2");
        const copiedAssistant1 = MessageId.make("copied-assistant-1");
        const copiedAssistant2 = MessageId.make("copied-assistant-2");
        const recursiveBoundaries: ReadonlyArray<OrchestrationForkBoundary> = [
          boundaries[0]!,
          {
            turnId: copiedTurn1,
            conversationTurnCount: 0,
            userMessageId: copiedUser1,
            assistantMessageId: copiedAssistant1,
            completedAt: "2026-01-01T00:00:02.000Z",
            checkpointTurnCount: null,
            checkpointStatus: null,
          },
          {
            turnId: copiedTurn2,
            conversationTurnCount: 0,
            userMessageId: copiedUser2,
            assistantMessageId: copiedAssistant2,
            completedAt: "2026-01-01T00:00:04.000Z",
            checkpointTurnCount: null,
            checkpointStatus: null,
          },
        ];
        const recursiveOrigin = makeOriginThread({
          messages: [
            message({
              id: copiedUser1,
              role: "user",
              text: "copied first prompt",
              turnId: copiedTurn1,
              createdAt: "2026-01-01T00:00:01.000Z",
            }),
            message({
              id: copiedAssistant1,
              role: "assistant",
              text: "copied first answer",
              turnId: copiedTurn1,
              createdAt: "2026-01-01T00:00:02.000Z",
            }),
            message({
              id: copiedUser2,
              role: "user",
              text: "copied second prompt",
              turnId: copiedTurn2,
              createdAt: "2026-01-01T00:00:03.000Z",
            }),
            message({
              id: copiedAssistant2,
              role: "assistant",
              text: "copied second answer",
              turnId: copiedTurn2,
              createdAt: "2026-01-01T00:00:04.000Z",
            }),
          ],
          checkpoints: [],
          conversationForkBoundaries: undefined,
          forkLineage: {
            originThreadId: ORIGIN,
            baselineAssistantMessageId: copiedAssistant2,
          },
        });

        const assistantEvents = yield* forkThreadForTest({
          command: forkCommand({ sourceAssistantMessageId: copiedAssistant1 }),
          readModel: makeReadModel({ origin: recursiveOrigin }),
          resolvedBoundaries: recursiveBoundaries,
        });
        expect(
          assistantEvents
            .filter((event) => event.type === "thread.message-sent")
            .map((event) => (event.type === "thread.message-sent" ? event.payload.text : "")),
        ).toEqual(["copied first prompt", "copied first answer"]);
        const assistantForked = assistantEvents.find((event) => event.type === "thread.forked");
        expect(
          assistantForked?.type === "thread.forked"
            ? assistantForked.payload.copiedBoundaries.length
            : 0,
        ).toBe(1);

        const userCommand = forkCommand({
          sourceAssistantMessageId: undefined,
          sourceUserMessageId: copiedUser2,
        });
        const userEvents = yield* forkThreadForTest({
          command: userCommand,
          readModel: makeReadModel({ origin: recursiveOrigin }),
          resolvedBoundaries: recursiveBoundaries,
        });
        expect(
          userEvents
            .filter((event) => event.type === "thread.message-sent")
            .map((event) => (event.type === "thread.message-sent" ? event.payload.text : "")),
        ).toEqual(["copied first prompt", "copied first answer"]);
        expect(
          userEvents.some(
            (event) =>
              event.type === "thread.message-sent" && event.payload.text === "copied second prompt",
          ),
        ).toBe(false);
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
      const error = yield* forkThreadWithUnmatchedResolution({
        command,
        readModel: makeReadModel(),
        resolvedBoundaries: boundaries,
      }).pipe(Effect.flip);
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
      const events = yield* forkThreadForTest({
        command: forkCommand({
          sourceAssistantMessageId: MessageId.make("inherited-assistant-only"),
        }),
        readModel: makeReadModel({ origin: reforkOrigin }),
        resolvedBoundaries: reforkOrigin.conversationForkBoundaries ?? [],
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
      const events = yield* forkThreadForTest({
        command: forkCommand({
          sourceAssistantMessageId: MessageId.make("post-fork-assistant-1"),
        }),
        readModel: makeReadModel({ origin: reforkOrigin }),
        resolvedBoundaries: reforkOrigin.conversationForkBoundaries ?? [],
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
      const events = yield* forkThreadForTest({
        command: forkCommand(),
        readModel: makeReadModel({ origin }),
      });
      expect(events.some((event) => event.type === "thread.forked")).toBe(true);
    }),
  );

  it.effect("does not include a newer streaming turn in the selected completed prefix", () =>
    Effect.gen(function* () {
      const streamingOrigin = makeOriginThread();
      const events = yield* forkThreadForTest({
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
      const error = yield* forkThreadForTest({
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
      const error = yield* forkThreadForTest({
        command: forkCommand(),
        readModel: makeReadModel({ origin: null }),
      }).pipe(Effect.flip);
      expect(error._tag).toBe("OrchestrationCommandInvariantError");
    }),
  );

  it.effect("rejects a nonexistent or stale conversational boundary", () =>
    Effect.gen(function* () {
      const error = yield* forkThreadWithUnmatchedResolution({
        command: forkCommand({
          sourceAssistantMessageId: MessageId.make("missing-assistant"),
        }),
        readModel: makeReadModel(),
        resolvedBoundaries: boundaries,
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
      const events = yield* forkThreadForTest({
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

  it.effect("rejects a legacy projectless fork origin", () =>
    Effect.gen(function* () {
      const origin = makeOriginThread({
        projectId: null,
        workspaceRoot: "/tmp/legacy-environment",
        branch: null,
        worktreePath: null,
        checkpoints: [],
      });
      const error = yield* forkThreadForTest({
        command: forkCommand({ workspaceMode: "local" }),
        readModel: makeReadModel({ origin }),
      }).pipe(Effect.flip);

      expect(error._tag).toBe("OrchestrationCommandInvariantError");
      if (error._tag === "OrchestrationCommandInvariantError") {
        expect(error.detail).toContain("has no project and cannot be forked");
      }
    }),
  );

  it.effect("rejects a new worktree when the conversational boundary has no checkpoint", () =>
    Effect.gen(function* () {
      const origin = makeOriginThread({ checkpoints: [] });
      const error = yield* forkThreadForTest({
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
      const error = yield* forkThreadForTest({
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

      const events = yield* forkThreadForTest({ command: forkCommand(), readModel });

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

  // SCIENT-OWNED RESOLVER TESTS — these exercise the decider with
  // `resolvedBoundaries` (SQL-backed), proving it does not trust
  // client-shaped `conversationForkBoundaries` arrays from the read model.

  it.effect("uses SQL-backed resolved boundaries and ignores stale read model boundaries", () =>
    Effect.gen(function* () {
      // The read model carries STALE boundaries that omit turn-2/A2 entirely.
      // The resolver provides the CORRECT SQL-backed boundaries including A2.
      const staleOrigin = makeOriginThread({
        conversationForkBoundaries: [
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
            checkpointStatus: "ready",
          },
          // NOTE: turn-2/A2 is deliberately absent from the stale read model.
        ],
      });
      const resolvedBoundaries = [
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
      const events = yield* forkThreadForTest({
        command: forkCommand({ sourceAssistantMessageId: A2 }),
        readModel: makeReadModel({ origin: staleOrigin }),
        resolvedBoundaries,
      });

      // The decider used the resolved boundaries (which include A2), not the
      // stale read model (which omits it). The fork succeeds and retains
      // the full prefix through turn-2.
      const forked = events.find((event) => event.type === "thread.forked");
      expect(forked?.type === "thread.forked" ? forked.payload.forkAtTurnId : null).toBe(T2);
      expect(forked?.type === "thread.forked" ? forked.payload.forkAtTurnCount : null).toBe(2);
      const texts = events.flatMap((event) =>
        event.type === "thread.message-sent" ? [event.payload.text] : [],
      );
      expect(texts).toEqual(["first prompt", "first answer", "second prompt", "second answer"]);
    }),
  );

  it.effect("rejects a resolved boundary absent from SQL-backed boundaries", () =>
    Effect.gen(function* () {
      // The resolver provides boundaries that do NOT include the requested
      // assistant. The decider must reject, even if the stale read model
      // does include it.
      const originWithStaleBoundary = makeOriginThread();
      const resolvedBoundaries = [
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
        // A2 is absent from resolved boundaries.
      ];
      const error = yield* forkThreadWithUnmatchedResolution({
        command: forkCommand({ sourceAssistantMessageId: A2 }),
        readModel: makeReadModel({ origin: originWithStaleBoundary }),
        resolvedBoundaries,
      }).pipe(Effect.flip);
      expect(error._tag).toBe("OrchestrationCommandInvariantError");
    }),
  );

  it.effect("ignores extra fields in the command payload (narrow public input)", () =>
    Effect.gen(function* () {
      // The command schema is Schema.Struct (not strict), so extra keys
      // survive decoding but the decider reads only declared public fields.
      // Inject extra boundary data that must NOT
      // influence the fork point.
      const commandWithExtra = {
        ...forkCommand({ sourceAssistantMessageId: A2 }),
        // Client-shaped fields that must be ignored:
        conversationForkBoundaries: [
          {
            turnId: TurnId.make("turn-1"),
            conversationTurnCount: 1,
            userMessageId: MessageId.make("user-1"),
            assistantMessageId: A1,
            completedAt: NOW,
            checkpointTurnCount: null,
            checkpointStatus: null,
          },
        ],
        retainedPrefix: [],
        turnCount: 1,
        checkpointCount: 0,
        title: "Caller-provided title",
      } as ThreadForkCommand;

      const events = yield* forkThreadForTest({
        command: commandWithExtra,
        readModel: makeReadModel(),
      });

      // The explicit authoritative fixture selects A2/turn-2. Extra
      // client-shaped command fields cannot override that selection.
      const forked = events.find((event) => event.type === "thread.forked");
      expect(forked?.type === "thread.forked" ? forked.payload.forkAtTurnId : null).toBe(T2);
      expect(forked?.type === "thread.forked" ? forked.payload.forkAtTurnCount : null).toBe(2);

      // An undeclared `title` field is still ignored. Only the contract's
      // explicit `titleOverride` field can select a destination title.
      const created = events[0];
      expect(created?.type === "thread.created" ? created.payload.title : null).toBe(
        "Origin conversation (2)",
      );
    }),
  );

  it.effect("selects an older boundary via resolved boundaries while newer turns exist", () =>
    Effect.gen(function* () {
      const resolvedBoundaries = [
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
      const events = yield* forkThreadForTest({
        command: forkCommand({ sourceAssistantMessageId: A1 }),
        readModel: makeReadModel(),
        resolvedBoundaries,
      });

      const forked = events.find((event) => event.type === "thread.forked");
      expect(forked?.type === "thread.forked" ? forked.payload.forkAtTurnId : null).toBe(
        TurnId.make("turn-1"),
      );
      expect(forked?.type === "thread.forked" ? forked.payload.forkAtTurnCount : null).toBe(1);
      // Only the first turn's prefix is retained.
      const texts = events.flatMap((event) =>
        event.type === "thread.message-sent" ? [event.payload.text] : [],
      );
      expect(texts).toEqual(["first prompt", "first answer"]);
    }),
  );

  it.effect("preserves origin immutability when using resolved boundaries", () =>
    Effect.gen(function* () {
      const readModel = makeReadModel();
      const originBefore = structuredClone(
        readModel.threads.find((thread) => thread.id === ORIGIN),
      );
      const resolvedBoundaries = [
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
      const events = yield* forkThreadForTest({
        command: forkCommand(),
        readModel,
        resolvedBoundaries,
      });

      const originAfter = readModel.threads.find((thread) => thread.id === ORIGIN);
      expect(originAfter).toEqual(originBefore);
      for (const event of events) {
        expect(event.aggregateId).not.toBe(ORIGIN);
      }
    }),
  );

  it.effect("does not synthesize checkpoint fallback when resolved boundaries are provided", () =>
    Effect.gen(function* () {
      // The read model has NO conversationForkBoundaries and NO checkpoints,
      // which would trigger the legacy fallback. But resolved boundaries are
      // provided, so the decider must use them exclusively.
      const originNoBoundaries = makeOriginThread({
        conversationForkBoundaries: undefined,
        checkpoints: [],
      });
      const resolvedBoundaries = [
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
          checkpointTurnCount: null,
          checkpointStatus: null,
        },
        {
          turnId: T2,
          conversationTurnCount: 2,
          userMessageId: MessageId.make("user-2"),
          assistantMessageId: A2,
          completedAt: NOW,
          checkpointTurnCount: null,
          checkpointStatus: null,
        },
      ];
      const events = yield* forkThreadForTest({
        command: forkCommand({ sourceAssistantMessageId: A2, workspaceMode: "local" }),
        readModel: makeReadModel({ origin: originNoBoundaries }),
        resolvedBoundaries,
      });

      // The fork succeeds at A2/turn-2 using the resolved boundaries.
      const forked = events.find((event) => event.type === "thread.forked");
      expect(forked?.type === "thread.forked" ? forked.payload.forkAtTurnId : null).toBe(T2);
      expect(forked?.type === "thread.forked" ? forked.payload.forkAtTurnCount : null).toBe(2);
      // No checkpoint since the resolved boundaries have null checkpoint info.
      expect(
        forked?.type === "thread.forked" ? forked.payload.sourceCheckpointTurnCount : undefined,
      ).toBeNull();
    }),
  );

  it.effect("copies reasoning in its own turn, the work log, and composer context", () =>
    Effect.gen(function* () {
      const base = makeOriginThread();
      const bigOutput = "o".repeat(40_000);
      const activity = (
        id: string,
        kind: string,
        turnId: string,
        payload: unknown,
      ): OrchestrationThreadActivity => ({
        id: EventId.make(id),
        tone: "tool",
        kind,
        summary: id,
        payload,
        turnId: TurnId.make(turnId),
        createdAt: NOW,
      });
      const origin = makeOriginThread({
        messages: [
          ...base.messages
            .slice(0, 3)
            .map((entry) =>
              entry.id === MessageId.make("user-2")
                ? { ...entry, context: { version: 1 as const, records: [] } }
                : entry,
            ),
          message({
            id: "reasoning-2",
            role: "reasoning",
            text: "thinking about the second prompt",
            turnId: "turn-2",
            createdAt: "2026-01-01T00:00:03.500Z",
          }),
          base.messages[3]!,
        ],
        activities: [
          activity("tool-done", "tool.completed", "turn-2", {
            toolCallId: "call-1",
            data: { output: bigOutput },
          }),
          activity("approval", "approval.requested", "turn-2", { requestId: "req-1" }),
          activity("usage", "context-window.updated", "turn-2", { usedTokens: 10 }),
        ],
      });
      const events = yield* forkThreadForTest({
        command: forkCommand({ sourceAssistantMessageId: A2 }),
        readModel: makeReadModel({ origin }),
      });

      const sent = events.flatMap((event) =>
        event.type === "thread.message-sent" ? [event.payload] : [],
      );
      const reasoning = sent.find((entry) => entry.role === "reasoning");
      const answer = sent.find((entry) => entry.text === "second answer");
      expect(reasoning?.turnId).not.toBeNull();
      expect(reasoning?.turnId).toBe(answer?.turnId);
      expect(sent.find((entry) => entry.text === "second prompt")?.context).toEqual({
        version: 1,
        records: [],
      });

      const copied = events.flatMap((event) =>
        event.type === "thread.activity-appended" ? [event.payload.activity] : [],
      );
      expect(copied.map((entry) => entry.kind)).toEqual(["tool.completed"]);
      expect(copied[0]?.turnId).toBe(answer?.turnId);
      const copiedPayload = copied[0]?.payload as { data: { output: string } } | undefined;
      const output = copiedPayload?.data.output ?? "";
      expect(output.length).toBeLessThan(bigOutput.length);
      expect(output).toContain("truncated in fork");

      const forked = events.find((event) => event.type === "thread.forked");
      const inherited = forked?.type === "thread.forked" ? forked.payload.inheritedTurnIds : [];
      const copiedTurns = new Set(sent.flatMap((entry) => (entry.turnId ? [entry.turnId] : [])));
      expect(new Set(inherited)).toEqual(copiedTurns);
    }),
  );

  it.effect("forks a running turn with its latest traces", () =>
    Effect.gen(function* () {
      const base = makeOriginThread();
      const activity = (
        id: string,
        kind: string,
        payload: unknown,
        summary = id,
      ): OrchestrationThreadActivity => ({
        id: EventId.make(id),
        tone: "tool",
        kind,
        summary,
        payload,
        turnId: T2,
        createdAt: NOW,
      });
      const origin = makeOriginThread({
        messages: [
          ...base.messages.slice(0, 2),
          message({
            id: "user-2",
            role: "user",
            text: "second prompt",
            turnId: null,
            createdAt: "2026-01-01T00:00:03.000Z",
          }),
          message({
            id: "reasoning-2",
            role: "reasoning",
            text: "still thinking about",
            turnId: "turn-2",
            createdAt: "2026-01-01T00:00:03.500Z",
            streaming: true,
          }),
          message({
            id: "assistant-2",
            role: "assistant",
            text: "Partial ans",
            turnId: "turn-2",
            createdAt: "2026-01-01T00:00:04.000Z",
            streaming: true,
          }),
        ],
        activities: [
          activity("edit-done", "tool.completed", {
            toolCallId: "call-edit",
            data: { changes: [{ path: "src/fit.py" }] },
          }),
          activity("run-started", "tool.started", { toolCallId: "call-run" }),
          activity("run-progress", "tool.updated", { toolCallId: "call-run", detail: "npm test" }),
          activity(
            "approval",
            "approval.requested",
            { requestId: "req-1" },
            "Approve running the migration",
          ),
        ],
        latestTurn: {
          turnId: T2,
          state: "running",
          requestedAt: NOW,
          startedAt: NOW,
          completedAt: null,
          assistantMessageId: null,
        },
        session: { ...IDLE_SESSION, status: "running", activeTurnId: T2 },
      });
      const completed = boundaries.slice(0, 2);
      const events = yield* forkThreadAuthoritative({
        command: forkCommand({
          sourceAssistantMessageId: undefined,
          sourceRunningTurnId: T2,
        }),
        readModel: makeReadModel({ origin }),
        resolvedBoundaries: {
          originThreadId: ORIGIN,
          forkPoint: { kind: "running-turn", turnId: T2 },
          boundaries: completed,
          selectedBoundary: completed[1]!,
        },
      });

      const sent = events.flatMap((event) =>
        event.type === "thread.message-sent" ? [event.payload] : [],
      );
      expect(sent.map((entry) => entry.text)).toEqual([
        "first prompt",
        "first answer",
        "second prompt",
        "still thinking about",
        "Partial ans",
      ]);
      expect(sent.every((entry) => entry.streaming === false)).toBe(true);
      const liveTurnId = sent.at(-1)?.turnId;
      expect(sent.slice(2).every((entry) => entry.turnId === liveTurnId)).toBe(true);

      const forked = events.find((event) => event.type === "thread.forked");
      if (forked?.type !== "thread.forked") return expect.unreachable();
      const cut = forked.payload.midTurnCut;
      expect(forked.payload.forkPointKind).toBe("running-turn");
      expect(forked.payload.baselineTurnId).toBe(liveTurnId);
      expect(forked.payload.sourceCheckpointTurnCount).toBeNull();
      expect(cut?.sourceTurnId).toBe(T2);
      expect(cut?.importedTurnId).toBe(liveTurnId);
      expect(cut?.partialMessageIds).toEqual(sent.slice(3).map((entry) => entry.messageId));
      expect(cut?.inFlightActivityIds).toHaveLength(1);
      expect(cut?.pendingRequests).toEqual(["Approve running the migration"]);
      expect(cut?.touchedFiles).toEqual(["src/fit.py"]);
      expect(cut?.sharedWorkspace).toBe(true);
      // The running turn's partial answer is a completed turn of the fork.
      expect(forked.payload.copiedBoundaries).toHaveLength(2);

      const copied = events.flatMap((event) =>
        event.type === "thread.activity-appended" ? [event.payload.activity] : [],
      );
      // Tool rows only: the approval request is never executable in the fork.
      expect(copied.map((entry) => entry.kind).toSorted()).toEqual([
        "tool.completed",
        "tool.updated",
      ]);
      expect(copied.map((entry) => entry.id)).toContain(cut?.inFlightActivityIds[0]);
    }),
  );

  it.effect("refuses to fork a turn that is no longer running", () =>
    Effect.gen(function* () {
      const completed = boundaries.slice(0, 2);
      const result = yield* Effect.result(
        forkThreadAuthoritative({
          command: forkCommand({ sourceAssistantMessageId: undefined, sourceRunningTurnId: T2 }),
          readModel: makeReadModel(),
          resolvedBoundaries: {
            originThreadId: ORIGIN,
            forkPoint: { kind: "running-turn", turnId: T2 },
            boundaries: completed,
            selectedBoundary: completed[1]!,
          },
        }),
      );
      expect(result._tag).toBe("Failure");
      expect(String(result._tag === "Failure" ? result.failure.message : "")).toContain(
        "no longer running",
      );
    }),
  );

  it.effect("binds an interrupted request to its own turn in a running-turn fork", () =>
    Effect.gen(function* () {
      const base = makeOriginThread();
      const T_INT = TurnId.make("turn-interrupted");
      const T_RUN = TurnId.make("turn-running");
      const origin = makeOriginThread({
        messages: [
          ...base.messages.slice(0, 2),
          message({
            id: "user-interrupted",
            role: "user",
            text: "first try",
            turnId: null,
            createdAt: "2026-01-01T00:00:03.000Z",
          }),
          message({
            id: "assistant-interrupted",
            role: "assistant",
            text: "partial before stop",
            turnId: "turn-interrupted",
            createdAt: "2026-01-01T00:00:03.500Z",
          }),
          message({
            id: "user-running",
            role: "user",
            text: "second try",
            turnId: null,
            createdAt: "2026-01-01T00:00:04.000Z",
          }),
          message({
            id: "reasoning-running",
            role: "reasoning",
            text: "thinking",
            turnId: "turn-running",
            createdAt: "2026-01-01T00:00:04.500Z",
            streaming: true,
          }),
        ],
        activities: [
          {
            id: EventId.make("legacy-sequenced"),
            tone: "tool",
            kind: "tool.completed",
            summary: "old tool",
            payload: { toolCallId: "call-old" },
            turnId: TurnId.make("turn-1"),
            sequence: 99,
            createdAt: NOW,
          },
        ],
        latestTurn: {
          turnId: T_RUN,
          state: "running",
          requestedAt: NOW,
          startedAt: NOW,
          completedAt: null,
          assistantMessageId: null,
        },
        session: { ...IDLE_SESSION, status: "running", activeTurnId: T_RUN },
      });
      const completed = boundaries.slice(0, 2);
      const events = yield* forkThreadAuthoritative({
        command: forkCommand({ sourceAssistantMessageId: undefined, sourceRunningTurnId: T_RUN }),
        readModel: makeReadModel({ origin }),
        resolvedBoundaries: {
          originThreadId: ORIGIN,
          forkPoint: { kind: "running-turn", turnId: T_RUN },
          boundaries: completed,
          selectedBoundary: completed[1]!,
          turnRequests: [
            { turnId: TurnId.make("turn-1"), userMessageId: MessageId.make("user-1") },
            { turnId: T_INT, userMessageId: MessageId.make("user-interrupted") },
          ],
        },
      });
      const sent = events.flatMap((event) =>
        event.type === "thread.message-sent" ? [event.payload] : [],
      );
      const turnOf = (text: string) => sent.find((entry) => entry.text === text)?.turnId;
      // The interrupted request stays with the answer it produced.
      expect(turnOf("first try")).toBe(turnOf("partial before stop"));
      expect(turnOf("second try")).toBe(turnOf("thinking"));
      expect(turnOf("first try")).not.toBe(turnOf("second try"));

      const forked = events.find((event) => event.type === "thread.forked");
      if (forked?.type !== "thread.forked") return expect.unreachable();
      // No answer text in the running turn yet: the baseline stays the last
      // completed turn, and the interrupted turn's boundary follows it in order.
      expect(forked.payload.baselineTurnId).toBe(turnOf("first answer"));
      expect(forked.payload.copiedBoundaries.map((boundary) => boundary.turnId)).toEqual([
        turnOf("first answer"),
        turnOf("partial before stop"),
      ]);
      // Copied activities are ordered in the fork, never by origin sequence.
      const copied = events.flatMap((event) =>
        event.type === "thread.activity-appended" ? [event.payload.activity] : [],
      );
      expect(copied).toHaveLength(1);
      expect(copied[0]).not.toHaveProperty("sequence");
    }),
  );

  it.effect("points copied composer context at the fork's own attachment copies", () =>
    Effect.gen(function* () {
      const base = makeOriginThread();
      const image = {
        type: "image" as const,
        id: "origin-image-1",
        name: "plot.png",
        mimeType: "image/png",
        sizeBytes: 10,
      };
      const origin = makeOriginThread({
        messages: base.messages.map((entry) =>
          entry.id === MessageId.make("user-2")
            ? {
                ...entry,
                attachments: [image],
                context: {
                  version: 1 as const,
                  records: [{ kind: "image", contextId: "ctx-1", attachmentId: "origin-image-1" }],
                } as unknown as OrchestrationMessage["context"],
              }
            : entry,
        ),
      });
      const events = yield* forkThreadForTest({
        command: forkCommand({ sourceAssistantMessageId: A2 }),
        readModel: makeReadModel({ origin }),
      });
      const prompt = events.flatMap((event) =>
        event.type === "thread.message-sent" && event.payload.text === "second prompt"
          ? [event.payload]
          : [],
      )[0];
      const copiedImageId = prompt?.attachments?.[0]?.id;
      expect(copiedImageId).toBeDefined();
      expect(copiedImageId).not.toBe("origin-image-1");
      expect(
        (prompt?.context?.records[0] as { readonly attachmentId?: string } | undefined)
          ?.attachmentId,
      ).toBe(copiedImageId);
    }),
  );

  // A turn that ended without an answer (the provider failed before replying).
  const TX = TurnId.make("turn-x");
  const unansweredActivity: OrchestrationThreadActivity = {
    id: EventId.make("lost-tool"),
    tone: "tool",
    kind: "tool.completed",
    summary: "Ran command",
    payload: { toolCallId: "lost-call" },
    turnId: TX,
    createdAt: NOW,
  };
  const unansweredBoundary = (conversationTurnCount: number): OrchestrationForkBoundary => ({
    turnId: TX,
    conversationTurnCount,
    userMessageId: MessageId.make("user-x"),
    assistantMessageId: null,
    completedAt: NOW,
    checkpointTurnCount: conversationTurnCount,
    checkpointStatus: "ready",
  });
  const unansweredMessages = (createdAt: string) => [
    message({ id: "user-x", role: "user", text: "lost prompt", turnId: null, createdAt }),
    message({
      id: "reasoning-x",
      role: "reasoning",
      text: "lost thinking",
      turnId: "turn-x",
      createdAt,
    }),
    // An answer the provider never finished: not history, and no reason to refuse the fork.
    message({
      id: "partial-x",
      role: "assistant",
      text: "lost partial answer",
      turnId: "turn-x",
      createdAt,
      streaming: true,
    }),
  ];
  const sentIn = (events: ReadonlyArray<{ readonly type: string; readonly payload: unknown }>) =>
    events.flatMap((event) =>
      event.type === "thread.message-sent"
        ? [event.payload as { text: string; turnId: TurnId | null; messageId: MessageId }]
        : [],
    );
  const activitiesIn = (
    events: ReadonlyArray<{ readonly type: string; readonly payload: unknown }>,
  ) =>
    events.flatMap((event) =>
      event.type === "thread.activity-appended"
        ? [(event.payload as { activity: OrchestrationThreadActivity }).activity]
        : [],
    );

  it.effect("carries a turn that ended without an answer, with its request and work log", () =>
    Effect.gen(function* () {
      const base = makeOriginThread();
      const origin = makeOriginThread({
        messages: [
          ...base.messages.slice(0, 2),
          ...unansweredMessages("2026-01-01T00:00:02.500Z"),
          ...base.messages.slice(2),
        ],
        activities: [unansweredActivity],
        checkpoints: [checkpoint("turn-1", 1), checkpoint("turn-x", 2), checkpoint("turn-2", 3)],
      });
      const resolvedBoundaries = [
        boundaries[0]!,
        boundaries[1]!,
        unansweredBoundary(2),
        { ...boundaries[2]!, conversationTurnCount: 3, checkpointTurnCount: 3 },
      ];
      const events = yield* forkThreadForTest({
        command: forkCommand({ sourceAssistantMessageId: A2 }),
        readModel: makeReadModel({ origin }),
        resolvedBoundaries,
      });

      const sent = sentIn(events);
      expect(sent.map((entry) => entry.text)).toEqual([
        "first prompt",
        "first answer",
        "lost prompt",
        "lost thinking",
        "second prompt",
        "second answer",
      ]);
      const lostTurnId = sent[2]!.turnId;
      expect(lostTurnId).not.toBeNull();
      expect(sent[3]!.turnId).toBe(lostTurnId);
      expect(new Set(sent.map((entry) => entry.turnId)).size).toBe(3);
      expect(activitiesIn(events).map((entry) => entry.turnId)).toEqual([lostTurnId]);

      const forked = events.find((event) => event.type === "thread.forked");
      if (forked?.type !== "thread.forked") throw new Error("missing thread.forked");
      // Only answered turns are fork points of the fork; the baseline is the selected answer.
      expect(forked.payload.copiedBoundaries.map((boundary) => boundary.turnId)).toEqual([
        sent[1]!.turnId,
        sent[5]!.turnId,
      ]);
      expect(forked.payload.baselineTurnId).toBe(sent[5]!.turnId);
      expect(forked.payload.baselineUserMessageId).toBe(sent[4]!.messageId);
      expect(forked.payload.baselineAssistantMessageId).toBe(sent[5]!.messageId);
      // Revert keeps every inherited turn, the unanswered one included.
      expect(forked.payload.inheritedTurnIds).toContain(lostTurnId);

      // Forking at the answer before it leaves the unanswered turn out.
      const earlier = yield* forkThreadForTest({
        command: forkCommand({ sourceAssistantMessageId: A1 }),
        readModel: makeReadModel({ origin }),
        resolvedBoundaries,
      });
      expect(sentIn(earlier).map((entry) => entry.text)).toEqual(["first prompt", "first answer"]);
      expect(activitiesIn(earlier)).toEqual([]);
    }),
  );

  it.effect(
    "keeps the last answer as baseline when the fork point follows an unanswered turn",
    () =>
      Effect.gen(function* () {
        const base = makeOriginThread();
        const origin = makeOriginThread({
          messages: [
            ...base.messages,
            ...unansweredMessages("2026-01-01T00:00:05.000Z"),
            message({
              id: "user-3",
              role: "user",
              text: "third prompt",
              turnId: null,
              createdAt: "2026-01-01T00:00:06.000Z",
            }),
          ],
          activities: [unansweredActivity],
          checkpoints: [checkpoint("turn-1", 1), checkpoint("turn-2", 2), checkpoint("turn-x", 3)],
        });
        const events = yield* forkThreadForTest({
          command: {
            type: "thread.fork",
            commandId: CommandId.make("cmd-fork"),
            originThreadId: ORIGIN,
            newThreadId: NEW,
            sourceUserMessageId: MessageId.make("user-3"),
            workspaceMode: "new-worktree",
          },
          readModel: makeReadModel({ origin }),
          resolvedBoundaries: [...boundaries, unansweredBoundary(3)],
        });

        const sent = sentIn(events);
        expect(sent.map((entry) => entry.text)).toEqual([
          "first prompt",
          "first answer",
          "second prompt",
          "second answer",
          "lost prompt",
          "lost thinking",
        ]);
        expect(activitiesIn(events).map((entry) => entry.turnId)).toEqual([sent[4]!.turnId]);
        const forked = events.find((event) => event.type === "thread.forked");
        if (forked?.type !== "thread.forked") throw new Error("missing thread.forked");
        // The workspace is the one the unanswered turn left; the conversation
        // baseline stays the last turn that has an answer.
        expect(forked.payload.forkAtTurnId).toBe(TX);
        expect(forked.payload.sourceCheckpointTurnCount).toBe(3);
        expect(forked.payload.baselineTurnId).toBe(sent[3]!.turnId);
        expect(forked.payload.baselineUserMessageId).toBe(sent[2]!.messageId);
        expect(forked.payload.baselineAssistantMessageId).toBe(sent[3]!.messageId);
        expect(forked.payload.copiedBoundaries.at(-1)?.turnId).toBe(forked.payload.baselineTurnId);
        expect(sent[4]!.turnId).not.toBe(forked.payload.baselineTurnId);
      }),
  );

  it.effect("leaves out an unanswered turn requested after the selected turn", () =>
    Effect.gen(function* () {
      // Steering: the second request and its work land before the first answer completes.
      const base = makeOriginThread();
      const origin = makeOriginThread({
        messages: [
          base.messages[0]!,
          ...unansweredMessages("2026-01-01T00:00:01.500Z"),
          base.messages[1]!,
        ],
        activities: [unansweredActivity],
      });
      const events = yield* forkThreadForTest({
        command: forkCommand({ sourceAssistantMessageId: A1 }),
        readModel: makeReadModel({ origin }),
        resolvedBoundaries: [boundaries[0]!, boundaries[1]!, unansweredBoundary(2)],
      });
      expect(sentIn(events).map((entry) => entry.text)).toEqual(["first prompt", "first answer"]);
      expect(activitiesIn(events)).toEqual([]);
    }),
  );

  it.effect("forks past an unanswered turn whose request an older conversation never bound", () =>
    Effect.gen(function* () {
      const base = makeOriginThread();
      const origin = makeOriginThread({
        messages: [
          ...base.messages.slice(0, 2),
          message({
            id: "user-x",
            role: "user",
            text: "lost prompt",
            turnId: null,
            createdAt: "2026-01-01T00:00:02.500Z",
          }),
          ...base.messages.slice(2),
        ],
        activities: [unansweredActivity, questionAnswerActivity(TX, "lost-answer")],
      });
      const events = yield* forkThreadForTest({
        command: forkCommand({ sourceAssistantMessageId: A2 }),
        readModel: makeReadModel({ origin }),
        resolvedBoundaries: [
          boundaries[0]!,
          boundaries[1]!,
          { ...unansweredBoundary(2), userMessageId: null },
          boundaries[2]!,
        ],
      });
      // Nothing ties the request to the turn, so the turn is left out rather than failing.
      expect(sentIn(events).map((entry) => entry.text)).toEqual([
        "first prompt",
        "first answer",
        "second prompt",
        "second answer",
      ]);
      expect(activitiesIn(events)).toEqual([]);
    }),
  );

  it.effect("starts from an empty baseline when no retained turn has an answer", () =>
    Effect.gen(function* () {
      const origin = makeOriginThread({
        messages: [
          ...unansweredMessages("2026-01-01T00:00:01.000Z"),
          message({
            id: "user-next",
            role: "user",
            text: "next prompt",
            turnId: null,
            createdAt: "2026-01-01T00:00:02.000Z",
          }),
        ],
        activities: [unansweredActivity],
        checkpoints: [checkpoint("turn-x", 1)],
      });
      const events = yield* forkThreadForTest({
        command: {
          type: "thread.fork",
          commandId: CommandId.make("cmd-fork"),
          originThreadId: ORIGIN,
          newThreadId: NEW,
          sourceUserMessageId: MessageId.make("user-next"),
          workspaceMode: "local",
        },
        readModel: makeReadModel({ origin }),
        resolvedBoundaries: [boundaries[0]!, unansweredBoundary(1)],
      });
      const sent = sentIn(events);
      expect(sent.map((entry) => entry.text)).toEqual(["lost prompt", "lost thinking"]);
      const forked = events.find((event) => event.type === "thread.forked");
      if (forked?.type !== "thread.forked") throw new Error("missing thread.forked");
      // The same empty baseline as a fork from a conversation's first message:
      // a turn of its own that holds no message, so the carried turn is not it.
      expect(forked.payload.baselineUserMessageId).toBeNull();
      expect(forked.payload.baselineAssistantMessageId).toBeNull();
      expect(forked.payload.copiedBoundaries).toEqual([]);
      expect(sent.map((entry) => entry.turnId)).not.toContain(forked.payload.baselineTurnId);
      expect(forked.payload.inheritedTurnIds).toEqual([sent[0]!.turnId]);
    }),
  );

  it.effect(
    "carries an unanswered turn once in a running-turn fork, as part of the live tail",
    () =>
      Effect.gen(function* () {
        const base = makeOriginThread();
        const T_RUN = TurnId.make("turn-running");
        const origin = makeOriginThread({
          messages: [
            ...base.messages.slice(0, 2),
            ...unansweredMessages("2026-01-01T00:00:03.000Z").slice(0, 2),
            message({
              id: "user-running",
              role: "user",
              text: "running prompt",
              turnId: null,
              createdAt: "2026-01-01T00:00:04.000Z",
            }),
          ],
          activities: [unansweredActivity],
          latestTurn: {
            turnId: T_RUN,
            state: "running",
            requestedAt: NOW,
            startedAt: NOW,
            completedAt: null,
            assistantMessageId: null,
          },
          session: { ...IDLE_SESSION, status: "running", activeTurnId: T_RUN },
        });
        const completed = [boundaries[0]!, boundaries[1]!, unansweredBoundary(2)];
        const events = yield* forkThreadAuthoritative({
          command: forkCommand({ sourceAssistantMessageId: undefined, sourceRunningTurnId: T_RUN }),
          readModel: makeReadModel({ origin }),
          resolvedBoundaries: {
            originThreadId: ORIGIN,
            forkPoint: { kind: "running-turn", turnId: T_RUN },
            boundaries: completed,
            selectedBoundary: completed[2]!,
            turnRequests: [
              { turnId: TurnId.make("turn-1"), userMessageId: MessageId.make("user-1") },
              { turnId: TX, userMessageId: MessageId.make("user-x") },
              { turnId: T_RUN, userMessageId: MessageId.make("user-running") },
            ],
          },
        });
        const sent = sentIn(events);
        expect(sent.map((entry) => entry.text)).toEqual([
          "first prompt",
          "first answer",
          "lost prompt",
          "lost thinking",
          "running prompt",
        ]);
        expect(sent[3]!.turnId).toBe(sent[2]!.turnId);
        expect(sent[4]!.turnId).not.toBe(sent[2]!.turnId);
        expect(activitiesIn(events).map((entry) => entry.turnId)).toEqual([sent[2]!.turnId]);
        const forked = events.find((event) => event.type === "thread.forked");
        if (forked?.type !== "thread.forked") throw new Error("missing thread.forked");
        expect(forked.payload.baselineTurnId).toBe(sent[1]!.turnId);
        expect(forked.payload.baselineAssistantMessageId).toBe(sent[1]!.messageId);
      }),
  );

  it.effect("carries an inherited unanswered turn again when the fork is forked", () =>
    Effect.gen(function* () {
      const inheritedTurn = TurnId.make("inherited-answered");
      const carriedTurn = TurnId.make("inherited-unanswered");
      const nativeTurn = TurnId.make("fork-turn-1");
      const at = (second: number) => `2026-01-01T00:00:0${second}.000Z`;
      const reforkOrigin = makeOriginThread({
        messages: [
          message({
            id: "inherited-user",
            role: "user",
            text: "inherited prompt",
            turnId: inheritedTurn,
            createdAt: at(1),
          }),
          message({
            id: "inherited-assistant",
            role: "assistant",
            text: "inherited answer",
            turnId: inheritedTurn,
            createdAt: at(2),
          }),
          message({
            id: "carried-user",
            role: "user",
            text: "lost prompt",
            turnId: carriedTurn,
            createdAt: at(3),
          }),
          message({
            id: "native-user",
            role: "user",
            text: "new prompt",
            turnId: null,
            createdAt: at(4),
          }),
          message({
            id: "native-assistant",
            role: "assistant",
            text: "new answer",
            turnId: nativeTurn,
            createdAt: at(5),
          }),
        ],
        activities: [{ ...unansweredActivity, turnId: carriedTurn }],
        checkpoints: [checkpoint(nativeTurn, 1)],
      });
      const resolvedBoundaries: OrchestrationForkBoundary[] = [
        boundaries[0]!,
        {
          turnId: inheritedTurn,
          conversationTurnCount: 0,
          userMessageId: MessageId.make("inherited-user"),
          assistantMessageId: MessageId.make("inherited-assistant"),
          completedAt: NOW,
          checkpointTurnCount: null,
          checkpointStatus: null,
        },
        {
          turnId: nativeTurn,
          conversationTurnCount: 1,
          userMessageId: MessageId.make("native-user"),
          assistantMessageId: MessageId.make("native-assistant"),
          completedAt: NOW,
          checkpointTurnCount: 1,
          checkpointStatus: "ready",
        },
      ];
      const fork = (sourceAssistantMessageId: MessageId) =>
        forkThreadAuthoritative({
          command: forkCommand({ sourceAssistantMessageId }),
          readModel: makeReadModel({ origin: reforkOrigin }),
          resolvedBoundaries: {
            ...resolveForkBoundariesFromList({
              originThreadId: ORIGIN,
              sourceAssistantMessageId,
              boundaries: resolvedBoundaries,
            })!,
            inheritedTurnIds: new Set([inheritedTurn, carriedTurn]),
          },
        });

      const events = yield* fork(MessageId.make("native-assistant"));
      const sent = sentIn(events);
      expect(sent.map((entry) => entry.text)).toEqual([
        "inherited prompt",
        "inherited answer",
        "lost prompt",
        "new prompt",
        "new answer",
      ]);
      expect(activitiesIn(events).map((entry) => entry.turnId)).toEqual([sent[2]!.turnId]);
      const forked = events.find((event) => event.type === "thread.forked");
      if (forked?.type !== "thread.forked") throw new Error("missing thread.forked");
      expect(forked.payload.copiedBoundaries).toHaveLength(2);
      expect(forked.payload.inheritedTurnIds).toContain(sent[2]!.turnId);

      // Forked at the inherited answer, the turn after it is not part of the history.
      const earlier = yield* fork(MessageId.make("inherited-assistant"));
      expect(sentIn(earlier).map((entry) => entry.text)).toEqual([
        "inherited prompt",
        "inherited answer",
      ]);
      expect(activitiesIn(earlier)).toEqual([]);
    }),
  );

  it.effect("orders inherited unanswered turns by their recorded order, not by position", () =>
    Effect.gen(function* () {
      const first = TurnId.make("inherited-first");
      const carried = TurnId.make("inherited-unanswered");
      const second = TurnId.make("inherited-second");
      // Copies share timestamps and get random ids, so the unanswered request can
      // sort on either side of an answer. Here it sits before the first answer
      // although its turn follows that one.
      const inherited = (id: string, role: "user" | "assistant", text: string, turnId: TurnId) =>
        message({ id, role, text, turnId, createdAt: "2026-01-01T00:00:01.000Z" });
      const reforkOrigin = makeOriginThread({
        messages: [
          inherited("first-user", "user", "first prompt", first),
          inherited("carried-user", "user", "lost prompt", carried),
          inherited("first-assistant", "assistant", "first answer", first),
          inherited("second-user", "user", "second prompt", second),
          inherited("second-assistant", "assistant", "second answer", second),
        ],
        activities: [{ ...unansweredActivity, turnId: carried }],
        checkpoints: [],
      });
      const copied = (
        turnId: TurnId,
        userMessageId: string,
        assistantMessageId: string,
      ): OrchestrationForkBoundary => ({
        turnId,
        conversationTurnCount: 0,
        userMessageId: MessageId.make(userMessageId),
        assistantMessageId: MessageId.make(assistantMessageId),
        completedAt: NOW,
        checkpointTurnCount: null,
        checkpointStatus: null,
      });
      const resolvedBoundaries = [
        boundaries[0]!,
        copied(first, "first-user", "first-assistant"),
        copied(second, "second-user", "second-assistant"),
      ];
      const fork = (sourceAssistantMessageId: MessageId) =>
        forkThreadAuthoritative({
          command: forkCommand({ sourceAssistantMessageId }),
          readModel: makeReadModel({ origin: reforkOrigin }),
          resolvedBoundaries: {
            ...resolveForkBoundariesFromList({
              originThreadId: ORIGIN,
              sourceAssistantMessageId,
              boundaries: resolvedBoundaries,
            })!,
            inheritedTurnIds: new Set([first, carried, second]),
          },
        });

      const atFirst = yield* fork(MessageId.make("first-assistant"));
      expect(sentIn(atFirst).map((entry) => entry.text)).toEqual(["first prompt", "first answer"]);
      expect(activitiesIn(atFirst)).toEqual([]);

      const atSecond = yield* fork(MessageId.make("second-assistant"));
      expect(sentIn(atSecond).map((entry) => entry.text)).toContain("lost prompt");
      expect(activitiesIn(atSecond)).toHaveLength(1);
    }),
  );
});
