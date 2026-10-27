import * as Schema from "effect/Schema";
import { ProviderInstanceId } from "../providerInstance.ts";
import { TrimmedNonEmptyString } from "../baseSchemas.ts";
import { ProviderStoreApp } from "./providerStore.ts";

export const ExtensionPluginContentsInput = Schema.Struct({
  instanceId: Schema.optional(ProviderInstanceId),
  pluginId: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(1000))),
  entryId: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(1000))),
  cwd: Schema.optional(TrimmedNonEmptyString),
});
export type ExtensionPluginContentsInput = typeof ExtensionPluginContentsInput.Type;
export const ExtensionSkillDocumentInput = Schema.Struct({
  ...ExtensionPluginContentsInput.fields,
  skillId: TrimmedNonEmptyString.check(Schema.isMaxLength(1000)),
});
export type ExtensionSkillDocumentInput = typeof ExtensionSkillDocumentInput.Type;
export const ExtensionPluginSkill = Schema.Struct({
  id: TrimmedNonEmptyString,
  name: TrimmedNonEmptyString,
  displayName: Schema.optional(Schema.String),
  description: Schema.String,
  documentAvailable: Schema.Boolean,
  enabled: Schema.Boolean,
  userInvocable: Schema.optional(Schema.Boolean),
  releaseKey: Schema.optional(Schema.String),
  path: Schema.optional(TrimmedNonEmptyString),
});
export type ExtensionPluginSkill = typeof ExtensionPluginSkill.Type;
export const ExtensionPluginContents = Schema.Struct({
  deferred: Schema.optional(Schema.Boolean),
  requiredKeys: Schema.optional(
    Schema.Array(TrimmedNonEmptyString.check(Schema.isMaxLength(128))).check(
      Schema.isMaxLength(200),
    ),
  ),
  apps: Schema.Array(
    Schema.Struct({
      ...ProviderStoreApp.fields,
      toolCounts: Schema.optional(
        Schema.Struct({
          read: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
          write: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
        }),
      ),
      toolSummaries: Schema.optional(
        Schema.Array(
          Schema.Struct({
            name: Schema.String.check(Schema.isMaxLength(500)),
            title: Schema.optional(Schema.String.check(Schema.isMaxLength(500))),
            description: Schema.String.check(Schema.isMaxLength(4000)),
            isReadOnly: Schema.Boolean,
            isEnabled: Schema.Boolean,
          }),
        ).check(Schema.isMaxLength(200)),
      ),
    }),
  ).check(Schema.isMaxLength(200)),
  mcpServers: Schema.Array(
    Schema.Struct({ name: TrimmedNonEmptyString, status: Schema.optional(Schema.String) }),
  ).check(Schema.isMaxLength(200)),
  skills: Schema.Array(ExtensionPluginSkill).check(Schema.isMaxLength(200)),
  hooks: Schema.optional(Schema.Array(Schema.String).check(Schema.isMaxLength(200))),
  commands: Schema.Array(Schema.String).check(Schema.isMaxLength(200)),
  agents: Schema.Array(Schema.String).check(Schema.isMaxLength(200)),
});
export type ExtensionPluginContents = typeof ExtensionPluginContents.Type;
export const ExtensionSkillDocument = Schema.Struct({
  instructions: Schema.String.check(Schema.isMaxLength(256 * 1024)),
});
export type ExtensionSkillDocument = typeof ExtensionSkillDocument.Type;
