import {
  threadPullRequestKeysEqual,
  threadPullRequestsOf,
} from "@t3tools/shared/threadPullRequests";
import {
  ChatAttachment,
  OrchestrationMessageContext,
  DEFAULT_MODEL,
  EventId,
  MessageId,
  ModelSelection,
  type OrchestrationV2AppThread,
  OrchestrationV2AppThreadJson,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2TurnItem,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  ThreadSectionId,
  ThreadLinkedPullRequest,
  ThreadPullRequestLink,
  TurnItemId,
  TurnId,
} from "@t3tools/contracts";
import * as KeyedLock from "@t3tools/shared/KeyedLock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import * as EventSink from "../EventSink.ts";
import {
  CODEX_CITATION_MARKER_PREFIX,
  projectLegacyCitationText,
} from "../legacyCitationProjection.ts";

import { randomUuidV4 } from "../RandomUuid.ts";
import {
  importMarkerField,
  makeForkLineageQueries,
  toForkLineageMarker,
  type ProjectionForkLineageRow,
} from "./LegacyForkLineageReader.ts";
import { importLegacyHistory, prepareLegacyHistory } from "./LegacyScientHistory.ts";
import { writeLegacySourceEvents } from "./LegacySourceReconciliation.ts";
import * as NodeUtil from "node:util";

const IMPORT_EVENT_PREFIX = "migration:v1";
const decodeMessageContext = Schema.decodeUnknownSync(OrchestrationMessageContext);
const TRANSCRIPT_EVENT_BATCH_SIZE = 100;

interface LegacyThreadRow {
  readonly thread_id: string;
  readonly project_id: string;
  readonly title: string;
  readonly section_id: string | null;
  readonly model_selection_json: string | null;
  readonly runtime_mode: string;
  readonly interaction_mode: string;
  readonly branch: string | null;
  readonly worktree_path: string | null;
  readonly created_at: string;
  readonly updated_at: string;
  readonly archived_at: string | null;
  readonly settled_override: string | null;
  readonly settled_at: string | null;
  readonly unsettled_at: string | null;
  readonly snoozed_until: string | null;
  readonly snoozed_at: string | null;
  readonly pinned_at: string | null;
  readonly auto_settle_disabled_at: string | null;
  readonly pin_order_key: string | null;
  readonly pull_requests_json: string;
  readonly linked_pull_request_json: string | null;
  readonly branch_pull_request_json: string | null;
  readonly active_order_key: string | null;
  readonly deleted_at: string | null;
}

interface LegacyRepairRow extends LegacyThreadRow {
  readonly payload_json: string;
}

interface LegacyMessageRow {
  readonly message_id: string;
  readonly turn_id: string | null;
  readonly thread_id: string;
  readonly role: "user" | "assistant";
  readonly text: string;
  readonly attachments_json: string | null;
  readonly context_json?: string | null;
  readonly is_streaming: number;
  readonly created_at: string;
  readonly updated_at: string;
  readonly ordinal: number;
}

interface LegacyImportRow {
  readonly thread_id: string;
  readonly transcript_imported_at: string | null;
  readonly history_repair_version: number;
}

// Increment only when a new missing-only historical repair is required. A
// transcript timestamp alone cannot qualify imports made by older binaries.
export const LEGACY_HISTORY_REPAIR_VERSION = 3;

export interface LegacyV1ImportSummary {
  readonly importedThreadCount: number;
  readonly importedMessageCount: number;
}

export class LegacyV1ThreadImportError extends Schema.TaggedError<LegacyV1ThreadImportError>()(
  "LegacyV1ThreadImportError",
  {
    operation: Schema.String,
    threadId: Schema.optional(ThreadId),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return this.threadId === undefined
      ? `Failed to ${this.operation} legacy v1 threads.`
      : `Failed to ${this.operation} legacy v1 thread ${this.threadId}.`;
  }
}

export interface LegacyV1ThreadImporterShape {
  readonly reconciliationFailure?: Effect.Effect<boolean, LegacyV1ThreadImportError>;
  readonly pendingThreadCount: Effect.Effect<number, LegacyV1ThreadImportError>;
  readonly reconcileShells: Effect.Effect<LegacyV1ImportSummary, LegacyV1ThreadImportError>;
  readonly ensureTranscript: (
    threadId: ThreadId,
  ) => Effect.Effect<LegacyV1ImportSummary, LegacyV1ThreadImportError>;
  readonly importPendingTranscripts: Effect.Effect<LegacyV1ImportSummary, never>;
}

export class LegacyV1ThreadImporter extends Context.Service<
  LegacyV1ThreadImporter,
  LegacyV1ThreadImporterShape
>()("t3/orchestration-v2/legacy/LegacyV1ThreadImporter") {}

