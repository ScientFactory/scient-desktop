import {
  IsoDateTime,
  NonNegativeInt,
  OrchestrationForkWorkspaceMode,
  ThreadId,
  ThreadForkAttachmentCopy,
  type ThreadForkedPayload,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type * as SqlClient from "effect/unstable/sql/SqlClient";

export type ScientForkCheckpointStatus = "ready" | "unavailable";
export type ScientForkWorkspaceStatus = "project-root" | "shared" | "worktree";

const AttachmentCopiesJson = Schema.fromJsonString(Schema.Array(ThreadForkAttachmentCopy));
const encodeAttachmentCopiesJson = Schema.encodeEffect(AttachmentCopiesJson);
const ForkRow = Schema.Struct({
  thread_id: ThreadId,
  forked_from_thread_id: ThreadId,
  fork_point_turn_count: NonNegativeInt,
  workspace_mode: OrchestrationForkWorkspaceMode,
  attachment_copies_json: AttachmentCopiesJson,
  created_at: IsoDateTime,
});
const decodeForkRow = Schema.decodeUnknownEffect(ForkRow);
const ForkStatusRow = Schema.Struct({
  status: Schema.Literals(["pending", "provisioning", "failed", "ready"]),
  last_error: Schema.NullOr(Schema.String),
});
const decodeForkStatusRow = Schema.decodeUnknownEffect(ForkStatusRow);

function forkRowToPayload(row: typeof ForkRow.Type): ThreadForkedPayload {
  return {
    originThreadId: row.forked_from_thread_id,
    newThreadId: row.thread_id,
    forkAtTurnCount: row.fork_point_turn_count,
    workspaceMode: row.workspace_mode,
    providerMode: "transcript-bootstrap",
    attachmentCopies: row.attachment_copies_json,
    createdAt: row.created_at,
  };
}

export const insertPendingFork = Effect.fn("insertPendingFork")(function* (
  sql: SqlClient.SqlClient,
  payload: ThreadForkedPayload,
) {
  const attachmentCopiesJson = yield* encodeAttachmentCopiesJson(payload.attachmentCopies).pipe(
    Effect.orDie,
  );
  yield* sql`
    INSERT INTO scient_thread_lineage (
      thread_id,
      forked_from_thread_id,
      fork_point_turn_count,
      workspace_mode,
      provider_mode,
      provider_bootstrap_status,
      attachment_copies_json,
      fidelity_mode,
      status,
      checkpoint_status,
      workspace_status,
      attempt_count,
      last_error,
      created_at,
      updated_at
    ) VALUES (
      ${payload.newThreadId},
      ${payload.originThreadId},
      ${payload.forkAtTurnCount},
      ${payload.workspaceMode},
      ${payload.providerMode},
      'pending',
      ${attachmentCopiesJson},
      'transcript-bootstrap',
      'pending',
      'pending',
      'pending',
      0,
      NULL,
      ${payload.createdAt},
      ${payload.createdAt}
    )
    ON CONFLICT(thread_id) DO NOTHING
  `;
});

export const claimFork = Effect.fn("claimFork")(function* (
  sql: SqlClient.SqlClient,
  threadId: ThreadId,
  updatedAt: string,
) {
  const claimed = yield* sql<{ readonly thread_id: string }>`
    UPDATE scient_thread_lineage
    SET
      status = 'provisioning',
      attempt_count = attempt_count + 1,
      last_error = NULL,
      updated_at = ${updatedAt}
    WHERE thread_id = ${threadId}
      AND status <> 'ready'
    RETURNING thread_id
  `;
  return claimed.length > 0;
});

export const markForkFailed = Effect.fn("markForkFailed")(function* (
  sql: SqlClient.SqlClient,
  input: {
    readonly threadId: ThreadId;
    readonly error: string;
    readonly updatedAt: string;
  },
) {
  yield* sql`
    UPDATE scient_thread_lineage
    SET
      status = 'failed',
      last_error = ${input.error},
      updated_at = ${input.updatedAt}
    WHERE thread_id = ${input.threadId}
      AND status <> 'ready'
  `;
});

export const markForkReady = Effect.fn("markForkReady")(function* (
  sql: SqlClient.SqlClient,
  input: {
    readonly threadId: ThreadId;
    readonly checkpointStatus: ScientForkCheckpointStatus;
    readonly workspaceStatus: ScientForkWorkspaceStatus;
    readonly updatedAt: string;
  },
) {
  yield* sql`
    UPDATE scient_thread_lineage
    SET
      status = 'ready',
      fidelity_mode = 'transcript-bootstrap',
      checkpoint_status = ${input.checkpointStatus},
      workspace_status = ${input.workspaceStatus},
      last_error = NULL,
      updated_at = ${input.updatedAt}
    WHERE thread_id = ${input.threadId}
  `;
});

export const listRecoverableForks = Effect.fn("listRecoverableForks")(function* (
  sql: SqlClient.SqlClient,
) {
  const rows = yield* sql<Record<string, unknown>>`
    SELECT
      thread_id,
      forked_from_thread_id,
      fork_point_turn_count,
      workspace_mode,
      attachment_copies_json,
      created_at
    FROM scient_thread_lineage
    WHERE status IN ('pending', 'provisioning', 'failed')
    ORDER BY created_at ASC, thread_id ASC
  `;
  return yield* Effect.forEach(rows, (row) =>
    decodeForkRow(row).pipe(Effect.map(forkRowToPayload)),
  );
});

export const getForkStatus = Effect.fn("getForkStatus")(function* (
  sql: SqlClient.SqlClient,
  threadId: ThreadId,
) {
  const rows = yield* sql<Record<string, unknown>>`
    SELECT status, last_error
    FROM scient_thread_lineage
    WHERE thread_id = ${threadId}
    LIMIT 1
  `;
  return rows[0] === undefined ? null : yield* decodeForkStatusRow(rows[0]);
});
