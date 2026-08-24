import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ProviderDriverKind } from "./providerInstance.ts";

export const ScientSkillInvocationPolicy = Schema.Literals(["automatic", "explicit"]);
export type ScientSkillInvocationPolicy = typeof ScientSkillInvocationPolicy.Type;

export const ScientSkillActivationScope = Schema.Literals(["project", "user"]);

export const ScientSkillCatalogItem = Schema.Struct({
  releaseKey: TrimmedNonEmptyString,
  id: TrimmedNonEmptyString,
  version: TrimmedNonEmptyString,
  name: TrimmedNonEmptyString,
  description: TrimmedNonEmptyString,
  origin: TrimmedNonEmptyString,
  supportedScopes: Schema.Array(ScientSkillActivationScope),
  defaultInvocationPolicy: ScientSkillInvocationPolicy,
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
