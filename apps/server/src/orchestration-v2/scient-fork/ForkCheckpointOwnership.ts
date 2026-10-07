/** Durable ownership of a fork snapshot before EventSink admission. Never
 * deletes a worktree or branch, and never adopts an orphan as a new text cut.
 */
import {
  CheckpointRef,
  CommandId,
  ThreadId,
  VcsCheckpointUnavailableError,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { CommandReceiptStoreV2 } from "../CommandReceiptStore.ts";
import { ProjectionStoreV2 } from "../ProjectionStore.ts";
import { ScientForkCheckpointBaseline } from "./ForkCheckpointBaseline.ts";
import { randomUuidV4 } from "../RandomUuid.ts";
import { VcsProcess } from "../../vcs/VcsProcess.ts";

interface Ownership {
  readonly attempt_id: string;
  readonly command_id: string;
  readonly target_thread_id: string;
  readonly cwd: string;
  readonly checkpoint_ref: string;
  readonly checkpoint_oid: string | null;
  readonly owner_pid: number;
}
// A second layer built in the same server must not reconcile an active capture.
const activeAttempts = new Set<string>();
const ownerAlive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
};

export const makeForkCheckpointOwnership = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const receipts = yield* CommandReceiptStoreV2;
  const projections = yield* ProjectionStoreV2;
  const baseline = yield* ScientForkCheckpointBaseline;
  const vcs = yield* VcsProcess;
  const unavailable = (cwd: string, _cause: unknown) =>
    new VcsCheckpointUnavailableError({
      operation: "ScientForkCheckpointOwnership",
      cwd,
      reason: "filesystem-error",
      detail: "The fork snapshot ownership record could not be persisted.",
    });
  const reconcile = Effect.fn("ForkCheckpointOwnership.reconcile")(function* (row: Ownership) {
    const receipt = yield* receipts.getByCommandId(CommandId.make(row.command_id));
    const target = yield* projections
      .getThread(ThreadId.make(row.target_thread_id))
      .pipe(Effect.catchTag("ProjectionStoreThreadNotFoundError", () => Effect.succeed(null)));
    const accepted =
      Option.isSome(receipt) &&
      receipt.value.status === "accepted" &&
      receipt.value.threadId === row.target_thread_id &&
      receipt.value.commandType === "thread.conversation.fork";
    const destinationMatches =
      target?.conversationFork?.commandId === row.command_id &&
      target.conversationFork.checkpointRef === row.checkpoint_ref &&
      target.conversationFork.checkpointOid === row.checkpoint_oid;
    if (accepted && !destinationMatches) {
      yield* Effect.logWarning(
        "Accepted fork snapshot metadata changed; preserving its ownership record",
        {
          attemptId: row.attempt_id,
        },
      );
      return;
    }
    if (!accepted) {
      if (!(yield* baseline.isGitRepository(row.cwd))) {
        yield* Effect.logWarning(
          "Fork snapshot workspace unavailable; preserving its ownership record",
          {
            attemptId: row.attempt_id,
          },
        );
        return;
      }
      const current = yield* baseline.resolveCheckpoint(
        row.cwd,
        CheckpointRef.make(row.checkpoint_ref),
      );
      if (current !== null) {
        if (current !== row.checkpoint_oid) {
          yield* Effect.logWarning(
            "Fork snapshot ref changed; preserving it and its ownership record",
            { attemptId: row.attempt_id },
          );
          return;
        }
        // Compare-and-delete protects a ref changed after the read as well.
        yield* vcs.run({
          operation: "ForkCheckpointOwnership.release",
          command: "git",
          cwd: row.cwd,
          args: ["update-ref", "-d", row.checkpoint_ref, current],
        });
      }
    }
    yield* sql`DELETE FROM scient_fork_checkpoint_ownership WHERE attempt_id = ${row.attempt_id}`;
  });
  const recover = Effect.fn("ForkCheckpointOwnership.recover")(function* () {
    // Stream rows in fixed batches. A damaged or concurrently changed resource
    // remains recorded; it must not prevent the remaining resources recovering.
    let cursor = "";
    for (;;) {
      const rows = yield* sql<Ownership>`SELECT * FROM scient_fork_checkpoint_ownership
        WHERE attempt_id > ${cursor} ORDER BY attempt_id LIMIT 64`;
      if (rows.length === 0) break;
      for (const row of rows) {
        cursor = row.attempt_id;
        if (
          activeAttempts.has(row.attempt_id) ||
          (row.owner_pid !== process.pid && ownerAlive(row.owner_pid))
        )
          continue;
        yield* reconcile(row).pipe(
          Effect.catch((cause) =>
            Effect.logWarning("Fork snapshot recovery deferred", {
              attemptId: row.attempt_id,
              cause,
            }),
          ),
        );
      }
    }
  });
  const reserve = Effect.fn("ForkCheckpointOwnership.reserve")(function* (input: {
    readonly commandId: CommandId;
    readonly targetThreadId: ThreadId;
    readonly cwd: string;
    readonly checkpointRef: CheckpointRef;
  }) {
    const attempt = yield* randomUuidV4;
    // Keep the existing per-thread namespace for pruning, with a unique attempt
    // suffix. A rejected/crashed attempt can never replace the next cut's ref.
    const ref = CheckpointRef.make(`${input.checkpointRef}-${attempt}`);
    const row: Ownership = {
      attempt_id: attempt,
      command_id: input.commandId,
      target_thread_id: input.targetThreadId,
      cwd: input.cwd,
      checkpoint_ref: ref,
      checkpoint_oid: null,
      owner_pid: process.pid,
    };
    yield* Effect.acquireRelease(
      sql`INSERT INTO scient_fork_checkpoint_ownership ${sql.insert({ ...row })}`.pipe(
        Effect.tap(() => Effect.sync(() => activeAttempts.add(attempt))),
        Effect.mapError((cause) => unavailable(input.cwd, cause)),
      ),
      () =>
        Effect.gen(function* () {
          const rows =
            yield* sql<Ownership>`SELECT * FROM scient_fork_checkpoint_ownership WHERE attempt_id = ${attempt}`;
          if (rows[0]) yield* reconcile(rows[0]);
        }).pipe(
          Effect.catch((cause) =>
            Effect.logWarning("Fork snapshot release deferred to recovery", {
              attemptId: attempt,
              cause,
            }),
          ),
          Effect.ensuring(Effect.sync(() => activeAttempts.delete(attempt))),
        ),
    );
    return {
      ref,
      beforePublish: (publication: {
        readonly cwd: string;
        readonly checkpointRef: string;
        readonly commitOid: string;
      }) =>
        Effect.gen(function* () {
          if (publication.cwd !== input.cwd || publication.checkpointRef !== ref)
            return yield* unavailable(input.cwd, "Snapshot publication owner mismatch");
          const rows = yield* sql<{
            checkpoint_oid: string;
          }>`UPDATE scient_fork_checkpoint_ownership SET checkpoint_oid = ${publication.commitOid}
          WHERE attempt_id = ${attempt} AND (checkpoint_oid IS NULL OR checkpoint_oid = ${publication.commitOid})
          RETURNING checkpoint_oid`.pipe(Effect.mapError((cause) => unavailable(input.cwd, cause)));
          if (rows.length !== 1 || rows[0]?.checkpoint_oid !== publication.commitOid)
            return yield* unavailable(input.cwd, "Snapshot publication owner disappeared");
        }),
    };
  });
  return { recover, reserve };
});
