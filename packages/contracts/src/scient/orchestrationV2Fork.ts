/**
 * Scient's fork-related orchestration V2 wire schemas: Claude fork boundary
 * evidence, fork initialization provenance, and the message-boundary fork
 * turn item with the notice older clients decode instead. The fork items
 * share one exact base-field factory. orchestrationV2.ts supplies its status
 * and native-reference schemas and keeps the items at their original union positions.
 *
 * @module orchestrationV2Fork
 */
import * as Schema from "effect/Schema";
import * as SchemaGetter from "effect/SchemaGetter";

import {
  ContextHandoffId,
  ContextTransferId,
  MessageId,
  NodeId,
  NonNegativeInt,
  ProviderThreadId,
  ProviderTurnId,
  RunId,
  ThreadId,
  TurnId,
  TurnItemId,
} from "../baseSchemas.ts";
import { ToolActivitySurface, ToolActivityIcon, ToolActivitySource } from "../providerRuntime.ts";
import type {
  OrchestrationV2TurnItemStatus as TurnItemStatus,
  OrchestrationV2ProviderRef as ProviderRef,
} from "../orchestrationV2.ts";

export const makeTurnItemBaseFields = (
  OrchestrationV2TurnItemStatus: typeof TurnItemStatus,
  OrchestrationV2ProviderRef: typeof ProviderRef,
): OrchestrationV2TurnItemBaseFields =>
  ({
    /** Group portable historical records without adopting an executable run. */
    historyTurnId: Schema.optional(TurnId),
    /** Frozen history carries provenance, never an executable source run or request. */
    inheritedFrom: Schema.optional(
      Schema.Struct({
        threadId: ThreadId,
        itemId: TurnItemId,
        runId: Schema.NullOr(RunId),
        status: OrchestrationV2TurnItemStatus,
      }),
    ),
    toolSurface: Schema.optional(ToolActivitySurface),
    toolIcon: Schema.optional(ToolActivityIcon),
    toolSource: Schema.optional(ToolActivitySource),
    id: TurnItemId,
    threadId: ThreadId,
    runId: Schema.NullOr(RunId),
    nodeId: Schema.NullOr(NodeId),
    providerThreadId: Schema.NullOr(ProviderThreadId),
    providerTurnId: Schema.NullOr(ProviderTurnId),
    nativeItemRef: Schema.NullOr(OrchestrationV2ProviderRef),
    parentItemId: Schema.NullOr(TurnItemId),
    ordinal: NonNegativeInt,
    status: OrchestrationV2TurnItemStatus,
    title: Schema.NullOr(Schema.String),
    startedAt: Schema.NullOr(Schema.DateTimeUtc),
    completedAt: Schema.NullOr(Schema.DateTimeUtc),
    updatedAt: Schema.DateTimeUtc,
  }) as const;

/** Shared fields stay private; their status and native-reference schemas belong to the V2 owner. */
interface OrchestrationV2TurnItemBaseFields {
  readonly historyTurnId: Schema.optional<typeof TurnId>;
  readonly inheritedFrom: Schema.optional<
    Schema.Struct<{
      readonly threadId: typeof ThreadId;
      readonly itemId: typeof TurnItemId;
      readonly runId: Schema.NullOr<typeof RunId>;
      readonly status: typeof TurnItemStatus;
    }>
  >;
  readonly toolSurface: Schema.optional<typeof ToolActivitySurface>;
  readonly toolIcon: Schema.optional<typeof ToolActivityIcon>;
  readonly toolSource: Schema.optional<typeof ToolActivitySource>;
  readonly id: typeof TurnItemId;
  readonly threadId: typeof ThreadId;
  readonly runId: Schema.NullOr<typeof RunId>;
  readonly nodeId: Schema.NullOr<typeof NodeId>;
  readonly providerThreadId: Schema.NullOr<typeof ProviderThreadId>;
  readonly providerTurnId: Schema.NullOr<typeof ProviderTurnId>;
  readonly nativeItemRef: Schema.NullOr<typeof ProviderRef>;
  readonly parentItemId: Schema.NullOr<typeof TurnItemId>;
  readonly ordinal: typeof NonNegativeInt;
  readonly status: typeof TurnItemStatus;
  readonly title: Schema.NullOr<typeof Schema.String>;
  readonly startedAt: Schema.NullOr<typeof Schema.DateTimeUtc>;
  readonly completedAt: Schema.NullOr<typeof Schema.DateTimeUtc>;
  readonly updatedAt: typeof Schema.DateTimeUtc;
}

