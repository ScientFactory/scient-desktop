import { ComputeLanguageId } from "@scientfactory/compute";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { TrimmedString } from "../baseSchemas.ts";

/**
 * Environment-owned preferences for one optional scientific language.
 *
 * An empty executable means automatic discovery. These are selection
 * preferences only: changing them never installs, repairs, licenses, or
 * mutates a runtime, and never rewrites an existing compute session.
 */
export const ScientificComputingLanguageSettings = Schema.Struct({
  // SCIENT-FORK:START — supported languages are discoverable unless explicitly disabled.
  enabled: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  // SCIENT-FORK:END
  executable: TrimmedString.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
});
export type ScientificComputingLanguageSettings = typeof ScientificComputingLanguageSettings.Type;

export const DEFAULT_SCIENTIFIC_COMPUTING_LANGUAGE_SETTINGS: ScientificComputingLanguageSettings =
  Schema.decodeSync(ScientificComputingLanguageSettings)({});

export const ScientificComputingSettings = Schema.Struct({
  schemaVersion: Schema.Literal(1).pipe(Schema.withDecodingDefault(Effect.succeed(1 as const))),
  languages: Schema.Record(ComputeLanguageId, ScientificComputingLanguageSettings).pipe(
    Schema.withDecodingDefault(Effect.succeed({})),
  ),
}).pipe(Schema.withDecodingDefault(Effect.succeed({})));
export type ScientificComputingSettings = typeof ScientificComputingSettings.Type;

/** Missing means "use the product default"; a persisted per-language choice always wins. */
export const resolveScientificComputingLanguageSettings = (
  settings: Pick<ScientificComputingSettings, "languages">,
  languageId: ComputeLanguageId,
): ScientificComputingLanguageSettings =>
  settings.languages[languageId] ?? DEFAULT_SCIENTIFIC_COMPUTING_LANGUAGE_SETTINGS;

/** Server-settings patch for scientific-computing preferences. */
export const ScientificComputingSettingsPatch = Schema.Struct({
  schemaVersion: Schema.optionalKey(Schema.Literal(1)),
  languages: Schema.optionalKey(
    Schema.Record(
      ComputeLanguageId,
      Schema.Struct({
        enabled: Schema.optionalKey(Schema.Boolean),
        executable: Schema.optionalKey(TrimmedString),
      }),
    ),
  ),
});
