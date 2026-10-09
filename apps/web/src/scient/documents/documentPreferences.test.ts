import * as Schema from "effect/Schema";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { removeLocalStorageItem, setLocalStorageItem } from "~/hooks/useLocalStorage";

import {
  NEW_DOCUMENT_LANGUAGE_STORAGE_KEY,
  NEW_DOCUMENT_TEMPLATE_STORAGE_KEY,
  normalizeNewDocumentLanguage,
  normalizeNewDocumentTemplate,
  readNewDocumentDefaults,
} from "./documentPreferences";
import { MORE_DOCUMENT_TEMPLATES, NEW_DOCUMENT_TEMPLATES } from "./documentTemplates";

afterEach(() => {
  removeLocalStorageItem(NEW_DOCUMENT_TEMPLATE_STORAGE_KEY);
  removeLocalStorageItem(NEW_DOCUMENT_LANGUAGE_STORAGE_KEY);
});

describe("new document defaults", () => {
  it("start as a Blank English document when nothing was chosen", () => {
    expect(readNewDocumentDefaults()).toEqual({ template: "blank", language: "english" });
  });

  it("follow the choice made in Settings", () => {
    setLocalStorageItem(NEW_DOCUMENT_TEMPLATE_STORAGE_KEY, "thesis", Schema.String);
    setLocalStorageItem(NEW_DOCUMENT_LANGUAGE_STORAGE_KEY, "hebrew", Schema.String);
    expect(readNewDocumentDefaults()).toEqual({ template: "thesis", language: "hebrew" });
  });

  it("fall back to Blank and English for anything Scient no longer offers", () => {
    setLocalStorageItem(NEW_DOCUMENT_TEMPLATE_STORAGE_KEY, "poster", Schema.String);
    setLocalStorageItem(NEW_DOCUMENT_LANGUAGE_STORAGE_KEY, "klingon", Schema.String);
    expect(readNewDocumentDefaults()).toEqual({ template: "blank", language: "english" });
    expect(normalizeNewDocumentTemplate(null)).toBe("blank");
    expect(normalizeNewDocumentLanguage(undefined)).toBe("english");
  });

  it("can be any template the new page offers", () => {
    for (const template of [...NEW_DOCUMENT_TEMPLATES, ...MORE_DOCUMENT_TEMPLATES]) {
      expect(normalizeNewDocumentTemplate(template.id)).toBe(template.id);
    }
  });
});
