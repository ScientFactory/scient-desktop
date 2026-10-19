import type { ScientLatexCompiler, ScientLatexToolchainReport } from "@t3tools/contracts";

export type LatexCompiler = ScientLatexCompiler;
export type LatexDocumentCompiler = LatexCompiler | "tectonic";
export type LatexCompilerChoice = "automatic" | LatexDocumentCompiler;

export const LATEX_COMPILER_CHOICES: readonly { id: LatexCompilerChoice; name: string }[] = [
  { id: "automatic", name: "Automatic" },
  { id: "tectonic", name: "Tectonic" },
  { id: "pdflatex", name: "pdfLaTeX" },
  { id: "xelatex", name: "XeLaTeX — recommended for Hebrew" },
  { id: "lualatex", name: "LuaLaTeX" },
];

const COMPILER_DIRECTIVE =
  /^(?:\uFEFF)?[\t ]*%+[\t ]*![\t ]*TEX[\t ]+(?:program|TS-program)[\t ]*=[\t ]*([^\r\n]*)/imu;
const ALL_COMPILER_DIRECTIVES =
  /^[\t ]*%+[\t ]*![\t ]*TEX[\t ]+(?:program|TS-program)[\t ]*=[^\r\n]*(?:\r?\n|$)/gimu;

export function normalizeLatexCompilerChoice(
  value: string | null | undefined,
): LatexCompilerChoice {
  return LATEX_COMPILER_CHOICES.find((choice) => choice.id === value)?.id ?? "automatic";
}

/** Preserve declarations from other editors, including engines Scient does not drive. */
export function latexCompilerDeclaration(source: string): string | null {
  return COMPILER_DIRECTIVE.exec(source)?.[1]?.trim() ?? null;
}

export function declaredLatexCompiler(source: string): LatexDocumentCompiler | null {
  const token = /^[A-Za-z]+(?=\s|$)/u
    .exec(latexCompilerDeclaration(source) ?? "")?.[0]
    ?.toLowerCase();
  if (token === "pdflatex" || token === "pdftex") return "pdflatex";
  if (token === "xelatex" || token === "xetex") return "xelatex";
  if (token === "lualatex" || token === "luatex") return "lualatex";
  if (token === "tectonic") return "tectonic";
  return null;
}

/** A deliberate document edit replaces every conflicting engine directive, never the body. */
export function updateLatexCompilerSource(source: string, compiler: LatexCompilerChoice): string {
  const bom = source.startsWith("\uFEFF") ? "\uFEFF" : "";
  const withoutDirective = source.slice(bom.length).replace(ALL_COMPILER_DIRECTIVES, "");
  if (compiler === "automatic") return `${bom}${withoutDirective}`;
  const eol = source.includes("\r\n") ? "\r\n" : "\n";
  return `${bom}% !TEX program = ${compiler}${eol}${withoutDirective}`;
}

export function latexCompilerAvailabilityLabel(
  report: ScientLatexToolchainReport | null,
  compiler: LatexDocumentCompiler,
  offline = false,
): string | null {
  if (offline) return "Offline";
  if (report === null) return "Not checked";
  // A latexmk report describes the default, not whether another driver exists.
  if (compiler === "tectonic")
    return report.kind === "tectonic"
      ? null
      : report.kind === null
        ? "Not installed"
        : "Not checked";
  const availability = report.compilers.find((item) => item.compiler === compiler);
  if (availability === undefined) return "Not checked";
  if (availability.available) return null;
  if (report.kind === "tectonic")
    return compiler === "xelatex"
      ? "Not installed; Tectonic is XeTeX-compatible"
      : "Not available through Tectonic";
  return "Not installed";
}

/** Tectonic satisfies XeTeX declarations without claiming a standalone XeLaTeX install. */
export function isLatexCompilerUnavailable(
  report: ScientLatexToolchainReport | null,
  compiler: LatexDocumentCompiler,
): boolean {
  if (compiler === "tectonic") return report?.kind === null;
  const availability = report?.compilers.find((item) => item.compiler === compiler);
  if (availability?.available) return false;
  if (report?.kind === "tectonic") return compiler !== "xelatex";
  return availability?.available === false;
}
