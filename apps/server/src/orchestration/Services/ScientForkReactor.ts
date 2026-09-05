/**
 * ScientForkReactor - Scient-owned conversation-fork reaction service interface.
 *
 * SCIENT-OWNED. Owns the background worker that reacts to the `thread.forked`
 * domain event and establishes the fork's CODE-STATE substrate (a git checkpoint
 * baseline plus, for the "new-worktree" workspace mode, a dedicated worktree),
 * then records the achieved fidelity via `thread.fork.complete`. Mirrors
 * `CheckpointReactor` in structure and lifecycle. Retire this module if/when T3
 * ships native thread fork.
 *
 * @module ScientForkReactor
 */
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";
import * as Schema from "effect/Schema";
import {
  ThreadId,
  type ForkDisposition,
  type ForkOptions,
  type GetForkOptionsInput,
} from "@t3tools/contracts";

export class ScientForkCompletionError extends Schema.TaggedErrorClass<ScientForkCompletionError>()(
  "ScientForkCompletionError",
  {
    threadId: ThreadId,
    detail: Schema.String,
  },
) {
  override get message(): string {
    return this.detail;
  }
}

/**
 * ScientForkReactorShape - Service API for the fork reactor lifecycle.
 */
export interface ScientForkReactorShape {
  /**
   * Start the fork reactor.
   *
   * The returned effect must be run in a scope so the worker fiber can be
   * finalized on shutdown. Consumes orchestration-domain events via an internal
   * queue.
   */
  readonly start: () => Effect.Effect<void, never, Scope.Scope>;

  /**
   * Resolves when the internal processing queue is empty and idle.
   * Intended for test use to replace timing-sensitive sleeps.
   */
  readonly drain: Effect.Effect<void>;

  /** Typed completion receipt used by the RPC acknowledgement gate and tests. */
  readonly awaitCompletion: (threadId: ThreadId) => Effect.Effect<void, ScientForkCompletionError>;
  readonly getDisposition: (
    threadId: ThreadId,
  ) => Effect.Effect<ForkDisposition, ScientForkCompletionError>;
  readonly getOptions: (
    input: GetForkOptionsInput,
  ) => Effect.Effect<ForkOptions, ScientForkCompletionError>;
}

/**
 * ScientForkReactor - Service tag for the conversation-fork reactor worker.
 */
export class ScientForkReactor extends Context.Service<ScientForkReactor, ScientForkReactorShape>()(
  "t3/orchestration/Services/ScientForkReactor",
) {}
