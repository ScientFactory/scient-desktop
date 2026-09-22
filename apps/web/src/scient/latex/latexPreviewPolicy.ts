/** Preview claims are deliberately independent of browser layout: only TeX
 * can verify pagination, package effects, macro expansion and cross-references. */
export function latexPreviewRebuildReason(
  compiledSource: string,
  currentSource: string,
  pdfMatchesSource: boolean,
): string | null {
  if (pdfMatchesSource) return null;
  const preamble = (source: string) => source.split("\\begin{document}")[0];
  if (
    currentSource.includes("\\begin{document}") &&
    preamble(compiledSource) !== preamble(currentSource)
  ) {
    return "Rebuild required for preamble, macros, fonts or page-layout changes. Writing view is approximate.";
  }
  const definitions = (source: string) =>
    source
      .split(/\r?\n/u)
      .filter((line) =>
        /\\(?:newcommand|renewcommand|def|gdef|let|newenvironment|renewenvironment|geometry|setlength|documentclass|usepackage)\b/u.test(
          line,
        ),
      )
      .join("\n");
  if (definitions(compiledSource) !== definitions(currentSource)) {
    return "Rebuild required for changed macros or global layout. Source-only commands are preserved, not executed in the writing view.";
  }
  return "Live writing preview · rebuild to verify equations, references and final pagination.";
}
