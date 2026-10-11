import { updateLatexVisualLayoutSource, type LatexVisualLayoutUpdate } from "./latexVisualDocument";
import {
  DEFAULT_HEBREW_DOCUMENT_FONT,
  latexDocumentLanguage,
  updateLatexLanguageSource,
  type LatexWritingLanguage,
} from "./latexLanguage";

export type LatexDocumentSettingsUpdate = Partial<LatexVisualLayoutUpdate> & {
  readonly language?: LatexWritingLanguage;
};

/** Apply the card's changes together, keeping language and layout on one undo step. */
export function updateLatexDocumentSettingsSource(
  source: string,
  update: LatexDocumentSettingsUpdate,
): string | null {
  const { language, ...layout } = update;
  const next = Object.keys(layout).length ? updateLatexVisualLayoutSource(source, layout) : source;
  if (next === null || language === undefined) return next;
  const setup = latexDocumentLanguage(next);
  return updateLatexLanguageSource(
    next,
    language,
    setup.hebrewFont ?? DEFAULT_HEBREW_DOCUMENT_FONT,
  );
}
