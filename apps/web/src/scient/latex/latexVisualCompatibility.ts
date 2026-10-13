import type { JSONContent } from "@tiptap/core";
import type { LatexVisualDocument } from "./latexVisualDocument";
import { latexWithoutComments, latexPreambleEnd } from "./latexSourceSyntax";

/** Render acceptance is separate from typesetting fidelity and content coverage. */
export function latexVisualCompatibility(source: string, projection: LatexVisualDocument) {
  const issues: { kind: "source" | "approximate"; message: string; line: number }[] = [];
  const seen = new Set<string>();
  const add = (kind: "source" | "approximate", message: string, at: number) => {
    const key = `${kind}:${message}${kind === "source" ? `:${at}` : ""}`;
    if (seen.has(key)) return;
    seen.add(key);
    issues.push({ kind, message, line: source.slice(0, Math.max(0, at)).split("\n").length });
  };
  const visit = (node: JSONContent, at: number) => {
    const layout = node.attrs?.layout;
    if (layout?.points)
      add(
        "approximate",
        "Explicit font sizes may be substituted by the TeX font. Compare the title and text sizes with PDF.",
        at,
      );
    if (node.type === "latexRawBlock")
      add("source", String(node.attrs?.reason ?? "This content requires Source or PDF."), at);
    if (layout?.kind === "sourceColumns" || layout?.kind === "fullWidthTitle")
      add(
        "approximate",
        "Columns and the full-width title use browser layout. Compare column breaks and pagination with PDF.",
        at,
      );
    if (["macroHeading", "contentFloat"].includes(String(layout?.kind)))
      add(
        "approximate",
        "Custom heading spacing and float placement are approximated. The compiled PDF supplies final typesetting.",
        at,
      );
    if (node.type === "latexRichPreview" && node.attrs?.kind === "compiledAlgorithm")
      add("approximate", "This drawing requires a PDF rebuild for its compiled appearance.", at);
    for (const child of node.content ?? []) {
      const raw = String(child.attrs?.raw ?? "");
      const childAt = raw ? source.indexOf(raw, at) : at;
      visit(child, childAt >= 0 ? childAt : at);
    }
  };
  for (const block of projection.blocks) visit(block.node, block.from);
  const preamble = latexWithoutComments(source.slice(0, latexPreambleEnd(source)));
  // Visual is continuous paper: it draws no running headers or footers.
  if (/\\(?:pagestyle\s*\{\s*fancy\s*\}|fancy(?:head|foot)\b|[lcr](?:head|foot)\b)/u.test(preamble))
    add("approximate", "Running headers and footers appear only in the compiled PDF.", 0);
  const classDeclaration = /\\documentclass\s*(?:\[([^\]]*)\])?\s*\{([^{}]+)\}/u.exec(preamble);
  if (
    classDeclaration &&
    !["article", "report", "book", "amsart", "amsbook", "amsproc"].includes(classDeclaration[2]!)
  )
    add(
      "approximate",
      `The ${classDeclaration[2]} class may define typography or structures that Visual cannot resolve.`,
      classDeclaration.index,
    );
  if (
    classDeclaration?.[1]
      ?.split(",")
      .some((option) => /^\s*(?!10pt|11pt|12pt)\d+pt\s*$/u.test(option))
  )
    add(
      "approximate",
      "Visual uses standard 10/11/12pt class metrics. This font-size option requires checking against PDF.",
      classDeclaration.index,
    );
  if (/\\(?:input|include|if[A-Za-z]*|catcode)\b/u.test(preamble))
    add(
      "approximate",
      "Included or conditional preamble settings require TeX evaluation; compare the resolved settings with PDF.",
      0,
    );
  if (/\\(?:usepackage|RequirePackage)\s*(?:\[[^\]]*\])?\s*\{[^{}]*\bmicrotype\b/u.test(preamble))
    add(
      "approximate",
      "Microtypography and TeX spacing adjustments can produce different line wrapping in PDF.",
      0,
    );
  if (/\\renewcommand\s*\{?\\arraystretch\b/u.test(preamble))
    add("approximate", "Custom table row spacing requires comparison with the compiled PDF.", 0);
  return issues;
}
