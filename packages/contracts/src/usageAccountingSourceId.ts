import * as Schema from "effect/Schema";

/** Stable key for one provider-authoritative usage accounting source. */
export const UsageAccountingSourceId = Schema.String.pipe(Schema.brand("UsageAccountingSourceId"));
export type UsageAccountingSourceId = typeof UsageAccountingSourceId.Type;