const decodeModelSelection = Schema.decodeUnknownOption(ModelSelection);
const decodeAttachmentEntries = Schema.decodeUnknownOption(Schema.Array(Schema.Unknown));
const decodeAttachment = Schema.decodeUnknownOption(ChatAttachment);
const decodePullRequests = Schema.decodeUnknownOption(Schema.Array(ThreadPullRequestLink));
const decodeLinkedPullRequest = Schema.decodeUnknownOption(ThreadLinkedPullRequest);
const decodeStoredThread = Schema.decodeUnknownOption(
  Schema.fromJsonString(OrchestrationV2AppThreadJson),
);
const encodeStoredThread = Schema.encodeSync(Schema.fromJsonString(OrchestrationV2AppThreadJson));
const encodeMessageKey = Schema.encodeSync(Schema.fromJsonString(Schema.Array(Schema.String)));
const decodeRecord = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
);
const decodeThreadBefore = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    Schema.Struct({
      thread_id: Schema.String,
      project_id: Schema.String,
      title: Schema.String,
      section_id: Schema.NullOr(Schema.String),
      model_selection_json: Schema.NullOr(Schema.String),
      runtime_mode: Schema.String,
      interaction_mode: Schema.String,
      branch: Schema.NullOr(Schema.String),
      worktree_path: Schema.NullOr(Schema.String),
      created_at: Schema.String,
      updated_at: Schema.String,
      archived_at: Schema.NullOr(Schema.String),
      settled_override: Schema.NullOr(Schema.String),
      settled_at: Schema.NullOr(Schema.String),
      unsettled_at: Schema.NullOr(Schema.String),
      snoozed_until: Schema.NullOr(Schema.String),
      snoozed_at: Schema.NullOr(Schema.String),
      pinned_at: Schema.NullOr(Schema.String),
      auto_settle_disabled_at: Schema.NullOr(Schema.String),
      pin_order_key: Schema.NullOr(Schema.String),
      linked_pull_request_json: Schema.NullOr(Schema.String),
      branch_pull_request_json: Schema.NullOr(Schema.String),
      active_order_key: Schema.NullOr(Schema.String),
      deleted_at: Schema.NullOr(Schema.String),
    }),
  ),
);
const decodeMessageBefore = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    Schema.Struct({
      message_id: Schema.String,
      thread_id: Schema.String,
      turn_id: Schema.NullOr(Schema.String),
      role: Schema.Literals(["user", "assistant"]),
      text: Schema.String,
      is_streaming: Schema.Number,
      created_at: Schema.String,
      updated_at: Schema.String,
      attachments_json: Schema.NullOr(Schema.String),
      context_json: Schema.optionalKey(Schema.NullOr(Schema.String)),
    }),
  ),
);

function parseJson(json: string): unknown {
  try {
    return JSON.parse(json);
  } catch {
    return undefined;
  }
}

function modelSelectionFor(row: LegacyThreadRow) {
  const decoded =
    row.model_selection_json === null
      ? Option.none()
      : decodeModelSelection(parseJson(row.model_selection_json));
  return Option.getOrElse(decoded, () => ({
    instanceId: ProviderInstanceId.make("codex"),
    model: DEFAULT_MODEL,
  }));
}

function attachmentsFor(row: LegacyMessageRow) {
  const attachments: Array<ChatAttachment> = [];
  if (row.attachments_json === null) return { attachments, invalid: false };
  const entries = decodeAttachmentEntries(parseJson(row.attachments_json));
  if (Option.isNone(entries)) return { attachments, invalid: true };
  let invalid = false;
  for (const entry of entries.value) {
    const attachment = decodeAttachment(entry);
    if (Option.isSome(attachment)) attachments.push(attachment.value);
    else invalid = true;
  }
  return { attachments, invalid };
}

function linkedPullRequestFor(row: LegacyThreadRow) {
  if (row.linked_pull_request_json === null) return null;
  return Option.getOrNull(decodeLinkedPullRequest(parseJson(row.linked_pull_request_json)));
}

function branchPullRequestFor(row: LegacyThreadRow) {
  if (row.branch_pull_request_json === null) return null;
  return Option.getOrNull(decodeLinkedPullRequest(parseJson(row.branch_pull_request_json)));
}

function runtimeModeFor(value: string): OrchestrationV2AppThread["runtimeMode"] {
  return value === "approval-required" ||
    value === "auto-accept-edits" ||
    value === "auto" ||
    value === "full-access"
    ? value
    : "full-access";
}

function interactionModeFor(value: string): OrchestrationV2AppThread["interactionMode"] {
  return value === "plan" ? "plan" : "default";
}

function settledOverrideFor(value: string | null): OrchestrationV2AppThread["settledOverride"] {
  return value === "settled" || value === "active" ? value : null;
}

function dateTime(value: string): DateTime.Utc {
  return DateTime.makeUnsafe(value);
}

function nullableDateTime(value: string | null): DateTime.Utc | null {
  return value === null ? null : dateTime(value);
}

