import * as Schema from "effect/Schema";

import { getLocalStorageItem } from "~/hooks/useLocalStorage";

import {
  DOCUMENT_TEMPLATES,
  NEW_DOCUMENT_LANGUAGES,
  type DocumentTemplateId,
  type NewDocumentLanguage,
} from "./documentTemplates";

/**
 * Settings ▸ Documents preferences that live on this device, beside the views
 * the LaTeX and Markdown editors already remember here. `scient.` keys, so none
 * can collide with an inherited `t3code.*` key.
 */
export const NEW_DOCUMENT_TEMPLATE_STORAGE_KEY = "scient.newDocumentTemplate";
export const NEW_DOCUMENT_LANGUAGE_STORAGE_KEY = "scient.newDocumentLanguage";

export const DEFAULT_NEW_DOCUMENT_TEMPLATE: DocumentTemplateId = "blank";
export const DEFAULT_NEW_DOCUMENT_LANGUAGE: NewDocumentLanguage = "english";

export function normalizeNewDocumentTemplate(value: string | null | undefined): DocumentTemplateId {
  return (
    DOCUMENT_TEMPLATES.find((template) => template.id === value)?.id ??
    DEFAULT_NEW_DOCUMENT_TEMPLATE
  );
}

export function normalizeNewDocumentLanguage(
  value: string | null | undefined,
): NewDocumentLanguage {
  return (
    NEW_DOCUMENT_LANGUAGES.find((language) => language.id === value)?.id ??
    DEFAULT_NEW_DOCUMENT_LANGUAGE
  );
}

function readStored(key: string): string | null {
  try {
    return getLocalStorageItem(key, Schema.String);
  } catch (error) {
    console.error(error);
    return null;
  }
}

/** Where a new LaTeX document starts. The row on the new page still changes it. */
export function readNewDocumentDefaults(): {
  readonly template: DocumentTemplateId;
  readonly language: NewDocumentLanguage;
} {
  return {
    template: normalizeNewDocumentTemplate(readStored(NEW_DOCUMENT_TEMPLATE_STORAGE_KEY)),
    language: normalizeNewDocumentLanguage(readStored(NEW_DOCUMENT_LANGUAGE_STORAGE_KEY)),
  };
}
