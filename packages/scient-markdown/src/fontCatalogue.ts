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
    pdftex: "ptm",
    fontspec: "Times New Roman",
  }),
  font("Cambria", "serif", "Caladea", false, {
    pdftex: null,
    fontspec: "Cambria",
  }),
  font("Georgia", "serif", "'Gelasio'", false, {
    pdftex: null,
    fontspec: "Georgia",
  }),
  font("Palatino", "serif", "'Palatino Linotype', 'Book Antiqua'", false, {
    pdftex: null,
    fontspec: "Palatino",
  }),
  font("Garamond", "serif", "'EB Garamond'", false, {
    pdftex: null,
    fontspec: "Garamond",
  }),
  font("Libertinus Serif", "serif", "'Linux Libertine'", false, {
    pdftex: null,
    fontspec: "Libertinus Serif",
  }),
  font("Latin Modern Roman", "serif", "'CMU Serif'", false, {
    pdftex: "lmr",
    fontspec: "Latin Modern Roman",
  }),
  font("Arial", "sans-serif", "Arimo, 'Liberation Sans', Helvetica", true, {
    pdftex: "phv",
    fontspec: "Arial",
  }),
  font("Helvetica", "sans-serif", "'Helvetica Neue', Arimo", false, {
    pdftex: "phv",
    fontspec: "Helvetica",
  }),
  font("Calibri", "sans-serif", "Carlito", false, {
    pdftex: null,
    fontspec: "Calibri",
  }),
  font("Latin Modern Sans", "sans-serif", "'CMU Sans Serif'", false, {
    pdftex: "lmss",
    fontspec: "Latin Modern Sans",
  }),
  font("David", "serif", "'David Libre'", true, {
    pdftex: null,
    fontspec: "David",
  }),
  font("Courier New", "monospace", "Cousine, 'Liberation Mono', Courier", false, {
    pdftex: null,
    fontspec: "Courier New",
  }),
  font("Consolas", "monospace", "Inconsolata, Menlo", false, {
    pdftex: null,
    fontspec: "Consolas",
  }),
  font("Latin Modern Mono", "monospace", "'CMU Typewriter Text'", false, {
    pdftex: "lmtt",
    fontspec: "Latin Modern Mono",
  }),
];

const BY_NAME: ReadonlyMap<string, CatalogueFont> = new Map(
  FONT_CATALOGUE.map((entry) => [entry.name, entry]),
);

/** The catalogue entry for a name written in a file, or null for any other string. */
export function catalogueFont(name: string): CatalogueFont | null {
  return BY_NAME.get(name) ?? null;
}

/** Also recognize TeX Gyre families in existing documents. */
export function fontForLatexCode(code: string | undefined) {
  if (!code) return undefined;
  const legacy: Readonly<Record<string, string>> = {
    qtm: "Times New Roman",
    qhv: "Arial",
    qpl: "Palatino",
    qcr: "Courier New",
  };
  return FONT_CATALOGUE.find((font) => font.latex.pdftex === code || font.name === legacy[code]);
}
