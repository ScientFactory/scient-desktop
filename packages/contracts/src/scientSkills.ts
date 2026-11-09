import * as Schema from "effect/Schema";

import { ProjectId, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ProviderDriverKind, ProviderInstanceId } from "./providerInstance.ts";
import { ServerProviders } from "./server.ts";

export const ScientSkillInvocationPolicy = Schema.Literals(["automatic", "explicit"]);
export type ScientSkillInvocationPolicy = typeof ScientSkillInvocationPolicy.Type;

export const ScientSkillActivationScope = Schema.Literals(["project", "user"]);
export const ScientSkillInventoryScope = Schema.Literals(["project", "user"]);

/** A personal skill's folder and history, shown on its row. */
export const PersonalSkillDetails = Schema.Struct({
  /** The skill's folder on the environment's computer. */
  folder: TrimmedNonEmptyString,
  /** Where it came from: a file name, a web address, "Pasted text" or an agent. */
  source: Schema.optional(TrimmedNonEmptyString),
  updatedAt: Schema.optional(TrimmedNonEmptyString),
  changedBy: Schema.optional(Schema.Literals(["you", "agent"])),
  /** An earlier version, or the change that made it, can be undone. */
  canUndo: Schema.Boolean,
});
export type PersonalSkillDetails = typeof PersonalSkillDetails.Type;

export const ScientSkillCatalogItem = Schema.Struct({
  releaseKey: TrimmedNonEmptyString,
  id: TrimmedNonEmptyString,
  version: TrimmedNonEmptyString,
  name: TrimmedNonEmptyString,
  description: TrimmedNonEmptyString,
  category: TrimmedNonEmptyString,
  categoryDescription: TrimmedNonEmptyString,
  origin: TrimmedNonEmptyString,
  scope: ScientSkillInventoryScope,
  path: Schema.optional(TrimmedNonEmptyString),
  supportedScopes: Schema.Array(ScientSkillActivationScope),
  defaultInvocationPolicy: ScientSkillInvocationPolicy,
  defaultActive: Schema.Boolean,
  active: Schema.Boolean,
  invocationPolicy: ScientSkillInvocationPolicy,
  personal: Schema.optional(PersonalSkillDetails),
});
export type ScientSkillCatalogItem = typeof ScientSkillCatalogItem.Type;

export const ScientSkillInventoryDiagnostic = Schema.Struct({
  code: TrimmedNonEmptyString,
  message: TrimmedNonEmptyString,
  path: Schema.optional(TrimmedNonEmptyString),
});
export type ScientSkillInventoryDiagnostic = typeof ScientSkillInventoryDiagnostic.Type;

export const ScientSkillInventory = Schema.Struct({
  skills: Schema.Array(ScientSkillCatalogItem),
  diagnostics: Schema.Array(ScientSkillInventoryDiagnostic),
  supportedProviders: Schema.Array(ProviderDriverKind),
});
export type ScientSkillInventory = typeof ScientSkillInventory.Type;

export const ScientSkillListInput = Schema.Struct({
  projectId: Schema.optional(ProjectId),
  threadId: Schema.optional(ThreadId),
});

export const ScientSkillReadDocumentInput = Schema.Struct({
  releaseKey: TrimmedNonEmptyString,
  projectId: Schema.optional(ProjectId),
});

export const ScientSkillDocument = Schema.Struct({
  releaseKey: TrimmedNonEmptyString,
  name: TrimmedNonEmptyString,
  description: TrimmedNonEmptyString,
  instructions: TrimmedNonEmptyString,
});
export type ScientSkillDocument = typeof ScientSkillDocument.Type;

export const ScientSkillSetUserActivationInput = Schema.Struct({
  releaseKey: TrimmedNonEmptyString,
  active: Schema.Boolean,
  invocationPolicy: ScientSkillInvocationPolicy,
});

export const ScientSkillSetProjectPreferenceInput = Schema.Struct({
  projectId: ProjectId,
  name: TrimmedNonEmptyString,
  active: Schema.Boolean,
  invocationPolicy: ScientSkillInvocationPolicy,
});

