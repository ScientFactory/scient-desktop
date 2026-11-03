import { hasOperationCapabilities, type OperationDefinition } from "@scientfactory/operations";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { scientOperationCatalog } from "../../mcp/ScientOperationCatalog.ts";
import { AgentInvocationContext, type AgentInvocationScope } from "./AgentInvocationContext.ts";
import { resolveAgentWorkspace } from "./AgentWorkspaceScope.ts";
import { WorkspaceBindingResolver } from "../projectScope/WorkspaceBindingResolver.ts";

export class AgentOperationUnavailable extends Schema.TaggedError<AgentOperationUnavailable>()(
  "AgentOperationUnavailable",
  { message: Schema.String },
) {}

function operationAvailable(operation: OperationDefinition, invocation: AgentInvocationScope) {
  return (
    hasOperationCapabilities(operation, invocation.capabilities) &&
    (operation.scope !== "skill-release" || invocation.skillScope !== undefined)
  );
}

/**
 * Internal admission primitive. External callers select registered tools, not
 * an operation ID plus an arbitrary effect. Domains retain publication fences.
 */
export const dispatchScientOperation = Effect.fn("AgentOperationDispatcher.dispatch")(function* <
  A,
  E,
  R,
>(operationId: string, action: Effect.Effect<A, E, R>) {
  const invocation = yield* AgentInvocationContext;
  const operation = scientOperationCatalog.get(operationId);
  if (!operation || !operationAvailable(operation, invocation)) {
    return yield* new AgentOperationUnavailable({
      message: "This Scient operation is not available in this agent session.",
    });
  }
  if (operation.scope !== "workspace") return yield* action;
  const resolver = yield* Effect.serviceOption(WorkspaceBindingResolver);
  if (Option.isNone(resolver))
    return yield* new AgentOperationUnavailable({
      message: "This host has no workspace resolver for the requested operation.",
    });
  const workspace = yield* resolveAgentWorkspace().pipe(
    Effect.provideService(WorkspaceBindingResolver, resolver.value),
  );
  return yield* action.pipe(
    Effect.provideService(AgentInvocationContext, { ...invocation, workspace }),
  );
});

/** Discovery uses the same grants as dispatch; a stale list never grants access. */
export const listAvailableScientOperations = Effect.fn("AgentOperationDispatcher.list")(
  function* () {
    const invocation = yield* AgentInvocationContext;
    const allowed = scientOperationCatalog
      .list()
      .filter((operation) => operationAvailable(operation, invocation));
    if (!allowed.some((operation) => operation.scope === "workspace")) return allowed;
    const verified = yield* resolveAgentWorkspace().pipe(
      Effect.tapError((cause) =>
        cause.code === "project-required"
          ? Effect.void
          : Effect.logWarning("Scient workspace tool discovery unavailable", {
              error: cause._tag,
              code: cause.code,
            }),
      ),
      Effect.option,
    );
    return allowed.filter(
      (operation) => operation.scope !== "workspace" || Option.isSome(verified),
    );
  },
);
