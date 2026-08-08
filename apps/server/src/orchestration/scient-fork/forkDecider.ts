/**
 * Scient conversation-fork decider.
 *
 * SCIENT-OWNED. All fork decision logic lives here so the T3-owned decider only
 * carries a single delegation seam. Retire this module if/when T3 ships native
 * thread fork.
 *
 * A fork creates a NEW, independent thread whose event stream is seeded from a
 * PREFIX of the origin thread (up to a completed assistant response), records fork
 * lineage, and leaves the origin thread completely untouched — the decider emits
 * events ONLY against `newThreadId`, never against `originThreadId`.
 *
 * We re-emit the retained transcript (`thread.message-sent`) as one immutable
 * fork-owned conversation baseline. Git eligibility stays separate: when the
 * selected conversation boundary has a ready checkpoint, its ref is projected
 * as the new thread's turn-zero checkpoint and copied by the fork worker.
 *
 * Where origin history comes from: the decider is a pure function over an
 * authoritatively hydrated origin in `OrchestrationReadModel`. The public
 * command identifies the clicked assistant response; server-owned conversation
 * boundaries resolve its turn/count. Checkpoints are only workspace/revert
 * evidence; they are not conversation-completion authority. See
 * docs/internals/scient-fork-divergence.md for the read-model boot caveat.
 */
