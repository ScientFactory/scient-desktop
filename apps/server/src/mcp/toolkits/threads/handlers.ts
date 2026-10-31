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
 * Authority comes from the host-issued invocation, never from the input: a
 * thread may read itself or another non-deleted thread in its own project.
 */
export const readHandoffSummaryForInvocation = Effect.fn("ScientThreadsToolkit.readHandoffSummary")(
  function* (input: ScientHandoffSummaryReadInput) {
    const invocation = yield* AgentInvocationContext.AgentInvocationContext;
    if (!invocation.capabilities.has("threads:read")) {
      return yield* toolError(
        "capability_denied",
        "This provider session does not grant read access to Scient threads.",
      );
    }
    const projections = yield* ProjectionStoreV2;
    const target = yield* projections
      .getThreadShell(input.threadId)
      .pipe(Effect.mapError(readFailed(input.threadId)));
    if (target === null) {
      return yield* toolError(
        "thread_not_found",
        `Thread ${input.threadId} does not exist or is no longer available.`,
      );
    }
    if (input.threadId !== invocation.threadId) {
      const caller = yield* projections
        .getThreadShell(invocation.threadId)
        .pipe(Effect.mapError(readFailed(input.threadId)));
      if (caller === null || caller.projectId !== target.projectId) {
        return yield* toolError(
          "thread_outside_project",
          `Thread ${input.threadId} is not in the calling thread's project. scient_handoff_summary_read only reads threads in the calling project.`,
        );
      }
    }
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
