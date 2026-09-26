import { snippet, type Completion, type CompletionContext } from "@codemirror/autocomplete";
import { foldService, indentService } from "@codemirror/language";
import { EditorSelection, StateField, type EditorState } from "@codemirror/state";
import { type EditorView } from "@codemirror/view";
import { MATH_SYMBOLS } from "./mathSymbols";
import { inlineBibliographyChoices } from "./latexAuthoringModel";
import {
  indexLatexSource,
  latexSourcePathBase,
  maskLatexNonCode,
  relativeLatexPath,
} from "./latexSourceModel";
import type { SourceProjectIndex } from "./useLatexSourceProject";

export const latexSourceIndex = StateField.define({
  create: (state) => indexLatexSource(state.doc.toString()),
  update: (index, transaction) =>
    transaction.docChanged ? indexLatexSource(transaction.newDoc.toString()) : index,
});

export const latexSourceFolding = foldService.of((state, start, end) => {
  const index = state.field(latexSourceIndex);
  const environment = index.environments.find(
    (entry) => entry.from >= start && entry.from <= end && entry.to > end,
  );
  if (environment) return { from: Math.max(end, environment.body), to: environment.to };
  const section = index.sections.find(
    (entry) => entry.from >= start && entry.from <= end && entry.to > end,
  );
  if (section && section.to > section.headingEnd)
    return { from: Math.max(end, section.headingEnd), to: section.to };
  return null;
});

export const latexSourceIndent = indentService.of((context, position) => {
  const line = context.state.doc.lineAt(position);
  if (line.number === 1) return 0;
  const previous = context.state.doc.line(line.number - 1);
  const before = maskLatexNonCode(previous.text).trim();
  const after = maskLatexNonCode(line.text).trimStart();
  const extra =
    /\\begin\{(?!document\})[^}]+\}/u.test(before) && !/\\end\{/u.test(before) ? context.unit : 0;
  const less = /^\\end\{(?!document\})/u.test(after) ? context.unit : 0;
  return Math.max(0, context.lineIndent(previous.from) + extra - less);
});

export const SOURCE_ENVIRONMENTS = [
  "document",
  "abstract",
  "itemize",
  "enumerate",
  "description",
  "equation",
  "equation*",
  "align",
  "align*",
  "aligned",
  "gather",
  "gather*",
  "multline",
  "multline*",
  "cases",
  "matrix",
  "pmatrix",
  "bmatrix",
  "vmatrix",
  "Vmatrix",
  "figure",
  "figure*",
  "table",
  "table*",
  "tabular",
  "tabularx",
  "longtable",
  "center",
  "quote",
  "quotation",
  "verbatim",
  "theorem",
  "lemma",
  "proof",
  "definition",
  "corollary",
  "proposition",
  "example",
  "remark",
  "minipage",
  "thebibliography",
];

