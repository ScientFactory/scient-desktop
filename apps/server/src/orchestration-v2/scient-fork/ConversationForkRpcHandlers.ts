/**
 * The RPC side of Scient's forks: what a fork point allows, and when a fork can be opened.
 * Forks themselves are T3's `thread.fork` on the shared dispatch method.
 *
 * @module ConversationForkRpcHandlers
 */
import {
  ORCHESTRATION_WS_METHODS,
  OrchestrationDispatchCommandError,
  OrchestrationGetSnapshotError,
  WsConversationRpcGroup,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import type {
  ScientRpcHandlerSubset,
  ScientRpcObservers,
} from "../../scient/ScientRpcObservers.ts";
import type { ConversationForkService } from "./ConversationForkService.ts";

/** Shared with ws.ts, which maps its own Scient command failures the same way. */
export const isOrchestrationDispatchCommandError = Schema.is(OrchestrationDispatchCommandError);

export const makeConversationForkRpcHandlers = ({
  observeRpcEffect,
  conversationForks,
}: Pick<ScientRpcObservers, "observeRpcEffect"> & {
  readonly conversationForks: ConversationForkService["Service"];
}) =>
  ({
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
    [ORCHESTRATION_WS_METHODS.awaitFork]: (input) =>
      observeRpcEffect(
        ORCHESTRATION_WS_METHODS.awaitFork,
        conversationForks.awaitReady(input.threadId),
        { "rpc.aggregate": "orchestration" },
      ),
  }) satisfies ScientRpcHandlerSubset<
    typeof WsConversationRpcGroup,
    typeof ORCHESTRATION_WS_METHODS.getForkOptions | typeof ORCHESTRATION_WS_METHODS.awaitFork
  >;
