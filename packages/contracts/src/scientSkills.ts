import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ProviderDriverKind, ProviderInstanceId } from "./providerInstance.ts";
import { ServerProviders } from "./server.ts";

export const ScientSkillInvocationPolicy = Schema.Literals(["automatic", "explicit"]);
export type ScientSkillInvocationPolicy = typeof ScientSkillInvocationPolicy.Type;

export const ScientSkillActivationScope = Schema.Literals(["project", "user"]);

export const ScientSkillCatalogItem = Schema.Struct({
  releaseKey: TrimmedNonEmptyString,
  id: TrimmedNonEmptyString,
  version: TrimmedNonEmptyString,
  name: TrimmedNonEmptyString,
  description: TrimmedNonEmptyString,
  category: TrimmedNonEmptyString,
  categoryDescription: TrimmedNonEmptyString,
  origin: TrimmedNonEmptyString,
  supportedScopes: Schema.Array(ScientSkillActivationScope),
  defaultInvocationPolicy: ScientSkillInvocationPolicy,
  defaultActive: Schema.Boolean,
  active: Schema.Boolean,
  invocationPolicy: ScientSkillInvocationPolicy,
});
export type ScientSkillCatalogItem = typeof ScientSkillCatalogItem.Type;

export const ScientSkillInventory = Schema.Struct({
  skills: Schema.Array(ScientSkillCatalogItem),
  supportedProviders: Schema.Array(ProviderDriverKind),
});
export type ScientSkillInventory = typeof ScientSkillInventory.Type;

export const ScientSkillSetUserActivationInput = Schema.Struct({
  releaseKey: TrimmedNonEmptyString,
  active: Schema.Boolean,
  invocationPolicy: ScientSkillInvocationPolicy,
});

export class ScientSkillManagementError extends Schema.TaggedErrorClass<ScientSkillManagementError>()(
  "ScientSkillManagementError",
  {
    operation: TrimmedNonEmptyString,
    message: TrimmedNonEmptyString,
  },
) {}

/**
 * Mutate one provider-owned skill through the provider's reviewed native API.
 * `path` is already part of the provider snapshot contract and is never shown
 * in normal Settings UI; the server still validates it against the latest
 * snapshot before dispatching the action.
 */
export const ProviderSkillSetEnabledInput = Schema.Struct({
  instanceId: ProviderInstanceId,
  name: TrimmedNonEmptyString,
  path: TrimmedNonEmptyString,
  enabled: Schema.Boolean,
});
export type ProviderSkillSetEnabledInput = typeof ProviderSkillSetEnabledInput.Type;

export const ProviderSkillSetEnabledResult = Schema.Struct({
  effectiveEnabled: Schema.Boolean,
  providers: ServerProviders,
});
export type ProviderSkillSetEnabledResult = typeof ProviderSkillSetEnabledResult.Type;

export class ProviderSkillManagementError extends Schema.TaggedErrorClass<ProviderSkillManagementError>()(
  "ProviderSkillManagementError",
  {
    instanceId: ProviderInstanceId,
    reason: Schema.Literals([
      "provider_not_found",
      "skill_not_found",
      "unsupported_provider",
      "provider_rejected",
    ]),
    message: TrimmedNonEmptyString,
  },
) {}
