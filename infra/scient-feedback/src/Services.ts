import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

export type SqlValue = string | number | null;

/** The D1 subset the Worker uses; `src/Local.ts` provides the same over node:sqlite. */
export class FeedbackSql extends Context.Service<
  FeedbackSql,
  {
    readonly run: (
      sql: string,
      params?: ReadonlyArray<SqlValue>,
    ) => Effect.Effect<{ readonly changes: number }>;
    readonly first: <Row>(
      sql: string,
      params?: ReadonlyArray<SqlValue>,
    ) => Effect.Effect<Row | undefined>;
    readonly all: <Row>(
      sql: string,
      params?: ReadonlyArray<SqlValue>,
    ) => Effect.Effect<ReadonlyArray<Row>>;
  }
>()("@scientfactory/scient-feedback-worker/Services/FeedbackSql") {}

export interface StoredFile {
  readonly bytes: Uint8Array;
  readonly contentType: string;
}

/** The private attachment bucket. */
export class Files extends Context.Service<
  Files,
  {
    readonly put: (key: string, bytes: Uint8Array, contentType: string) => Effect.Effect<void>;
    readonly get: (key: string) => Effect.Effect<StoredFile | undefined>;
    readonly delete: (keys: ReadonlyArray<string>) => Effect.Effect<void>;
  }
>()("@scientfactory/scient-feedback-worker/Services/Files") {}

export type RateLimitKind = "report-client" | "report-network" | "status-client";

/** Workers rate-limit bindings: a short window per key, best effort across locations. */
export class RateLimits extends Context.Service<
  RateLimits,
  { readonly allow: (kind: RateLimitKind, key: string) => Effect.Effect<boolean> }
>()("@scientfactory/scient-feedback-worker/Services/RateLimits") {}

export interface FeedbackSettings {
  /** Off answers 503, so apps keep reports queued. */
  readonly ingestionEnabled: boolean;
  /** Enables `/v1/admin/*` when set. */
  readonly adminToken: string | null;
  /** Reports accepted per UTC day from everyone; beyond it apps keep them queued. */
  readonly dailyReportCap: number;
  /** Reports accepted from one installation in 24 hours. */
  readonly clientDailyReportCap: number;
}

export class FeedbackConfig extends Context.Service<FeedbackConfig, FeedbackSettings>()(
  "@scientfactory/scient-feedback-worker/Services/FeedbackConfig",
) {}

export const DEFAULT_FEEDBACK_SETTINGS: FeedbackSettings = {
  ingestionEnabled: true,
  adminToken: null,
  dailyReportCap: 2_000,
  clientDailyReportCap: 50,
};
