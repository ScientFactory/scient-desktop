/**
 * Reads which packages a document asks for out of the document itself, before
 * anything has been compiled.
 *
 * The reactive resolver — compile, read the missing file out of the
 * transcript, fetch it, compile again — is correct and unavoidable for a
 * package another package pulls in, but it is a terrible way to start. LaTeX
 * takes an emergency stop at the *first* input it cannot find, so a preamble
 * naming eight packages the distribution does not carry costs eight compiles
 * and eight `tlmgr` runs, each of which is a process, a repository round trip,
 * and a rebuild of the distribution's file index. Reading the preamble first
 * turns that into one fetch.
 *
 * Nothing here decides anything: it turns source text into names, bounded and
 * deduplicated, and the caller decides which of them are worth fetching.
 * Nothing here reads files either — the caller supplies the bounded heads it
 * already reads for root resolution.
 */

/** Longer than any real preamble's package list; a generated file is not one. */
const MAX_PREAMBLE_PACKAGES = 40;
/** One level of includes, and only the first few: this is a head start, not a scan. */
const MAX_PREAMBLE_INCLUDES = 8;
/** What a CTAN package may be called; anything else is not asked for. */
const PACKAGE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;

/**
 * `\usepackage[margin=1in]{geometry}` and `\RequirePackage{etoolbox}`, with
 * the option group — which may itself contain braces and commas — skipped.
 */
const PACKAGE_PATTERN = /\\(?:usepackage|RequirePackage)\s*(?:\[[^\]]*\])?\s*\{([^{}]*)\}/gu;
/**
 * `\input{sections/intro}` and `\include{appendix}`. `\input sections/intro`
 * without braces is legal plain TeX and deliberately not read: it is rare in
 * LaTeX documents and its termination rules are not worth guessing at.
 */
const INPUT_PATTERN = /\\(?:input|include)\s*\{([^{}]*)\}/gu;

/** Everything after an unescaped `%` is a comment, on every line. */
export function stripLatexComments(source: string): string {
  return source
    .split(/\r?\n/u)
    .map((line) => {
      for (let index = 0; index < line.length; index += 1) {
        if (line[index] !== "%") continue;
        // `\%` is a literal percent sign; `\\%` is a line break then a comment.
        let backslashes = 0;
        for (let back = index - 1; back >= 0 && line[back] === "\\"; back -= 1) backslashes += 1;
        if (backslashes % 2 === 0) return line.slice(0, index);
      }
      return line;
    })
    .join("\n");
}

/**
 * The packages this source asks for by name, in the order it asks. A group may
 * name several at once (`\usepackage{amsmath,amssymb}`), and a name that is
 * not a package name — a macro the author expanded, an empty slot — is
 * dropped rather than carried to `tlmgr` as argv.
 */
export function latexPreamblePackages(source: string): ReadonlyArray<string> {
  const names: string[] = [];
  const seen = new Set<string>();
  for (const match of stripLatexComments(source).matchAll(PACKAGE_PATTERN)) {
    for (const raw of (match[1] ?? "").split(",")) {
      const name = raw.trim();
      if (name.length === 0 || !PACKAGE_NAME_PATTERN.test(name)) continue;
      const identity = name.toLowerCase();
      if (seen.has(identity)) continue;
      seen.add(identity);
      names.push(name);
      if (names.length >= MAX_PREAMBLE_PACKAGES) return names;
    }
  }
  return names;
}

/**
 * The files this source pulls in, as workspace-relative paths would be written
 * in the document: forward slashes, `.tex` supplied when the author left it
 * off, and never a parent walk or an absolute path — a caller resolves these
 * against the root document's own directory and must not be handed something
 * that leaves it.
 */
export function latexPreambleIncludes(source: string): ReadonlyArray<string> {
  const targets: string[] = [];
  const seen = new Set<string>();
  for (const match of stripLatexComments(source).matchAll(INPUT_PATTERN)) {
    const raw = (match[1] ?? "").trim().replaceAll("\\", "/");
    if (raw.length === 0) continue;
    const target = /\.\w{1,8}$/u.test(raw) ? raw : `${raw}.tex`;
    if (
      target.startsWith("/") ||
      target.startsWith("../") ||
      target.includes("/../") ||
      /^[A-Za-z]:/u.test(target)
    ) {
      continue;
    }
    if (seen.has(target)) continue;
    seen.add(target);
    targets.push(target);
    if (targets.length >= MAX_PREAMBLE_INCLUDES) return targets;
  }
  return targets;
}
