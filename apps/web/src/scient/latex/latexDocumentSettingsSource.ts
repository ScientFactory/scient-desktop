import { updateLatexVisualLayoutSource, type LatexVisualLayoutUpdate } from "./latexVisualDocument";
import {
  DEFAULT_HEBREW_DOCUMENT_FONT,
  latexDocumentLanguage,
  updateLatexLanguageSource,
  type LatexWritingLanguage,
} from "./latexLanguage";
import {
  updateDocumentLayoutSettings,
  type DocumentLayoutSettings,
} from "./latexDocumentLayoutSettings";

export type LatexDocumentSettingsUpdate = Partial<LatexVisualLayoutUpdate> &
  DocumentLayoutSettings & {
    readonly language?: LatexWritingLanguage;
  };

/** Apply the card's changes together, keeping language and layout on one undo step. */
export function updateLatexDocumentSettingsSource(
  source: string,
  update: LatexDocumentSettingsUpdate,
): string | null {
  const {
    language,
    documentClass,
    paper,
    baseFontPt,
    margin,
    orientation,
    margins,
    paragraphStyle,
    ...extended
  } = update;
  const layout = Object.fromEntries(
    Object.entries({
      documentClass,
      paper,
      baseFontPt,
      margin,
      orientation,
      margins,
      paragraphStyle,
    }).filter(([, value]) => value !== undefined),
  ) as Partial<LatexVisualLayoutUpdate>;
  const basic = Object.keys(layout).length
    ? (updateLatexVisualLayoutSource(source, layout)?.source ?? null)
    : source;
  const next = basic === null ? null : updateDocumentLayoutSettings(basic, extended);
  if (next === null || language === undefined) return next;
  const setup = latexDocumentLanguage(next);
  return updateLatexLanguageSource(
    next,
    language,
    setup.hebrewFont ?? DEFAULT_HEBREW_DOCUMENT_FONT,
  );
}
