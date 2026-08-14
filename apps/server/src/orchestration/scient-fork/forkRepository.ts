import {
  IsoDateTime,
  NonNegativeInt,
  OrchestrationForkWorkspaceMode,
  MessageId,
  ThreadId,
  TurnId,
  ThreadForkAttachmentCopy,
  ThreadForkCopiedBoundary,
  type ThreadForkedPayload,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type * as SqlClient from "effect/unstable/sql/SqlClient";

export type ScientForkCheckpointStatus = "ready" | "unavailable";
export type ScientForkWorkspaceStatus = "project-root" | "shared" | "worktree";

const AttachmentCopiesJson = Schema.fromJsonString(Schema.Array(ThreadForkAttachmentCopy));
const encodeAttachmentCopiesJson = Schema.encodeEffect(AttachmentCopiesJson);
const CopiedBoundariesJson = Schema.fromJsonString(Schema.Array(ThreadForkCopiedBoundary));
const encodeCopiedBoundariesJson = Schema.encodeEffect(CopiedBoundariesJson);
const ForkRow = Schema.Struct({
  thread_id: ThreadId,
  forked_from_thread_id: ThreadId,
  fork_point_turn_id: Schema.NullOr(TurnId),
  fork_point_turn_count: NonNegativeInt,
  source_checkpoint_turn_count: Schema.NullOr(NonNegativeInt),
  baseline_turn_id: TurnId,
  baseline_user_message_id: Schema.NullOr(MessageId),
  baseline_assistant_message_id: Schema.NullOr(MessageId),
  fork_point_kind: Schema.Literals(["assistant-response", "user-message"]),
  source_user_message_id: Schema.NullOr(MessageId),
  copied_boundaries_json: CopiedBoundariesJson,
  workspace_mode: OrchestrationForkWorkspaceMode,
  attachment_copies_json: AttachmentCopiesJson,
  created_at: IsoDateTime,
});
const decodeForkRow = Schema.decodeUnknownEffect(ForkRow);
const ForkStatusRow = Schema.Struct({
  status: Schema.Literals(["pending", "provisioning", "failed", "abandoned", "ready"]),
  last_error: Schema.NullOr(Schema.String),
});
const decodeForkStatusRow = Schema.decodeUnknownEffect(ForkStatusRow);

function forkRowToPayload(row: typeof ForkRow.Type): ThreadForkedPayload {
  return {
    originThreadId: row.forked_from_thread_id,
    newThreadId: row.thread_id,
    forkAtTurnId: row.fork_point_turn_id,
    forkAtTurnCount: row.fork_point_turn_count,
    sourceCheckpointTurnCount: row.source_checkpoint_turn_count,
    baselineTurnId: row.baseline_turn_id,
    baselineUserMessageId: row.baseline_user_message_id,
    baselineAssistantMessageId: row.baseline_assistant_message_id,
    forkPointKind: row.fork_point_kind,
    sourceUserMessageId: row.source_user_message_id,
    copiedBoundaries: row.copied_boundaries_json,
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
  const copiedBoundariesJson = yield* encodeCopiedBoundariesJson(payload.copiedBoundaries).pipe(
    Effect.orDie,
  );
  yield* sql`
    INSERT INTO scient_thread_lineage (
      thread_id,
      forked_from_thread_id,
      fork_point_turn_id,
      fork_point_turn_count,
      source_checkpoint_turn_count,
      baseline_turn_id,
      baseline_user_message_id,
      baseline_assistant_message_id,
      fork_point_kind,
      source_user_message_id,
      copied_boundaries_json,
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
      ${payload.forkAtTurnId},
      ${payload.forkAtTurnCount},
      ${payload.sourceCheckpointTurnCount},
      ${payload.baselineTurnId},
      ${payload.baselineUserMessageId},
      ${payload.baselineAssistantMessageId},
      ${payload.forkPointKind ?? "assistant-response"},
      ${payload.sourceUserMessageId ?? null},
      ${copiedBoundariesJson},
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
    ON CONFLICT(thread_id) DO UPDATE SET
      fork_point_turn_id = COALESCE(scient_thread_lineage.fork_point_turn_id, excluded.fork_point_turn_id),
      source_checkpoint_turn_count = COALESCE(scient_thread_lineage.source_checkpoint_turn_count, excluded.source_checkpoint_turn_count),
      baseline_turn_id = COALESCE(scient_thread_lineage.baseline_turn_id, excluded.baseline_turn_id),
      baseline_user_message_id = COALESCE(scient_thread_lineage.baseline_user_message_id, excluded.baseline_user_message_id),
      baseline_assistant_message_id = COALESCE(scient_thread_lineage.baseline_assistant_message_id, excluded.baseline_assistant_message_id),
      fork_point_kind = excluded.fork_point_kind,
      source_user_message_id = COALESCE(scient_thread_lineage.source_user_message_id, excluded.source_user_message_id),
      copied_boundaries_json = CASE
        WHEN scient_thread_lineage.copied_boundaries_json = '[]'
          THEN excluded.copied_boundaries_json
        ELSE scient_thread_lineage.copied_boundaries_json
      END
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
      AND status NOT IN ('ready', 'abandoned')
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
  // Abandoned is terminal: it cannot regress to failed. Only non-terminal,
  // non-ready states (pending, provisioning, failed) can be marked failed.
  yield* sql`
    UPDATE scient_thread_lineage
    SET
      status = 'failed',
      last_error = ${input.error},
      updated_at = ${input.updatedAt}
    WHERE thread_id = ${input.threadId}
      AND status NOT IN ('ready', 'abandoned')
  `;
});

export const markForkAbandoned = Effect.fn("markForkAbandoned")(function* (
  sql: SqlClient.SqlClient,
  input: {
    readonly threadId: ThreadId;
    readonly error: string;
    readonly updatedAt: string;
  },
) {
  // Abandoned is terminal. Only non-terminal, non-ready states can be
  // abandoned; an already-abandoned row is unchanged.
  yield* sql`
    UPDATE scient_thread_lineage
    SET
      status = 'abandoned',
      last_error = ${input.error},
      updated_at = ${input.updatedAt}
    WHERE thread_id = ${input.threadId}
      AND status NOT IN ('ready', 'abandoned')
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
  // Only non-terminal, non-ready states can transition to ready. Abandoned
  // is terminal and cannot regress. The fidelity_mode compatibility column
  // is not written here; it was set by insertPendingFork and normalized by
  // migration 3.
  yield* sql`
    UPDATE scient_thread_lineage
    SET
      status = 'ready',
      checkpoint_status = ${input.checkpointStatus},
      workspace_status = ${input.workspaceStatus},
      last_error = NULL,
      updated_at = ${input.updatedAt}
    WHERE thread_id = ${input.threadId}
      AND status IN ('pending', 'provisioning', 'failed')
  `;
});

export const listRecoverableForks = Effect.fn("listRecoverableForks")(function* (
  sql: SqlClient.SqlClient,
) {
  const rows = yield* sql<Record<string, unknown>>`
    SELECT
      thread_id,
      forked_from_thread_id,
      fork_point_turn_id,
      fork_point_turn_count,
      source_checkpoint_turn_count,
      baseline_turn_id,
      baseline_user_message_id,
      baseline_assistant_message_id,
      fork_point_kind,
      source_user_message_id,
      COALESCE(copied_boundaries_json, '[]') AS copied_boundaries_json,
      workspace_mode,
      attachment_copies_json,
      created_at
    FROM scient_thread_lineage
    WHERE status IN ('pending', 'provisioning', 'failed')
      AND baseline_turn_id IS NOT NULL
    ORDER BY created_at ASC, thread_id ASC
  `;
  return yield* Effect.forEach(rows, (row) =>
    decodeForkRow(row).pipe(Effect.map(forkRowToPayload)),
  );
});

export const getRecoverableFork = Effect.fn("getRecoverableFork")(function* (
  sql: SqlClient.SqlClient,
  threadId: ThreadId,
) {
  const rows = yield* sql<Record<string, unknown>>`
    SELECT
      thread_id,
      forked_from_thread_id,
      fork_point_turn_id,
      fork_point_turn_count,
      source_checkpoint_turn_count,
      baseline_turn_id,
      baseline_user_message_id,
      baseline_assistant_message_id,
      fork_point_kind,
      source_user_message_id,
      COALESCE(copied_boundaries_json, '[]') AS copied_boundaries_json,
      workspace_mode,
      attachment_copies_json,
      created_at
    FROM scient_thread_lineage
    WHERE thread_id = ${threadId}
      AND status IN ('pending', 'provisioning', 'failed')
      AND baseline_turn_id IS NOT NULL
    LIMIT 1
  `;
  return rows[0] === undefined
    ? null
    : yield* decodeForkRow(rows[0]).pipe(Effect.map(forkRowToPayload));
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
