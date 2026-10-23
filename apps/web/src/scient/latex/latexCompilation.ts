export const LATEX_COMPILATION_STORAGE_KEY = "scient.latexCompilation";
export const DEFAULT_LATEX_COMPILATION = "on-save";
export const LATEX_AUTO_COMPILE_DELAY_MS = 2_000;

export const LATEX_COMPILATION_OPTIONS = [
  { id: "auto", name: "Auto-compile", description: "Update the PDF after you pause editing." },
  { id: "on-save", name: "On save", description: "Update the PDF when you save." },
  { id: "manual", name: "Manual", description: "Update the PDF when you click Rebuild." },
] as const;

export type LatexCompilationMode = (typeof LATEX_COMPILATION_OPTIONS)[number]["id"];

export function normalizeLatexCompilation(value: string): LatexCompilationMode {
  return (
    LATEX_COMPILATION_OPTIONS.find((option) => option.id === value)?.id ?? DEFAULT_LATEX_COMPILATION
  );
}
