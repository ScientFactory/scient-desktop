/**
 * Forking a running turn: its streamed but unsaved reply text is captured before the fork locks
 * its threads, and the fork commits only while the captured run still owns its thread. When the
 * capture cannot run or the source moves on, the fork keeps the saved history instead of refusing.
 */
import type {
  CommandId,
  OrchestrationDispatchCommandError,
  OrchestrationV2ThreadProjection,
  ScientThreadForkBoundary,
  ThreadId,
} from "@t3tools/contracts";
import {
  ProviderTextSnapshotError,
  type CapturedProviderText,
  type ProviderTextSnapshotOwner,
} from "@t3tools/provider-core/server/ProviderAdapter";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import type { ProviderTextSnapshotManagerShape } from "../scient-provider/ProviderTextSnapshots.ts";

type RunningForkRecords = Pick<
  OrchestrationV2ThreadProjection,
  "thread" | "runs" | "attempts" | "providerThreads" | "providerTurns"
>;

/** The live owner a running fork captures, or why it forks saved history only. */
export type RunningTurnCaptureTarget =
  | { readonly type: "capture"; readonly owner: ProviderTextSnapshotOwner }
  | { readonly type: "saved-history"; readonly reason: "not-codex" | "not-started" }
  | { readonly type: "saved-history"; readonly reason: "boundary-not-ready"; readonly log: true };

/**
 * Only Codex buffers reply text natively. Before its turn is accepted (Codex can take many seconds
 * to start) nothing native is buffered yet, so the fork freezes what is committed.
 */
export function runningTurnCaptureTarget(
  records: RunningForkRecords,
  boundary: Extract<ScientThreadForkBoundary, { kind: "running-turn" }>,
): RunningTurnCaptureTarget {
  const run = records.runs.find((row) => row.id === boundary.runId);
  const thread = records.providerThreads.find((row) => row.id === run?.providerThreadId);
  if (thread?.driver !== "codex") return { type: "saved-history", reason: "not-codex" };
  const attempt = records.attempts.find((row) => row.id === run?.activeAttemptId);
  // Native turn/started can be committed before the start RPC binds the attempt.
  // The accepted turn's exact attempt/root/thread links remain canonical authority.
  const turns = records.providerTurns.filter(
    (row) =>
      row.runAttemptId === attempt?.id &&
      row.nodeId === run?.rootNodeId &&
      row.providerThreadId === thread.id &&
      row.nativeAcceptance === "accepted" &&
      ["running", "waiting"].includes(row.status) &&
      (attempt?.providerTurnId == null || row.id === attempt.providerTurnId),
  );
  if (turns.length === 0) return { type: "saved-history", reason: "not-started" };
  const turn = turns.length === 1 ? turns[0] : undefined;
  if (
    run === undefined ||
    attempt === undefined ||
    turn === undefined ||
    run.rootNodeId === null ||
    thread.providerSessionId === null ||
    thread.nativeThreadRef?.nativeId == null ||
    turn.nativeTurnRef?.nativeId == null
  )
    return { type: "saved-history", reason: "boundary-not-ready", log: true };
  return {
    type: "capture",
    owner: {
      threadId: records.thread.id,
      runId: run.id,
      activeAttemptId: attempt.id,
      rootNodeId: run.rootNodeId,
      runOrdinal: run.ordinal,
      providerThreadId: thread.id,
      nativeThreadId: thread.nativeThreadRef.nativeId,
      providerTurnId: turn.id,
      nativeTurnId: turn.nativeTurnRef.nativeId,
      providerSessionId: thread.providerSessionId,
      providerInstanceId: run.providerInstanceId,
      driver: thread.driver,
    },
  };
}

/** The fork command's parts the capture needs. */
export interface RunningTurnForkCommand {
  readonly commandId: CommandId;
  readonly sourceThreadId: ThreadId;
  readonly scient?: { readonly boundary: ScientThreadForkBoundary } | undefined;
}

const RUNNING_FORK_WITHOUT_LIVE_TEXT = "Running fork forks saved history without live text";

