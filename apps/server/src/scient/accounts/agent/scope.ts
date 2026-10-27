import {
  AccountsError,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2Run,
  type ProjectId,
  type ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { ProjectionStoreV2 } from "../../../orchestration-v2/ProjectionStore.ts";
import { AgentInvocationContext } from "../../operations/AgentInvocationContext.ts";

export const accountSessionScope = Effect.fn("AccountsAgent.sessionScope")(function* () {
  const invocation = yield* AgentInvocationContext;
  const store = yield* ProjectionStoreV2;
  const projection = yield* store.getThreadRecords(invocation.threadId, ["runs", "messages"]).pipe(
    Effect.mapError(
      () =>
        new AccountsError({
          reason: "unavailable",
          message: "The account session could not be resolved.",
        }),
    ),
  );
  return deriveAccountSessionScope(
    invocation.threadId,
    projection.thread.projectId,
    projection.runs,
    projection.messages,
  );
});

export function deriveAccountSessionScope(
  threadId: ThreadId,
  projectId: ProjectId | undefined,
  runs: ReadonlyArray<Pick<OrchestrationV2Run, "id" | "ordinal" | "status" | "userMessageId">>,
  messages: ReadonlyArray<Pick<OrchestrationV2ConversationMessage, "id" | "scheduledTaskId">>,
) {
  const active = runs.filter((candidate) =>
    ["running", "waiting", "starting", "preparing"].includes(candidate.status),
  );
  return {
    threadId,
    projectId,
    unattended:
      active.length === 0 ||
      active.some((run) => {
        const message = messages.find((candidate) => candidate.id === run.userMessageId);
        return message === undefined || message.scheduledTaskId !== undefined;
      }),
  };
}
