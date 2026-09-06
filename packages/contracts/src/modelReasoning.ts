import * as Schema from "effect/Schema";

export const ModelReasoningLevel = Schema.Literals([
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);
export type ModelReasoningLevel = typeof ModelReasoningLevel.Type;

/** Evidence about controls, not a user selection. Unknown never means unsupported. */
export const ModelReasoningMetadata = Schema.Struct({
  status: Schema.Literals(["known", "unknown"]),
  source: Schema.Literals(["provider", "catalog", "manual", "unknown"]),
  /** ISO timestamp of the evidence; retained when a refresh fails. */
  checkedAt: Schema.String,
  stale: Schema.Boolean,
  /** Verified model capabilities, independent of reasoning status. Absence means unknown. */
  contextWindow: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThan(0))),
  maxOutputTokens: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThan(0))),
  images: Schema.optionalKey(Schema.Boolean),
  supported: Schema.NullOr(Schema.Boolean),
  levels: Schema.Array(ModelReasoningLevel),
  defaultLevel: Schema.optionalKey(ModelReasoningLevel),
  mandatory: Schema.optionalKey(Schema.Boolean),
  mode: Schema.optionalKey(Schema.Literals(["effort", "adaptive", "budget"])),
  detail: Schema.optionalKey(Schema.String),
});
export type ModelReasoningMetadata = typeof ModelReasoningMetadata.Type;