const importedThread = Effect.fn("LegacyV1ThreadImporter.importedThread")(function* (
  row: LegacyThreadRow,
  origins: ReadonlyMap<ThreadId, ProjectionForkLineageRow>,
): Effect.fn.Return<OrchestrationV2AppThread, LegacyV1ThreadImportError> {
  const threadId = ThreadId.make(row.thread_id);
  const origin = origins.get(threadId);
  const forkLineage = toForkLineageMarker(origin);
  let rootThreadId = threadId;
  let ancestorId = forkLineage?.originThreadId ?? null;
  const visited = new Set<ThreadId>([threadId]);
  while (ancestorId !== null) {
    if (visited.has(ancestorId)) {
      return yield* new LegacyV1ThreadImportError({
        operation: "resolve cyclic fork lineage",
        threadId,
      });
    }
    visited.add(ancestorId);
    rootThreadId = ancestorId;
    ancestorId = origins.get(ancestorId)?.originThreadId ?? null;
  }
  const modelSelection = modelSelectionFor(row);
  const branch = row.branch?.trim() || null;
  const worktreePath = row.worktree_path?.trim() || null;
  const pullRequests = Option.getOrElse(
    decodePullRequests(parseJson(row.pull_requests_json)),
    () => [],
  );
  const linkedPullRequest = linkedPullRequestFor(row);
  const legacyLink = threadPullRequestsOf({ linkedPullRequest })[0];
  const importedPullRequests =
    legacyLink !== undefined &&
    !pullRequests.some((link) => threadPullRequestKeysEqual(link, legacyLink))
      ? [...pullRequests, legacyLink]
      : pullRequests;
  return {
    createdBy: "system",
    creationSource: "server",
    id: threadId,
    projectId: ProjectId.make(row.project_id),
    title: row.title.trim() === "" ? "Untitled thread" : row.title,
    providerInstanceId: modelSelection.instanceId,
    modelSelection,
    runtimeMode: runtimeModeFor(row.runtime_mode),
    interactionMode: interactionModeFor(row.interaction_mode),
    branch,
    worktreePath,
    linkedPullRequest,
    pullRequests: importedPullRequests,
    branchPullRequest: branchPullRequestFor(row),
    activeOrderKey: row.active_order_key?.trim() || null,
    activeProviderThreadId: null,
    historyOrigin: "v1_import",
    lineage: {
      parentThreadId: forkLineage?.originThreadId ?? null,
      relationshipToParent: forkLineage === null ? null : "fork",
      rootThreadId,
    },
    forkedFrom: null,
    createdAt: dateTime(row.created_at),
    updatedAt: dateTime(row.updated_at),
    archivedAt: nullableDateTime(row.archived_at),
    settledOverride: settledOverrideFor(row.settled_override),
    settledAt: nullableDateTime(row.settled_at),
    unsettledAt: nullableDateTime(row.unsettled_at),
    snoozedUntil: nullableDateTime(row.snoozed_until),
    snoozedAt: nullableDateTime(row.snoozed_at),
    pinnedAt: nullableDateTime(row.pinned_at),
    autoSettleDisabledAt: nullableDateTime(row.auto_settle_disabled_at),
    pinOrderKey: row.pin_order_key?.trim() || null,
    lastVisitedAt: null,
    deletedAt: nullableDateTime(row.deleted_at),
    sectionId: row.section_id === null ? null : ThreadSectionId.make(row.section_id),
    forkLineage,
    conversationImport: importMarkerField(origin).conversationImport ?? null,
  };
});

function messageEvents(row: LegacyMessageRow): ReadonlyArray<OrchestrationV2DomainEvent> {
  const threadId = ThreadId.make(row.thread_id);
  const messageId = MessageId.make(row.message_id);
  const createdAt = dateTime(row.created_at);
  const updatedAt = dateTime(row.updated_at);
  const { attachments } = attachmentsFor(row);
  const context = row.context_json ? decodeMessageContext(parseJson(row.context_json)) : undefined;
  const message: OrchestrationV2ConversationMessage = {
    createdBy: row.role === "user" ? "user" : "agent",
    creationSource: "server",
    id: messageId,
    threadId,
    runId: null,
    nodeId: null,
    role: row.role,
    text: row.text,
    ...(context === undefined ? {} : { context }),
    attachments,
    streaming: false,
    createdAt,
    updatedAt,
  };
  const baseTurnItem = {
    id: TurnItemId.make(`${IMPORT_EVENT_PREFIX}:turn-item:${row.message_id}`),
    ...(row.turn_id === null ? {} : { historyTurnId: TurnId.make(row.turn_id) }),
    threadId,
    runId: null,
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: row.ordinal,
    status: row.is_streaming === 1 ? ("interrupted" as const) : ("completed" as const),
    title: null,
    startedAt: createdAt,
    completedAt: updatedAt,
    updatedAt,
  };
  const turnItem: OrchestrationV2TurnItem =
    row.role === "user"
      ? {
          ...baseTurnItem,
          createdBy: "user",
          creationSource: "server",
          type: "user_message",
          messageId,
          inputIntent: "turn_start",
          text: row.text,
          ...(context === undefined ? {} : { context }),
          attachments,
        }
      : {
          ...baseTurnItem,
          type: "assistant_message",
          messageId,
          text: row.text,
          ...(context === undefined ? {} : { context }),
          streaming: false,
        };
  return [
    {
      id: EventId.make(`${IMPORT_EVENT_PREFIX}:message:${row.message_id}`),
      type: "message.updated",
      threadId,
      occurredAt: updatedAt,
      payload: message,
    },
    {
      id: EventId.make(`${IMPORT_EVENT_PREFIX}:turn-item:${row.message_id}`),
      type: "turn-item.updated",
      threadId,
      occurredAt: updatedAt,
      payload: turnItem,
    },
  ];
}

