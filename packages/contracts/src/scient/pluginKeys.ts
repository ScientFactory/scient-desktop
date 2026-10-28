import * as Schema from "effect/Schema";
import { ProjectId, TrimmedNonEmptyString } from "../baseSchemas.ts";
import { ProviderInstanceId } from "../providerInstance.ts";
import { VaultSecretRef } from "./secrets.ts";

export const PluginKeyTarget = Schema.Struct({
  agent: Schema.optional(ProviderInstanceId),
  pluginId: TrimmedNonEmptyString.check(Schema.isMaxLength(1000)),
  cwd: Schema.optional(TrimmedNonEmptyString),
  projectId: Schema.optional(ProjectId),
});
export type PluginKeyTarget = typeof PluginKeyTarget.Type;
export const PluginKeyIdentity = Schema.Struct({
  agent: Schema.optional(ProviderInstanceId),
  pluginId: PluginKeyTarget.fields.pluginId,
  envName: Schema.String.check(Schema.isPattern(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/)),
});
export type PluginKeyIdentity = typeof PluginKeyIdentity.Type;
const AccountTokenRef = VaultSecretRef.check(
  Schema.isPattern(/^account:acc_[A-Za-z0-9_-]{8,64}:token$/),
);
export const PluginKeyBinding = Schema.Struct({
  ...PluginKeyIdentity.fields,
  accountRef: AccountTokenRef,
});
export type PluginKeyBinding = typeof PluginKeyBinding.Type;
export const PluginKeyBindInput = Schema.Struct({
  ...PluginKeyTarget.fields,
  envName: PluginKeyIdentity.fields.envName,
  accountRef: AccountTokenRef,
});
export const PluginKeyUnbindInput = Schema.Struct({
  ...PluginKeyTarget.fields,
  envName: PluginKeyIdentity.fields.envName,
});
export const PluginKeyState = Schema.Struct({
  status: Schema.Literals(["ready", "needs-key"]),
  commandLineBlocked: Schema.optional(Schema.Boolean),
  requirementsKnown: Schema.Boolean,
  writable: Schema.Boolean,
  keys: Schema.Array(
    Schema.Struct({
      envName: PluginKeyIdentity.fields.envName,
      origins: Schema.optional(Schema.Array(Schema.String).check(Schema.isMaxLength(200))),
      accountRef: Schema.optional(VaultSecretRef),
      accountName: Schema.optional(Schema.String),
      available: Schema.Boolean,
    }),
  ).check(Schema.isMaxLength(200)),
  accounts: Schema.Array(Schema.Struct({ ref: VaultSecretRef, name: Schema.String })),
});
export type PluginKeyState = typeof PluginKeyState.Type;
