import * as Schema from "effect/Schema";

import { ProviderDriverKind, ProviderInstanceId } from "../providerInstance.ts";
import { TrimmedNonEmptyString } from "../baseSchemas.ts";

export const ExtensionAudience = Schema.Union([
  Schema.Struct({ layer: Schema.Literal("scient") }),
  Schema.Struct({ layer: Schema.Literal("shared") }),
  Schema.Struct({
    layer: Schema.Literal("agent"),
    driver: ProviderDriverKind,
    instanceId: ProviderInstanceId,
    label: TrimmedNonEmptyString,
    reason: TrimmedNonEmptyString,
  }),
]);
export type ExtensionAudience = typeof ExtensionAudience.Type;

export const ExtensionAgentStores = Schema.Struct({
  codex: Schema.optional(TrimmedNonEmptyString),
});
