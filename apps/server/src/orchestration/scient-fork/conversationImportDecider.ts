/**
 * Decides `thread.conversation.import`: a new, independent thread holding an
 * imported conversation, written by one command so every event commits in one
 * SQL transaction.
 *
 * SCIENT-OWNED. The server's conversation importer builds the command from a
 * validated package, with fresh local ids for everything and attachments
 * already published. This decider only checks the destination and the
 * command's own consistency, then emits, in order: `thread.created`, the
 * history (`thread.message-sent`, `thread.proposed-plan-upserted`,
 * `thread.activity-appended`), and `thread.conversation-imported`, which the
 * Scient lineage projector folds into an `import` context transfer.
 */
import {
  EventId,
  type OrchestrationCommand,
  type OrchestrationEvent,
  type OrchestrationReadModel,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import type * as PlatformError from "effect/PlatformError";

import { OrchestrationCommandInvariantError } from "../Errors.ts";
import { requireProject, requireThreadAbsent } from "../commandInvariants.ts";

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
type PlannedOrchestrationEvent = DistributiveOmit<OrchestrationEvent, "sequence">;

export type ThreadConversationImportCommand = Extract<
  OrchestrationCommand,
  { type: "thread.conversation.import" }
>;

const invariant = (detail: string) =>
  new OrchestrationCommandInvariantError({ commandType: "thread.conversation.import", detail });

/** The first inconsistency in the command's own records, or null. */
function commandInconsistency(command: ThreadConversationImportCommand): string | null {
  const messageIds = new Set<string>();
  for (const message of command.messages) {
    if (messageIds.has(message.messageId)) return `Message ${message.messageId} appears twice.`;
    messageIds.add(message.messageId);
  }
  const inherited = new Set<string>(command.inheritedTurnIds);
  const recordTurns = [
    ...command.messages.map((message) => message.turnId),
    ...command.proposedPlans.map((plan) => plan.turnId),
    ...command.activities.map((activity) => activity.turnId),
    ...command.turns.map((turn) => turn.turnId),
  ];
  for (const turnId of recordTurns) {
    if (turnId !== null && !inherited.has(turnId)) {
      return `Turn ${turnId} is not recorded as imported history.`;
    }
  }
  for (const turn of command.turns) {
    for (const messageId of [turn.userMessageId, turn.assistantMessageId]) {
      if (messageId !== null && !messageIds.has(messageId)) {
        return `Turn ${turn.turnId} names message ${messageId}, which is not imported.`;
      }
    }
  }
  const activityIds = new Set<string>();
  for (const activity of command.activities) {
    if (activityIds.has(activity.id)) return `Activity ${activity.id} appears twice.`;
    activityIds.add(activity.id);
  }
  return null;
}

export const decideConversationImport = Effect.fn("scientDecideConversationImport")(function* ({
  command,
  readModel,
}: {
  readonly command: ThreadConversationImportCommand;
  readonly readModel: OrchestrationReadModel;
}): Effect.fn.Return<
  ReadonlyArray<PlannedOrchestrationEvent>,
  OrchestrationCommandInvariantError | PlatformError.PlatformError,
  Crypto.Crypto
> {
  const project = yield* requireProject({ readModel, command, projectId: command.projectId });
  if (project.deletedAt !== null) {
    return yield* invariant(`Project '${command.projectId}' was deleted.`);
  }
  yield* requireThreadAbsent({ readModel, command, threadId: command.threadId });
  const inconsistency = commandInconsistency(command);
  if (inconsistency !== null) return yield* invariant(inconsistency);

  const crypto = yield* Crypto.Crypto;
  const eventBase = Effect.fnUntraced(function* () {
    return {
      eventId: EventId.make(yield* crypto.randomUUIDv4),
      aggregateKind: "thread" as const,
      aggregateId: command.threadId,
      // Records keep their own history timestamps; the events happen now.
      occurredAt: command.createdAt,
      commandId: command.commandId,
      causationEventId: null,
      correlationId: command.commandId,
      metadata: {},
    };
  });

  const events: PlannedOrchestrationEvent[] = [
    {
      ...(yield* eventBase()),
      type: "thread.created",
      payload: {
        threadId: command.threadId,
        projectId: command.projectId,
        title: command.title,
        modelSelection: command.modelSelection,
        runtimeMode: command.runtimeMode,
        interactionMode: command.interactionMode,
        branch: null,
        worktreePath: null,
        createdAt: command.createdAt,
        updatedAt: command.createdAt,
      },
    },
  ];
  for (const message of command.messages) {
    events.push({
      ...(yield* eventBase()),
      type: "thread.message-sent",
      payload: {
        threadId: command.threadId,
        messageId: message.messageId,
        role: message.role,
        text: message.text,
        ...(message.attachments === undefined ? {} : { attachments: message.attachments }),
        turnId: message.turnId,
        streaming: false,
        createdAt: message.createdAt,
        updatedAt: message.updatedAt,
      },
    });
  }
  for (const proposedPlan of command.proposedPlans) {
    events.push({
      ...(yield* eventBase()),
      type: "thread.proposed-plan-upserted",
      payload: { threadId: command.threadId, proposedPlan },
    });
  }
  for (const activity of command.activities) {
    events.push({
      ...(yield* eventBase()),
      type: "thread.activity-appended",
      payload: { threadId: command.threadId, activity },
    });
  }
  const { inheritedTurnIds: _serverOnly, ...origin } = command.origin;
  events.push({
    ...(yield* eventBase()),
    type: "thread.conversation-imported",
    payload: {
      threadId: command.threadId,
      origin,
      inheritedTurnIds: command.inheritedTurnIds,
      turns: command.turns,
      createdAt: command.createdAt,
    },
  });
  return events;
});
