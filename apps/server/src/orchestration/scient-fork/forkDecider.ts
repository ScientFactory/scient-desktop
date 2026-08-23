/**
 * Scient conversation-fork decider.
 *
 * SCIENT-OWNED. All fork decision logic lives here so the T3-owned decider only
 * carries a single delegation seam. Retire this module if/when T3 ships native
 * thread fork.
 *
 * A fork creates a NEW, independent thread whose event stream is seeded from a
 * PREFIX of the origin thread, records fork lineage, and leaves the origin
 * thread completely untouched — the decider emits events ONLY against
 * `newThreadId`, never against `originThreadId`. A user-message fork retains
 * only the completed prefix before that message; the client stages the
 * selected request as an unsent destination composer draft.
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
import { deriveForkTitle } from "@t3tools/shared/scientForkTitle";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import type * as PlatformError from "effect/PlatformError";

import { toSafeThreadAttachmentSegment } from "../../attachmentStore.ts";
import { checkpointRefForThreadTurn } from "../../checkpointing/Utils.ts";
import { OrchestrationCommandInvariantError } from "../Errors.ts";
import { requireThread, requireThreadAbsent } from "../commandInvariants.ts";
import type { ResolvedForkBoundaries } from "./forkBoundaryTypes.ts";

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

function commandForkPoint(command: ThreadForkCommand): ResolvedForkBoundaries["forkPoint"] {
  return command.sourceAssistantMessageId !== undefined
    ? { kind: "assistant-response", messageId: command.sourceAssistantMessageId }
    : { kind: "user-message", messageId: command.sourceUserMessageId! };
}

/**
 * Decide a `thread.fork` command into the events that seed the new thread.
 * Emits, in order: `thread.created` (new aggregate) → re-emitted prefix
 * `thread.message-sent` events → `thread.forked` (lineage). Never emits against
 * the origin thread.
 *
 * Production callers must supply {@link ResolvedForkBoundaries} from the
 * Scient-owned SQL resolver. There is intentionally no production fallback to
 * snapshot boundary arrays or checkpoint synthesis.
 */
