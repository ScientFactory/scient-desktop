import type { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { ProjectionStoreV2 } from "../../../orchestration-v2/ProjectionStore.ts";
import * as AgentInvocationContext from "../../../scient/operations/AgentInvocationContext.ts";
import {
  HANDOFF_SUMMARY_PAGE_CHARS,
  type ScientHandoffSummaryReadInput,
  ScientHandoffSummaryReadToolError,
  ScientThreadsToolkit,
} from "./tools.ts";

const toolError = (code: ScientHandoffSummaryReadToolError["code"], message: string) =>
  new ScientHandoffSummaryReadToolError({ code, message });

const readFailed = (threadId: ThreadId) => () =>
  toolError("orchestration_error", `Thread ${threadId} could not be read.`);

/**
 * Authority comes from the host-issued invocation, never from the input. Scoping
 * follows upstream's `readThread`: a live caller reads live threads in its own
 * project, and a missing, deleted or other-project thread reads the same.
 */
export const readHandoffSummaryForInvocation = Effect.fn("ScientThreadsToolkit.readHandoffSummary")(
  function* (input: ScientHandoffSummaryReadInput) {
    const invocation = yield* AgentInvocationContext.AgentInvocationContext;
    const projections = yield* ProjectionStoreV2;
    const shell = (threadId: ThreadId) =>
      projections.getThreadShell(threadId).pipe(Effect.mapError(readFailed(input.threadId)));
    const caller = yield* shell(invocation.threadId);
    if (caller === null || caller.deletedAt !== null)
      return yield* toolError("thread_not_found", "The calling thread was not found.");
    const target = input.threadId === caller.id ? caller : yield* shell(input.threadId);
    if (target === null || target.deletedAt !== null || target.projectId !== caller.projectId)
      return yield* toolError("thread_not_found", "The thread was not found.");
    const page = yield* projections
      .getContextHandoffSummaryPage(
        input.threadId,
        input.contextHandoffId,
        input.textOffset ?? 0,
        HANDOFF_SUMMARY_PAGE_CHARS,
      )
      .pipe(Effect.mapError(readFailed(input.threadId)));
    if (page === null)
      return yield* toolError("thread_not_found", "That handoff is not retained by this thread.");
    return { text: page.text, nextTextOffset: page.nextTextOffset };
  },
);

const handlers = {
  scient_handoff_summary_read: (input) => readHandoffSummaryForInvocation(input),
} satisfies Parameters<typeof ScientThreadsToolkit.toLayer>[0];

export const ScientThreadsToolkitHandlersLive = ScientThreadsToolkit.toLayer(handlers);
