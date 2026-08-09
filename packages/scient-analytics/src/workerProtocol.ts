import type { AnalyticsConsent, AnalyticsEvent, AnalyticsPriority } from "./contract.ts";

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
  | { readonly type: "close"; readonly requestId: number };

export type AnalyticsWorkerResponse =
  | { readonly type: "ready" }
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
