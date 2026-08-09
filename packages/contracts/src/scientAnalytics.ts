import * as Schema from "effect/Schema";

export const ScientAnalyticsConsent = Schema.Literals([
  "off",
  "essential",
  "product",
  "diagnostic",
]);
export type ScientAnalyticsConsent = typeof ScientAnalyticsConsent.Type;

export const ScientAnalyticsStatus = Schema.Struct({
  available: Schema.Boolean,
  consent: ScientAnalyticsConsent,
});
export type ScientAnalyticsStatus = typeof ScientAnalyticsStatus.Type;

export const ScientAnalyticsPreferenceUpdate = Schema.Struct({
  consent: ScientAnalyticsConsent,
});
export type ScientAnalyticsPreferenceUpdate = typeof ScientAnalyticsPreferenceUpdate.Type;

export const ScientAnalyticsUiEventName = Schema.Literals([
  "project.added",
  "project.add.failed",
  "project.opened",
  "thread.created",
  "voice.transcription.started",
  "voice.transcription.completed",
  "voice.transcription.failed",
  "voice.transcription.cancelled",
  "surface.opened",
  "setting.changed",
]);
export type ScientAnalyticsUiEventName = typeof ScientAnalyticsUiEventName.Type;

export const ScientAnalyticsUiEvent = Schema.Struct({
  name: ScientAnalyticsUiEventName,
  properties: Schema.Record(
    Schema.String,
    Schema.Union([Schema.String, Schema.Boolean, Schema.Number]),
  ),
});
export type ScientAnalyticsUiEvent = typeof ScientAnalyticsUiEvent.Type;

export const ScientAnalyticsRecordResult = Schema.Struct({ accepted: Schema.Boolean });
export type ScientAnalyticsRecordResult = typeof ScientAnalyticsRecordResult.Type;

export const ScientAnalyticsDeletionResult = Schema.Struct({
  deleted: Schema.Boolean,
});
export type ScientAnalyticsDeletionResult = typeof ScientAnalyticsDeletionResult.Type;
