import * as Schema from "effect/Schema";
import { TrimmedNonEmptyString } from "./baseSchemas.ts";

/** Inert source information for presenting provider syntax; never execution authority. */
export const ProviderCitationPresentationSource = Schema.Struct({
  id: TrimmedNonEmptyString.check(Schema.isMaxLength(256)),
  url: TrimmedNonEmptyString.check(Schema.isMaxLength(32_768)),
  title: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(1_024))),
});
export const ProviderCitationPresentation = Schema.Struct({
  format: Schema.Literal("codex-private-v1"),
  sources: Schema.Array(ProviderCitationPresentationSource).check(Schema.isMaxLength(128)),
});
export type ProviderCitationPresentation = typeof ProviderCitationPresentation.Type;
