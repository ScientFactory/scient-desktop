import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { TrimmedString } from "../baseSchemas.ts";
import { AccountId } from "./accounts.ts";

/** Library lookups that send a key from Accounts; each keeps the key the person chose. */
export const LibraryKeyUse = Schema.Literals([
  "zotero",
  "openAlex",
  "semanticScholar",
  "ncbi",
  "googleBooks",
  "unpaywallEmail",
]);
export type LibraryKeyUse = typeof LibraryKeyUse.Type;

const LibraryKeyChoices = Schema.Record(Schema.String, AccountId);

/**
 * Library (Sources) settings. The contact email is sent to Crossref, OpenAlex and Unpaywall
 * only when set; empty means requests carry no email.
 */
export const ScientSourcesSettings = Schema.Struct({
  registryContactEmail: TrimmedString.check(Schema.isMaxLength(254)).pipe(
    Schema.withDecodingDefault(Effect.succeed("")),
  ),
  /** By `LibraryKeyUse`. Absent until a key is first used, then today's choice is kept. */
  keys: LibraryKeyChoices.pipe(Schema.withDecodingDefault(Effect.succeed({}))),
}).pipe(Schema.withDecodingDefault(Effect.succeed({})));
export type ScientSourcesSettings = typeof ScientSourcesSettings.Type;

export const ScientSourcesSettingsPatch = Schema.Struct({
  registryContactEmail: Schema.optionalKey(TrimmedString.check(Schema.isMaxLength(254))),
  keys: Schema.optionalKey(LibraryKeyChoices),
});
export type ScientSourcesSettingsPatch = typeof ScientSourcesSettingsPatch.Type;

const EMAIL_PATTERN = /^[^\s@<>()[\]\\,;:"]+@[^\s@<>()[\]\\,;:"]+\.[^\s@<>()[\]\\,;:"]+$/u;

/** The contact email to send, or null when it is empty or not shaped like an address. */
export function usableRegistryContactEmail(value: string): string | null {
  const trimmed = value.trim();
  return EMAIL_PATTERN.test(trimmed) ? trimmed : null;
}
