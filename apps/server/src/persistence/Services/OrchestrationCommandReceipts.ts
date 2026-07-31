/**
 * OrchestrationCommandReceiptRepository - Repository interface for command receipts.
 *
 * Owns persistence operations for deduplication and status tracking of
 * orchestration command handling.
 *
 * @module OrchestrationCommandReceiptRepository
 */
import {
  CommandId,
  IsoDateTime,
  NonNegativeInt,
  OrchestrationAggregateKind,
  OrchestrationCommandReceiptStatus,
  ProjectId,
  ThreadId,
} from "@synara/contracts";
import { Option, Schema, ServiceMap } from "effect";
import type { Effect } from "effect";

import type { OrchestrationCommandReceiptRepositoryError } from "../Errors.ts";

export const OrchestrationCommandReceipt = Schema.Struct({
  commandId: CommandId,
  aggregateKind: OrchestrationAggregateKind,
  aggregateId: Schema.Union([ProjectId, ThreadId]),
  acceptedAt: IsoDateTime,
  resultSequence: NonNegativeInt,
  status: OrchestrationCommandReceiptStatus,
  error: Schema.NullOr(Schema.String),
});
export type OrchestrationCommandReceipt = typeof OrchestrationCommandReceipt.Type;

export const GetByCommandIdInput = Schema.Struct({
  commandId: CommandId,
});
export type GetByCommandIdInput = typeof GetByCommandIdInput.Type;

/**
 * OrchestrationCommandReceiptRepositoryShape - Service API for command receipts.
 */
export interface OrchestrationCommandReceiptRepositoryShape {
  /**
   * Insert an immutable command receipt row. An exact duplicate is idempotent;
   * any conflicting result for the same command id fails closed.
   */
  readonly upsert: (
    receipt: OrchestrationCommandReceipt,
  ) => Effect.Effect<void, OrchestrationCommandReceiptRepositoryError>;

  /**
   * Read a command receipt by command id.
   */
  readonly getByCommandId: (
    input: GetByCommandIdInput,
  ) => Effect.Effect<
    Option.Option<OrchestrationCommandReceipt>,
    OrchestrationCommandReceiptRepositoryError
  >;
}

/**
 * OrchestrationCommandReceiptRepository - Service tag for command receipt persistence.
 */
export class OrchestrationCommandReceiptRepository extends ServiceMap.Service<
  OrchestrationCommandReceiptRepository,
  OrchestrationCommandReceiptRepositoryShape
>()(
  "synara/persistence/Services/OrchestrationCommandReceipts/OrchestrationCommandReceiptRepository",
) {}
