import * as Schema from "effect/Schema";

import { ProviderDriverKind, ProviderInstanceId } from "../providerInstance.ts";
import { TrimmedNonEmptyString } from "../baseSchemas.ts";

export const ExtensionAudience = Schema.Union([
  Schema.Struct({ layer: Schema.Literal("scient") }),
  Schema.Struct({
    layer: Schema.Literal("shared"),
    ownerInstanceId: Schema.optional(ProviderInstanceId),
  }),
  Schema.Struct({
    layer: Schema.Literal("agent"),
    driver: ProviderDriverKind,
    instanceId: ProviderInstanceId,
    label: TrimmedNonEmptyString,
    reason: TrimmedNonEmptyString,
  }),
  /** A service each agent reaches through its own account: a ChatGPT app or claude.ai connector. */
  Schema.Struct({
    layer: Schema.Literal("account"),
    /** Agents whose own account has the service connected. */
    connected: Schema.Array(
      Schema.Struct({ instanceId: ProviderInstanceId, label: TrimmedNonEmptyString }),
    ),
    /** Agents that can have it after a step, and the step. */
    pending: Schema.Array(
      Schema.Struct({ instanceId: ProviderInstanceId, reason: TrimmedNonEmptyString }),
    ),
  }),
]);
export type ExtensionAudience = typeof ExtensionAudience.Type;

export const ExtensionAgentStores = Schema.Struct({
  codex: Schema.optional(TrimmedNonEmptyString),
});

export function supportsScientClaudePlugins(version: string | null | undefined): boolean {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(version ?? "");
  return (
    match !== null &&
    (Number(match[1]) > 0 ||
      Number(match[2]) > 1 ||
      (Number(match[2]) === 1 && Number(match[3]) >= 3))
  );
}
