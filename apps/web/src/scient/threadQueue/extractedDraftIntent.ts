import * as Schema from "effect/Schema";

/** Browser-local semantic intent. Recovery journal copies may change their key;
 * the intent ID never changes. A malformed present marker must fail closed. */
export const ExtractedDraftIntent = Schema.Union([
  Schema.Struct({
    intentId: Schema.String.check(Schema.isPattern(/^[a-f0-9-]{36}$/)),
    journalKey: Schema.String.check(Schema.isMinLength(1)),
  }),
  Schema.Struct({ invalid: Schema.Literal(true) }),
]);
export type ExtractedDraftIntent = typeof ExtractedDraftIntent.Type;
const isExtractedDraftIntent = Schema.is(ExtractedDraftIntent);

/** Present malformed provenance stays distinguishable from an ordinary draft. */
export function normalizeExtractedDraftIntent(value: unknown): ExtractedDraftIntent {
  return isExtractedDraftIntent(value) ? value : { invalid: true };
}

/** Transfer provenance only when the destination can retain the same intent. */
export function transferredExtractedDraftIntent(
  source: ExtractedDraftIntent | undefined,
  destination: ExtractedDraftIntent | undefined,
) {
  if (source && destination && JSON.stringify(source) !== JSON.stringify(destination))
    throw new Error("Keep extracted intents in separate recoverable drafts.");
  return source ? { extractedIntent: source } : {};
}