export const forkThread = Effect.fn("scientForkThread")(function* ({
  command,
  readModel,
  resolvedBoundaries,
}: {
  readonly command: ThreadForkCommand;
  readonly readModel: OrchestrationReadModel;
  /**
   * Authoritative server-owned boundaries for this fork request. Required on
   * every production and test path so checkpoints and cached snapshot arrays
   * cannot silently become conversation-completion authority.
   */
  readonly resolvedBoundaries: ResolvedForkBoundaries;
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
  if (origin.projectId === null) {
    return yield* invariant(
      `Origin thread '${command.originThreadId}' has no project and cannot be forked.`,
    );
  }

  // The new thread id must be free.
  yield* requireThreadAbsent({
    readModel,
    command,
    threadId: command.newThreadId,
  });

  const forkPoint = commandForkPoint(command);
  if (
    resolvedBoundaries.originThreadId !== command.originThreadId ||
    resolvedBoundaries.forkPoint.kind !== forkPoint.kind ||
    resolvedBoundaries.forkPoint.messageId !== forkPoint.messageId
  ) {
    return yield* invariant(
      `Authoritative fork boundaries do not match the public fork request for origin thread '${command.originThreadId}'.`,
    );
  }

  const conversationBoundaries = resolvedBoundaries.boundaries;
  // Re-select from the authoritative list so a malformed resolver result
  // cannot smuggle selected-boundary metadata that is absent from that list.
  const selectedBoundary = conversationBoundaries.find(
    (boundary) =>
      boundary.turnId === resolvedBoundaries.selectedBoundary.turnId &&
      boundary.conversationTurnCount ===
        resolvedBoundaries.selectedBoundary.conversationTurnCount &&
      boundary.assistantMessageId === resolvedBoundaries.selectedBoundary.assistantMessageId,
  );
  if (
    selectedBoundary === undefined ||
    (forkPoint.kind === "assistant-response" &&
      selectedBoundary.assistantMessageId !== forkPoint.messageId)
  ) {
    return yield* invariant(
      forkPoint.kind === "assistant-response"
        ? `Assistant message '${forkPoint.messageId}' is not a completed conversation boundary of origin thread '${command.originThreadId}'.`
        : `User message '${forkPoint.messageId}' has no completed conversation boundary before it in origin thread '${command.originThreadId}'.`,
    );
  }

  const sourceMessage = origin.messages.find((message) => message.id === forkPoint.messageId);
  if (forkPoint.kind === "assistant-response") {
    if (
      !sourceMessage ||
      sourceMessage.role !== "assistant" ||
      sourceMessage.streaming ||
      selectedBoundary.turnId === null ||
      sourceMessage.turnId !== selectedBoundary.turnId
    ) {
      return yield* invariant(
        `Assistant message '${forkPoint.messageId}' is not a terminal completed response of origin thread '${command.originThreadId}'.`,
      );
    }
  } else if (!sourceMessage || sourceMessage.role !== "user" || sourceMessage.streaming) {
    return yield* invariant(
      `User message '${forkPoint.messageId}' is not an available durable request of origin thread '${command.originThreadId}'.`,
    );
  }
  // An explicit title is user authorship, not authority over the fork
  // boundary. Without one, the server remains the collision authority and
  // allocates the automatic title from its current read model.
  const forkTitle =
    command.titleOverride ??
    deriveForkTitle({
      origin,
      originHasForkLineage:
        conversationBoundaries.some(isForkBaselineBoundary) || origin.forkLineage != null,
      projectThreads: readModel.threads.filter((thread) => thread.projectId === origin.projectId),
    });

  const selectedBoundaryIndex = conversationBoundaries.indexOf(selectedBoundary);
  const retainedBoundaries = conversationBoundaries.slice(0, selectedBoundaryIndex + 1);
  const retainedTurnIds = new Set<string>(
    retainedBoundaries.flatMap((boundary) => (boundary.turnId === null ? [] : [boundary.turnId])),
  );
  const retainedPrefix = retainPrefixMessages(origin.messages, retainedBoundaries, retainedTurnIds);
  const prefixMessages = retainedPrefix.messages;
  if (
    forkPoint.kind === "user-message" &&
    prefixMessages.some((message) => message.id === forkPoint.messageId)
  ) {
    return yield* invariant(
      `User message '${forkPoint.messageId}' was included in the retained transcript instead of remaining an unsent draft.`,
    );
  }
  if (prefixMessages.some((message) => message.streaming)) {
    return yield* invariant(
      `Message '${forkPoint.messageId}' belongs to an incomplete conversation prefix and cannot be forked.`,
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
      `Message '${forkPoint.messageId}' has no ready Git checkpoint before the selected fork point; fork it in the same workspace or choose a checkpoint-backed message.`,
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
      // Resolved above: an explicit user title, or server-allocated automatic
      // numbering when the command omits an override.
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
  const messageIdRemap = new Map<string, MessageId>();

  // 2) Re-emit the prefix transcript into the new thread's stream. Payload
  // timestamps preserve message history, while event occurrence stays at the
  // fork time so the new thread cannot be sorted as if it were old.
  for (const message of prefixMessages) {
    const freshMessageId = yield* Crypto.Crypto.pipe(
      Effect.flatMap((crypto) => crypto.randomUUIDv4),
    );
    const messageId = MessageId.make(freshMessageId);
    messageIdRemap.set(message.id, messageId);
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

  const copiedBoundaries = retainedBoundaries.flatMap((boundary) => {
    if (boundary.turnId === null || boundary.assistantMessageId === null) return [];
    const turnId = importedTurnIds.get(boundary.turnId);
    const assistantMessageId = messageIdRemap.get(boundary.assistantMessageId);
    if (turnId === undefined || assistantMessageId === undefined) return [];
    return [
      {
        turnId,
        userMessageId:
          boundary.userMessageId === null
            ? null
            : (messageIdRemap.get(boundary.userMessageId) ?? null),
        assistantMessageId,
        completedAt: boundary.completedAt,
      },
    ];
  });
  const retainedCompletedBoundaryCount = retainedBoundaries.filter(
    (boundary) => boundary.turnId !== null && boundary.assistantMessageId !== null,
  ).length;
  if (copiedBoundaries.length !== retainedCompletedBoundaryCount) {
    return yield* invariant(
      `The retained transcript for '${forkPoint.messageId}' could not preserve every logical fork boundary.`,
    );
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
      forkPointKind: forkPoint.kind,
      sourceUserMessageId: forkPoint.kind === "user-message" ? forkPoint.messageId : null,
      copiedBoundaries,
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