const COMMAND_SNIPPETS: readonly [string, string, string][] = [
  ["documentclass", "\\documentclass[${10pt}]{${article}}", "Document class"],
  ["usepackage", "\\usepackage{${package}}", "Load a package"],
  ["title", "\\title{${}}", "Document title"],
  ["author", "\\author{${}}", "Author"],
  ["date", "\\date{${}}", "Date"],
  ["maketitle", "\\maketitle", "Print the title"],
  ["part", "\\part{${}}", "Part"],
  ["chapter", "\\chapter{${}}", "Chapter"],
  ["section", "\\section{${}}", "Section"],
  ["subsection", "\\subsection{${}}", "Subsection"],
  ["subsubsection", "\\subsubsection{${}}", "Subsubsection"],
  ["paragraph", "\\paragraph{${}}", "Paragraph heading"],
  ["textbf", "\\textbf{${}}", "Bold"],
  ["textit", "\\textit{${}}", "Italic"],
  ["emph", "\\emph{${}}", "Emphasis"],
  ["texttt", "\\texttt{${}}", "Monospace"],
  ["underline", "\\underline{${}}", "Underline"],
  ["footnote", "\\footnote{${}}", "Footnote"],
  ["label", "\\label{${}}", "Reference label"],
  ["ref", "\\ref{${}}", "Reference"],
  ["eqref", "\\eqref{${}}", "Equation reference"],
  ["pageref", "\\pageref{${}}", "Page reference"],
  ["autoref", "\\autoref{${}}", "Named reference (hyperref)"],
  ["cite", "\\cite{${}}", "Citation"],
  ["citep", "\\citep{${}}", "Parenthetical citation (natbib)"],
  ["citet", "\\citet{${}}", "Textual citation (natbib)"],
  ["parencite", "\\parencite{${}}", "Parenthetical citation (biblatex)"],
  ["textcite", "\\textcite{${}}", "Text citation (biblatex)"],
  ["input", "\\input{${}}", "Include a source file"],
  ["include", "\\include{${}}", "Include a chapter"],
  ["includegraphics", "\\includegraphics[width=${\\linewidth}]{${}}", "Image (graphicx)"],
  ["caption", "\\caption{${}}", "Caption"],
  ["centering", "\\centering", "Center contents"],
  ["item", "\\item ${}", "List item"],
  ["tableofcontents", "\\tableofcontents", "Table of contents"],
  ["newpage", "\\newpage", "Page break"],
  ["clearpage", "\\clearpage", "Page break and pending floats"],
  ["newcommand", "\\newcommand{\\${1:name}}[${2:1}]{${3}}", "Define a command"],
  ["renewcommand", "\\renewcommand{\\${name}}{${}}", "Redefine a command"],
  ["newtheorem", "\\newtheorem{${theorem}}{${Theorem}}", "Define a theorem environment"],
  ["bibliography", "\\bibliography{${}}", "BibTeX bibliography"],
  ["bibliographystyle", "\\bibliographystyle{${plain}}", "Bibliography style"],
  ["addbibresource", "\\addbibresource{${}}", "Bibliography file (biblatex)"],
  ["printbibliography", "\\printbibliography", "Print bibliography (biblatex)"],
  ["href", "\\href{${url}}{${text}}", "Link (hyperref)"],
  ["url", "\\url{${}}", "URL (url or hyperref)"],
  ["frac", "\\frac{${}}{${}}", "Fraction"],
  ["sqrt", "\\sqrt{${}}", "Square root"],
  ["sum", "\\sum_{${}}^{${}} ${}", "Sum"],
  ["int", "\\int_{${}}^{${}} ${}", "Integral"],
  ["left", "\\left(${}\\right)", "Paired delimiters"],
  ["text", "\\text{${}}", "Text in math (amsmath)"],
  ["hline", "\\hline", "Table rule"],
  ["toprule", "\\toprule", "Top rule (booktabs)"],
  ["midrule", "\\midrule", "Middle rule (booktabs)"],
  ["bottomrule", "\\bottomrule", "Bottom rule (booktabs)"],
];

function environmentSnippet(name: string): string {
  const argumentsText =
    name === "tabular" || name === "longtable"
      ? "{${cc}}"
      : name === "tabularx"
        ? "{${\\linewidth}}{${XX}}"
        : name === "minipage"
          ? "{${\\linewidth}}"
          : name === "thebibliography"
            ? "{${99}}"
            : "";
  const body = /^(?:itemize|enumerate)$/u.test(name)
    ? "\\item ${}"
    : name === "description"
      ? "\\item[${}] ${}"
      : "${}";
  return `\\begin{${name}}${argumentsText}\n\t${body}\n\\end{${name}}`;
}

const standardCommands: Completion[] = [
  ...new Map<string, Completion>([
    ...MATH_SYMBOLS.filter((symbol) => /^\\[A-Za-z]+$/u.test(symbol.command)).map(
      (symbol): [string, Completion] => [
        symbol.command,
        {
          label: symbol.command,
          type: "function",
          detail: symbol.label,
          info: symbol.packages.length ? `Requires ${symbol.packages.join(", ")}.` : symbol.label,
          apply: snippet(
            symbol.latex
              .replaceAll("#0", "${}")
              .replaceAll("\\{", "\\\\{")
              .replaceAll("\\}", "\\\\}"),
          ),
        },
      ],
    ),
    ...COMMAND_SNIPPETS.map(([name, template, detail]): [string, Completion] => [
      `\\${name}`,
      { label: `\\${name}`, type: "function", detail, apply: snippet(template), boost: 2 },
    ]),
  ]).values(),
];

