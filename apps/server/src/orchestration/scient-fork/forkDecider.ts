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
  ApprovalRequestId,
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

import { attachmentFileExtension, toSafeThreadAttachmentSegment } from "../../attachmentStore.ts";
import { checkpointRefForThreadTurn } from "../../checkpointing/Utils.ts";
import { OrchestrationCommandInvariantError } from "../Errors.ts";
import { requireThread, requireThreadAbsent } from "../commandInvariants.ts";
import type { ResolvedForkBoundaries } from "./forkBoundaryTypes.ts";
import { retainQuestionAnswers, questionAnswerAttachments } from "./retainedQuestionAnswers.ts";
import {
  capForkActivityPayload,
  isForkCopiedActivity,
  withoutOriginSequence,
} from "./forkActivityCopy.ts";
import { collectForkLiveTail, type ForkLiveTail } from "./forkLiveTail.ts";

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
  const messageById = new Map(messages.map((message, index) => [message.id, { message, index }]));
  let lastRetainedIndex = -1;
  for (const boundary of retainedBoundaries) {
    const index =
      boundary.assistantMessageId === null
        ? -1
        : (messageById.get(boundary.assistantMessageId)?.index ?? -1);
    lastRetainedIndex = Math.max(lastRetainedIndex, index);
  }

  for (const message of messages.slice(0, lastRetainedIndex + 1)) {
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

    const assistantIndex = messageById.get(boundary.assistantMessageId)?.index ?? -1;
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
        : messageById.get(boundary.userMessageId)?.message;
    let user = explicitUser?.role === "user" ? explicitUser : undefined;
    if (!user) {
      for (let index = assistantIndex - 1; index >= 0; index--) {
        const candidate = messages[index]!;
        if (candidate.role === "user" && !claimedUserMessageIds.has(candidate.id)) {
          user = candidate;
          break;
        }
      }
    }
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

/**
 * A turn can end without an answer: the provider failed or was stopped before
 * replying. It is history all the same, so a fork keeps its request and work
 * log when the turn sits before the fork point. In a conversation's own
 * history such a turn is a boundary without an assistant message; in a fork it
 * is an inherited turn that the copied-boundary manifest does not list.
 *
 * Returns the turn of every message to carry for those turns. A request that
 * an older conversation never bound to its turn is not found, and is left out.
 */
function retainUnansweredTurns(input: {
  readonly messages: ReadonlyArray<OrchestrationMessage>;
  /** Every boundary of the conversation, and those up to the fork point. */
  readonly boundaries: ReadonlyArray<OrchestrationForkBoundary>;
  readonly retainedBoundaries: ReadonlyArray<OrchestrationForkBoundary>;
  /** Inherited turns of the conversation, in history order. */
  readonly inheritedTurnIds: ReadonlyArray<string>;
  /** The turn the fork point belongs to; null when the conversation produced it itself. */
  readonly forkPointTurnId: string | null;
  /** Index of the first message that lies outside the forked history. */
  readonly endIndex: number;
}): ReadonlyMap<string, TurnId> {
  const boundaryTurnIds = new Set<string | null>(
    input.boundaries.map((boundary) => boundary.turnId),
  );
  // Inherited turns carry no boundary to order them by. Their recorded order
  // does: one is part of the history when it comes before the fork point's
  // turn, or when that turn is the conversation's own and so follows them all.
  const forkPointOrder =
    input.forkPointTurnId === null ? -1 : input.inheritedTurnIds.indexOf(input.forkPointTurnId);
  const inheritedTurnIds = new Set(
    (forkPointOrder < 0
      ? input.inheritedTurnIds
      : input.inheritedTurnIds.slice(0, forkPointOrder)
    ).filter((turnId) => !boundaryTurnIds.has(turnId)),
  );
  // The conversation's own unanswered turns are ordered by their boundaries.
  // A request is stored without a turn; its boundary names the turn it started.
  const ownTurnIds = new Set<string>();
  const turnIdByRequest = new Map<string, TurnId>();
  for (const boundary of input.retainedBoundaries) {
    if (boundary.turnId === null || boundary.assistantMessageId !== null) continue;
    ownTurnIds.add(boundary.turnId);
    if (boundary.userMessageId !== null) {
      turnIdByRequest.set(boundary.userMessageId, boundary.turnId);
    }
  }
  const turnIdByMessageId = new Map<string, TurnId>();
  for (const [index, message] of input.messages.entries()) {
    // An answer left unfinished is not history a fork can replay.
    if (message.role === "system" || message.streaming) continue;
    const turnId =
      message.turnId !== null && inheritedTurnIds.has(message.turnId)
        ? message.turnId
        : index >= input.endIndex
          ? undefined
          : (turnIdByRequest.get(message.id) ??
            (message.turnId !== null && ownTurnIds.has(message.turnId)
              ? message.turnId
              : undefined));
    if (turnId !== undefined) turnIdByMessageId.set(message.id, turnId);
  }
  return turnIdByMessageId;
}

/**
 * The origin history a fork carries up to its fork point: the turns that have
 * an answer, and the turns that ended without one. The decider and the
 * admission check both select with this, so they cannot disagree.
 */
export function retainForkHistory(input: {
  readonly messages: ReadonlyArray<OrchestrationMessage>;
  readonly resolvedBoundaries: ResolvedForkBoundaries;
  readonly retainedBoundaries: ReadonlyArray<OrchestrationForkBoundary>;
}): {
  readonly messages: ReadonlyArray<OrchestrationMessage>;
  /** Source turns whose work log and question answers the fork copies. */
  readonly retainedTurnIds: ReadonlySet<string>;
  readonly sourceTurnIdByMessageId: ReadonlyMap<string, TurnId>;
  readonly unansweredTurnIdByMessageId: ReadonlyMap<string, TurnId>;
} {
  const { forkPoint } = input.resolvedBoundaries;
  // Answered turns first; turns without an answer are carried separately.
  const retainedTurnIds = new Set<string>(
    input.retainedBoundaries.flatMap((boundary) =>
      boundary.turnId === null || boundary.assistantMessageId === null ? [] : [boundary.turnId],
    ),
  );
  const answered = retainPrefixMessages(input.messages, input.retainedBoundaries, retainedTurnIds);
  const answeredMessageIds = new Set(answered.messages.map((message) => message.id));
  const unansweredTurnIdByMessageId = retainUnansweredTurns({
    messages: input.messages,
    boundaries: input.resolvedBoundaries.boundaries,
    retainedBoundaries: input.retainedBoundaries,
    inheritedTurnIds: [...(input.resolvedBoundaries.inheritedTurnIds ?? [])],
    forkPointTurnId:
      forkPoint.kind === "assistant-response"
        ? input.resolvedBoundaries.selectedBoundary.turnId
        : forkPoint.kind === "user-message"
          ? (input.messages.find((message) => message.id === forkPoint.messageId)?.turnId ?? null)
          : null,
    // A running-turn fork carries everything after its last answer as the live tail.
    endIndex:
      forkPoint.kind === "running-turn"
        ? input.messages.findLastIndex((message) => answeredMessageIds.has(message.id)) + 1
        : input.messages.findIndex((message) => message.id === forkPoint.messageId),
  });
  for (const turnId of unansweredTurnIdByMessageId.values()) retainedTurnIds.add(turnId);
  return {
    messages: input.messages.filter(
      (message) =>
        answeredMessageIds.has(message.id) || unansweredTurnIdByMessageId.has(message.id),
    ),
    retainedTurnIds,
    sourceTurnIdByMessageId: answered.sourceTurnIdByMessageId,
    unansweredTurnIdByMessageId,
  };
}

/** Composer context records name attachments by id; point them at the fork's copies. */
function remapContextAttachments(
  context: OrchestrationMessage["context"],
  attachmentRemap: ReadonlyMap<string, ChatAttachment>,
): OrchestrationMessage["context"] {
  if (context === undefined) return undefined;
  return {
    ...context,
    records: context.records.map((record) => {
      const attachmentId = (record as { readonly attachmentId?: unknown }).attachmentId;
      const target =
        typeof attachmentId === "string" ? attachmentRemap.get(attachmentId) : undefined;
      return target === undefined ? record : { ...record, attachmentId: target.id };
    }),
  };
}

const invariant = (detail: string): OrchestrationCommandInvariantError =>
  new OrchestrationCommandInvariantError({ commandType: "thread.fork", detail });

function commandForkPoint(command: ThreadForkCommand): ResolvedForkBoundaries["forkPoint"] {
  if (command.sourceRunningTurnId !== undefined) {
    return { kind: "running-turn", turnId: command.sourceRunningTurnId };
  }
  return command.sourceAssistantMessageId !== undefined
    ? { kind: "assistant-response", messageId: command.sourceAssistantMessageId }
    : { kind: "user-message", messageId: command.sourceUserMessageId! };
}

function forkPointId(forkPoint: ResolvedForkBoundaries["forkPoint"]): string {
  return forkPoint.kind === "running-turn" ? forkPoint.turnId : forkPoint.messageId;
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
  const sourceImport = origin.conversationImport
    ? (({ inheritedTurnIds: _turns, ...source }) => source)(origin.conversationImport)
    : origin.forkLineage?.sourceImport;

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
    forkPointId(resolvedBoundaries.forkPoint) !== forkPointId(forkPoint)
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
        : forkPoint.kind === "user-message"
          ? `User message '${forkPoint.messageId}' has no completed conversation boundary before it in origin thread '${command.originThreadId}'.`
          : `The running turn '${forkPoint.turnId}' has no completed conversation boundary before it in origin thread '${command.originThreadId}'.`,
    );
  }

  const sourceMessage =
    forkPoint.kind === "running-turn"
      ? undefined
      : origin.messages.find((message) => message.id === forkPoint.messageId);
  if (forkPoint.kind === "running-turn") {
    // The turn must still be the origin's active one; a turn that already
    // finished is forked from its response instead.
    const running =
      origin.session?.activeTurnId === forkPoint.turnId ||
      (origin.latestTurn?.turnId === forkPoint.turnId && origin.latestTurn.state === "running");
    if (!running) {
      return yield* invariant(
        `Turn '${forkPoint.turnId}' is no longer running in origin thread '${command.originThreadId}'. Fork its response instead.`,
      );
    }
  } else if (forkPoint.kind === "assistant-response") {
    if (
      !sourceMessage ||
      sourceMessage.role !== "assistant" ||
      sourceMessage.streaming ||
      selectedBoundary.turnId === null ||
      (sourceMessage.turnId !== null && sourceMessage.turnId !== selectedBoundary.turnId)
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
  const retainedPrefix = retainForkHistory({
    messages: origin.messages,
    resolvedBoundaries,
    retainedBoundaries,
  });
  const { retainedTurnIds, unansweredTurnIdByMessageId } = retainedPrefix;
  const prefixMessages = retainedPrefix.messages;
  // A fork of the running turn also carries everything after the completed
  // prefix: the request, reasoning, tool work and partial text so far.
  const liveTail: ForkLiveTail | null =
    forkPoint.kind === "running-turn"
      ? collectForkLiveTail({
          origin,
          retainedMessageIds: new Set(prefixMessages.map((message) => message.id)),
          retainedTurnIds,
          runningTurnId: forkPoint.turnId,
          turnRequests: resolvedBoundaries.turnRequests ?? [],
        })
      : null;
  // The running turn becomes the fork's baseline only once it produced answer
  // text; until then the baseline stays the last completed turn, so the fork
  // never records a turn without a response as a completed one.
  const liveBaselineTurnId =
    liveTail !== null &&
    liveTail.messages.some(
      (message) =>
        message.role === "assistant" &&
        liveTail.turnIdByMessageId.get(message.id) === liveTail.runningTurnId,
    )
      ? liveTail.runningTurnId
      : null;
  const retainedAnswers = retainQuestionAnswers(
    origin.activities,
    liveTail === null ? retainedTurnIds : new Set([...retainedTurnIds, ...liveTail.turnIds]),
  );
  if (retainedAnswers.error) return yield* invariant(retainedAnswers.error);
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
      `Message '${forkPointId(forkPoint)}' belongs to an incomplete conversation prefix and cannot be forked.`,
    );
  }

  const selectedCheckpoint = origin.checkpoints.find(
    (checkpoint) =>
      selectedBoundary.turnId !== null &&
      checkpoint.turnId === selectedBoundary.turnId &&
      checkpoint.status === "ready",
  );
  // A running-turn fork snapshots the current workspace instead of copying a
  // historical checkpoint.
  if (command.workspaceMode === "new-worktree" && !selectedCheckpoint && liveTail === null) {
    return yield* invariant(
      `Message '${forkPointId(forkPoint)}' has no ready Git checkpoint before the selected fork point; fork it in the same workspace or choose a checkpoint-backed message.`,
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
  for (const source of [
    ...prefixMessages.flatMap((message) => message.attachments ?? []),
    ...(liveTail?.messages.flatMap((message) => message.attachments ?? []) ?? []),
    ...questionAnswerAttachments(retainedAnswers.answers),
  ]) {
    if (attachmentRemap.has(source.id)) continue;
    const uuid = yield* Crypto.Crypto.pipe(Effect.flatMap((crypto) => crypto.randomUUIDv4));
    const extensionSuffix =
      source.type === "file" ? `-${attachmentFileExtension(source.name).slice(1)}` : "";
    const target = { ...source, id: `${attachmentThreadSegment}-${uuid}${extensionSuffix}` };
    attachmentRemap.set(source.id, target);
    attachmentCopies.push({ source, target });
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
  // A fork stays in its origin's section. Filed in the same decision, so the
  // fork is never briefly unsectioned. An id whose catalog entry was removed
  // reads as General, exactly like the origin.
  if (origin.sectionId != null) {
    events.push({
      ...(yield* withForkEventBase({
        commandId: command.commandId,
        aggregateId: command.newThreadId,
        occurredAt,
      })),
      type: "thread.meta-updated",
      payload: {
        threadId: command.newThreadId,
        sectionId: origin.sectionId,
        updatedAt: occurredAt,
      },
    });
  }

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
  // The fork's baseline is the newest inherited turn with an answer: the
  // running turn for a running-turn fork, otherwise the last answered
  // boundary (the selected one, unless that turn ended without an answer).
  const baselineSourceTurnId =
    liveBaselineTurnId ??
    retainedBoundaries.findLast((boundary) => boundary.assistantMessageId !== null)?.turnId ??
    null;
  // Every source turn maps to one destination turn, so a turn's user message,
  // reasoning, answer and work log stay grouped together in the fork.
  const importedTurnIdFor = Effect.fnUntraced(function* (
    sourceTurnKey: string,
    sourceTurnId: string | null,
  ) {
    const existing = importedTurnIds.get(sourceTurnKey);
    if (existing !== undefined) return existing;
    const importedTurnId =
      sourceTurnId !== null && sourceTurnId === baselineSourceTurnId
        ? baselineTurnId
        : TurnId.make(yield* Crypto.Crypto.pipe(Effect.flatMap((crypto) => crypto.randomUUIDv4)));
    importedTurnIds.set(sourceTurnKey, importedTurnId);
    return importedTurnId;
  });

  // 2) Re-emit the prefix transcript into the new thread's stream. Payload
  // timestamps preserve message history, while event occurrence stays at the
  // fork time so the new thread cannot be sorted as if it were old.
  for (const message of prefixMessages) {
    const freshMessageId = yield* Crypto.Crypto.pipe(
      Effect.flatMap((crypto) => crypto.randomUUIDv4),
    );
    const messageId = MessageId.make(freshMessageId);
    messageIdRemap.set(message.id, messageId);
    const unansweredTurnId = unansweredTurnIdByMessageId.get(message.id);
    if (message.role === "user" && unansweredTurnId === undefined) {
      baselineUserMessageId = messageId;
    }
    if (message.role === "assistant") baselineAssistantMessageId = messageId;
    // System messages stay turnless. Reasoning keeps its own turn so it folds
    // into the response it produced instead of floating detached.
    let importedTurnId: TurnId | null = null;
    if (message.role !== "system") {
      const sourceTurnId =
        unansweredTurnId ??
        (message.role === "user" || message.role === "assistant"
          ? (retainedPrefix.sourceTurnIdByMessageId.get(message.id) ?? message.turnId)
          : message.turnId);
      importedTurnId = yield* importedTurnIdFor(
        sourceTurnId ?? `message:${message.id}`,
        sourceTurnId,
      );
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
        // Composer context (selected diffs, comments, terminal output) is
        // part of what the user sent; the fork keeps it with the message.
        ...(message.context !== undefined
          ? { context: remapContextAttachments(message.context, attachmentRemap)! }
          : {}),
        turnId: importedTurnId,
        streaming: false,
        createdAt: message.createdAt,
        updatedAt: message.updatedAt,
      },
    });
  }

  // 2b) The running turn's latest state. Rows still streaming at the cut are
  // copied as they stood; the provider handoff labels them partial.
  const partialMessageIds: MessageId[] = [];
  const liveTurnMessages = new Map<
    string,
    { user: MessageId | null; assistant: MessageId | null }
  >();
  for (const message of liveTail?.messages ?? []) {
    const messageId = MessageId.make(
      yield* Crypto.Crypto.pipe(Effect.flatMap((crypto) => crypto.randomUUIDv4)),
    );
    messageIdRemap.set(message.id, messageId);
    const sourceTurnId = liveTail!.turnIdByMessageId.get(message.id) ?? liveTail!.runningTurnId;
    const importedTurnId = yield* importedTurnIdFor(sourceTurnId, sourceTurnId);
    const turnMessages = liveTurnMessages.get(sourceTurnId) ?? { user: null, assistant: null };
    const isBaselineTurn = sourceTurnId === liveBaselineTurnId;
    if (message.role === "user") {
      if (isBaselineTurn) baselineUserMessageId = messageId;
      turnMessages.user = messageId;
    }
    if (message.role === "assistant") {
      if (isBaselineTurn) baselineAssistantMessageId = messageId;
      turnMessages.assistant = messageId;
    }
    liveTurnMessages.set(sourceTurnId, turnMessages);
    if (liveTail!.partialMessageIds.has(message.id)) partialMessageIds.push(messageId);
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
        ...(message.context !== undefined
          ? { context: remapContextAttachments(message.context, attachmentRemap)! }
          : {}),
        turnId: importedTurnId,
        streaming: false,
        createdAt: message.createdAt,
        updatedAt: message.updatedAt,
      },
    });
  }

  // Copy history, not executable question requests/responses. Existing activity
  // projectors render and retain these files without contacting a provider.
  const requestIds = new Map<string, ApprovalRequestId>();
  for (const { activity, answer } of retainedAnswers.answers) {
    const turnId = activity.turnId === null ? undefined : importedTurnIds.get(activity.turnId);
    if (turnId === undefined)
      return yield* invariant("A retained question answer has no copied conversation turn.");
    const id = EventId.make(
      yield* Crypto.Crypto.pipe(Effect.flatMap((crypto) => crypto.randomUUIDv4)),
    );
    let requestId = requestIds.get(answer.requestId);
    if (requestId === undefined) {
      requestId = ApprovalRequestId.make(
        yield* Crypto.Crypto.pipe(Effect.flatMap((crypto) => crypto.randomUUIDv4)),
      );
      requestIds.set(answer.requestId, requestId);
    }
    // An imported answer names the message it folds; the fork names its copy.
    const { messageId: originMessageId, ...copiedAnswer } = answer;
    const messageId =
      originMessageId === undefined ? undefined : messageIdRemap.get(originMessageId);
    events.push({
      ...(yield* withForkEventBase({
        commandId: command.commandId,
        aggregateId: command.newThreadId,
        occurredAt,
      })),
      type: "thread.activity-appended",
      payload: {
        threadId: command.newThreadId,
        activity: {
          ...withoutOriginSequence(activity),
          id,
          turnId,
          payload: {
            ...copiedAnswer,
            requestId,
            ...(messageId === undefined ? {} : { messageId }),
            attachmentsByQuestionId: Object.fromEntries(
              Object.entries(answer.attachmentsByQuestionId).map(([questionId, attachments]) => [
                questionId,
                attachments.map((attachment) => attachmentRemap.get(attachment.id)!),
              ]),
            ),
          },
        },
      },
    });
  }

  // The visible work log of every retained turn. Payloads are bounded; nothing
  // executable (approvals, questions) is copied.
  for (const activity of origin.activities) {
    if (activity.turnId === null || !retainedTurnIds.has(activity.turnId)) continue;
    if (!isForkCopiedActivity(activity)) continue;
    const turnId = importedTurnIds.get(activity.turnId);
    if (turnId === undefined) continue;
    events.push({
      ...(yield* withForkEventBase({
        commandId: command.commandId,
        aggregateId: command.newThreadId,
        occurredAt,
      })),
      type: "thread.activity-appended",
      payload: {
        threadId: command.newThreadId,
        activity: {
          ...withoutOriginSequence(activity),
          id: EventId.make(
            yield* Crypto.Crypto.pipe(Effect.flatMap((crypto) => crypto.randomUUIDv4)),
          ),
          turnId,
          payload: capForkActivityPayload(activity.payload),
        },
      },
    });
  }

  // The running turn's work log, including the latest row of each unfinished
  // tool call (recorded in flight; its result is unknown at the cut).
  const inFlightActivityIds: EventId[] = [];
  for (const activity of liveTail?.activities ?? []) {
    const turnId = activity.turnId === null ? undefined : importedTurnIds.get(activity.turnId);
    if (turnId === undefined) continue;
    const id = EventId.make(
      yield* Crypto.Crypto.pipe(Effect.flatMap((crypto) => crypto.randomUUIDv4)),
    );
    if (liveTail!.inFlightActivityIds.has(activity.id)) inFlightActivityIds.push(id);
    events.push({
      ...(yield* withForkEventBase({
        commandId: command.commandId,
        aggregateId: command.newThreadId,
        occurredAt,
      })),
      type: "thread.activity-appended",
      payload: {
        threadId: command.newThreadId,
        activity: {
          ...withoutOriginSequence(activity),
          id,
          turnId,
          payload: capForkActivityPayload(activity.payload),
        },
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
      `The retained transcript for '${forkPointId(forkPoint)}' could not preserve every logical fork boundary.`,
    );
  }
  // A running turn that already produced text is a completed turn of the fork:
  // the fork can itself be forked from it.
  for (const [sourceTurnId, turnMessages] of liveTurnMessages) {
    const turnId = importedTurnIds.get(sourceTurnId);
    if (turnId === undefined || turnMessages.assistant === null) continue;
    copiedBoundaries.push({
      turnId,
      userMessageId: turnMessages.user,
      assistantMessageId: turnMessages.assistant,
      completedAt: occurredAt,
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
      // A running-turn fork snapshots the workspace at the cut instead.
      sourceCheckpointTurnCount:
        liveTail === null ? (selectedCheckpoint?.checkpointTurnCount ?? null) : null,
      baselineTurnId,
      baselineUserMessageId,
      baselineAssistantMessageId,
      forkPointKind: forkPoint.kind,
      sourceUserMessageId: forkPoint.kind === "user-message" ? forkPoint.messageId : null,
      copiedBoundaries,
      workspaceMode: command.workspaceMode,
      providerMode: "transcript-bootstrap",
      attachmentCopies,
      inheritedTurnIds: [...new Set(importedTurnIds.values())],
      ...(sourceImport === undefined ? {} : { sourceImport }),
      ...(liveTail === null
        ? {}
        : {
            midTurnCut: {
              sourceTurnId: liveTail.runningTurnId,
              importedTurnId: importedTurnIds.get(liveTail.runningTurnId) ?? baselineTurnId,
              cutSequence: readModel.snapshotSequence,
              partialMessageIds,
              inFlightActivityIds,
              pendingRequests: [...liveTail.pendingRequests],
              touchedFiles: [...liveTail.touchedFiles],
              sharedWorkspace: command.workspaceMode === "local",
            },
          }),
      createdAt: occurredAt,
    },
  });

  // How much this fork copies, on the command's trace span: the first thing to
  // read when a fork is slow.
  yield* Effect.annotateCurrentSpan("scient.fork.events", events.length);

  // The turn-zero checkpoint is announced by `thread.fork.complete`, after the
  // fork worker has actually copied its ref.
  return events;
});

