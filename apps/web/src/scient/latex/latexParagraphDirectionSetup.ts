import type { JSONContent } from "@tiptap/core";
import type { DocumentSourcePatch } from "@scientfactory/scient-document";
import { declaredLatexCompiler, updateLatexCompilerSource } from "./latexCompiler";
import { latexDocumentLanguage } from "./latexLanguage";
import { latexPackageInventory } from "./latexPackages";
import { latexSourceArgument, latexSourceCommands } from "./latexSourceSyntax";

export function latexParagraphDirectionSupported(source: string): boolean {
  const packages = latexPackageInventory(source).loaded;
  return latexDocumentLanguage(source).bidi || packages.has("luabidi") || packages.has("babelbidi");
}

/** Only an explicit new direction, rather than ordinary typing, requests setup. */
export function introducesLatexParagraphDirection(
  previous: readonly JSONContent[],
  next: readonly JSONContent[],
): boolean {
  const count = (nodes: readonly JSONContent[]) => {
    const counts = new Map<string, number>();
    const visit = (node: JSONContent) => {
      if (node.attrs?.layout?.kind === "direction") {
        const key = String(node.attrs.layout.direction);
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
      node.content?.forEach(visit);
    };
    nodes.forEach(visit);
    return counts;
  };
  const before = count(previous);
  return [...count(next)].some(([direction, total]) => total > (before.get(direction) ?? 0));
}

/** Direction uses the matching Unicode engine without changing language or fonts. */
export function prepareLatexParagraphDirectionSetup(source: string): {
  source: string;
  patches: readonly DocumentSourcePatch[];
} | null {
  if (latexParagraphDirectionSupported(source)) return { source, patches: [] };
  const boundary = latexSourceCommands(source).find(
    (command) =>
      command.depth === 0 &&
      command.name === "begin" &&
      latexSourceArgument(source, command.to)?.value === "document",
  );
  if (!boundary) return null;
  const compiler = declaredLatexCompiler(source);
  const eol = source.includes("\r\n") ? "\r\n" : "\n";
  const preamble = source.slice(0, boundary.from);
  // bidi patches packages already loaded, so add it after the existing preamble.
  let prepared =
    preamble +
    (preamble.endsWith("\n") ? "" : eol) +
    (compiler === "lualatex" ? "\\usepackage{luabidi}" : "\\usepackage{bidi}") +
    eol;
  if (compiler !== "lualatex" && compiler !== "xelatex")
    prepared = updateLatexCompilerSource(prepared, "xelatex");
  return {
    source: prepared + source.slice(boundary.from),
    patches: [{ start: 0, end: boundary.from, expected: preamble, replacement: prepared }],
  };
}