/** Something the user gives to add skills from. */
export const PersonalSkillSource = Schema.Union([
  Schema.Struct({ type: Schema.Literal("path"), path: TrimmedNonEmptyString }),
  Schema.Struct({ type: Schema.Literal("url"), url: TrimmedNonEmptyString }),
  Schema.Struct({
    type: Schema.Literal("text"),
    text: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256 * 1024)),
    name: Schema.optional(TrimmedNonEmptyString),
  }),
]);
export type PersonalSkillSource = typeof PersonalSkillSource.Type;

export const PersonalSkillInspectInput = Schema.Struct({ source: PersonalSkillSource });

/** One skill found in a source: ready to add, or material an agent can finish. */
export const PersonalSkillCandidate = Schema.Struct({
  key: TrimmedNonEmptyString,
  name: Schema.optional(TrimmedNonEmptyString),
  description: Schema.optional(TrimmedNonEmptyString),
  status: Schema.Literals(["ready", "needs-agent"]),
  /** Why an agent is needed, in plain words. */
  reason: Schema.optional(TrimmedNonEmptyString),
  /** Fixes Scient made or files it left out, in plain words. */
  notes: Schema.Array(TrimmedNonEmptyString),
  /** A personal skill already has this name; adding replaces it, with Undo. */
  exists: Schema.Boolean,
  /** A skill built into Scient or a plugin has this name; it cannot be added as is. */
  conflict: Schema.optional(TrimmedNonEmptyString),
  /** For an agent: the file or folder to finish from, and its text when short. */
  material: Schema.optional(
    Schema.Struct({ path: TrimmedNonEmptyString, text: Schema.optional(Schema.String) }),
  ),
});
export type PersonalSkillCandidate = typeof PersonalSkillCandidate.Type;

export const PersonalSkillInspection = Schema.Union([
  /** Not a skill source: a connector or plugin, handled by the connector path. */
  Schema.Struct({ kind: Schema.Literal("none") }),
  Schema.Struct({
    kind: Schema.Literal("skills"),
    stagingId: TrimmedNonEmptyString,
    sourceLabel: TrimmedNonEmptyString,
    candidates: Schema.Array(PersonalSkillCandidate),
  }),
]);
export type PersonalSkillInspection = typeof PersonalSkillInspection.Type;

export const PersonalSkillAddInput = Schema.Struct({
  stagingId: TrimmedNonEmptyString,
  keys: Schema.Array(TrimmedNonEmptyString).check(Schema.isMinLength(1)),
});

export const PersonalSkillAddResult = Schema.Struct({
  added: Schema.Array(TrimmedNonEmptyString),
  inventory: ScientSkillInventory,
});
export type PersonalSkillAddResult = typeof PersonalSkillAddResult.Type;

export const PersonalSkillNameInput = Schema.Struct({ name: TrimmedNonEmptyString });

export const PersonalSkillExport = Schema.Struct({
  fileName: TrimmedNonEmptyString,
  base64: Schema.String,
});
export type PersonalSkillExport = typeof PersonalSkillExport.Type;

/** A skill another agent on this computer has, which Scient can copy in. */
export const ImportableSkill = Schema.Struct({
  app: Schema.Literals(["claude", "codex", "cursor", "agents"]),
  appLabel: TrimmedNonEmptyString,
  name: TrimmedNonEmptyString,
  description: Schema.optional(TrimmedNonEmptyString),
  folder: TrimmedNonEmptyString,
  /** A personal skill already has this name. */
  added: Schema.Boolean,
});
export type ImportableSkill = typeof ImportableSkill.Type;

export const ImportableSkillsResult = Schema.Struct({ skills: Schema.Array(ImportableSkill) });
export type ImportableSkillsResult = typeof ImportableSkillsResult.Type;

export class ScientSkillManagementError extends Schema.TaggedError<ScientSkillManagementError>()(
  "ScientSkillManagementError",
  {
    operation: TrimmedNonEmptyString,
    message: TrimmedNonEmptyString,
  },
) {}

export const ProviderSkillReadDocumentInput = Schema.Struct({
  instanceId: ProviderInstanceId,
  name: TrimmedNonEmptyString,
  path: TrimmedNonEmptyString,
});
export type ProviderSkillReadDocumentInput = typeof ProviderSkillReadDocumentInput.Type;
export const ProviderSkillDocument = Schema.Struct({
  instructions: Schema.String,
  unavailableReason: Schema.optional(Schema.String),
});

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

export class ProviderSkillManagementError extends Schema.TaggedError<ProviderSkillManagementError>()(
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