import {
  EventId,
  isForkBaselineBoundary,
  MessageId,
  TurnId,
  type ChatAttachment,
  type OrchestrationCommand,
  type OrchestrationEvent,
  type OrchestrationForkBoundary,
  type OrchestrationMessage,
  type OrchestrationReadModel,
  type OrchestrationThread,
  type ThreadForkCommand,
  type ThreadForkedPayload,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import type * as PlatformError from "effect/PlatformError";

import { toSafeThreadAttachmentSegment } from "../../attachmentStore.ts";
import { checkpointRefForThreadTurn } from "../../checkpointing/Utils.ts";
import { OrchestrationCommandInvariantError } from "../Errors.ts";
import { requireThread, requireThreadAbsent } from "../commandInvariants.ts";

const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

/**
 * Distributive so the `type`→`payload` discriminant survives. A plain
 * `Omit<OrchestrationEvent, "sequence">` collapses the discriminated union into
 * one object with unioned properties, which breaks `.type`-narrowing for every
 * consumer that reads emitted events back (tests, projectors, engine).
 */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
/** Event with everything except the store-assigned monotonic sequence. */
type PlannedOrchestrationEvent = DistributiveOmit<OrchestrationEvent, "sequence">;

/**
 * Mirror of `decider.ts`'s private `withEventBase`. Replicated (rather than
 * imported) to keep the fork module free of any dependency back on the T3
 * decider — importing it would create a decider ⇄ scient-fork import cycle,
 * since the decider delegates INTO this module.
 */
const withForkEventBase = (input: {
  readonly commandId: OrchestrationCommand["commandId"];
  readonly aggregateId: OrchestrationEvent["aggregateId"];
  readonly occurredAt: string;
}): Effect.Effect<
  Omit<OrchestrationEvent, "sequence" | "type" | "payload">,
  PlatformError.PlatformError,
  Crypto.Crypto
> =>
  Crypto.Crypto.pipe(
    Effect.flatMap((crypto) =>
      crypto.randomUUIDv4.pipe(
        Effect.map((eventId) => ({
          eventId: EventId.make(eventId),
          aggregateKind: "thread" as const,
          aggregateId: input.aggregateId,
          occurredAt: input.occurredAt,
          commandId: input.commandId,
          causationEventId: null,
          correlationId: input.commandId,
          metadata: {},
        })),
      ),
    ),
  );

/**
 * Which messages belong to the prefix kept through the selected boundaries.
 * Boundary message ids are authoritative when present. Older threads can lack
 * user ids on their boundaries, so the nearest unclaimed user message before
 * each boundary assistant is associated as a legacy fallback.
 */
function retainPrefixMessages(
  messages: ReadonlyArray<OrchestrationMessage>,
  retainedBoundaries: ReadonlyArray<OrchestrationForkBoundary>,
  retainedTurnIds: ReadonlySet<string>,
): {
  readonly messages: ReadonlyArray<OrchestrationMessage>;
  readonly sourceTurnIdByMessageId: ReadonlyMap<string, TurnId>;
} {
  const retainedMessageIds = new Set<string>();
  const sourceTurnIdByMessageId = new Map<string, TurnId>();
  const claimedUserMessageIds = new Set<string>();

  for (const message of messages) {
    if (message.role === "system") {
      retainedMessageIds.add(message.id);
    } else if (message.turnId !== null && retainedTurnIds.has(message.turnId)) {
      retainedMessageIds.add(message.id);
    }
  }

  for (const boundary of retainedBoundaries) {
    if (boundary.turnId === null || boundary.assistantMessageId === null) {
      continue;
    }

    const assistantIndex = messages.findIndex(
      (message) => message.id === boundary.assistantMessageId,
    );
    if (assistantIndex < 0) {
      continue;
    }
    const assistant = messages[assistantIndex];
    if (assistant?.role !== "assistant") {
      continue;
    }
    retainedMessageIds.add(assistant.id);
    sourceTurnIdByMessageId.set(assistant.id, boundary.turnId);

    const explicitUser =
      boundary.userMessageId === null
        ? undefined
        : messages.find(
            (message) => message.id === boundary.userMessageId && message.role === "user",
          );
    const user =
      explicitUser ??
      messages.findLast(
        (message, index) =>
          index < assistantIndex &&
          message.role === "user" &&
          !claimedUserMessageIds.has(message.id),
      );
    if (user) {
      retainedMessageIds.add(user.id);
      claimedUserMessageIds.add(user.id);
      sourceTurnIdByMessageId.set(user.id, boundary.turnId);
    }
  }

  return {
    messages: messages.filter((message) => retainedMessageIds.has(message.id)),
    sourceTurnIdByMessageId,
  };
}

const invariant = (detail: string): OrchestrationCommandInvariantError =>
  new OrchestrationCommandInvariantError({ commandType: "thread.fork", detail });

function deriveForkTitle(origin: OrchestrationThread, readModel: OrchestrationReadModel): string {
  const isForkedOrigin = origin.conversationForkBoundaries?.some(isForkBaselineBoundary) === true;
  const sameProjectThreads = readModel.threads.filter(
    (thread) => thread.projectId === origin.projectId,
  );
  const siblingTitles = new Set(sameProjectThreads.map((thread) => thread.title));
  const suffixMatch = origin.title.match(/^(.*)\s+\(\d+\)$/);
  const candidateBaseTitle = suffixMatch?.[1]?.trim() ?? null;
  // A numeric suffix is generated fork numbering only when the unsuffixed
  // title exists as a same-project sibling. This preserves meaningful titles
  // such as "Conversation (111)" and renamed forks such as "Experiment (2024)".
  const hasVerifiedForkSuffix =
    isForkedOrigin &&
    candidateBaseTitle !== null &&
    sameProjectThreads.some(
      (thread) => thread.id !== origin.id && thread.title === candidateBaseTitle,
    );
  const baseTitle = (hasVerifiedForkSuffix ? candidateBaseTitle : origin.title).trim() || "Fork";
  for (let suffix = 2; suffix <= 10_000; suffix += 1) {
    const candidate = `${baseTitle} (${suffix})`;
    if (!siblingTitles.has(candidate)) {
      return candidate;
    }
  }
  return `${baseTitle} (${origin.id.slice(-8)})`;
}

/**
 * Decide a `thread.fork` command into the events that seed the new thread.
 * Emits, in order: `thread.created` (new aggregate) → re-emitted prefix
 * `thread.message-sent` events → `thread.forked` (lineage). Never emits against
 * the origin thread.
 */
export const forkThread = Effect.fn("scientForkThread")(function* ({
  command,
  readModel,
}: {
  readonly command: ThreadForkCommand;
  readonly readModel: OrchestrationReadModel;
}): Effect.fn.Return<
  ReadonlyArray<PlannedOrchestrationEvent>,
  OrchestrationCommandInvariantError | PlatformError.PlatformError,
  Crypto.Crypto
> {
  const origin: OrchestrationThread = yield* requireThread({
    readModel,
    command,
    threadId: command.originThreadId,
  });
  if (origin.deletedAt !== null) {
    return yield* invariant(
      `Origin thread '${command.originThreadId}' is deleted and cannot be forked.`,
    );
  }

  // The new thread id must be free.
  yield* requireThreadAbsent({
    readModel,
    command,
    threadId: command.newThreadId,
  });

  const conversationBoundaries = origin.conversationForkBoundaries ?? [
    {
      turnId: null,
      conversationTurnCount: 0,
      userMessageId: null,
      assistantMessageId: null,
      completedAt: origin.createdAt,
      checkpointTurnCount: null,
      checkpointStatus: null,
    },
    ...origin.checkpoints.map((checkpoint) => ({
      turnId: checkpoint.turnId,
      conversationTurnCount: checkpoint.checkpointTurnCount,
      userMessageId: null,
      assistantMessageId: checkpoint.assistantMessageId,
      completedAt: checkpoint.completedAt,
      checkpointTurnCount: checkpoint.checkpointTurnCount,
      checkpointStatus: checkpoint.status,
    })),
  ];
  const selectedBoundary = conversationBoundaries.find(
    (boundary) => boundary.assistantMessageId === command.sourceAssistantMessageId,
  );
  if (!selectedBoundary) {
    return yield* invariant(
      `Assistant message '${command.sourceAssistantMessageId}' is not a completed conversation boundary of origin thread '${command.originThreadId}'.`,
    );
  }

  const sourceAssistantMessage = origin.messages.find(
    (message) => message.id === command.sourceAssistantMessageId,
  );
  if (
    !sourceAssistantMessage ||
    sourceAssistantMessage.role !== "assistant" ||
    sourceAssistantMessage.streaming ||
    selectedBoundary.turnId === null ||
    sourceAssistantMessage.turnId !== selectedBoundary.turnId
  ) {
    return yield* invariant(
      `Assistant message '${command.sourceAssistantMessageId}' is not a terminal completed response of origin thread '${command.originThreadId}'.`,
    );
  }
  const forkTitle = deriveForkTitle(origin, readModel);

  const retainedBoundaries = conversationBoundaries.filter(
    (boundary) => boundary.conversationTurnCount <= selectedBoundary.conversationTurnCount,
  );
  const retainedTurnIds = new Set<string>(
    retainedBoundaries.flatMap((boundary) => (boundary.turnId === null ? [] : [boundary.turnId])),
  );
  const retainedPrefix = retainPrefixMessages(origin.messages, retainedBoundaries, retainedTurnIds);
  const prefixMessages = retainedPrefix.messages;
  if (prefixMessages.some((message) => message.streaming)) {
    return yield* invariant(
      `Assistant message '${command.sourceAssistantMessageId}' belongs to an incomplete conversation prefix and cannot be forked.`,
    );
  }

  const selectedCheckpoint = origin.checkpoints.find(
    (checkpoint) =>
      selectedBoundary.turnId !== null &&
      checkpoint.turnId === selectedBoundary.turnId &&
      checkpoint.status === "ready",
  );
  if (command.workspaceMode === "new-worktree" && !selectedCheckpoint) {
    return yield* invariant(
      `Assistant message '${command.sourceAssistantMessageId}' has no ready Git checkpoint; fork it in the same workspace or choose a checkpoint-backed response.`,
    );
  }

  const occurredAt = yield* nowIso;
  const events: PlannedOrchestrationEvent[] = [];
  const attachmentThreadSegment = toSafeThreadAttachmentSegment(command.newThreadId);
  if (attachmentThreadSegment === null) {
    return yield* invariant(
      `New thread id '${command.newThreadId}' cannot own safe attachment ids.`,
    );
  }

  const attachmentRemap = new Map<string, ChatAttachment>();
  const attachmentCopies: Array<ThreadForkedPayload["attachmentCopies"][number]> = [];
  for (const message of prefixMessages) {
    for (const source of message.attachments ?? []) {
      if (attachmentRemap.has(source.id)) continue;
      const uuid = yield* Crypto.Crypto.pipe(Effect.flatMap((crypto) => crypto.randomUUIDv4));
      const target = { ...source, id: `${attachmentThreadSegment}-${uuid}` };
      attachmentRemap.set(source.id, target);
      attachmentCopies.push({ source, target });
    }
  }

  // 1) The new thread aggregate. The provider session starts independently and
  //    receives the retained transcript once on the first post-fork turn. The
  //    reactor assigns the requested workspace only after this decision commits.
  events.push({
    ...(yield* withForkEventBase({
      commandId: command.commandId,
      aggregateId: command.newThreadId,
      occurredAt,
    })),
    type: "thread.created",
    payload: {
      threadId: command.newThreadId,
      projectId: origin.projectId,
      // Fork titles are server-owned so every entry point gets the same
      // collision-safe numbering. A caller-provided title would otherwise
      // silently bypass the fork naming convention.
      title: forkTitle,
      modelSelection: origin.modelSelection,
      runtimeMode: origin.runtimeMode,
      interactionMode: origin.interactionMode,
      branch: null,
      worktreePath: null,
      createdAt: occurredAt,
      updatedAt: occurredAt,
    },
  });

  // The imported transcript is one immutable provider-neutral baseline. It is
  // deliberately not represented as N native provider turns: the new provider
  // session receives it once as bootstrap context, so rollback counts only
  // genuinely new post-fork turns.
  const baselineTurnId = TurnId.make(
    yield* Crypto.Crypto.pipe(Effect.flatMap((crypto) => crypto.randomUUIDv4)),
  );
  let baselineUserMessageId: MessageId | null = null;
  let baselineAssistantMessageId: MessageId | null = null;
  const importedTurnIds = new Map<string, TurnId>();

  // 2) Re-emit the prefix transcript into the new thread's stream. Payload
  // timestamps preserve message history, while event occurrence stays at the
  // fork time so the new thread cannot be sorted as if it were old.
  for (const message of prefixMessages) {
    const freshMessageId = yield* Crypto.Crypto.pipe(
      Effect.flatMap((crypto) => crypto.randomUUIDv4),
    );
    const messageId = MessageId.make(freshMessageId);
    if (message.role === "user") baselineUserMessageId = messageId;
    if (message.role === "assistant") baselineAssistantMessageId = messageId;
    let importedTurnId: TurnId | null = null;
    if (message.role === "user" || message.role === "assistant") {
      const sourceTurnId = retainedPrefix.sourceTurnIdByMessageId.get(message.id) ?? message.turnId;
      const sourceTurnKey = sourceTurnId ?? `message:${message.id}`;
      importedTurnId = importedTurnIds.get(sourceTurnKey) ?? null;
      if (importedTurnId === null) {
        importedTurnId =
          sourceTurnId === selectedBoundary.turnId
            ? baselineTurnId
            : TurnId.make(
                yield* Crypto.Crypto.pipe(Effect.flatMap((crypto) => crypto.randomUUIDv4)),
              );
        importedTurnIds.set(sourceTurnKey, importedTurnId);
      }
    }
    events.push({
      ...(yield* withForkEventBase({
        commandId: command.commandId,
        aggregateId: command.newThreadId,
        occurredAt,
      })),
      type: "thread.message-sent",
      payload: {
        threadId: command.newThreadId,
        messageId,
        role: message.role,
        text: message.text,
        ...(message.attachments !== undefined
          ? {
              attachments: message.attachments.map(
                (attachment) => attachmentRemap.get(attachment.id) ?? attachment,
              ),
            }
          : {}),
        turnId: importedTurnId,
        streaming: false,
        createdAt: message.createdAt,
        updatedAt: message.updatedAt,
      },
    });
  }

  // 3) Lineage. Folded into scient_thread_lineage by the Scient lineage
  //    projector; ignored (no-op) by every other projector and the read model.
  events.push({
    ...(yield* withForkEventBase({
      commandId: command.commandId,
      aggregateId: command.newThreadId,
      occurredAt,
    })),
    type: "thread.forked",
    payload: {
      originThreadId: command.originThreadId,
      newThreadId: command.newThreadId,
      forkAtTurnId: selectedBoundary.turnId,
      forkAtTurnCount: selectedBoundary.conversationTurnCount,
      sourceCheckpointTurnCount: selectedCheckpoint?.checkpointTurnCount ?? null,
      baselineTurnId,
      baselineUserMessageId,
      baselineAssistantMessageId,
      workspaceMode: command.workspaceMode,
      providerMode: "transcript-bootstrap",
      attachmentCopies,
      createdAt: occurredAt,
    },
  });

  if (selectedCheckpoint) {
    events.push({
      ...(yield* withForkEventBase({
        commandId: command.commandId,
        aggregateId: command.newThreadId,
        occurredAt,
      })),
      type: "thread.turn-diff-completed",
      payload: {
        threadId: command.newThreadId,
        turnId: baselineTurnId,
        checkpointTurnCount: 0,
        checkpointRef: checkpointRefForThreadTurn(command.newThreadId, 0),
        status: "ready",
        files: [],
        assistantMessageId: baselineAssistantMessageId,
        completedAt: occurredAt,
      },
    });
  }

  return events;
});
