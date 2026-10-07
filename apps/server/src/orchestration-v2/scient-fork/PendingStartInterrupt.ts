/** Interrupts a run whose provider start is still pending. Native turn identity is
 * read only from a recorded receipt; it is never invented before one arrives. */
import {
  ProviderSessionId,
  ProviderThreadId,
  ProviderTurnId,
  RunAttemptId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import type * as ProjectionStore from "../ProjectionStore.ts";
import type { ProviderTurnControlServiceV2Shape } from "../ProviderTurnControlService.ts";

/** Private pending-start control: native turn identity is not invented before its receipt. */
export class ProviderRunInterruptError extends Schema.TaggedError<ProviderRunInterruptError>()(
  "ProviderRunInterruptError",
  {
    threadId: ThreadId,
    runId: RunId,
    reason: Schema.Literals(["receipt_pending", "lookup_failed", "native_interrupt_failed"]),
    cause: Schema.optional(Schema.Defect()),
  },
) {}

const isProviderRunInterruptError = Schema.is(ProviderRunInterruptError);

export type InterruptPendingStart = (input: {
  readonly threadId: ThreadId;
  readonly runId: RunId;
  readonly expectedAttemptId: RunAttemptId;
  readonly providerSessionId: ProviderSessionId;
  readonly providerThreadId: ProviderThreadId;
}) => Effect.Effect<Option.Option<ProviderTurnId>, ProviderRunInterruptError>;

export const makeInterruptPendingStart =
  (deps: {
    readonly projections: ProjectionStore.ProjectionStoreV2Shape;
    readonly interrupt: ProviderTurnControlServiceV2Shape["interrupt"];
  }): InterruptPendingStart =>
  (input) => {
    const { projections, interrupt } = deps;
    return Effect.gen(function* () {
      const projection = yield* projections.getThreadRecords(input.threadId, [
        "runs",
        "attempts",
        "nodes",
        "providerThreads",
        "providerTurns",
      ]);
      if (projection.thread.deletedAt !== null || projection.thread.archivedAt !== null)
        return Option.none();
      const run = projection.runs.find((candidate) => candidate.id === input.runId);
      if (
        run === undefined ||
        run.status !== "running" ||
        run.activeAttemptId !== input.expectedAttemptId ||
        run.providerThreadId !== input.providerThreadId ||
        projection.thread.activeProviderThreadId !== input.providerThreadId
      )
        return Option.none();
      const attempt = projection.attempts.find(
        (candidate) => candidate.id === input.expectedAttemptId,
      );
      const root = projection.nodes.find((candidate) => candidate.id === run.rootNodeId);
      const thread = projection.providerThreads.find(
        (candidate) => candidate.id === input.providerThreadId,
      );
      if (
        attempt === undefined ||
        root === undefined ||
        thread === undefined ||
        attempt.runId !== run.id ||
        attempt.status !== "running" ||
        attempt.rootNodeId !== root.id ||
        attempt.providerThreadId !== thread.id ||
        attempt.providerInstanceId !== run.providerInstanceId ||
        root.runId !== run.id ||
        root.threadId !== input.threadId ||
        root.rootNodeId !== root.id ||
        root.providerThreadId !== thread.id ||
        root.status !== "running" ||
        thread.appThreadId !== input.threadId ||
        thread.providerInstanceId !== run.providerInstanceId ||
        thread.providerSessionId !== input.providerSessionId
      )
        return Option.none();
      const turn = projection.providerTurns.findLast(
        (candidate) =>
          candidate.runAttemptId === attempt.id &&
          candidate.nodeId === root.id &&
          candidate.providerThreadId === thread.id &&
          (attempt.providerTurnId === null || candidate.id === attempt.providerTurnId),
      );
      if (turn === undefined)
        return yield* new ProviderRunInterruptError({
          threadId: input.threadId,
          runId: input.runId,
          reason: "receipt_pending",
        });
      if (turn.status !== "running") return Option.none();
      yield* interrupt({
        threadId: input.threadId,
        providerSessionId: input.providerSessionId,
        providerThreadId: thread.id,
        providerTurnId: turn.id,
      }).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderRunInterruptError({
              threadId: input.threadId,
              runId: input.runId,
              reason: "native_interrupt_failed",
              cause,
            }),
        ),
      );
      return Option.some(turn.id);
    }).pipe(
      Effect.mapError((cause) =>
        isProviderRunInterruptError(cause)
          ? cause
          : new ProviderRunInterruptError({
              threadId: input.threadId,
              runId: input.runId,
              reason: "lookup_failed",
              cause,
            }),
      ),
    );
  };
