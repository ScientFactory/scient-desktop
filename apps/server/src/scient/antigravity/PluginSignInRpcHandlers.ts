/**
 * Opens an Antigravity plugin sign-in from its chat notice. The page stays with the session that
 * printed it; this resolves that live session for the thread and returns the page on a click.
 */
import {
  type PluginSignInOpenInput,
  PluginSignInError,
  WS_METHODS,
  type WsWorkspaceRpcGroup,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";

import type * as ProviderSessionManager from "../../orchestration-v2/ProviderSessionManager.ts";
import type * as ThreadManagementService from "../../orchestration-v2/ThreadManagementService.ts";
import type { ScientRpcHandlerSubset, ScientRpcObservers } from "../ScientRpcObservers.ts";

const isPluginSignInError = Schema.is(PluginSignInError);
const ended = new PluginSignInError({
  reason: "expired",
  detail: "The agent session has ended. Ask the agent to try again.",
});

export const makePluginSignInRpcHandlers = ({
  observeRpcEffect,
  threadManagement,
  providerSessions,
}: Pick<ScientRpcObservers, "observeRpcEffect"> & {
  readonly threadManagement: ThreadManagementService.ThreadManagementService["Service"];
  readonly providerSessions: ProviderSessionManager.ProviderSessionManagerV2["Service"];
}) => {
  const open = Effect.fn("PluginSignIn.open")(
    function* (input: PluginSignInOpenInput) {
      const { providerThreads } = yield* threadManagement.getThreadRecords(input.threadId, [
        "providerThreads",
      ]);
      const providerThread = providerThreads.find(
        (candidate) => candidate.id === input.providerThreadId,
      );
      if (providerThread?.providerSessionId == null) return yield* ended;
      const runtime = Option.getOrUndefined(
        yield* providerSessions.get(providerThread.providerSessionId),
      );
      if (runtime === undefined) return yield* ended;
      if (runtime.scientPluginSignIn === undefined) {
        return yield* new PluginSignInError({
          reason: "unsupported",
          detail: "This agent can't sign plugins in from Scient.",
        });
      }
      return yield* runtime.scientPluginSignIn.open({
        threadId: input.threadId,
        providerThread,
        attemptId: input.attemptId,
      });
    },
    // Lookup failures can carry thread details; callers see one safe line.
    (effect, input) =>
      effect.pipe(
        Effect.catchIf(
          (cause) => !isPluginSignInError(cause),
          (cause) =>
            Effect.logWarning("plugin-sign-in.failed", {
              threadId: input.threadId,
              cause: Predicate.hasProperty(cause, "_tag") ? cause._tag : "unknown",
            }).pipe(
              Effect.andThen(
                Effect.fail(
                  new PluginSignInError({
                    reason: "failed",
                    detail: "Scient couldn't open this sign-in.",
                  }),
                ),
              ),
            ),
        ),
      ),
  );

  return {
    [WS_METHODS.pluginSignInOpen]: (input) =>
      observeRpcEffect(WS_METHODS.pluginSignInOpen, open(input), {
        "rpc.aggregate": "provider",
      }),
  } satisfies ScientRpcHandlerSubset<
    typeof WsWorkspaceRpcGroup,
    typeof WS_METHODS.pluginSignInOpen
  >;
};
