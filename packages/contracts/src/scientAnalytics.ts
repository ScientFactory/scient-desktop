import * as Schema from "effect/Schema";

export const ScientAnalyticsConsent = Schema.Literals([
  "off",
  "essential",
  "product",
  "diagnostic",
]);
export type ScientAnalyticsConsent = typeof ScientAnalyticsConsent.Type;

const CollectionContext = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(96));

export const ScientAnalyticsStatus = Schema.Struct({
  available: Schema.Boolean,
  consent: ScientAnalyticsConsent,
  /** Ephemeral consent fence for UI operations; never an analytics property. */
  collectionContext: Schema.optional(CollectionContext),
  /** The server can fence a complete voice job, including delayed outcomes. */
  voiceLifecycleVersion: Schema.optional(Schema.Literal(2)),
});
export type ScientAnalyticsStatus = typeof ScientAnalyticsStatus.Type;

/** Any event name, as in T3; the server checks only an event's shape and size. */
export const ScientAnalyticsUiEventName = Schema.String.check(
  Schema.isPattern(/^[a-z][a-z0-9_.-]{0,79}$/),
);
export type ScientAnalyticsUiEventName = typeof ScientAnalyticsUiEventName.Type;

export const ScientAnalyticsUiEvent = Schema.Struct({
  name: ScientAnalyticsUiEventName,
  properties: Schema.Record(
    Schema.String,
    Schema.Union([Schema.String, Schema.Boolean, Schema.Number]),
  ),
  collectionContext: Schema.optional(CollectionContext),
});
export type ScientAnalyticsUiEvent = typeof ScientAnalyticsUiEvent.Type;

export const ScientAnalyticsRecordResult = Schema.Struct({ accepted: Schema.Boolean });
export type ScientAnalyticsRecordResult = typeof ScientAnalyticsRecordResult.Type;