/**
 * Settle fork provisioning. When the worker copied the baseline checkpoint,
 * the fork's turn-zero checkpoint becomes visible in the same decision, never
 * before its ref exists.
 */
export const decideForkComplete = Effect.fn("scientDecideForkComplete")(function* ({
  command,
}: {
  readonly command: Extract<OrchestrationCommand, { type: "thread.fork.complete" }>;
}): Effect.fn.Return<
  ReadonlyArray<PlannedOrchestrationEvent>,
  PlatformError.PlatformError,
  Crypto.Crypto
> {
  const completed: PlannedOrchestrationEvent = {
    ...(yield* withForkEventBase({
      commandId: command.commandId,
      aggregateId: command.threadId,
      occurredAt: command.createdAt,
    })),
    type: "thread.fork-completed",
    payload: {
      threadId: command.threadId,
      checkpointStatus: command.checkpointStatus,
      workspaceStatus: command.workspaceStatus,
    },
  };
  if (command.checkpointStatus !== "ready" || command.checkpointBaseline === undefined) {
    return [completed];
  }
  return [
    completed,
    {
      ...(yield* withForkEventBase({
        commandId: command.commandId,
        aggregateId: command.threadId,
        occurredAt: command.createdAt,
      })),
      type: "thread.turn-diff-completed",
      payload: {
        threadId: command.threadId,
        turnId: command.checkpointBaseline.turnId,
        checkpointTurnCount: 0,
        checkpointRef: checkpointRefForThreadTurn(command.threadId, 0),
        status: "ready",
        files: [],
        assistantMessageId: command.checkpointBaseline.assistantMessageId,
        completedAt: command.createdAt,
      },
    },
  ];
});
