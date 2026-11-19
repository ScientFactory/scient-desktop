export const LATEX_COMPILATION_STORAGE_KEY = "scient.latexCompilation";
import { msg } from "gt-react";
export const DEFAULT_LATEX_COMPILATION = "on-save";
export const LATEX_AUTO_COMPILE_DELAY_MS = 2_000;

/** `name` and `description` are `msg()` strings: resolve them where they are shown. */
export const LATEX_COMPILATION_OPTIONS = [
  {
    id: "auto",
    name: msg("Auto-compile"),
    description: msg("Update the PDF after you pause editing."),
  },
  { id: "on-save", name: msg("On save"), description: msg("Update the PDF when you save.") },
  {
    id: "manual",
    name: msg("Manual", { $context: "LaTeX compilation mode" }),
    description: msg("Update the PDF when you click Rebuild."),
  },
] as const;

export type LatexCompilationMode = (typeof LATEX_COMPILATION_OPTIONS)[number]["id"];

export function normalizeLatexCompilation(value: string): LatexCompilationMode {
  return (
    LATEX_COMPILATION_OPTIONS.find((option) => option.id === value)?.id ?? DEFAULT_LATEX_COMPILATION
  );
}
