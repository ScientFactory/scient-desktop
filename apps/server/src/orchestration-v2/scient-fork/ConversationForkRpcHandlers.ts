/**
 * The RPC side of Scient's message-boundary forks: a retained
 * conversation-fork transport on the shared dispatch method, and the fork
 * options query.
 *
 * @module ConversationForkRpcHandlers
 */
import {
  ORCHESTRATION_WS_METHODS,
  OrchestrationDispatchCommandError,
  OrchestrationGetSnapshotError,
  type OrchestrationV2Command,
  type ThreadForkCommand,
  WsConversationRpcGroup,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import type {
  ScientRpcHandlerSubset,
  ScientRpcObservers,
} from "../../scient/ScientRpcObservers.ts";
import type * as ServerRuntimeStartup from "../../serverRuntimeStartup.ts";
import type { ConversationForkService } from "./ConversationForkService.ts";

/** Shared with ws.ts, which maps its own Scient command failures the same way. */
export const isOrchestrationDispatchCommandError = Schema.is(OrchestrationDispatchCommandError);

/** Message-boundary forks use Scient's native service alongside native run commands. */
const isConversationForkCommand = (
  command: ThreadForkCommand | OrchestrationV2Command,
): command is ThreadForkCommand => command.type === "thread.fork" && "originThreadId" in command;

export const makeConversationForkRpcHandlers = ({
  observeRpcEffect,
  startup,
  conversationForks,
}: Pick<ScientRpcObservers, "observeRpcEffect"> & {
  readonly startup: ServerRuntimeStartup.ServerRuntimeStartup["Service"];
  readonly conversationForks: ConversationForkService["Service"];
}) => {
  // Retained conversation-fork transport commits native V2 history and effects.
  const dispatchCommand = (command: ThreadForkCommand) =>
    observeRpcEffect(
      ORCHESTRATION_WS_METHODS.dispatchCommand,
      startup
        .enqueueCommand(conversationForks.dispatch(command))
        .pipe(
          Effect.mapError((cause) =>
            isOrchestrationDispatchCommandError(cause)
              ? cause
              : new OrchestrationDispatchCommandError({ message: cause.message, cause }),
          ),
        ),
      { "rpc.aggregate": "orchestration" },
    );
  return {
    /** Sends a message-boundary fork to the fork service and every other command on. */
    route:
      <A>(dispatchNative: (command: OrchestrationV2Command) => A) =>
      (command: ThreadForkCommand | OrchestrationV2Command) =>
        isConversationForkCommand(command) ? dispatchCommand(command) : dispatchNative(command),
    handlers: {
      [ORCHESTRATION_WS_METHODS.getForkOptions]: (input) =>
        observeRpcEffect(
          ORCHESTRATION_WS_METHODS.getForkOptions,
          conversationForks
            .getOptions(input)
            .pipe(
              Effect.mapError(
                (cause) => new OrchestrationGetSnapshotError({ message: cause.message, cause }),
              ),
            ),
          { "rpc.aggregate": "orchestration" },
        ),
    } satisfies ScientRpcHandlerSubset<
      typeof WsConversationRpcGroup,
      typeof ORCHESTRATION_WS_METHODS.getForkOptions
    >,
  };
};
