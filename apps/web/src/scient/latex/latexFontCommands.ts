import type { Editor } from "@tiptap/core";
import {
  FONT_FAMILIES,
  FONT_SIZES,
  type FontFamilyName,
  type FontSizeName,
} from "../writing/fontChoices";

/** Generic family to the LaTeX Visual mark that writes it (`\textrm`, `\textsf`, `\texttt`). */
const FAMILY_MARKS: Readonly<Record<FontFamilyName, string>> = {
  serif: "latexRoman",
  "sans-serif": "latexSans",
  monospace: "code",
};

const sizeMark = (size: FontSizeName) => `latexSize_${size}`;

/** The size and family shared by the whole selection; null when none or mixed. */
export function latexFontState(editor: Editor | null): {
  readonly size: FontSizeName | null;
  readonly family: FontFamilyName | null;
} {
  if (!editor) return { size: null, family: null };
  return {
    size: FONT_SIZES.find(({ name }) => editor.isActive(sizeMark(name)))?.name ?? null,
    family: FONT_FAMILIES.find(({ name }) => editor.isActive(FAMILY_MARKS[name]))?.name ?? null,
  };
}

/** A size replaces the previous one, as in LaTeX; null returns to the document default. */
export function setLatexFontSize(editor: Editor | null, size: FontSizeName | null): boolean {
  if (!editor) return false;
  let chain = editor.chain().focus();
  for (const { name } of FONT_SIZES) chain = chain.unsetMark(sizeMark(name));
  if (size) chain = chain.setMark(sizeMark(size));
  return chain.run();
}

/** A family replaces the previous one; null returns to the document default. */
export function setLatexFontFamily(editor: Editor | null, family: FontFamilyName | null): boolean {
  if (!editor) return false;
  let chain = editor.chain().focus();
  for (const { name } of FONT_FAMILIES) chain = chain.unsetMark(FAMILY_MARKS[name]);
  if (family) chain = chain.setMark(FAMILY_MARKS[family]);
  return chain.run();
}
