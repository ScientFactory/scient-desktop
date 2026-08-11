import {
  GENERAL_CHAT_MOVE_TERMINALS_OPEN,
  type OrchestrationCommand,
  OrchestrationDispatchCommandError,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

/**
 * Coordinates the one runtime resource the pure event decider cannot see.
 * The decider owns durable thread/session invariants; this guard prevents a
 * running PTY from surviving the workspace ownership transition.
 */
export const ensureScientGeneralChatMoveHasNoRunningTerminals = Effect.fn(
  "ScientGeneralChat.ensureMoveHasNoRunningTerminals",
)(function* (input: {
  readonly command: OrchestrationCommand;
  readonly hasRunningSessionsForThread: (threadId: string) => Effect.Effect<boolean>;
}) {
  if (input.command.type !== "thread.meta.update" || input.command.moveToProjectId === undefined) {
    return;
  }
  if (!(yield* input.hasRunningSessionsForThread(input.command.threadId))) return;
  return yield* new OrchestrationDispatchCommandError({
    message: `${GENERAL_CHAT_MOVE_TERMINALS_OPEN}: Close every terminal for this chat before moving it to a project.`,
  });
});
