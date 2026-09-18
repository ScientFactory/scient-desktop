import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { AgentInvocationContext } from "./AgentInvocationContext.ts";
import { WorkspaceBindingResolver } from "../projectScope/WorkspaceBindingResolver.ts";

export class AgentWorkspaceError extends Schema.TaggedError<AgentWorkspaceError>()(
  "AgentWorkspaceError",
  {
    code: Schema.Literals(["project-required", "project-changed"]),
    message: Schema.String,
  },
) {}

/** A captured receipt is revalidated, never replaced with the thread's newer root. */
export const resolveAgentWorkspace = Effect.fn("AgentWorkspaceScope.resolve")(function* () {
  const invocation = yield* AgentInvocationContext;
  const resolver = yield* WorkspaceBindingResolver;
  const resolved =
    invocation.workspace ??
    (yield* resolver.resolveThread(invocation.threadId).pipe(
      Effect.mapError(
        (cause) =>
          new AgentWorkspaceError({
            code: cause.kind === "project-required" ? "project-required" : "project-changed",
            message:
              cause.kind === "project-required"
                ? "This operation requires a thread in a Scient project."
                : "Scient could not verify the current project workspace. Retry from the project.",
          }),
      ),
    ));
  const binding = resolved.binding;
  if (
    binding.environmentId !== invocation.environmentId ||
    binding.trustState !== "verified" ||
    binding.supersededBy !== null
  ) {
    return yield* new AgentWorkspaceError({
      code: "project-changed",
      message: "The current project workspace is not verified for this operation.",
    });
  }
  if (invocation.workspace) {
    yield* resolver
      .assertCurrentThreadScope({
        threadId: invocation.threadId,
        bindingId: binding.bindingId,
        authorityGeneration: binding.authorityGeneration,
        scopeRevision: resolved.scopeRevision,
      })
      .pipe(
        Effect.mapError(
          () =>
            new AgentWorkspaceError({
              code: "project-changed",
              message:
                "The project workspace changed during this operation. Retry from the project.",
            }),
        ),
      );
  }
  return resolved;
});

/** Domain entrypoints consume this admission, not a second filesystem snapshot.
 * Later queued execution/publication fences still explicitly revalidate. */
export const consumeAgentWorkspace = Effect.fn("AgentWorkspaceScope.consume")(function* () {
  const invocation = yield* AgentInvocationContext;
  if (!invocation.workspace) return yield* resolveAgentWorkspace();
  const binding = invocation.workspace.binding;
  if (
    binding.environmentId !== invocation.environmentId ||
    binding.trustState !== "verified" ||
    binding.supersededBy !== null
  )
    return yield* new AgentWorkspaceError({
      code: "project-changed",
      message: "The admitted workspace is not verified for this operation.",
    });
  return invocation.workspace;
});
