import * as Schema from "effect/Schema";
import { ElementContextDetails, PreviewAnnotationPayloadSchema } from "@t3tools/contracts";
import { collectSelectedScientSkillNames } from "@t3tools/shared/composerInlineTokens";
import {
  PersistedTerminalContextDraft,
  type ComposerThreadDraftState,
} from "../../composerDraftStore";
import { ReviewCommentContextSchema } from "../../reviewCommentContext";
import { elementContextToPreviewAnnotation } from "../../lib/elementContext";
import { migrateLegacyTerminalContextPlaceholders } from "../../lib/terminalContext";
import { ensureInlineContextReferences } from "../../lib/composerContextReferences";
import {
  terminalContextReference,
  previewAnnotationContextReference,
  reviewCommentContextReference,
} from "../../lib/composerContextRecords";

// Queue-only edit data, not provider input or authority. Reuse draft codecs;
// unlike ordinary draft hydration, a queued terminal selection retains its text.
const contextFields = {
  prompt: Schema.String,
  terminalContexts: Schema.Array(
    Schema.Struct({ ...PersistedTerminalContextDraft.fields, text: Schema.String }),
  ),
  previewAnnotations: Schema.Array(PreviewAnnotationPayloadSchema),
  reviewComments: Schema.Array(ReviewCommentContextSchema),
};
const legacyElements = Schema.Array(
  Schema.Struct({
    ...ElementContextDetails.fields,
    id: Schema.String,
    pickedAt: Schema.String,
  }),
);
const currentSnapshot = Schema.fromJsonString(
  Schema.Struct({
    version: Schema.Literal(2),
    ...contextFields,
  }),
);
const snapshot = Schema.fromJsonString(
  Schema.Union([
    Schema.Struct({ version: Schema.Literal(2), ...contextFields }),
    Schema.Struct({
      version: Schema.Literal(1),
      ...contextFields,
      elementContexts: Schema.optional(legacyElements),
    }),
  ]),
);
type ContextDraft = Pick<
  ComposerThreadDraftState,
  "prompt" | "terminalContexts" | "previewAnnotations" | "reviewComments"
>;

export function encodeQueueComposerSnapshot(draft: ContextDraft): string {
  return Schema.encodeSync(currentSnapshot)({ version: 2, ...draft });
}

/** Old queue snapshots/journals bypass ordinary composer hydration. Preserve
 * their selected data using the same element and terminal migrations as main. */
export function migrateQueueComposerContext(
  draft: Omit<typeof currentSnapshot.Type, "version"> & { elementContexts?: unknown },
): ContextDraft {
  const previewAnnotations = [...draft.previewAnnotations];
  for (const element of Schema.decodeUnknownSync(legacyElements)(draft.elementContexts ?? [])) {
    if (!previewAnnotations.some((annotation) => annotation.id === element.id)) {
      const { id, pickedAt, ...selection } = element;
      previewAnnotations.push(elementContextToPreviewAnnotation(selection, id, pickedAt));
    }
  }
  return {
    prompt: ensureInlineContextReferences(
      migrateLegacyTerminalContextPlaceholders(draft.prompt, draft.terminalContexts),
      [
        ...draft.terminalContexts.map(terminalContextReference),
        ...previewAnnotations.map(previewAnnotationContextReference),
        ...draft.reviewComments.map(reviewCommentContextReference),
      ],
    ),
    terminalContexts: [...draft.terminalContexts],
    previewAnnotations,
    reviewComments: [...draft.reviewComments],
  };
}

export function decodeQueueComposerSnapshot(value: string): ContextDraft {
  const decoded = Schema.decodeUnknownSync(snapshot)(value);
  if (decoded.version === 1) return migrateQueueComposerContext(decoded);
  const { version: _version, ...draft } = decoded;
  return {
    ...draft,
    terminalContexts: [...draft.terminalContexts],
    previewAnnotations: [...draft.previewAnnotations],
    reviewComments: [...draft.reviewComments],
  };
}

const LEGACY_QUEUE_SELECTION_MESSAGE =
  "This older queue edit has no separate composer/context snapshot. Its $names cannot be treated as new Skill selections. Keep the queued message unchanged, or compose a new message with the Skills you want; the saved edit is preserved.";

export function assertQueueEditSelectionProvenance(separated: boolean | undefined, prompt: string) {
  if (!separated && collectSelectedScientSkillNames(prompt).length > 0) {
    throw new Error(LEGACY_QUEUE_SELECTION_MESSAGE);
  }
}