export function makeRunningTurnFork<ERead>(deps: {
  readonly snapshots: Option.Option<ProviderTextSnapshotManagerShape>;
  /** The source's control records, or null once the fork is already accepted. */
  readonly readRecords: (
    fork: RunningTurnForkCommand,
  ) => Effect.Effect<RunningForkRecords | null, ERead>;
  /** Serializes the commit with attachment cleanup, which could remove captured files. */
  readonly withAttachmentPermit: <A, E, R>(
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E, R>;
  readonly workspaceExists: (cwd: string) => Effect.Effect<boolean>;
  readonly unavailable: (message: string) => OrchestrationDispatchCommandError;
}) {
  const { snapshots } = deps;
  const withoutCapture = (reason: string, fork: RunningTurnForkCommand) =>
    Effect.logWarning(RUNNING_FORK_WITHOUT_LIVE_TEXT, {
      reason,
      threadId: fork.sourceThreadId,
    }).pipe(Effect.as(null));

  const capture = Effect.fnUntraced(function* (
    fork: RunningTurnForkCommand,
    boundary: Extract<ScientThreadForkBoundary, { kind: "running-turn" }>,
  ) {
    const records = yield* deps.readRecords(fork);
    if (records === null) return null;
    const target = runningTurnCaptureTarget(records, boundary);
    if (target.type === "saved-history")
      return "log" in target ? yield* withoutCapture(target.reason, fork) : null;
    const manager = Option.getOrUndefined(snapshots);
    if (manager?.captureRunningForkText === undefined)
      return yield* withoutCapture("unavailable", fork);
    return yield* manager.captureRunningForkText(target.owner).pipe(
      Effect.catchTags({
        ProviderTextSnapshotError: (cause) => withoutCapture(cause.reason, fork),
      }),
    );
  });

  const release = (captured: CapturedProviderText | null) =>
    captured === null
      ? Effect.void
      : (Option.getOrUndefined(snapshots)?.releaseCapturedForkText?.(captured) ?? Effect.void);

  return {
    /**
     * Runs the fork attempt with the turn's unsaved text. An attempt built on the capture can fail
     * because the source moved on after it (its turn finished, its worktree changed); the capture
     * is released and the fork forks the saved history as it is now.
     */
    withCapture: <A, E, R>(
      fork: RunningTurnForkCommand,
      attempt: (captured: CapturedProviderText | null) => Effect.Effect<A, E, R>,
    ): Effect.Effect<A, E, R> => {
      const boundary = fork.scient?.boundary;
      return boundary?.kind !== "running-turn"
        ? attempt(null)
        : Effect.scoped(
            Effect.gen(function* () {
              const captured = yield* Effect.acquireRelease(
                capture(fork, boundary).pipe(
                  Effect.catch((cause) =>
                    Effect.logWarning(RUNNING_FORK_WITHOUT_LIVE_TEXT, {
                      reason: "prepare-failed",
                      cause,
                    }).pipe(Effect.as(null)),
                  ),
                ),
                release,
                { interruptible: true },
              );
              if (captured === null) return yield* attempt(null);
              return yield* attempt(captured).pipe(
                Effect.ensuring(release(captured)),
                Effect.catch((cause) =>
                  Effect.logWarning("Running fork forks saved history after its source moved on", {
                    cause,
                  }).pipe(Effect.andThen(attempt(null))),
                ),
              );
            }),
          );
    },
    /** Commits only while the captured run still owns its live text and its files are on disk. */
    fence: <A, E, R>(
      captured: CapturedProviderText,
      cwd: string,
      commit: Effect.Effect<A, E, R>,
    ): Effect.Effect<A, E | OrchestrationDispatchCommandError | ProviderTextSnapshotError, R> => {
      const guarded = Effect.gen(function* () {
        if (!(yield* deps.workspaceExists(cwd)))
          return yield* deps.unavailable("The captured workspace is unavailable. Retry the fork.");
        return yield* commit;
      }).pipe(deps.withAttachmentPermit);
      const manager = Option.getOrUndefined(snapshots);
      return manager?.withCapturedForkText === undefined
        ? Effect.fail(new ProviderTextSnapshotError({ reason: "owner-lost" }))
        : manager.withCapturedForkText(captured, guarded);
    },
  };
}
