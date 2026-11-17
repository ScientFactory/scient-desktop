/**
 * Forks a conversation the way a client does: T3's `thread.fork` with Scient's boundary, then the
 * readiness wait. Errors read the way the client sees them.
 */
import {
  type CommandId,
  type MessageId,
  OrchestrationDispatchCommandError,
  RunId,
  type ScientConversationFork,
  type ThreadId,
  type TurnId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import {
  OrchestratorCommandPreviouslyRejectedError,
  OrchestratorCommandRejectedError,
  OrchestratorV2,
} from "../Orchestrator.ts";
import { ProjectionStoreV2 } from "../ProjectionStore.ts";
import { writeConversationFork } from "../scient-fork/ConversationForkRecords.ts";
import { ConversationForkService } from "../scient-fork/ConversationForkService.ts";
import { userFacingDispatchErrorMessage } from "../UserFacingErrors.ts";

export interface ConversationForkTestCommand {
  readonly type?: "thread.fork";
  readonly commandId: CommandId;
  readonly originThreadId: ThreadId;
  readonly newThreadId: ThreadId;
  readonly sourceAssistantMessageId?: MessageId | undefined;
  readonly sourceUserMessageId?: MessageId | undefined;
  readonly sourceRunningRunId?: RunId | undefined;
  /** Tests name a running run by its id typed as a turn. */
  readonly sourceRunningTurnId?: TurnId | undefined;
  readonly workspaceMode: "local" | "new-worktree";
  readonly titleOverride?: string | undefined;
}

const isRejection = Schema.is(
  Schema.Union([OrchestratorCommandRejectedError, OrchestratorCommandPreviouslyRejectedError]),
);
const isDispatchError = Schema.is(OrchestrationDispatchCommandError);

export const toThreadForkCommand = (input: ConversationForkTestCommand) => {
  const runningRunId =
    input.sourceRunningRunId ??
    (input.sourceRunningTurnId === undefined
      ? undefined
      : RunId.make(String(input.sourceRunningTurnId)));
  return {
    type: "thread.fork" as const,
    commandId: input.commandId,
    sourceThreadId: input.originThreadId,
    targetThreadId: input.newThreadId,
    sourcePoint: { type: "latest_stable" as const },
    createdBy: "user" as const,
    creationSource: "web" as const,
    ...(input.titleOverride === undefined ? {} : { title: input.titleOverride }),
    scient: {
      workspaceMode: input.workspaceMode,
      boundary:
        runningRunId !== undefined
          ? { kind: "running-turn" as const, runId: runningRunId }
          : input.sourceUserMessageId !== undefined
            ? { kind: "user-message" as const, messageId: input.sourceUserMessageId }
            : { kind: "assistant-response" as const, messageId: input.sourceAssistantMessageId! },
    },
  };
};

/** Dispatches the fork and waits until it can be opened, as the web client does. */
export const forkConversation = Effect.fn("testkit.forkConversation")(function* (
  input: ConversationForkTestCommand,
) {
  const orchestrator = yield* OrchestratorV2;
  const forks = yield* ConversationForkService;
  // Without a named point, the client forks the latest completed response.
  const latest =
    input.sourceAssistantMessageId === undefined &&
    input.sourceUserMessageId === undefined &&
    input.sourceRunningRunId === undefined &&
    input.sourceRunningTurnId === undefined
      ? (yield* forks.getOptions({ originThreadId: input.originThreadId })).sourceAssistantMessageId
      : null;
  const receipt = yield* orchestrator
    .dispatch(
      toThreadForkCommand(latest === null ? input : { ...input, sourceAssistantMessageId: latest }),
    )
    .pipe(
      Effect.mapError((cause) =>
        isDispatchError(cause)
          ? cause
          : new OrchestrationDispatchCommandError({
              message: userFacingDispatchErrorMessage(cause) ?? "The fork failed.",
              cause,
              forkDisposition: isRejection(cause) ? "rejected" : "unknown",
            }),
      ),
    );
  const ready = yield* forks.awaitReady(input.newThreadId);
  return { sequence: receipt.sequence, forkAttachmentIdMap: ready.forkAttachmentIdMap };
});

/** A thread's fork setup state, as Scient's table records it. */
export const conversationForkOf = (threadId: ThreadId) =>
  Effect.flatMap(ProjectionStoreV2, (store) => store.getConversationFork(threadId)).pipe(
    Effect.orDie,
  );

/** Records a fixture fork's setup state, as a fork's own commit does. */
export const recordConversationFork = (threadId: ThreadId, fork: ScientConversationFork) =>
  Effect.flatMap(SqlClient.SqlClient, (sql) => writeConversationFork(sql, threadId, fork)).pipe(
    Effect.orDie,
  );
