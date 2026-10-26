import * as Schema from "effect/Schema";
import { TrimmedNonEmptyString } from "../baseSchemas.ts";
import { ProviderInstanceId } from "../providerInstance.ts";

export const ProviderStoreApp = Schema.Struct({
  name: TrimmedNonEmptyString,
  installUrl: Schema.optional(Schema.String),
  connected: Schema.Boolean,
  enabled: Schema.Boolean,
});
export type ProviderStoreApp = typeof ProviderStoreApp.Type;

export const ProviderStoreEntry = Schema.Struct({
  id: TrimmedNonEmptyString,
  name: TrimmedNonEmptyString,
  marketplace: TrimmedNonEmptyString,
  displayName: TrimmedNonEmptyString,
  description: Schema.String,
  kind: Schema.Literals(["shared", "codex"]),
  installed: Schema.Boolean,
  version: Schema.optional(Schema.String),
  publisher: Schema.optional(Schema.String),
  website: Schema.optional(Schema.String),
  iconUrl: Schema.optional(Schema.String),
  includes: Schema.Array(Schema.String),
  review: Schema.optional(Schema.Literals(["anthropic", "partner"])),
  disabledReason: Schema.optional(Schema.String),
  authPolicy: Schema.optional(Schema.String),
  apps: Schema.Array(ProviderStoreApp),
});
export type ProviderStoreEntry = typeof ProviderStoreEntry.Type;

export const ProviderStoreSearchInput = Schema.Struct({
  instanceId: ProviderInstanceId,
  query: Schema.optional(Schema.String.check(Schema.isMaxLength(500))),
  cursor: Schema.optional(Schema.String.check(Schema.isMaxLength(1000))),
  limit: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 50 }))),
  preview: Schema.optional(Schema.Boolean),
  refresh: Schema.optional(Schema.Boolean),
});
export type ProviderStoreSearchInput = typeof ProviderStoreSearchInput.Type;
export const ProviderStoreEntryInput = Schema.Struct({
  instanceId: ProviderInstanceId,
  entryId: TrimmedNonEmptyString.check(Schema.isMaxLength(1000)),
});
export type ProviderStoreEntryInput = typeof ProviderStoreEntryInput.Type;
export const ProviderStorePage = Schema.Struct({
  entries: Schema.Array(ProviderStoreEntry),
  nextCursor: Schema.optional(Schema.String),
  total: Schema.Number,
  canAddOfficialStore: Schema.optional(Schema.Boolean),
  message: Schema.optional(Schema.String),
});
export type ProviderStorePage = typeof ProviderStorePage.Type;