/** Exact native Claude cursors are root assistant UUIDs, rather than native turn IDs. */
export const OrchestrationV2ClaudeForkBoundaryEvidence = Schema.Struct({
  kind: Schema.Literal("claude_root_assistant_uuid"),
  sourceThreadId: ThreadId,
  runId: RunId,
  rootNodeId: NodeId,
  assistantNodeId: NodeId,
  assistantItemId: TurnItemId,
  providerThreadId: ProviderThreadId,
  providerTurnId: ProviderTurnId,
  nativeMessageId: Schema.String.check(Schema.isUUID()),
});
export type OrchestrationV2ClaudeForkBoundaryEvidence =
  typeof OrchestrationV2ClaudeForkBoundaryEvidence.Type;

/** Inert presentation provenance; these origin IDs grant no execution ownership. */
export const OrchestrationV2ForkInitialization = Schema.Struct({
  transferId: ContextTransferId,
  contextHandoffId: ContextHandoffId,
  threadId: ThreadId,
  runId: RunId,
});
export type OrchestrationV2ForkInitialization = typeof OrchestrationV2ForkInitialization.Type;

export const makeMessageForkItems = (
  OrchestrationV2TurnItemBaseFields: OrchestrationV2TurnItemBaseFields,
) => {
  const MessageForkSource = Schema.Struct({
    type: Schema.Literal("message"),
    threadId: ThreadId,
    messageId: MessageId,
    position: Schema.Literals(["before", "after"]),
  });
  const MessageForkItemFields = {
    ...OrchestrationV2TurnItemBaseFields,
    type: Schema.Literal("fork"),
    source: MessageForkSource,
    targetThreadId: ThreadId,
    providerThreadId: Schema.optional(ProviderThreadId),
  } as const;
  const MessageForkItemShape = Schema.Struct(MessageForkItemFields);
  const messageForkOwnership = Schema.makeFilter(
    (item: typeof MessageForkItemShape.Type) =>
      (item.runId === null &&
        item.nodeId === null &&
        item.providerThreadId === undefined &&
        item.providerTurnId === null &&
        item.nativeItemRef === null) ||
      "A message fork boundary cannot carry execution authority.",
  );
  const MessageForkItem = MessageForkItemShape.check(messageForkOwnership);
  // Older clients reject an unfamiliar fork source. Send an inert notice they
  // already decode; current clients retain the exact portable message boundary.
  const MessageForkNotice = Schema.Struct({
    ...OrchestrationV2TurnItemBaseFields,
    runId: Schema.Null,
    nodeId: Schema.Null,
    providerThreadId: Schema.Null,
    providerTurnId: Schema.Null,
    nativeItemRef: Schema.Null,
    type: Schema.Literal("system_notice"),
    message: Schema.String,
    forkBoundary: Schema.Struct({ source: MessageForkSource, targetThreadId: ThreadId }),
  });
  const decodeMessageForkNotice = SchemaGetter.transform(
    ({
      type: _type,
      message: _message,
      forkBoundary,
      providerThreadId: _providerThreadId,
      ...fields
    }: typeof MessageForkNotice.Type): typeof MessageForkItem.Type => ({
      ...fields,
      type: "fork",
      ...forkBoundary,
    }),
  );
  const encodeMessageForkNotice = SchemaGetter.transform(
    ({
      type: _type,
      source,
      targetThreadId,
      providerThreadId: _providerThreadId,
      ...fields
    }: typeof MessageForkItem.Type): typeof MessageForkNotice.Type => ({
      ...fields,
      type: "system_notice",
      message: "Conversation forked here",
      runId: null,
      nodeId: null,
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      forkBoundary: { source, targetThreadId },
    }),
  );

  return {
    MessageForkItem,
    MessageForkNoticeItem: MessageForkNotice.pipe(
      Schema.decodeTo(Schema.toType(MessageForkItem), {
        decode: decodeMessageForkNotice,
        encode: encodeMessageForkNotice,
      }),
    ),
    MessageForkItemJson: MessageForkItem.mapFields((fields) => ({
      ...fields,
      startedAt: Schema.NullOr(Schema.DateTimeUtcFromString),
      completedAt: Schema.NullOr(Schema.DateTimeUtcFromString),
      updatedAt: Schema.DateTimeUtcFromString,
    })).check(messageForkOwnership),
    MessageForkNoticeItemJson: MessageForkNotice.mapFields((fields) => ({
      ...fields,
      startedAt: Schema.NullOr(Schema.DateTimeUtcFromString),
      completedAt: Schema.NullOr(Schema.DateTimeUtcFromString),
      updatedAt: Schema.DateTimeUtcFromString,
    })).pipe(
      Schema.decodeTo(Schema.toType(MessageForkItem), {
        decode: decodeMessageForkNotice,
        encode: encodeMessageForkNotice,
      }),
    ),
  };
};