/** Suggestions use literal definitions and linked project files; they do not run a language server. */
export function latexSourceCompletion(
  project: () => SourceProjectIndex,
  file: string,
  rootFile = file,
) {
  return (context: CompletionContext) => {
    const line = context.state.doc.lineAt(context.pos);
    const prefix = line.text.slice(0, context.pos - line.from);
    const parsed = context.state.field(latexSourceIndex);
    const significant = line.from + prefix.trimEnd().length - 1;
    if (significant >= line.from && parsed.code[significant] !== line.text[significant - line.from])
      return null;
    const linked = project();
    const argument = /\\([A-Za-z]+)\*?(?:\[[^\]]*\])*\{([^{}]*)$/u.exec(prefix);
    if (argument) {
      const command = argument[1]!,
        text = argument[2]!;
      const start = context.pos - text.length;
      if (command === "begin" || command === "end") {
        const open: string[] = [];
        if (command === "end")
          for (const token of parsed.code
            .slice(0, context.pos)
            .matchAll(/\\(begin|end)\{([^{}]+)\}/gu)) {
            if (token[1] === "begin") open.push(token[2]!);
            else {
              const at = open.lastIndexOf(token[2]!);
              if (at >= 0) open.splice(at);
            }
          }
        const names = [
          ...new Set([
            ...SOURCE_ENVIRONMENTS,
            ...parsed.customEnvironments,
            ...linked.environments,
          ]),
        ];
        return {
          from: start,
          options: names.map((name): Completion => ({
            label: name,
            type: "type",
            detail: "Environment",
            apply: name,
            boost: name === open.at(-1) ? 10 : 0,
          })),
          validFor: /^[A-Za-z*]*$/u,
        };
      }
      if (
        command === "usepackage" ||
        command === "documentclass" ||
        command === "bibliographystyle"
      ) {
        const names =
          command === "documentclass"
            ? [
                "article",
                "report",
                "book",
                "letter",
                "beamer",
                "memoir",
                "scrartcl",
                "scrreprt",
                "scrbook",
              ]
            : command === "bibliographystyle"
              ? ["plain", "unsrt", "alpha", "abbrv", "plainnat", "unsrtnat", "abbrvnat"]
              : [
                  "amsmath",
                  "amssymb",
                  "amsthm",
                  "mathtools",
                  "graphicx",
                  "geometry",
                  "hyperref",
                  "cleveref",
                  "booktabs",
                  "array",
                  "tabularx",
                  "longtable",
                  "multirow",
                  "caption",
                  "subcaption",
                  "float",
                  "xcolor",
                  "babel",
                  "fontenc",
                  "inputenc",
                  "fontspec",
                  "microtype",
                  "enumitem",
                  "natbib",
                  "biblatex",
                  "csquotes",
                  "siunitx",
                  "tikz",
                  "pgfplots",
                  "listings",
                  "fancyhdr",
                  "setspace",
                  "titlesec",
                  "parskip",
                ];
        return {
          from: start + text.lastIndexOf(",") + 1,
          options: names.map((name) => ({
            label: name,
            type: "type",
            detail:
              command === "usepackage"
                ? "Package"
                : command === "documentclass"
                  ? "Document class"
                  : "Bibliography style",
          })),
          validFor: /^[A-Za-z0-9-]*$/u,
        };
      }
      if (/^(?:[Cc]ref|[Cc]refrange|ref|eqref|pageref|autoref|nameref)$/u.test(command)) {
        const from = start + text.lastIndexOf(",") + 1;
        const labels = [...parsed.labels.map((label) => ({ ...label, file })), ...linked.labels];
        return {
          from,
          options: [
            ...new Map(
              labels.map((label) => [
                label.key,
                { label: label.key, type: "constant", detail: label.file },
              ]),
            ).values(),
          ],
          validFor: /^[^{}\s,]*$/u,
        };
      }
      if (/cite/iu.test(command)) {
        const from = start + text.lastIndexOf(",") + 1;
        const words = context.state.sliceDoc(from, context.pos).toLowerCase().trim().split(/\s+/u);
        const citations = [
          ...inlineBibliographyChoices(context.state.doc.toString()),
          ...linked.citations,
        ].filter((entry) =>
          words.every((word) =>
            `${entry.key} ${entry.title} ${entry.detail}`.toLowerCase().includes(word),
          ),
        );
        return {
          from,
          options: [
            ...new Map(
              citations.map((entry) => [
                entry.key,
                {
                  label: entry.key,
                  type: "constant",
                  detail: entry.title.slice(0, 65),
                  info: `${entry.title}\n${entry.detail}`,
                },
              ]),
            ).values(),
          ],
          filter: false as const,
        };
      }
      if (
        /^(?:input|include|subfile|includegraphics|bibliography|addbibresource)$/u.test(command)
      ) {
        const base = latexSourcePathBase(parsed.code, file, rootFile);
        const kind =
          command === "includegraphics"
            ? /\.(?:png|jpe?g|pdf|eps|svg)$/iu
            : /bibliography|addbibresource/u.test(command)
              ? /\.bib$/iu
              : /\.tex$/iu;
        return {
          from: command === "bibliography" ? start + text.lastIndexOf(",") + 1 : start,
          options: linked.files
            .filter((path) => path !== file && kind.test(path))
            .map((path) => ({
              label:
                command === "bibliography"
                  ? relativeLatexPath(base, path).replace(/\.bib$/iu, "")
                  : relativeLatexPath(base, path),
              type: "text",
              detail: "Project file",
            })),
          validFor: /^[^{}]*$/u,
        };
      }
    }
    const match = context.matchBefore(/\\[A-Za-z@]*$/u);
    if (!match) return null;
    const definitions = [...parsed.commands, ...linked.commands].map((entry): Completion => ({
      label: `\\${entry.name}`,
      type: "function",
      detail: "Document command",
      boost: 5,
      apply: snippet(`\\${entry.name}` + "{${}}".repeat(entry.arguments)),
    }));
    const environments = [
      ...new Set([...SOURCE_ENVIRONMENTS, ...parsed.customEnvironments, ...linked.environments]),
    ].map((name): Completion => ({
      label: `\\begin{${name}}`,
      type: "type",
      detail: "Environment",
      apply: snippet(environmentSnippet(name)),
    }));
    return {
      from: match.from,
      options: [
        ...new Map(
          [...standardCommands, ...environments, ...definitions].map((entry) => [
            entry.label,
            entry,
          ]),
        ).values(),
      ],
      validFor: /^\\[A-Za-z@]*$/u,
    };
  };
}

