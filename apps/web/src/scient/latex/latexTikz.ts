import { latexSourceArgument, latexSourceCommands } from "./latexSourceSyntax";

/** Recognize a complete picture without interpreting the TikZ or pgfplots language. */
export function latexTikzEnd(source: string): number | null {
  if (source.length > 100_000 || !/^\s*\\begin\s*\{tikzpicture\}/u.test(source)) return null;
  let depth = 0;
  for (const command of latexSourceCommands(source)) {
    if (command.name !== "begin" && command.name !== "end") continue;
    const argument = latexSourceArgument(source, command.to);
    if (argument?.value !== "tikzpicture") continue;
    depth += command.name === "begin" ? 1 : -1;
    if (depth === 0) return argument.end;
  }
  return null;
}

export function isLatexTikz(source: string): boolean {
  const end = latexTikzEnd(source);
  return end !== null && !source.slice(end).trim();
}
