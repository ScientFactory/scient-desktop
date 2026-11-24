import { ProjectId } from "./baseSchemas.ts";
import * as Schema from "effect/Schema";

const term = Schema.String.check(Schema.isPattern(/^\S(?:[\s\S]{0,78}\S)?$/u));
export const TranscriptionWord = Schema.Struct({
  term,
  preferred: Schema.optionalKey(term),
  variants: Schema.optionalKey(Schema.Array(term)),
  note: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(256))),
  language: Schema.String.check(Schema.isPattern(/^(und|[a-z]{2,3}(-[a-zA-Z0-9]{2,8})*)$/)),
  source: Schema.Literals(["user", "suggested-accepted"]),
});
export type TranscriptionWord = typeof TranscriptionWord.Type;
export const TranscriptionWords = Schema.Array(TranscriptionWord);

export const DictationRecognitionHints = Schema.Array(
  Schema.String.check(Schema.isMaxLength(160)),
).check(Schema.isMaxLength(16));

export const DictationVocabulary = Schema.Struct({
  words: TranscriptionWords,
  hints: DictationRecognitionHints,
});
export type DictationVocabulary = typeof DictationVocabulary.Type;

export class DictationWordsError extends Schema.TaggedError<DictationWordsError>()(
  "DictationWordsError",
  { message: Schema.String },
) {}

export const TranscriptionWordEdit = Schema.Struct({
  operation: Schema.Literals(["save", "remove"]),
  word: TranscriptionWord,
});

const wordDestination = {
  projectId: Schema.optionalKey(ProjectId),
  level: Schema.Literals(["global", "project", "recording"]),
  id: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(256))),
};
export const WordsCommand = Schema.Union([
  Schema.Struct({ action: Schema.Literal("words-list"), ...wordDestination }),
  Schema.Struct({
    action: Schema.Literals(["words-add", "words-remove"]),
    ...wordDestination,
    word: TranscriptionWord,
  }),
  Schema.Struct({
    action: Schema.Literal("words-accept"),
    ...wordDestination,
    suggestionRevision: Schema.String.check(Schema.isMaxLength(256)),
    word: TranscriptionWord,
  }),
  Schema.Struct({ action: Schema.Literal("recordings-list"), projectId: ProjectId }),
  Schema.Struct({
    action: Schema.Literal("suggestions-list"),
    projectId: ProjectId,
    id: Schema.String.check(Schema.isMaxLength(256)),
  }),
]);
export type WordsCommand = typeof WordsCommand.Type;

export const WordsCommandResult = Schema.Struct({
  words: Schema.optionalKey(TranscriptionWords),
  storageBytes: Schema.optionalKey(Schema.Number),
  sourceCount: Schema.optionalKey(Schema.Number),
  recordings: Schema.optionalKey(
    Schema.Array(Schema.Struct({ id: Schema.String, title: Schema.String })),
  ),
});
export type WordsCommandResult = typeof WordsCommandResult.Type;

// Set only when this version is the enforced minimum for all desktop and mobile clients,
// the protocol matrix passes, and archives have reached all intended environments.
const MINIMUM_SUPPORTED_WORDS_CLIENT_VERSION: string | null = null;
export const LEGACY_WORDS_TRANSITION_ENABLED = MINIMUM_SUPPORTED_WORDS_CLIENT_VERSION === null;