export function wrapLatexSelection(view: EditorView, before: string, after: string): boolean {
  if (view.state.readOnly) return false;
  view.dispatch(
    view.state.changeByRange((range) => ({
      changes: [
        { from: range.from, insert: before },
        { from: range.to, insert: after },
      ],
      range: EditorSelection.range(range.from + before.length, range.to + before.length),
    })),
    { scrollIntoView: true, userEvent: "input" },
  );
  return true;
}

export function completeLatexEnvironment(view: EditorView): boolean {
  const selection = view.state.selection;
  if (view.state.readOnly || selection.ranges.length !== 1 || !selection.main.empty) return false;
  const line = view.state.doc.lineAt(selection.main.head);
  if (selection.main.head !== line.to) return false;
  const match = /^(\s*)\\begin\{([^{}]+)\}(?:\[[^\]]*\])?(?:\{[^{}]*\})*\s*$/u.exec(line.text);
  if (
    !match ||
    view.state
      .field(latexSourceIndex)
      .environments.some((entry) => entry.from >= line.from && entry.from < line.to)
  )
    return false;
  const indent = match[1]!,
    name = match[2]!;
  const body = name === "document" ? indent : indent + "  ";
  const insert = `\n${body}\n${indent}\\end{${name}}`;
  view.dispatch({
    changes: { from: line.to, insert },
    selection: { anchor: line.to + 1 + body.length },
    scrollIntoView: true,
    userEvent: "input",
  });
  return true;
}

export function sourceReferenceAt(state: EditorState, position: number) {
  const line = state.doc.lineAt(position);
  const code = state.field(latexSourceIndex).code.slice(line.from, line.to);
  for (const match of code.matchAll(
    /\\(input|include|subfile|ref|eqref|pageref|autoref|[Cc]ref)\{([^{}]+)\}/gu,
  )) {
    const from = line.from + match.index;
    if (position >= from && position <= from + match[0].length)
      return { command: match[1]!, argument: match[2]! };
  }
  return null;
}
