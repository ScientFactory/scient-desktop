import {
  IsoDateTime,
  NonNegativeInt,
  OrchestrationForkWorkspaceMode,
  OrchestrationConversationImportSource,
  MessageId,
  ThreadId,
  TurnId,
  ThreadForkAttachmentCopy,
  ThreadForkCopiedBoundary,
  ThreadForkMidTurnCut,
  type ThreadForkedPayload,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { inheritedTurnIdsOf } from "./inheritedTurns.ts";
import * as Schema from "effect/Schema";
import type * as SqlClient from "effect/unstable/sql/SqlClient";

export type ScientForkCheckpointStatus = "ready" | "unavailable";
export type ScientForkWorkspaceStatus = "project-root" | "shared" | "worktree";

const AttachmentCopiesJson = Schema.fromJsonString(Schema.Array(ThreadForkAttachmentCopy));
const encodeAttachmentCopiesJson = Schema.encodeEffect(AttachmentCopiesJson);
const CopiedBoundariesJson = Schema.fromJsonString(Schema.Array(ThreadForkCopiedBoundary));
const encodeCopiedBoundariesJson = Schema.encodeEffect(CopiedBoundariesJson);
const InheritedTurnIdsJson = Schema.fromJsonString(Schema.Array(TurnId));
const encodeInheritedTurnIdsJson = Schema.encodeEffect(InheritedTurnIdsJson);
const MidTurnCutJson = Schema.fromJsonString(ThreadForkMidTurnCut);
const encodeMidTurnCutJson = Schema.encodeEffect(MidTurnCutJson);
const SourcePointJson = Schema.fromJsonString(
  Schema.Struct({
    threadId: ThreadId,
    turnId: Schema.NullOr(TurnId),
    turnCount: NonNegativeInt,
    cutSequence: Schema.optional(NonNegativeInt),
  }),
);
const encodeSourcePointJson = Schema.encodeEffect(SourcePointJson);
const SourceImportJson = Schema.fromJsonString(OrchestrationConversationImportSource);
const encodeSourceImportJson = Schema.encodeEffect(SourceImportJson);

const ForkRow = Schema.Struct({
  thread_id: ThreadId,
  forked_from_thread_id: ThreadId,
  fork_point_turn_id: Schema.NullOr(TurnId),
  fork_point_turn_count: NonNegativeInt,
  source_checkpoint_turn_count: Schema.NullOr(NonNegativeInt),
  baseline_turn_id: TurnId,
  baseline_user_message_id: Schema.NullOr(MessageId),
  baseline_assistant_message_id: Schema.NullOr(MessageId),
  fork_point_kind: Schema.Literals(["assistant-response", "user-message", "running-turn"]),
  source_user_message_id: Schema.NullOr(MessageId),
  copied_boundaries_json: CopiedBoundariesJson,
  workspace_mode: OrchestrationForkWorkspaceMode,
  attachment_copies_json: AttachmentCopiesJson,
  inherited_turn_ids_json: InheritedTurnIdsJson,
  mid_turn_cut_json: Schema.NullOr(MidTurnCutJson),
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
    inheritedTurnIds: row.inherited_turn_ids_json,
    ...(row.mid_turn_cut_json === null ? {} : { midTurnCut: row.mid_turn_cut_json }),
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
  const inheritedTurnIdsJson = yield* encodeInheritedTurnIdsJson(inheritedTurnIdsOf(payload)).pipe(
    Effect.orDie,
  );
  const midTurnCutJson =
    payload.midTurnCut === undefined
      ? null
      : yield* encodeMidTurnCutJson(payload.midTurnCut).pipe(Effect.orDie);
  const sourcePointJson = yield* encodeSourcePointJson({
    threadId: payload.originThreadId,
    turnId: payload.forkAtTurnId,
    turnCount: payload.forkAtTurnCount,
    ...(payload.midTurnCut === undefined ? {} : { cutSequence: payload.midTurnCut.cutSequence }),
  }).pipe(Effect.orDie);
  const sourceImportJson =
    payload.sourceImport === undefined
      ? null
      : yield* encodeSourceImportJson(payload.sourceImport).pipe(Effect.orDie);
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
      inherited_turn_ids_json,
      mid_turn_cut_json,
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
      ${inheritedTurnIdsJson},
      ${midTurnCutJson},
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
      END,
      inherited_turn_ids_json = CASE
        WHEN scient_thread_lineage.inherited_turn_ids_json = '[]'
          THEN excluded.inherited_turn_ids_json
        ELSE scient_thread_lineage.inherited_turn_ids_json
      END,
      mid_turn_cut_json = COALESCE(scient_thread_lineage.mid_turn_cut_json, excluded.mid_turn_cut_json)
  `;
  // The fork's provider context is resolved lazily on its first dispatch.
  yield* sql`
    INSERT INTO scient_context_transfers (
      thread_id,
      type,
      source_thread_id,
      source_point_json,
      status,
      origin_json,
      created_at,
      updated_at
    ) VALUES (
      ${payload.newThreadId},
      'fork',
      ${payload.originThreadId},
      ${sourcePointJson},
      'pending',
      ${sourceImportJson},
      ${payload.createdAt},
      ${payload.createdAt}
    )
    ON CONFLICT(thread_id) DO UPDATE SET
      origin_json = COALESCE(scient_context_transfers.origin_json, excluded.origin_json)
  `;
});

/** Claims provisioning and returns this attempt's number, or null if not claimable. */
export const claimForkAttempt = Effect.fn("claimForkAttempt")(function* (
  sql: SqlClient.SqlClient,
  threadId: ThreadId,
  updatedAt: string,
) {
  const claimed = yield* sql<{ readonly attempt_count: number }>`
    UPDATE scient_thread_lineage
    SET
      status = 'provisioning',
      attempt_count = attempt_count + 1,
      last_error = NULL,
      updated_at = ${updatedAt}
    WHERE thread_id = ${threadId}
      AND status NOT IN ('ready', 'abandoned')
    RETURNING attempt_count
  `;
  return claimed[0]?.attempt_count ?? null;
});

export const claimFork = Effect.fn("claimFork")(function* (
  sql: SqlClient.SqlClient,
  threadId: ThreadId,
  updatedAt: string,
) {
  return (yield* claimForkAttempt(sql, threadId, updatedAt)) !== null;
});

/**
 * The origin turn now recorded at a checkpoint count. A fork copies its
 * baseline by count, so provisioning confirms the count still names the turn
 * the fork was decided from (a revert and rerun can reuse the count).
 */
export const originTurnAtCheckpoint = Effect.fn("originTurnAtCheckpoint")(function* (
  sql: SqlClient.SqlClient,
  input: { readonly originThreadId: ThreadId; readonly checkpointTurnCount: number },
) {
  const rows = yield* sql<{ readonly turn_id: string | null }>`
    SELECT turn_id FROM projection_turns
    WHERE thread_id = ${input.originThreadId}
      AND checkpoint_turn_count = ${input.checkpointTurnCount}
    LIMIT 1
  `;
  return rows[0]?.turn_id ?? null;
});

/** Whether the fork thread was deleted (for example by the user) during setup. */
export const isForkThreadDeleted = Effect.fn("isForkThreadDeleted")(function* (
  sql: SqlClient.SqlClient,
  threadId: ThreadId,
) {
  const rows = yield* sql<{ readonly deleted_at: string | null }>`
    SELECT deleted_at FROM projection_threads WHERE thread_id = ${threadId} LIMIT 1
  `;
  return rows[0] === undefined || rows[0].deleted_at !== null;
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
      inherited_turn_ids_json,
      mid_turn_cut_json,
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
      inherited_turn_ids_json,
      mid_turn_cut_json,
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

/** What a user sees when sending to a fork that is not set up. */
export function forkNotReadyDetail(status: {
  readonly status: string;
  readonly last_error: string | null;
}): string {
  const reason = status.last_error ? `: ${status.last_error}` : ".";
  switch (status.status) {
    case "failed":
      return `This fork's setup failed${reason} Fork the conversation again, or restart Scient to retry the setup.`;
    case "abandoned":
      return `This fork could not be set up${reason} Fork the conversation again.`;
    default:
      return "This fork is still being set up. Send your message again once it is ready.";
  }
}

/** Read the immutable copy manifest only after provisioning has succeeded. */
export const getReadyForkAttachmentIdMap = Effect.fn("getReadyForkAttachmentIdMap")(function* (
  sql: SqlClient.SqlClient,
  threadId: ThreadId,
) {
  const rows = yield* sql<{ readonly attachment_copies_json: string }>`
    SELECT attachment_copies_json FROM scient_thread_lineage
    WHERE thread_id = ${threadId} AND status = 'ready' LIMIT 1
  `;
  if (!rows[0]) return {};
  const copies = yield* Schema.decodeUnknownEffect(AttachmentCopiesJson)(
    rows[0].attachment_copies_json,
  );
  return Object.fromEntries(copies.map(({ source, target }) => [source.id, target.id]));
});
