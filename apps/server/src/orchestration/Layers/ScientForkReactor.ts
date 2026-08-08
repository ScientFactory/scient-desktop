/**
 * ScientForkReactor - reacts to `thread.forked` and provisions the fork's
 * CODE-STATE substrate.
 *
 * SCIENT-OWNED. When a `thread.forked` domain event is observed, this reactor
 * establishes the new thread's git substrate for the chosen workspace mode:
 *
 *   - always: a checkpoint baseline is written by copying the origin thread's
 *     fork-point checkpoint ref onto the new thread's turn-0 checkpoint ref, so
 *     the new thread's timeline starts from exactly the origin's fork-point tree.
 *   - "new-worktree": a fresh worktree branched from the fork-point ref is
 *     created and recorded on the new thread's metadata.
 *   - "local": the origin thread's worktree path (when present) is adopted by
 *     the new thread so both operate over the same working tree.
 *
 * It then records the achieved fidelity via `thread.fork.complete`. Fidelity is
 * always "chat-only" for now: the fork carries the event-spine transcript only.
 *
 * Mirrors `CheckpointReactor` exactly (drainable worker + parked stream fork +
 * error-safe processing) so it is idempotent and a failed substrate can never
 * crash the fiber — the new thread already durably exists with its transcript.
 * Retire this module if/when T3 ships native thread fork.
 *
 * SCIENT-FORK FOLLOW-UP: native conversational-session continuity is a
 * deliberate later increment. The provider layer already implements and tests
 * `providerService.forkConversation`; a follow-up will call it here (plus bind a
 * resume cursor at the new thread's first turn) and report "native-session"
 * fidelity. It is intentionally NOT invoked here.
 *
 * @module ScientForkReactor
 */
import { CommandId, type GitCommandError, type OrchestrationEvent } from "@t3tools/contracts";
import * as Cache from "effect/Cache";
import * as Cause from "effect/Cause";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type * as PlatformError from "effect/PlatformError";
import * as Stream from "effect/Stream";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";

import { checkpointRefForThreadTurn } from "../../checkpointing/Utils.ts";
import * as CheckpointStore from "../../checkpointing/CheckpointStore.ts";
import type { CheckpointStoreError } from "../../checkpointing/Errors.ts";
import { GitWorkflowService } from "../../git/GitWorkflowService.ts";
import type { ProjectionRepositoryError } from "../../persistence/Errors.ts";
import { forkParked } from "../../serverActivation.ts";
import { ScientForkReactor, type ScientForkReactorShape } from "../Services/ScientForkReactor.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import type { OrchestrationDispatchError } from "../Errors.ts";

const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

type ForkedEvent = Extract<OrchestrationEvent, { type: "thread.forked" }>;

// Dedup bounds mirror ProviderCommandReactor's handled-turn-start cache: a
// replayed `thread.forked` (e.g. a resuming client re-observing history) must
// not double-provision the substrate.
const HANDLED_FORK_KEY_MAX = 10_000;
const HANDLED_FORK_KEY_TTL = Duration.minutes(30);