function chunks<A>(items: ReadonlyArray<A>, size: number): Array<ReadonlyArray<A>> {
  const result: Array<ReadonlyArray<A>> = [];
  for (let index = 0; index < items.length; index += size) {
    result.push(items.slice(index, index + size));
  }
  return result;
}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const eventSink = yield* EventSink.EventSinkV2;
  const { listForkLineageRows } = makeForkLineageQueries(sql);
  const transcriptImports = yield* KeyedLock.make<ThreadId>();

  const listMessages = (threadId: ThreadId) =>
    sql<LegacyMessageRow>`
      SELECT
        message_id,
        turn_id,
        thread_id,
        role,
        text,
        attachments_json,
        context_json,
        is_streaming,
        created_at,
        updated_at,
        ROW_NUMBER() OVER (
          PARTITION BY thread_id
          ORDER BY created_at ASC, message_id ASC
        ) AS ordinal
      FROM projection_thread_messages
      WHERE thread_id = ${threadId}
        AND role IN ('user', 'assistant')
      ORDER BY created_at ASC, message_id ASC
    `;

  const listShellMessages = (threadId: ThreadId) =>
    Effect.gen(function* () {
      const latest = yield* sql<LegacyMessageRow>`
        SELECT
          message.message_id,
          message.turn_id,
          message.thread_id,
          message.role,
          message.text,
          message.attachments_json,
          message.context_json,
          message.is_streaming,
          message.created_at,
          message.updated_at,
          (
            SELECT COUNT(*)
            FROM projection_thread_messages AS earlier
            WHERE earlier.thread_id = message.thread_id
              AND earlier.role IN ('user', 'assistant')
              AND (
                earlier.created_at < message.created_at
                OR (
                  earlier.created_at = message.created_at
                  AND earlier.message_id <= message.message_id
                )
              )
          ) AS ordinal
        FROM projection_thread_messages AS message
        WHERE message.thread_id = ${threadId}
          AND message.role IN ('user', 'assistant')
        ORDER BY message.created_at DESC, message.message_id DESC
        LIMIT 1
      `;
      const latestUser = yield* sql<LegacyMessageRow>`
        SELECT
          message.message_id,
          message.turn_id,
          message.thread_id,
          message.role,
          message.text,
          message.attachments_json,
          message.context_json,
          message.is_streaming,
          message.created_at,
          message.updated_at,
          (
            SELECT COUNT(*)
            FROM projection_thread_messages AS earlier
            WHERE earlier.thread_id = message.thread_id
              AND earlier.role IN ('user', 'assistant')
              AND (
                earlier.created_at < message.created_at
                OR (
                  earlier.created_at = message.created_at
                  AND earlier.message_id <= message.message_id
                )
              )
          ) AS ordinal
        FROM projection_thread_messages AS message
        WHERE message.thread_id = ${threadId}
          AND message.role = 'user'
        ORDER BY message.created_at DESC, message.message_id DESC
        LIMIT 1
      `;
      return [latestUser[0], latest[0]].filter(
        (message, index, selected): message is LegacyMessageRow =>
          message !== undefined &&
          selected.findIndex((candidate) => candidate?.message_id === message.message_id) === index,
      );
    });

  const repairLegacyCitations = (threadId: ThreadId) =>
    Effect.gen(function* () {
      const messages = (yield* listMessages(threadId)).filter(
        (message) =>
          message.role === "assistant" && message.text.includes(CODEX_CITATION_MARKER_PREFIX),
      );
      if (messages.length === 0) return;
      const sources = yield* sql<{ turn_id: string; payload_json: string }>`
      SELECT turn_id, payload_json FROM projection_thread_activities
      WHERE thread_id = ${threadId} AND turn_id IS NOT NULL AND kind = 'tool.completed'
        AND json_extract(payload_json, '$.itemType') = 'web_search'
      ORDER BY created_at, activity_id`;
      const byTurn = new Map<string, unknown[]>();
      for (const source of sources) {
        const payloads = byTurn.get(source.turn_id) ?? [];
        payloads.push(parseJson(source.payload_json));
        byTurn.set(source.turn_id, payloads);
      }
      const events = messages.flatMap((message) => {
        const text = projectLegacyCitationText(
          message.text,
          message.turn_id === null ? [] : (byTurn.get(message.turn_id) ?? []),
        );
        if (text === message.text) return [];
        return messageEvents({ ...message, text }).map((event) => ({
          ...event,
          id: EventId.make(`migration:v1:history:citation:${event.id}`),
        }));
      });
      for (const batch of chunks(events, TRANSCRIPT_EVENT_BATCH_SIZE)) {
        yield* eventSink.write({ events: batch, guardLegacyCitationRepairs: true });
        yield* Effect.yieldNow;
      }
    });

  const reconcileShellsBase = Effect.gen(function* () {
    const now = DateTime.formatIso(yield* DateTime.now);
    const repairRows = yield* sql<LegacyRepairRow>`
      SELECT
        thread.thread_id,
        thread.project_id,
        thread.title,
        thread.section_id,
        thread.model_selection_json,
        thread.runtime_mode,
        thread.interaction_mode,
        thread.branch,
        thread.worktree_path,
        thread.created_at,
        thread.updated_at,
        thread.archived_at,
        thread.settled_override,
        thread.settled_at,
        thread.unsettled_at,
        thread.snoozed_until,
        thread.snoozed_at,
        thread.pinned_at,
        thread.auto_settle_disabled_at,
        thread.pin_order_key,
        (SELECT json_group_array(json_object('host', pr.host, 'repository', pr.repository, 'number', pr.number, 'url', pr.url, 'source', pr.source, 'linkedAt', pr.linked_at, 'snapshot', json(pr.snapshot_json), 'stack', json(pr.stack_json))) FROM projection_thread_pull_requests pr WHERE pr.thread_id = thread.thread_id) AS pull_requests_json,
        thread.linked_pull_request_json,
        thread.branch_pull_request_json,
        thread.active_order_key,
        thread.deleted_at,
        projection.payload_json
      FROM orchestration_v2_legacy_imports AS legacy_import
      INNER JOIN projection_threads AS thread
        ON thread.thread_id = legacy_import.thread_id
      INNER JOIN orchestration_v2_projection_threads AS projection
        ON projection.thread_id = legacy_import.thread_id
      WHERE json_type(projection.payload_json, '$.pinnedAt') IS NULL
         OR json_type(projection.payload_json, '$.autoSettleDisabledAt') IS NULL
         OR json_type(projection.payload_json, '$.pinOrderKey') IS NULL
         OR json_type(projection.payload_json, '$.snoozedUntil') IS NULL
         OR json_type(projection.payload_json, '$.snoozedAt') IS NULL
         OR json_type(projection.payload_json, '$.unsettledAt') IS NULL
         OR json_type(projection.payload_json, '$.linkedPullRequest') IS NULL
         OR json_type(projection.payload_json, '$.pullRequests') IS NULL
         OR json_type(projection.payload_json, '$.branchPullRequest') IS NULL
         OR json_type(projection.payload_json, '$.activeOrderKey') IS NULL
         OR json_type(projection.payload_json, '$.sectionId') IS NULL
         OR json_type(projection.payload_json, '$.forkLineage') IS NULL
         OR json_type(projection.payload_json, '$.conversationImport') IS NULL
      ORDER BY thread.created_at ASC, thread.thread_id ASC
    `;
    const rows = yield* sql<LegacyThreadRow>`
      SELECT
        thread.thread_id,
        thread.project_id,
        thread.title,
        thread.section_id,
        thread.model_selection_json,
        thread.runtime_mode,
        thread.interaction_mode,
        thread.branch,
        thread.worktree_path,
        thread.created_at,
        thread.updated_at,
        thread.archived_at,
        thread.settled_override,
        thread.settled_at,
        thread.unsettled_at,
        thread.snoozed_until,
        thread.snoozed_at,
        thread.pinned_at,
        thread.auto_settle_disabled_at,
        thread.pin_order_key,
        (SELECT json_group_array(json_object('host', pr.host, 'repository', pr.repository, 'number', pr.number, 'url', pr.url, 'source', pr.source, 'linkedAt', pr.linked_at, 'snapshot', json(pr.snapshot_json), 'stack', json(pr.stack_json))) FROM projection_thread_pull_requests pr WHERE pr.thread_id = thread.thread_id) AS pull_requests_json,
        thread.linked_pull_request_json,
        thread.branch_pull_request_json,
        thread.active_order_key,
        thread.deleted_at
      FROM projection_threads AS thread
      WHERE NOT EXISTS (
        SELECT 1
        FROM orchestration_events AS event INDEXED BY orchestration_events_v2_created_threads_idx
        WHERE event.application_event_version = 2
          AND event.aggregate_kind = 'thread'
          AND event.stream_id = thread.thread_id
          AND event.event_type = 'thread.created'
      )
      ORDER BY thread.created_at ASC, thread.thread_id ASC
    `;
    const origins = new Map(
      (repairRows.length > 0 || rows.length > 0 ? yield* listForkLineageRows(undefined) : []).map(
        (origin) => [origin.threadId, origin] as const,
      ),
    );
    let repairedThreadCount = 0;
    for (const row of repairRows) {
      const decoded = decodeStoredThread(row.payload_json);
      if (Option.isNone(decoded)) continue;
      const current = decoded.value;
      const legacy = yield* importedThread(row, origins);
      const legacyPullRequests = legacy.pullRequests ?? [];
      const repaired: OrchestrationV2AppThread = {
        ...current,
        pinnedAt: current.pinnedAt === undefined ? legacy.pinnedAt : current.pinnedAt,
        autoSettleDisabledAt:
          current.autoSettleDisabledAt === undefined
            ? legacy.autoSettleDisabledAt
            : current.autoSettleDisabledAt,
        pinOrderKey: current.pinOrderKey === undefined ? legacy.pinOrderKey : current.pinOrderKey,
        snoozedUntil:
          current.snoozedUntil === undefined ? legacy.snoozedUntil : current.snoozedUntil,
        snoozedAt: current.snoozedAt === undefined ? legacy.snoozedAt : current.snoozedAt,
        unsettledAt: current.unsettledAt === undefined ? legacy.unsettledAt : current.unsettledAt,
        linkedPullRequest:
          current.linkedPullRequest === undefined
            ? legacy.linkedPullRequest
            : current.linkedPullRequest,
        pullRequests:
          current.pullRequests === undefined
            ? current.linkedPullRequest === null
              ? []
              : legacyPullRequests.length > 0
                ? legacyPullRequests
                : threadPullRequestsOf({
                    linkedPullRequest:
                      current.linkedPullRequest === undefined
                        ? legacy.linkedPullRequest
                        : current.linkedPullRequest,
                  })
            : current.pullRequests,
        branchPullRequest:
          current.branchPullRequest === undefined
            ? legacy.branchPullRequest
            : current.branchPullRequest,
        activeOrderKey:
          current.activeOrderKey === undefined ? legacy.activeOrderKey : current.activeOrderKey,
        sectionId: current.sectionId === undefined ? legacy.sectionId : current.sectionId,
        forkLineage: current.forkLineage === undefined ? legacy.forkLineage : current.forkLineage,
        conversationImport:
          current.conversationImport === undefined
            ? legacy.conversationImport
            : current.conversationImport,
        lineage: current.forkLineage === undefined ? legacy.lineage : current.lineage,
      };
      // Later schema additions can require another repair for the same thread.
      const repairId = yield* randomUuidV4;
      yield* eventSink.write({
        events: [
          {
            id: EventId.make(
              `${IMPORT_EVENT_PREFIX}:thread:${row.thread_id}:metadata-repair:${repairId}`,
            ),
            type: "thread.metadata-updated",
            threadId: repaired.id,
            providerInstanceId: repaired.providerInstanceId,
            occurredAt: dateTime(now),
            payload: repaired,
          },
        ],
      });
      repairedThreadCount += 1;
    }
    let importedThreadCount = repairedThreadCount;
    let importedMessageCount = 0;
    for (const row of rows) {
      const thread = yield* importedThread(row, origins);
      const previews = yield* listShellMessages(thread.id);
      const events: Array<OrchestrationV2DomainEvent> = [
        {
          id: EventId.make(`${IMPORT_EVENT_PREFIX}:thread:${row.thread_id}:created`),
          type: "thread.created",
          threadId: thread.id,
          providerInstanceId: thread.providerInstanceId,
          occurredAt: thread.createdAt,
          payload: thread,
        },
        ...previews.flatMap(messageEvents),
        {
          id: EventId.make(`${IMPORT_EVENT_PREFIX}:thread:${row.thread_id}:shell`),
          type: "thread.metadata-updated",
          threadId: thread.id,
          providerInstanceId: thread.providerInstanceId,
          occurredAt: thread.updatedAt,
          payload: thread,
        },
      ];
      yield* eventSink.write({
        events: [],
        transactionHooks: {
          prepare: Effect.void,
          prepareEvents: Effect.gen(function* () {
            yield* prepareLegacyHistory(sql, thread.id);
            yield* Effect.forEach(
              previews,
              (message) =>
                sql`
                INSERT INTO orchestration_v2_turn_item_positions (
                  thread_id,
                  turn_item_id,
                  ordinal
                )
                VALUES (
                  ${thread.id},
                  ${TurnItemId.make(`${IMPORT_EVENT_PREFIX}:turn-item:${message.message_id}`)},
                  ${message.ordinal}
                )
                ON CONFLICT(thread_id, turn_item_id) DO NOTHING
              `,
              { discard: true },
            );
          }).pipe(Effect.as(events)),
          finalize: sql`
            INSERT INTO orchestration_v2_legacy_imports (
              thread_id,
              source_updated_at,
              shell_imported_at,
              transcript_imported_at,
              imported_message_count,
              last_error
            )
            VALUES (
              ${thread.id},
              ${row.updated_at},
              ${now},
              NULL,
              ${previews.length},
              NULL
            )
            ON CONFLICT(thread_id) DO NOTHING
          `.pipe(Effect.asVoid),
        },
      });
      importedThreadCount += 1;
      importedMessageCount += previews.length;
    }
    return { importedThreadCount, importedMessageCount };
  });

  const reconcileShells = reconcileShellsBase.pipe(
    Effect.mapError((cause) => new LegacyV1ThreadImportError({ operation: "import", cause })),
  );

  const reconcileSourceMetadata = (threadId: ThreadId, revision: number) => {
    const events: OrchestrationV2DomainEvent[] = [];
    return eventSink
      .write({
        events,
        transactionHooks: {
          prepare: Effect.gen(function* () {
            const [change] = yield* sql<{
              before_json: string;
            }>`SELECT before_json FROM scient_legacy_reconciliation_changes
          WHERE thread_id = ${threadId} AND table_name = 'projection_threads' AND resolved = 0 AND before_json IS NOT NULL
          ORDER BY revision LIMIT 1`;
            if (change === undefined) return;
            const [source] = yield* sql<LegacyThreadRow>`SELECT thread.*,
          (SELECT json_group_array(json_object('host', pr.host, 'repository', pr.repository, 'number', pr.number,
            'url', pr.url, 'source', pr.source, 'linkedAt', pr.linked_at, 'snapshot', json(pr.snapshot_json), 'stack', json(pr.stack_json)))
            FROM projection_thread_pull_requests AS pr WHERE pr.thread_id = thread.thread_id) AS pull_requests_json
          FROM projection_threads AS thread WHERE thread.thread_id = ${threadId}`;
            const [projection] = yield* sql<{
              payload_json: string;
            }>`SELECT payload_json FROM orchestration_v2_projection_threads WHERE thread_id = ${threadId}`;
            if (source === undefined || projection === undefined) return;
            const decoded = decodeStoredThread(projection.payload_json);
            if (Option.isNone(decoded) || decoded.value.deletedAt !== null) return;
            const origins = new Map(
              (yield* listForkLineageRows(undefined)).map(
                (origin) => [origin.threadId, origin] as const,
              ),
            );
            const copiedBaseline = yield* importedThread(
              {
                ...(yield* decodeThreadBefore(change.before_json)),
                pull_requests_json:
                  typeof decodeRecord(change.before_json).pull_requests_json === "string"
                    ? String(decodeRecord(change.before_json).pull_requests_json)
                    : "[]",
              },
              origins,
            );
            const [previousSource] = yield* sql<{ source_json: string }>`SELECT source_json
              FROM scient_legacy_reconciliation_entities WHERE thread_id = ${threadId}
                AND entity_type = 'thread' AND entity_id = ${threadId}`;
            const previous =
              previousSource === undefined
                ? Option.none()
                : decodeStoredThread(previousSource.source_json);
            const baseline = Option.getOrElse(previous, () => copiedBaseline);
            const latest = yield* importedThread(source, origins);
            const current = decoded.value;
            const continuedInV2 =
              current.activeProviderThreadId !== null ||
              (yield* sql`SELECT 1 FROM orchestration_v2_projection_runs WHERE thread_id = ${threadId} LIMIT 1`)
                .length > 0;
            const baselineJson = decodeRecord(encodeStoredThread(baseline));
            const currentJson = decodeRecord(encodeStoredThread(current));
            const latestJson = decodeRecord(encodeStoredThread(latest));
            const repaired = { ...current };
            const keys = [
              "projectId",
              "title",
              "modelSelection",
              "runtimeMode",
              "interactionMode",
              "branch",
              "worktreePath",
              "linkedPullRequest",
              "pullRequests",
              "branchPullRequest",
              "activeOrderKey",
              "archivedAt",
              "settledOverride",
              "settledAt",
              "unsettledAt",
              "snoozedUntil",
              "snoozedAt",
              "pinnedAt",
              "autoSettleDisabledAt",
              "pinOrderKey",
              "sectionId",
            ] as const;
            for (const key of keys) {
              if (
                continuedInV2 &&
                (key === "projectId" ||
                  key === "modelSelection" ||
                  key === "runtimeMode" ||
                  key === "interactionMode" ||
                  key === "branch" ||
                  key === "worktreePath")
              )
                continue;
              if (
                !NodeUtil.isDeepStrictEqual(latestJson[key], baselineJson[key]) &&
                NodeUtil.isDeepStrictEqual(currentJson[key], baselineJson[key])
              ) {
                Object.assign(repaired, { [key]: latest[key] });
              }
            }
            if (repaired.modelSelection !== current.modelSelection)
              repaired.providerInstanceId = repaired.modelSelection.instanceId;
            // A stale V1 deletion cannot discard work already continued in V2.
            if (
              latest.deletedAt !== null &&
              !continuedInV2 &&
              DateTime.toEpochMillis(current.updatedAt) <=
                DateTime.toEpochMillis(baseline.updatedAt)
            )
              repaired.deletedAt = latest.deletedAt;
            if (
              DateTime.toEpochMillis(latest.updatedAt) > DateTime.toEpochMillis(current.updatedAt)
            )
              repaired.updatedAt = latest.updatedAt;
            yield* sql`INSERT INTO scient_legacy_reconciliation_entities(thread_id, entity_type, entity_id, source_json)
              VALUES (${threadId}, 'thread', ${threadId}, ${encodeStoredThread(latest)})
              ON CONFLICT(thread_id, entity_type, entity_id) DO UPDATE SET source_json = excluded.source_json`;
            if (encodeStoredThread(repaired) === encodeStoredThread(current)) return;
            const id = EventId.make(`migration:v1:reconciliation:metadata:${revision}:${threadId}`);
            if ((yield* sql`SELECT 1 FROM orchestration_events WHERE event_id = ${id}`).length > 0)
              return;
            events.push({
              id,
              type: "thread.metadata-updated",
              threadId,
              providerInstanceId: repaired.providerInstanceId,
              occurredAt: repaired.updatedAt,
              payload: repaired,
            });
          }),
          finalize: Effect.void,
        },
      })
      .pipe(Effect.asVoid);
  };

  const reconciliationFailure = sql<{
    last_error: string | null;
  }>`SELECT last_error FROM scient_legacy_reconciliation_state WHERE id = 1`.pipe(
    Effect.map((rows) => rows[0]?.last_error !== null && rows[0]?.last_error !== undefined),
    Effect.mapError(
      (cause) => new LegacyV1ThreadImportError({ operation: "inspect original source", cause }),
    ),
  );

  const pendingThreadCount = sql<{ readonly count: number }>`
    SELECT COUNT(*) AS count
    FROM (
      SELECT thread.thread_id
      FROM projection_threads AS thread
      WHERE NOT EXISTS (
        SELECT 1
        FROM orchestration_events AS event INDEXED BY orchestration_events_v2_created_threads_idx
        WHERE event.application_event_version = 2
          AND event.aggregate_kind = 'thread'
          AND event.stream_id = thread.thread_id
          AND event.event_type = 'thread.created'
      )
      UNION
      SELECT legacy_import.thread_id
      FROM orchestration_v2_legacy_imports AS legacy_import
      WHERE legacy_import.transcript_imported_at IS NULL
        OR legacy_import.history_repair_version < ${LEGACY_HISTORY_REPAIR_VERSION}
      UNION
      SELECT thread_id FROM scient_legacy_reconciliation_changes WHERE resolved = 0
    )
  `.pipe(
    Effect.map((rows) => rows[0]?.count ?? 0),
    Effect.mapError(
      (cause) => new LegacyV1ThreadImportError({ operation: "inspect pending", cause }),
    ),
  );

  // Confirm only after both transcript and historical-artifact hydration.
  // Reconciliation resets completion before this process starts, so thread
  // reads and command dispatches can avoid the lock and lookup after the
  // first successful confirmation in this process.
  const confirmedTranscriptThreadIds = new Set<ThreadId>();

  const ensureTranscriptBase = (threadId: ThreadId) =>
    transcriptImports.withLock(
      threadId,
      Effect.gen(function* () {
        const imports = yield* sql<LegacyImportRow>`
          SELECT thread_id, transcript_imported_at, history_repair_version
          FROM orchestration_v2_legacy_imports
          WHERE thread_id = ${threadId}
          LIMIT 1
        `;
        const imported = imports[0];
        if (imported === undefined) {
          return { importedThreadCount: 0, importedMessageCount: 0 };
        }
        if (
          imported.transcript_imported_at !== null &&
          imported.history_repair_version >= LEGACY_HISTORY_REPAIR_VERSION
        ) {
          confirmedTranscriptThreadIds.add(threadId);
          return { importedThreadCount: 0, importedMessageCount: 0 };
        }
        const [sourceRevision] = yield* sql<{
          revision: number | null;
        }>`SELECT max(revision) AS revision
          FROM scient_legacy_reconciliation_changes WHERE thread_id = ${threadId} AND resolved = 0`;
        const revision = sourceRevision?.revision ?? 0;
        const history = yield* sql.withTransaction(prepareLegacyHistory(sql, threadId, true));
        yield* importLegacyHistory(sql, eventSink, threadId, history, revision);
        if (imported.transcript_imported_at !== null) {
          yield* repairLegacyCitations(threadId);
          // Every guarded batch has committed before acknowledging this
          // generation. Retain the original transcript completion timestamp.
          yield* sql`UPDATE orchestration_v2_legacy_imports
            SET history_repair_version = ${LEGACY_HISTORY_REPAIR_VERSION}, last_error = NULL
            WHERE thread_id = ${threadId}`;
          confirmedTranscriptThreadIds.add(threadId);
          return { importedThreadCount: 0, importedMessageCount: 0 };
        }
        const messages = yield* listMessages(threadId);
        const existingRows = yield* sql<{ readonly event_id: string }>`
          SELECT event_id
          FROM orchestration_events
          WHERE application_event_version = 2
            AND aggregate_kind = 'thread'
            AND stream_id = ${threadId}
            AND event_id LIKE ${`${IMPORT_EVENT_PREFIX}:message:%`}
        `;
        const existing = new Set(existingRows.map((row) => row.event_id));
        const missing =
          revision > 0
            ? messages
            : messages.filter(
                (message) => !existing.has(`${IMPORT_EVENT_PREFIX}:message:${message.message_id}`),
              );
        let importedMessageCount = 0;
        for (const batch of chunks(missing, TRANSCRIPT_EVENT_BATCH_SIZE / 2)) {
          yield* Effect.forEach(
            batch,
            (message) =>
              sql`
                INSERT INTO orchestration_v2_turn_item_positions (
                  thread_id,
                  turn_item_id,
                  ordinal
                )
                VALUES (
                  ${threadId},
                  ${TurnItemId.make(`${IMPORT_EVENT_PREFIX}:turn-item:${message.message_id}`)},
                  ${message.ordinal}
                )
                ON CONFLICT(thread_id, turn_item_id) DO NOTHING
              `,
            { discard: true },
          );
          const expected = new Map<string, OrchestrationV2DomainEvent>();
          if (revision > 0) {
            for (const message of batch) {
              const [before] = yield* sql<{
                before_json: string;
              }>`SELECT before_json FROM scient_legacy_reconciliation_changes
                WHERE thread_id = ${threadId} AND table_name = 'projection_thread_messages'
                  AND row_key = ${encodeMessageKey([message.message_id])} AND resolved = 0 AND before_json IS NOT NULL
                ORDER BY revision LIMIT 1`;
              if (before === undefined) continue;
              const baseline = yield* decodeMessageBefore(before.before_json);
              for (const event of messageEvents({ ...baseline, ordinal: message.ordinal }))
                expected.set(event.id, event);
            }
          }
          importedMessageCount += yield* writeLegacySourceEvents(
            sql,
            eventSink,
            batch.flatMap(messageEvents),
            revision,
            expected,
          );
          yield* Effect.yieldNow;
        }
        // Retain valid siblings and the raw source, but never acknowledge or
        // continue a transcript whose attachment conversion is incomplete.
        const invalidMessage = messages.find((message) => attachmentsFor(message).invalid);
        if (invalidMessage !== undefined) {
          return yield* new LegacyV1ThreadImportError({
            operation: "restore message attachments for",
            threadId,
            cause: new Error(
              `Malformed attachments in legacy message ${invalidMessage.message_id}; original data is preserved.`,
            ),
          });
        }
        yield* repairLegacyCitations(threadId);
        if (revision > 0) yield* reconcileSourceMetadata(threadId, revision);
        const now = DateTime.formatIso(yield* DateTime.now);
        yield* sql.withTransaction(
          Effect.gen(function* () {
            yield* sql`
          UPDATE orchestration_v2_legacy_imports
          SET
            transcript_imported_at = ${now},
            history_repair_version = ${LEGACY_HISTORY_REPAIR_VERSION},
            imported_message_count = ${messages.length},
            last_error = NULL
          WHERE thread_id = ${threadId}
        `;
            yield* sql`UPDATE scient_legacy_reconciliation_changes SET resolved = 1 WHERE thread_id = ${threadId} AND revision <= ${revision}`;
          }),
        );
        confirmedTranscriptThreadIds.add(threadId);
        return {
          importedThreadCount: 1,
          importedMessageCount,
        };
      }),
    );

  const ensureTranscript = (threadId: ThreadId) =>
    confirmedTranscriptThreadIds.has(threadId)
      ? Effect.succeed({ importedThreadCount: 0, importedMessageCount: 0 })
      : ensureTranscriptBase(threadId).pipe(
          Effect.mapError(
            (cause) =>
              new LegacyV1ThreadImportError({
                operation: "hydrate transcript for",
                threadId,
                cause,
              }),
          ),
        );

  const importPendingTranscripts = Effect.gen(function* () {
    const rows = yield* sql<LegacyImportRow>`
      SELECT thread_id, transcript_imported_at, history_repair_version
      FROM orchestration_v2_legacy_imports
      WHERE transcript_imported_at IS NULL
        OR history_repair_version < ${LEGACY_HISTORY_REPAIR_VERSION}
      ORDER BY shell_imported_at ASC, thread_id ASC
    `;
    let importedThreadCount = 0;
    let importedMessageCount = 0;
    for (const row of rows) {
      const result = yield* ensureTranscript(ThreadId.make(row.thread_id)).pipe(
        Effect.tapError((error) =>
          Effect.logWarning("Failed to hydrate migrated v1 thread transcript", {
            threadId: row.thread_id,
            cause: error,
          }),
        ),
        Effect.catch(() =>
          sql`
            UPDATE orchestration_v2_legacy_imports
            SET last_error = 'Transcript hydration failed; retry on next open.'
            WHERE thread_id = ${row.thread_id}
          `.pipe(
            Effect.as({ importedThreadCount: 0, importedMessageCount: 0 }),
            Effect.orElseSucceed(() => ({
              importedThreadCount: 0,
              importedMessageCount: 0,
            })),
          ),
        ),
      );
      importedThreadCount += result.importedThreadCount;
      importedMessageCount += result.importedMessageCount;
      yield* Effect.yieldNow;
    }
    return { importedThreadCount, importedMessageCount };
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("Legacy v1 transcript background import stopped", { cause }).pipe(
        Effect.as({ importedThreadCount: 0, importedMessageCount: 0 }),
      ),
    ),
  );

  return LegacyV1ThreadImporter.of({
    reconciliationFailure,
    pendingThreadCount,
    reconcileShells,
    ensureTranscript,
    importPendingTranscripts,
  });
});

export const layer: Layer.Layer<
  LegacyV1ThreadImporter,
  never,
  EventSink.EventSinkV2 | SqlClient.SqlClient
> = Layer.effect(LegacyV1ThreadImporter, make);
