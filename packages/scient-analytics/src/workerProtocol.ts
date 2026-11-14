import type { AnalyticsConsent, AnalyticsEvent, AnalyticsPriority } from "./contract.ts";

/** One upload's deadline, from connecting through reading the acknowledgement. */
export const SEND_DEADLINE_MS = 15_000;
/**
 * One flush's whole budget. A flush starts another upload only while that upload's full
 * deadline still fits, so a flush (and an explicit `flush()` waiting on it) ends within it.
 */
export const FLUSH_DEADLINE_MS = 2 * SEND_DEADLINE_MS;
/** A person waits on deletion, so it gets a shorter deadline. */
export const DELETE_DEADLINE_MS = 10_000;

export interface AnalyticsWorkerInput {
  readonly outboxPath: string;
  readonly endpoint: string;
  readonly consent: AnalyticsConsent;
  readonly purpose: "collection" | "deletion";
}

export interface AnalyticsEventDraft extends Omit<AnalyticsEvent, "distinct_id"> {
  readonly priority: AnalyticsPriority;
}

export type AnalyticsWorkerCommand =
  | {
      readonly type: "enqueue";
      readonly batchId: number;
      readonly events: ReadonlyArray<AnalyticsEventDraft>;
    }
  | { readonly type: "flush"; readonly requestId: number }
  | {
      readonly type: "set-consent";
      readonly requestId: number;
      readonly consent: AnalyticsConsent;
    }
  | { readonly type: "pending-count"; readonly requestId: number }
  | { readonly type: "delete-data"; readonly requestId: number }
  | { readonly type: "close"; readonly requestId: number };

export type AnalyticsWorkerResponse =
  | { readonly type: "ready" }
  | {
      readonly type: "diagnostics";
      readonly queuedCount: number;
      readonly droppedCount: number;
      readonly retryCount: number;
      readonly deliveryClass: "delivered" | "timeout" | "network" | "rejected";
    }
  | {
      readonly type: "persisted";
      readonly batchId: number;
      readonly accepted: number;
    }
  | {
      readonly type: "result";
      readonly requestId: number;
      readonly value: number;
    }
  | {
      readonly type: "fatal";
      readonly errorClass: "initialization" | "runtime";
    };
