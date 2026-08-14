/**
 * Reads which files a TeX run could not find out of its own transcript, and
 * decides which of them a package repository could supply.
 *
 * The distribution Scient installs ships TeX Live's infrastructure and a base
 * set of packages; everything else is fetched on demand. A document that uses
 * anything outside that set therefore stops at `File `mathtools.sty' not
 * found.` until the package is placed, which is what the caller uses this
 * module to notice. Nothing here runs anything: it turns one transcript into
 * names, and the decision to install them belongs to `LatexPackageInstaller`.
 *
 * A missing `.tex`, `.bib`, or image is the author's own file — no repository
 * has it, and offering to install one would be a lie — so those are read and
 * deliberately map to nothing.
 */

/**
 * A preamble that goes wrong early can report failures for the rest of the
 * document, and an install round is a subprocess per run, so the list a caller
 * acts on is bounded here rather than at the point of use.
 */
const MAX_MISSING_INPUTS = 10;
/** Longer than any real input name; a wrapped or corrupted line is not one. */
const MAX_INPUT_NAME_LENGTH = 120;

/**
 * Every shape an engine reports a missing input in. `latexmk` forwards
 * pdfTeX's own wording and adds its own summary line; tectonic labels the same
 * failure with an `error:` prefix and its own phrasing. All of them quote the
 * file name, which is what makes the capture safe: the closing quote ends it.
 */
const MISSING_INPUT_PATTERNS: ReadonlyArray<RegExp> = [
  // `! LaTeX Error: File `mathtools.sty' not found.` and tectonic's
  // `error: ... file `mathtools.sty' not found`.
  /file\s+[`'"]([^`'"\n]+)['"`]\s+not found/giu,
  // TeX's own prompt when an `\input` target is missing.
  /I can't find file\s+[`'"]([^`'"\n]+)['"`]/giu,
  // tectonic, for a file it could not open at all.
  /(?:could not|unable to)\s+(?:open|find)\s+(?:the\s+)?file\s+[`'"]([^`'"\n]+)['"`]/giu,
  // latexmk's own summary, which survives even where the engine's output does not.
  /Missing input file:\s*[`'"]([^`'"\n]+)['"`]/giu,
];

/** Files a repository can supply. Everything else belongs to the author. */
const PACKAGE_EXTENSIONS: ReadonlySet<string> = new Set([".sty", ".cls"]);
/** What a CTAN package may be called; anything else is not asked for. */
const PACKAGE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;

function normalizeMissingInput(raw: string): string | null {
  const name = raw.trim().replaceAll("\\", "/").replace(/^\.\//u, "");
  if (name.length === 0 || name.length > MAX_INPUT_NAME_LENGTH) return null;
  return name;
}

/**
 * Every input the transcript says was missing, deduplicated and bounded, in the
 * form the engine printed it (extension included). The same failure is usually
 * reported by more than one of the patterns above, which is what the
 * deduplication is for.
 */
export function extractMissingLatexInputs(transcript: string): string[] {
  const inputs: string[] = [];
  const seen = new Set<string>();
  for (const pattern of MISSING_INPUT_PATTERNS) {
    for (const match of transcript.matchAll(pattern)) {
      const name = normalizeMissingInput(match[1] ?? "");
      if (name === null) continue;
      const identity = name.toLowerCase();
      if (seen.has(identity)) continue;
      seen.add(identity);
      inputs.push(name);
      if (inputs.length >= MAX_MISSING_INPUTS) return inputs;
    }
  }
  return inputs;
}

/**
 * The package that would supply this input, or `null` when nothing could:
 * `mathtools.sty` is the `mathtools` package, `revtex4-2.cls` is `revtex4-2`,
 * and `chapters/intro.tex` is a file the author still has to write.
 */
export function packageNameForMissingInput(fileName: string): string | null {
  const baseName = fileName.replaceAll("\\", "/").split("/").at(-1) ?? fileName;
  const dot = baseName.lastIndexOf(".");
  if (dot <= 0) return null;
  if (!PACKAGE_EXTENSIONS.has(baseName.slice(dot).toLowerCase())) return null;
  const name = baseName.slice(0, dot);
  return PACKAGE_NAME_PATTERN.test(name) ? name : null;
}

/** The installable packages one transcript asks for, deduplicated and bounded. */
export function missingLatexPackages(transcript: string): string[] {
  const packages: string[] = [];
  const seen = new Set<string>();
  for (const input of extractMissingLatexInputs(transcript)) {
    const name = packageNameForMissingInput(input);
    if (name === null || seen.has(name)) continue;
    seen.add(name);
    packages.push(name);
  }
  return packages;
}
