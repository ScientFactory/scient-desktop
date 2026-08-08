/**
 * Scient conversation-fork decider.
 *
 * SCIENT-OWNED. All fork decision logic lives here so the T3-owned decider only
 * carries a single delegation seam. Retire this module if/when T3 ships native
 * thread fork.
 *
 * A fork creates a NEW, independent thread whose event stream is seeded from a
 * PREFIX of the origin thread (up to a completed turn boundary), records fork
 * lineage, and leaves the origin thread completely untouched — the decider emits
 * events ONLY against `newThreadId`, never against `originThreadId`.
 *
 * We re-emit the retained transcript (`thread.message-sent`) plus a
 * `thread.created` for the new aggregate and a `thread.forked` lineage event.
 * We deliberately do not re-emit `thread.turn-diff-completed`: those events
 * drive T3's checkpoint reactor. The Scient fork worker instead copies the
 * selected origin checkpoint to the new thread's turn-zero ref exactly once.
 *
 * Where origin history comes from: the decider is a pure function over the
 * in-memory `OrchestrationReadModel`, which carries per-thread `messages` and
 * `checkpoints`. We read the origin's completed-turn boundaries from its
 * `checkpoints` and the transcript from its `messages`. See
 * docs/internals/scient-fork-divergence.md for the read-model boot caveat.
 */
import {
  EventId,
  MessageId,
  TurnId,
  type ChatAttachment,
  type OrchestrationCommand,
  type OrchestrationEvent,
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
 * Which messages belong to the prefix kept up to `forkAtTurnCount`. Mirrors the
 * projector's `retainThreadMessagesAfterRevert` so a fork at turn N contains
 * exactly what a revert-to-N would retain: system messages, messages linked to a
 * retained turn, plus the earliest turnless user/assistant messages needed to
 * account for the N completed turns (user turn-start messages carry a null
 * turnId until adopted, so they need this fallback). Original order is kept.
 */
function retainPrefixMessages(
  messages: ReadonlyArray<OrchestrationMessage>,
  retainedTurnIds: ReadonlySet<string>,
  turnCount: number,
): ReadonlyArray<OrchestrationMessage> {
  const retainedMessageIds = new Set<string>();
  for (const message of messages) {
    if (message.role === "system") {
      retainedMessageIds.add(message.id);
      continue;
    }
    if (message.turnId !== null && retainedTurnIds.has(message.turnId)) {
      retainedMessageIds.add(message.id);
    }
  }

  const fillFromFallback = (role: "user" | "assistant") => {
    const retainedCount = messages.filter(
      (message) => message.role === role && retainedMessageIds.has(message.id),
    ).length;
    const missingCount = Math.max(0, turnCount - retainedCount);
    if (missingCount === 0) {
      return;
    }
    const fallback = messages
      .filter(
        (message) =>
          message.role === role &&
          !retainedMessageIds.has(message.id) &&
          (message.turnId === null || retainedTurnIds.has(message.turnId)),
      )
      .toSorted(
        (left, right) =>
          left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id),
      )
      .slice(0, missingCount);
    for (const message of fallback) {
      retainedMessageIds.add(message.id);
    }
  };
  fillFromFallback("user");
  fillFromFallback("assistant");

  return messages.filter((message) => retainedMessageIds.has(message.id));
}

const invariant = (detail: string): OrchestrationCommandInvariantError =>
  new OrchestrationCommandInvariantError({ commandType: "thread.fork", detail });

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

  // Fail closed: never fork a thread that is mid-turn / streaming. Forking an
  // in-flight turn would capture a torn, half-written boundary.
  const sessionBusy =
    origin.session !== null &&
    (origin.session.status === "starting" || origin.session.status === "running");
  const turnRunning = origin.latestTurn !== null && origin.latestTurn.state === "running";
  const messageStreaming = origin.messages.some((message) => message.streaming);
  if (sessionBusy || turnRunning || messageStreaming) {
    return yield* invariant(
      `Origin thread '${command.originThreadId}' is mid-turn; forking is only allowed at a settled turn boundary.`,
    );
  }

  // Turn zero is the initial checkpoint T3 creates before the first provider
  // turn. It is valid even though projected checkpoint summaries begin at the
  // first completed turn.
  const completedBoundaries = new Set([
    0,
    ...origin.checkpoints.map((checkpoint) => checkpoint.checkpointTurnCount),
  ]);
  if (!completedBoundaries.has(command.forkAtTurnCount)) {
    return yield* invariant(
      `forkAtTurnCount ${command.forkAtTurnCount} is not a completed turn boundary of origin thread '${command.originThreadId}'.`,
    );
  }

  const retainedCheckpoints = origin.checkpoints.filter(
    (checkpoint) => checkpoint.checkpointTurnCount <= command.forkAtTurnCount,
  );
  const retainedTurnIds = new Set<string>(
    retainedCheckpoints.map((checkpoint) => checkpoint.turnId),
  );
  const prefixMessages = retainPrefixMessages(
    origin.messages,
    retainedTurnIds,
    command.forkAtTurnCount,
  );

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
      title: command.title ?? origin.title,
      modelSelection: origin.modelSelection,
      runtimeMode: origin.runtimeMode,
      interactionMode: origin.interactionMode,
      branch: null,
      worktreePath: null,
      createdAt: occurredAt,
      updatedAt: occurredAt,
    },
  });

  // Re-key every origin turn id to a fresh id scoped to the new thread. Message
  // ids MUST be re-keyed too (projection_thread_messages.message_id is a global
  // primary key); turn ids are re-keyed defensively so no identifier is shared
  // across the two independent threads.
  const turnIdRemap = new Map<string, TurnId>();
  for (const turnId of retainedTurnIds) {
    const fresh = yield* Crypto.Crypto.pipe(Effect.flatMap((crypto) => crypto.randomUUIDv4));
    turnIdRemap.set(turnId, TurnId.make(fresh));
  }

  // 2) Re-emit the prefix transcript into the new thread's stream. Payload
  // timestamps preserve message history, while event occurrence stays at the
  // fork time so the new thread cannot be sorted as if it were old.
  for (const message of prefixMessages) {
    const freshMessageId = yield* Crypto.Crypto.pipe(
      Effect.flatMap((crypto) => crypto.randomUUIDv4),
    );
    const remappedTurnId =
      message.turnId === null ? null : (turnIdRemap.get(message.turnId) ?? null);
    events.push({
      ...(yield* withForkEventBase({
        commandId: command.commandId,
        aggregateId: command.newThreadId,
        occurredAt,
      })),
      type: "thread.message-sent",
      payload: {
        threadId: command.newThreadId,
        messageId: MessageId.make(freshMessageId),
        role: message.role,
        text: message.text,
        ...(message.attachments !== undefined
          ? {
              attachments: message.attachments.map(
                (attachment) => attachmentRemap.get(attachment.id) ?? attachment,
              ),
            }
          : {}),
        turnId: remappedTurnId,
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
      forkAtTurnCount: command.forkAtTurnCount,
      workspaceMode: command.workspaceMode,
      providerMode: "transcript-bootstrap",
      attachmentCopies,
      createdAt: occurredAt,
    },
  });

  return events;
});