const make = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  const randomUUID = crypto.randomUUIDv4;
  const serverCommandId = (tag: string) =>
    randomUUID.pipe(Effect.map((uuid) => CommandId.make(`server:${tag}:${uuid}`)));
  const orchestrationEngine = yield* OrchestrationEngineService;
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
  const checkpointStore = yield* CheckpointStore.CheckpointStore;
  const gitWorkflow = yield* GitWorkflowService;

  // Keyed on the NEW thread id so a re-observed fork for the same new thread is
  // provisioned exactly once (mirrors ProviderCommandReactor's dedup cache).
  const handledForkKeys = yield* Cache.make<string, true>({
    capacity: HANDLED_FORK_KEY_MAX,
    timeToLive: HANDLED_FORK_KEY_TTL,
    lookup: () => Effect.succeed(true),
  });
  const hasHandledForkRecently = (key: string) =>
    Cache.getOption(handledForkKeys, key).pipe(
      Effect.flatMap((cached) =>
        Cache.set(handledForkKeys, key, true).pipe(Effect.as(Option.isSome(cached))),
      ),
    );

  // Report the fidelity the fork actually achieved. Always "chat-only" for now.
  const completeFork = (newThreadId: ForkedEvent["payload"]["newThreadId"]) =>
    Effect.all({ commandId: serverCommandId("scient-fork-complete"), createdAt: nowIso }).pipe(
      Effect.flatMap(({ commandId, createdAt }) =>
        orchestrationEngine.dispatch({
          type: "thread.fork.complete",
          commandId,
          threadId: newThreadId,
          fidelityMode: "chat-only",
          createdAt,
        }),
      ),
    );

  const processFork = Effect.fn("processFork")(function* (event: ForkedEvent) {
    const payload = event.payload;

    // Idempotency: a replayed `thread.forked` must not re-provision.
    const alreadyHandled = yield* hasHandledForkRecently(payload.newThreadId);
    if (alreadyHandled) {
      yield* Effect.logDebug("scient fork reactor: fork already provisioned; skipping", {
        newThreadId: payload.newThreadId,
      });
      return;
    }

    // a. Resolve the origin thread's workspace context. Without it we cannot
    //    locate a git working tree, so there is no CODE-STATE substrate to
    //    establish — still finalize the fork chat-only (the new thread already
    //    durably exists with its transcript).
    const ctxOption = yield* projectionSnapshotQuery.getThreadCheckpointContext(
      payload.originThreadId,
    );
    if (Option.isNone(ctxOption)) {
      yield* Effect.logWarning(
        "scient fork reactor: origin checkpoint context missing; completing fork chat-only",
        { originThreadId: payload.originThreadId, newThreadId: payload.newThreadId },
      );
      yield* completeFork(payload.newThreadId);
      return;
    }
    const ctx = ctxOption.value;

    // b. Prefer the origin thread's dedicated worktree; fall back to the
    //    project workspace root.
    const originCwd = ctx.worktreePath ?? ctx.workspaceRoot;

    // c. The baseline copies the origin's fork-point tree onto the new thread's
    //    turn-0 checkpoint ref.
    const fromRef = checkpointRefForThreadTurn(payload.originThreadId, payload.forkAtTurnCount);
    const toRef = checkpointRefForThreadTurn(payload.newThreadId, 0);

    // d. Establish the workspace substrate for the chosen mode.
    if (payload.workspaceMode === "new-worktree") {
      const wt = yield* gitWorkflow.createWorktree({
        cwd: originCwd,
        refName: fromRef,
        newRefName: `scient/fork/${payload.newThreadId}`,
        path: null,
      });
      yield* orchestrationEngine.dispatch({
        type: "thread.meta.update",
        commandId: yield* serverCommandId("scient-fork-meta"),
        threadId: payload.newThreadId,
        branch: wt.worktree.refName,
        worktreePath: wt.worktree.path,
      });
    } else if (ctx.worktreePath !== null) {
      // "local": adopt the origin's worktree so both threads share the working
      // tree. When the origin has no dedicated worktree there is nothing to
      // record (the new thread cold-starts from the project workspace root).
      yield* orchestrationEngine.dispatch({
        type: "thread.meta.update",
        commandId: yield* serverCommandId("scient-fork-meta"),
        threadId: payload.newThreadId,
        worktreePath: ctx.worktreePath,
      });
    }

    // e. Write the checkpoint baseline. A missing source ref (returns false) is
    //    tolerated: the fork still exists as a chat thread; it just lacks a
    //    filesystem baseline to diff its first turn against.
    const baselined = yield* checkpointStore.forkBaseline({
      cwd: originCwd,
      fromCheckpointRef: fromRef,
      toCheckpointRef: toRef,
    });
    if (!baselined) {
      yield* Effect.logWarning(
        "scient fork reactor: fork baseline source ref missing; continuing without baseline",
        {
          newThreadId: payload.newThreadId,
          fromCheckpointRef: fromRef,
          toCheckpointRef: toRef,
        },
      );
    }

    // f. Record the achieved fidelity.
    yield* completeFork(payload.newThreadId);
  });

  const processInput = (
    event: ForkedEvent,
  ): Effect.Effect<
    void,
    | CheckpointStoreError
    | OrchestrationDispatchError
    | ProjectionRepositoryError
    | GitCommandError
    | PlatformError.PlatformError,
    never
  > => processFork(event);

  // A failed substrate must NOT crash the worker fiber: the new thread already
  // durably exists with its transcript, so we log everything except interrupts
  // (which must propagate for clean shutdown). Mirrors CheckpointReactor.
  const processInputSafely = (event: ForkedEvent) =>
    processInput(event).pipe(
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) {
          return Effect.failCause(cause);
        }
        return Effect.logWarning("scient fork reactor failed to process input", {
          eventType: event.type,
          newThreadId: event.payload.newThreadId,
          cause: Cause.pretty(cause),
        });
      }),
    );

  const worker = yield* makeDrainableWorker(processInputSafely);

  const start: ScientForkReactorShape["start"] = Effect.fn("start")(function* () {
    yield* forkParked(
      Stream.runForEach(orchestrationEngine.streamDomainEvents, (event) =>
        event.type === "thread.forked" ? worker.enqueue(event) : Effect.void,
      ),
    );
  });

  return {
    start,
    drain: worker.drain,
  } satisfies ScientForkReactorShape;
});

export const ScientForkReactorLive = Layer.effect(ScientForkReactor, make);
