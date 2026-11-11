/**
 * Named fonts offered for text, shared by both editors and both exports. A name is written
 * to a file, CSS, LaTeX or Word XML only when it is in this list.
 */

export type FontCategory = "serif" | "sans-serif" | "monospace";

export interface CatalogueFont {
  /** The name written in files; also the Word font name. */
  readonly name: string;
  readonly category: FontCategory;
  /** CSS fallback stack used when rendering; the name itself comes first. */
  readonly css: string;
  /** True when the font has Hebrew letters on the usual systems. */
  readonly hebrew: boolean;
  readonly latex: {
    /** pdfLaTeX font family code (`\fontfamily{code}`) of a free look-alike, or null. */
    readonly pdftex: string | null;
    /** Name for `fontspec` under XeLaTeX or LuaLaTeX. */
    readonly fontspec: string;
    /** Free font used when the named one is not installed (fontspec fallback). */
    readonly fallback: string | null;
  };
}

const GENERIC: Readonly<Record<FontCategory, string>> = {
  serif: "serif",
  "sans-serif": "sans-serif",
  monospace: "monospace",
};

function font(
  name: string,
  category: FontCategory,
  stack: string,
  hebrew: boolean,
  latex: CatalogueFont["latex"],
): CatalogueFont {
  return { name, category, css: `'${name}', ${stack}, ${GENERIC[category]}`, hebrew, latex };
}

export const FONT_CATALOGUE: ReadonlyArray<CatalogueFont> = [
  font("Times New Roman", "serif", "Tinos, 'Liberation Serif', Times", true, {
    pdftex: "qtm",
    fontspec: "Times New Roman",
    fallback: "TeX Gyre Termes",
  }),
  font("Cambria", "serif", "Caladea", false, {
    pdftex: null,
    fontspec: "Cambria",
    fallback: "Latin Modern Roman",
  }),
  font("Georgia", "serif", "'Gelasio'", false, {
    pdftex: null,
    fontspec: "Georgia",
    fallback: "Latin Modern Roman",
  }),
  font("Palatino", "serif", "'Palatino Linotype', 'Book Antiqua'", false, {
    pdftex: "qpl",
    fontspec: "Palatino",
    fallback: "TeX Gyre Pagella",
  }),
  font("Garamond", "serif", "'EB Garamond'", false, {
    pdftex: null,
    fontspec: "Garamond",
    fallback: "Latin Modern Roman",
  }),
  font("Libertinus Serif", "serif", "'Linux Libertine'", false, {
    pdftex: null,
    fontspec: "Libertinus Serif",
    fallback: "Latin Modern Roman",
  }),
  font("Latin Modern Roman", "serif", "'CMU Serif'", false, {
    pdftex: "lmr",
    fontspec: "Latin Modern Roman",
    fallback: null,
  }),
  font("Arial", "sans-serif", "Arimo, 'Liberation Sans', Helvetica", true, {
    pdftex: "qhv",
    fontspec: "Arial",
    fallback: "TeX Gyre Heros",
  }),
  font("Helvetica", "sans-serif", "'Helvetica Neue', Arimo", false, {
    pdftex: "qhv",
    fontspec: "Helvetica",
    fallback: "TeX Gyre Heros",
  }),
  font("Calibri", "sans-serif", "Carlito", false, {
    pdftex: null,
    fontspec: "Calibri",
    fallback: "Latin Modern Sans",
  }),
  font("Latin Modern Sans", "sans-serif", "'CMU Sans Serif'", false, {
    pdftex: "lmss",
    fontspec: "Latin Modern Sans",
    fallback: null,
  }),
  font("David", "serif", "'David Libre'", true, {
    pdftex: null,
    fontspec: "David",
    fallback: "Times New Roman",
  }),
  font("Courier New", "monospace", "Cousine, 'Liberation Mono', Courier", false, {
    pdftex: "qcr",
    fontspec: "Courier New",
    fallback: "TeX Gyre Cursor",
  }),
  font("Consolas", "monospace", "Inconsolata, Menlo", false, {
    pdftex: null,
    fontspec: "Consolas",
    fallback: "Latin Modern Mono",
  }),
  font("Latin Modern Mono", "monospace", "'CMU Typewriter Text'", false, {
    pdftex: "lmtt",
    fontspec: "Latin Modern Mono",
    fallback: null,
  }),
];

const BY_NAME: ReadonlyMap<string, CatalogueFont> = new Map(
  FONT_CATALOGUE.map((entry) => [entry.name, entry]),
);

/** The catalogue entry for a name written in a file, or null for any other string. */
export function catalogueFont(name: string): CatalogueFont | null {
  return BY_NAME.get(name) ?? null;
}
