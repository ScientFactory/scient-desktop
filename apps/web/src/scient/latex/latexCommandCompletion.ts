import { MATH_SYMBOLS } from "./mathSymbols";
import { MATH_FORMATTING_ARGUMENTS } from "./mathTextFormatting";
import { latexDocumentColors } from "./latexColorBoxes";
import type { DocumentMathMacro } from "./latexDocumentMacros";
import { LATEX_INLINE_MARKS } from "./latexTextFormatting";

export interface LatexCompletionContext {
  readonly source?: string;
  readonly referenceSource?: () => string;
  readonly macros?: Readonly<Record<string, DocumentMathMacro>>;
  readonly colors?: Readonly<Record<string, string>>;
}

export interface LatexCommandChoice {
  readonly label: string;
  readonly latex: string;
  readonly preview: string;
  readonly text?: boolean;
  readonly argument?: boolean;
  readonly math?: boolean;
}

export interface LatexSourceChoice extends LatexCommandChoice {
  readonly from: number;
  readonly to: number;
  readonly replacement: string;
  readonly caret: number;
}

const commands = new Map<string, LatexCommandChoice>();
for (const symbol of MATH_SYMBOLS) {
  if (!/^\\[A-Za-z]+$/u.test(symbol.command) || !symbol.latex.startsWith(symbol.command)) continue;
  const latex = symbol.latex.replace(/#[0-9?]/gu, "#?");
  commands.set(symbol.command, {
    label: symbol.command,
    latex,
    preview: latex.replace(/#\?/gu, ""),
    math: true,
  });
}
for (const [name, mode] of Object.entries(MATH_FORMATTING_ARGUMENTS)) {
  const label = `\\${name}`;
  commands.set(label, {
    label,
    latex: `${label}{#?}`,
    preview: `${label}{}`,
    text: mode === "text",
    math: true,
  });
}

const textTemplates = [
  ["emph", "\\emph{#?}", "\\emph{text}"],
  ["underline", "\\underline{#?}", "\\underline{text}"],
  ["footnote", "\\footnote{#?}", "\\footnote{text}"],
  ["href", "\\href{#?}{#?}", "\\href{url}{text}"],
  ["url", "\\url{#?}", "\\url{url}"],
  ["label", "\\label{#?}", "\\label{key}"],
  ["ref", "\\ref{#?}", "\\ref{key}"],
  ["eqref", "\\eqref{#?}", "\\eqref{key}"],
  ["autoref", "\\autoref{#?}", "\\autoref{key}"],
  ["cref", "\\cref{#?}", "\\cref{key}"],
  ["Cref", "\\Cref{#?}", "\\Cref{key}"],
  ["cite", "\\cite{#?}", "\\cite{key}"],
  ["citep", "\\citep{#?}", "\\citep{key}"],
  ["citet", "\\citet{#?}", "\\citet{key}"],
  ["section", "\\section{#?}", "\\section{title}"],
  ["subsection", "\\subsection{#?}", "\\subsection{title}"],
  ["subsubsection", "\\subsubsection{#?}", "\\subsubsection{title}"],
  ["paragraph", "\\paragraph{#?}", "\\paragraph{title}"],
  ["subparagraph", "\\subparagraph{#?}", "\\subparagraph{title}"],
  ["chapter", "\\chapter{#?}", "\\chapter{title}"],
  ["part", "\\part{#?}", "\\part{title}"],
  ["caption", "\\caption{#?}", "\\caption{text}"],
  ["title", "\\title{#?}", "\\title{title}"],
  ["author", "\\author{#?}", "\\author{name}"],
  ["date", "\\date{#?}", "\\date{date}"],
  ["includegraphics", "\\includegraphics{#?}", "\\includegraphics{file}"],
  ["input", "\\input{#?}", "\\input{file}"],
  ["include", "\\include{#?}", "\\include{file}"],
  ["bibliography", "\\bibliography{#?}", "\\bibliography{file}"],
  ["bibliographystyle", "\\bibliographystyle{#?}", "\\bibliographystyle{style}"],
  ["usepackage", "\\usepackage{#?}", "\\usepackage{package}"],
  ["documentclass", "\\documentclass{#?}", "\\documentclass{class}"],
  ["definecolor", "\\definecolor{#?}{#?}{#?}", "\\definecolor{name}{model}{value}"],
  ["colorlet", "\\colorlet{#?}{#?}", "\\colorlet{name}{color}"],
] as const;
for (const [name, latex, preview] of textTemplates)
  commands.set(`\\${name}`, {
    label: `\\${name}`,
    latex,
    preview,
    text: true,
    ...(commands.get(`\\${name}`)?.math ? { math: true } : {}),
  });

for (const name of ["begin", "end"])
  commands.set(`\\${name}`, {
    label: `\\${name}`,
    latex: `\\${name}{#?}`,
    preview: `\\${name}{environment}`,
    argument: true,
  });

for (const [name, latex, preview] of [
  ["color", "\\color{#?}", "\\color{color}"],
  ["textcolor", "\\textcolor{#?}{#?}", "\\textcolor{color}{text}"],
  ["colorbox", "\\colorbox{#?}{#?}", "\\colorbox{color}{text}"],
  ["fcolorbox", "\\fcolorbox{#?}{#?}{#?}", "\\fcolorbox{border}{background}{text}"],
] as const)
  commands.set(`\\${name}`, { label: `\\${name}`, latex, preview, argument: true, math: true });

const textCommands = new Set([
  ...Object.keys(LATEX_INLINE_MARKS),
  "textnormal",
  "footnote",
  "href",
  "url",
  "ref",
  "eqref",
  "autoref",
  "cref",
  "Cref",
  "cite",
  "citep",
  "citet",
  "color",
  "textcolor",
  "colorbox",
  "fcolorbox",
  "fbox",
  "section",
  "subsection",
  "subsubsection",
  "paragraph",
  "subparagraph",
  "chapter",
]);

export const LATEX_COMPLETION_ENVIRONMENTS = [
  "equation",
  "equation*",
  "align",
  "align*",
  "gather",
  "gather*",
  "aligned",
  "alignedat",
  "gathered",
  "matrix",
  "pmatrix",
  "bmatrix",
  "Bmatrix",
  "vmatrix",
  "Vmatrix",
  "smallmatrix",
  "cases",
  "itemize",
  "enumerate",
  "description",
  "quote",
  "quotation",
  "abstract",
  "figure",
  "table",
  "tabular",
  "theorem",
  "lemma",
  "proof",
  "verbatim",
  "algorithm",
  "algorithmic",
  "tcolorbox",
  "tikzpicture",
] as const;

/** Shared insertion templates; preview names are never inserted as document content. */
export function latexCommandChoices(
  query: string,
  mode: "math" | "prose" | "source",
  context: LatexCompletionContext = {},
): LatexCommandChoice[] {
  if (!/^\\[A-Za-z]+$/u.test(query)) return [];
  const catalog = new Map(commands);
  for (const [name, macro] of Object.entries(context.macros ?? {})) {
    const label = `\\${name}`;
    catalog.set(label, {
      label,
      latex: label + "{#?}".repeat(macro.args),
      preview: label + "{}".repeat(macro.args),
      math: true,
    });
  }
  return [...catalog.values()]
    .filter(
      (choice) =>
        choice.label.startsWith(query) &&
        (mode !== "math" || choice.math) &&
        (mode !== "prose" || choice.math || textCommands.has(choice.label.slice(1))),
    )
    .sort((a, b) => Number(b.label === query) - Number(a.label === query));
}

export function latexChoiceInsertion(choice: LatexCommandChoice) {
  const first = choice.latex.indexOf("#?");
  return {
    replacement: choice.latex.replace(/#\?/gu, ""),
    caret: first < 0 ? choice.latex.length : first,
  };
}

/** Complete literal argument values while preserving the rest of an existing command. */
export function latexArgumentChoices(
  source: string,
  caret: number,
  context: LatexCompletionContext = {},
): LatexSourceChoice[] {
  const before = source.slice(0, caret);
  const color =
    /\\(color|textcolor|colorbox|fcolorbox)\{([^{}]*)$/u.exec(before) ??
    /\\(fcolorbox|colorlet)\{[^{}]*\}\{([^{}]*)$/u.exec(before);
  const reference = /\\(ref|eqref|autoref|cref|Cref|cite|citep|citet)\{([^{}]*)$/u.exec(before);
  const match = color ?? reference;
  if (!match) return [];
  if (Object.hasOwn(context.macros ?? {}, match[1]!)) return [];
  const typed = match[2]!;
  const fragment = /[^!,\s]*$/u.exec(typed)![0];
  const from = caret - fragment.length;
  const following = /^[^{}!,\s]*/u.exec(source.slice(caret))![0];
  const colors = context.colors ?? latexDocumentColors(context.source ?? "");
  const values = color
    ? typed.includes("!") && (typed.split("!").length - 1) % 2 === 1
      ? ["0", "10", "25", "50", "75", "90", "100"]
      : Object.keys(colors)
    : [
        ...(context.referenceSource?.() ?? context.source ?? "").matchAll(
          match[1]!.startsWith("cite")
            ? /\\bibitem(?:\[[^\]]*\])?\{([^{}]+)\}/gu
            : /\\label\{([^{}]+)\}/gu,
        ),
      ].map((entry) => entry[1]!);
  return [...new Set(values)]
    .filter((name) => name.startsWith(fragment))
    .map((name) => ({
      label: name,
      latex: name,
      preview: name,
      from,
      to: caret + following.length,
      replacement: name,
      caret: name.length,
    }));
}

export function latexSourceChoices(
  source: string,
  caret: number,
  mode: "math" | "prose" | "source" = "source",
  context: LatexCompletionContext = {},
): LatexSourceChoice[] {
  const before = source.slice(0, caret);
  // An escaped slash or a commented command must not trigger completion.
  const line = before.slice(before.lastIndexOf("\n") + 1);
  if (mode !== "prose" && /(?<!\\)%/u.test(line)) return [];
  const arguments_ = latexArgumentChoices(source, caret, context);
  if (arguments_.length) return arguments_;
  const environment = /(?<!\\)\\begin\{([A-Za-z*]*)$/u.exec(before);
  if (environment && mode !== "prose") {
    return LATEX_COMPLETION_ENVIRONMENTS.filter(
      (name) =>
        name.startsWith(environment[1]!) &&
        (mode !== "math" ||
          /^(?:aligned|alignedat|gathered|[pBbvV]?matrix|smallmatrix|cases)$/u.test(name)),
    ).map((name) => {
      const argument = name === "tabular" || name === "alignedat" ? "{#?}" : "";
      const body =
        name === "itemize" || name === "enumerate"
          ? "\\item #?"
          : name === "description"
            ? "\\item[#?] #?"
            : "#?";
      const latex = `\\begin{${name}}${argument}\n${body}\n\\end{${name}}`;
      const insertion = latexChoiceInsertion({ label: name, latex, preview: latex });
      const following = /^[A-Za-z*]*\}?/u.exec(source.slice(caret))![0];
      return {
        label: `\\begin{${name}}`,
        latex,
        preview: `\\begin{${name}}${argument.replace("#?", name === "tabular" ? "columns" : "pairs")} … \\end{${name}}`,
        from: caret - environment[0].length,
        to: caret + following.length,
        ...insertion,
      };
    });
  }
  const command = /(?<!\\)\\[A-Za-z]+$/u.exec(before);
  if (!command) return [];
  const following = /^[A-Za-z]*/u.exec(source.slice(caret))![0];
  return latexCommandChoices(command[0], mode, context).map((choice) => {
    const insertion = latexChoiceInsertion(choice);
    // Existing authored arguments are retained; only the command name changes.
    const hasArguments = source[caret + following.length] === "{";
    return {
      ...choice,
      from: caret - command[0].length,
      to: caret + following.length,
      replacement: hasArguments ? choice.label : insertion.replacement,
      caret: hasArguments ? choice.label.length + 1 : insertion.caret,
    };
  });
}
