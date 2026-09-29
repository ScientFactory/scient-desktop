import type { JSONContent } from "@tiptap/core";
import { newMathSymbolPackages } from "./mathSymbols";
import {
  ensureLatexPackages,
  ensureLatexMenuColors,
  latexPackageInventory,
  newLatexCommandPackages,
} from "./latexPackages";
import {
  latexLengthInches,
  latexVisualLayoutProfile,
  LATEX_PAPER_SIZES,
  type LatexVisualLayoutProfile,
} from "./latexVisualLayout";

export { latexVisualLayoutProfile, type LatexVisualLayoutProfile } from "./latexVisualLayout";

export interface LatexVisualSourceBlock {
  readonly id: string;
  readonly from: number;
  readonly to: number;
  readonly node: JSONContent;
  readonly source: string;
  readonly editable: boolean;
}

export interface LatexVisualDocument {
  readonly source: string;
  readonly content: JSONContent;
  readonly blocks: readonly LatexVisualSourceBlock[];
  readonly supportedBlocks: number;
  readonly rawBlocks: number;
}

export interface LatexRootUpdate {
  readonly expected: string;
  readonly next: string;
}

export const LATEX_HEADING_STYLES = [
  { level: 6, command: "chapter", label: "Chapter" },
  { level: 1, command: "section", label: "Section" },
  { level: 2, command: "subsection", label: "Subsection" },
  { level: 3, command: "subsubsection", label: "Subsubsection" },
  { level: 4, command: "paragraph", label: "Paragraph heading" },
  { level: 5, command: "subparagraph", label: "Subparagraph heading" },
] as const;

export interface LatexVisualLayoutUpdate {
  readonly documentClass?: string;
  readonly paper: LatexVisualLayoutProfile["paper"];
  readonly baseFontPt: 10 | 11 | 12;
  readonly margin: string;
  readonly margins?: Record<"top" | "right" | "bottom" | "left", string>;
  readonly paragraphStyle: "indented" | "spaced";
}

function replaceOrInsertPreambleLine(
  source: string,
  pattern: RegExp,
  value: string,
  insertionAt: number,
  eol: string,
): string {
  const match = pattern.exec(source.slice(0, insertionAt));
  if (match)
    return source.slice(0, match.index) + value + source.slice(match.index + match[0].length);
  const boundary = insertionAt > 0 && !/[\r\n]/u.test(source[insertionAt - 1]!) ? eol : "";
  return source.slice(0, insertionAt) + boundary + value + eol + source.slice(insertionAt);
}

export function updateLatexVisualLayoutSource(
  source: string,
  update: Partial<LatexVisualLayoutUpdate>,
): string | null {
  const classAt = findDelimiter(source, "\\documentclass", 0);
  const documentClass = /^\\documentclass\s*(?:\[([^\]]*)\])?\s*\{([^{}]+)\}/u.exec(
    source.slice(classAt),
  );
  const begin = findDelimiter(source, "\\begin{document}", 0);
  if (classAt < 0 || !documentClass || begin < 0 || classAt > begin) return null;
  const eol = source.includes("\r\n") ? "\r\n" : "\n";
  const targetClass = update.documentClass ?? documentClass[2];
  if (targetClass !== documentClass[2]) {
    if (
      !["article", "report", "book"].includes(targetClass ?? "") ||
      !["article", "report", "book"].includes(documentClass[2] ?? "")
    )
      return null;
    if (targetClass === "article" && /\\(?:chapter|part)\b/u.test(source.slice(begin))) return null;
    if (
      targetClass !== "book" &&
      /\\(?:frontmatter|mainmatter|backmatter)\b/u.test(source.slice(begin))
    )
      return null;
  }
  let changed = source;
  if (
    update.baseFontPt !== undefined ||
    update.paper !== undefined ||
    update.documentClass !== undefined
  ) {
    const options = (documentClass[1] ?? "")
      .split(",")
      .filter(
        (option) =>
          !(update.baseFontPt !== undefined && /^(?:10|11|12)pt$/u.test(option.trim())) &&
          !(
            update.paper !== undefined &&
            /^(?:a4|a5|b5|letter|legal|executive)paper$/u.test(option.trim())
          ),
      );
    if (update.baseFontPt !== undefined) options.push(`${update.baseFontPt}pt`);
    if (update.paper !== undefined) options.push(`${update.paper}paper`);
    const value = options.filter(Boolean).join(",");
    changed =
      source.slice(0, classAt) +
      `\\documentclass${value ? `[${value}]` : ""}{${targetClass}}` +
      source.slice(classAt + documentClass[0].length);
  }
  const margins =
    update.margins ??
    (update.margin === undefined
      ? undefined
      : { top: update.margin, right: update.margin, bottom: update.margin, left: update.margin });
  if (margins !== undefined || update.paper !== undefined) {
    if (margins !== undefined) {
      const values = Object.values(margins).map((value) => latexLengthInches(value));
      const paper = LATEX_PAPER_SIZES[update.paper ?? latexVisualLayoutProfile(source).paper];
      if (
        Object.values(margins).some(
          (value) => !/^(?:\d+(?:\.\d*)?|\.\d+)\s*(?:in|cm|mm|pt)$/u.test(value.trim()),
        ) ||
        values.some((value) => value === null || value <= 0) ||
        (latexLengthInches(margins.left) ?? 0) + (latexLengthInches(margins.right) ?? 0) >=
          paper.width ||
        (latexLengthInches(margins.top) ?? 0) + (latexLengthInches(margins.bottom) ?? 0) >=
          paper.height
      )
        return null;
    }
    const options = (value: string) =>
      [
        ...value
          .split(/,(?![^{}]*\})/u)
          .filter(
            (option) =>
              !(
                margins !== undefined &&
                /^(?:margin|hmargin|vmargin|top|right|bottom|left|inner|outer|textwidth|textheight|width|height|total|scale|hscale|vscale)\s*=/u.test(
                  option.trim(),
                )
              ) &&
              !(
                update.paper !== undefined &&
                /^(?:(?:a4|a5|b5|letter|legal|executive)paper\b|(?:paper|paperwidth|paperheight)\s*=)/u.test(
                  option.trim(),
                )
              ),
          ),
        ...(update.margins
          ? Object.entries(update.margins).map(
              ([side, value]) => `${side}=${value.replace(/\s+/gu, "")}`,
            )
          : update.margin !== undefined
            ? [`margin=${update.margin.replace(/\s+/gu, "")}`]
            : []),
        ...(update.paper !== undefined ? [`${update.paper}paper`] : []),
      ]
        .filter(Boolean)
        .join(",");
    const at = findDelimiter(changed, "\\begin{document}", 0);
    const preamble = changed.slice(0, at);
    const geometry = /\\usepackage(?:\[([^\]]*)\])?\{geometry\}/u;
    const configure = /\\geometry\s*\{((?:[^{}]|\{[^{}]*\})*)\}/gu;
    if (
      geometry.test(preamble) ||
      /\\usepackage(?:\[[^\]]*\])?\{[^{}]*\bgeometry\b[^{}]*\}/u.test(preamble)
    ) {
      let updated = preamble.replace(
        geometry,
        (_match, value: string | undefined) => `\\usepackage[${options(value ?? "")}]{geometry}`,
      );
      if (configure.test(preamble))
        updated = updated.replace(
          configure,
          (_match, value: string) => `\\geometry{${options(value)}}`,
        );
      else if (updated === preamble) updated += `\\geometry{${options("")}}${eol}`;
      changed = updated + changed.slice(at);
    } else if (margins !== undefined) {
      changed =
        preamble +
        (preamble.endsWith("\n") ? "" : eol) +
        `\\usepackage[${options("")}]{geometry}${eol}` +
        changed.slice(at);
    }
  }
  if (update.paragraphStyle !== undefined) {
    for (const [command, value] of [
      ["parindent", update.paragraphStyle === "spaced" ? "0pt" : "1.5em"],
      ["parskip", update.paragraphStyle === "spaced" ? "0.75em" : "0pt plus 1pt"],
    ]) {
      changed = replaceOrInsertPreambleLine(
        changed,
        new RegExp(`\\\\setlength\\{\\\\${command}\\}\\{[^{}]+\\}`, "u"),
        `\\setlength{\\${command}}{${value}}`,
        findDelimiter(changed, "\\begin{document}", 0),
        eol,
      );
    }
  }
  return changed;
}

const INLINE_MARKS: Readonly<Record<string, string>> = {
  textbf: "bold",
  textit: "italic",
  emph: "italic",
  texttt: "code",
};
const INLINE_ATOMS = new Set([
  "cite",
  "citep",
  "citet",
  "citeauthor",
  "citeyear",
  "ref",
  "eqref",
  "autoref",
  "pageref",
  "nameref",
  "label",
  "url",
  "footnote",
  "index",
]);
const SOURCE_ONLY_INLINE_COMMANDS = new Set([
  "begin",
  "end",
  "input",
  "include",
  "includeonly",
  "documentclass",
  "usepackage",
  "RequirePackage",
  "write",
  "openout",
  "read",
]);
const DISPLAY_MATH_ENVIRONMENTS = /^(equation\*?|align\*?|gather\*?)$/u;
export const STRUCTURED_MATH_ENVIRONMENTS = [
  "matrix",
  "bmatrix",
  "pmatrix",
  "vmatrix",
  "Vmatrix",
  "cases",
  "aligned",
] as const;
const STRUCTURED_MATH_ENVIRONMENT = new RegExp(
  `^(?:${STRUCTURED_MATH_ENVIRONMENTS.join("|")})$`,
  "u",
);
const ESCAPES: Readonly<Record<string, string>> = {
  "%": "%",
  "&": "&",
  _: "_",
  "#": "#",
  $: "$",
  "{": "{",
  "}": "}",
};

function textNode(text: string, marks: readonly string[]): JSONContent | null {
  if (!text) return null;
  return {
    type: "text",
    text,
    ...(marks.length === 0 ? {} : { marks: marks.map((type) => ({ type })) }),
  };
}

function closingBrace(source: string, opening: number): number | null {
  let depth = 1;
  for (let index = opening + 1; index < source.length; index++) {
    if (source[index] === "%") {
      const newline = source.indexOf("\n", index);
      if (newline < 0) return null;
      index = newline;
    } else if (source[index] === "\\") {
      index++;
    } else if (source[index] === "{") {
      depth++;
    } else if (source[index] === "}") {
      depth--;
      if (depth === 0) return index;
    }
  }
  return null;
}

function parseInline(source: string, marks: readonly string[] = []): JSONContent[] | null {
  const nodes: JSONContent[] = [];
  let plain = "";
  const flush = () => {
    const node = textNode(plain, marks);
    if (node) nodes.push(node);
    plain = "";
  };
  for (let index = 0; index < source.length;) {
    const char = source[index]!;
    if (
      char === "%" ||
      char === "{" ||
      char === "}" ||
      char === "&" ||
      char === "#" ||
      char === "^" ||
      char === "_"
    ) {
      return null;
    }
    if (char === "$" && source[index + 1] !== "$") {
      const end = findDelimiter(source, "$", index + 1);
      if (end < 0) return null;
      flush();
      nodes.push({
        type: "latexInlineMath",
        attrs: { tex: source.slice(index + 1, end), wrapper: "dollar" },
      });
      index = end + 1;
      continue;
    }
    if (char === "\\") {
      const escaped = ESCAPES[source[index + 1] ?? ""];
      if (escaped !== undefined) {
        plain += escaped;
        index += 2;
        continue;
      }
      if (source.startsWith("\\(", index)) {
        const end = findDelimiter(source, "\\)", index + 2);
        if (end < 0) return null;
        flush();
        nodes.push({
          type: "latexInlineMath",
          attrs: { tex: source.slice(index + 2, end), wrapper: "paren" },
        });
        index = end + 2;
        continue;
      }
      if (source.startsWith("\\\\", index)) {
        flush();
        nodes.push({ type: "hardBreak" });
        index += 2;
        if (source[index] === "\r") index++;
        if (source[index] === "\n") index++;
        continue;
      }
      const literal = /^\\(textbackslash|textasciitilde|textasciicircum)\{\}/u.exec(
        source.slice(index),
      );
      if (literal) {
        plain +=
          literal[1] === "textbackslash" ? "\\" : literal[1] === "textasciitilde" ? "~" : "^";
        index += literal[0].length;
        continue;
      }
      const command = /^\\([A-Za-z]+)/u.exec(source.slice(index));
      if (!command) return null;
      const name = command[1]!;
      const after = index + command[0].length;
      if (source[after] !== "{") return null;
      const close = closingBrace(source, after);
      if (close === null) return null;
      const raw = source.slice(index, close + 1);
      const argument = source.slice(after + 1, close);
      const mark = INLINE_MARKS[name];
      if (mark !== undefined) {
        const children = parseInline(argument, [...marks, mark]);
        if (children === null) return null;
        flush();
        nodes.push(...children);
      } else if (!SOURCE_ONLY_INLINE_COMMANDS.has(name) && INLINE_ATOMS.has(name)) {
        flush();
        nodes.push({ type: "latexInlineCommand", attrs: { name, argument, raw } });
      } else {
        return null;
      }
      index = close + 1;
      continue;
    }
    if (char === "~") {
      plain += "\u00a0";
      index++;
      continue;
    }
    const whitespace = /^\s+/u.exec(source.slice(index));
    if (whitespace) {
      plain += " ";
      index += whitespace[0].length;
      continue;
    }
    if (source.startsWith("---", index)) {
      plain += "—";
      index += 3;
      continue;
    }
    if (source.startsWith("--", index)) {
      plain += "–";
      index += 2;
      continue;
    }
    plain += char;
    index++;
  }
  flush();
  return nodes;
}

function sourceId(index: number): string {
  return `latex-block-${index}`;
}

function withSourceId(node: JSONContent, id: string): JSONContent {
  return { ...node, attrs: { ...node.attrs, sourceId: id } };
}

function parseHeading(source: string): JSONContent | null {
  const match = /^\\(chapter|section|subsection|subsubsection|paragraph|subparagraph)(\*)?\{/u.exec(
    source,
  );
  if (!match) return null;
  const opening = match[0].length - 1;
  const close = closingBrace(source, opening);
  if (close === null) return null;
  const tail = source.slice(close + 1).trim();
  const label = /^\\label\{([^{}\\%\s]+)\}$/u.exec(tail);
  if (tail && !label) return null;
  const content = parseInline(source.slice(opening + 1, close));
  if (content === null) return null;
  const level = LATEX_HEADING_STYLES.find((style) => style.command === match[1])!.level;
  return {
    type: "heading",
    attrs: {
      level,
      latexCommand: match[1],
      unnumbered: match[2] === "*",
      referenceLabel: label?.[1] ?? null,
    },
    content,
  };
}

function parseList(source: string, depth: number): JSONContent | null {
  if (depth > 32) return null;
  const opening = /^\\begin\{(itemize|enumerate)\}(\[resume\])?\s*/u.exec(source);
  if (!opening) return null;
  const environment = opening[1]!;
  if (opening[2] && environment !== "enumerate") return null;
  const closing = `\\end{${environment}}`;
  const close = source.lastIndexOf(closing);
  if (close < opening[0].length || source.slice(close + closing.length).trim() !== "") return null;
  const body = source.slice(opening[0].length, close);
  const matches: { index: number; length: number }[] = [];
  for (let cursor = 0; cursor < body.length; cursor++) {
    if (body[cursor] === "%") return null;
    if (body[cursor] === "{") {
      const close = closingBrace(body, cursor);
      if (close === null) return null;
      cursor = close;
    } else if (body.startsWith("\\begin{", cursor)) {
      const close = matchingEnvironmentEnd(body, cursor);
      if (close === null) return null;
      cursor = close - 1;
    } else if (body[cursor] === "\\") {
      const item = /^\\item(?![a-zA-Z])\s*/u.exec(body.slice(cursor));
      if (item) {
        if (body[cursor + item[0].length] === "[") return null;
        matches.push({ index: cursor, length: item[0].length });
        cursor += item[0].length - 1;
      } else cursor++;
    }
  }
  if (matches.length === 0) return null;
  if (body.slice(0, matches[0]!.index).trim()) return null;
  const items: JSONContent[] = [];
  for (let index = 0; index < matches.length; index++) {
    const start = matches[index]!.index + matches[index]!.length;
    const end = index + 1 < matches.length ? matches[index + 1]!.index! : body.length;
    const item = body.slice(start, end).trim();
    const projected = projectLatexVisualDocument(item, depth + 1);
    if (projected.rawBlocks > 0 || projected.blocks[0]?.node.type !== "paragraph") return null;
    items.push({ type: "listItem", content: projected.content.content ?? [] });
  }
  return {
    type: environment === "itemize" ? "bulletList" : "orderedList",
    ...(opening[2] ? { attrs: { resume: true } } : {}),
    content: items,
  };
}

export interface LatexVisualMathAttributes {
  readonly tex: string;
  readonly environment?: string | null;
  readonly wrapper?: "paren" | "dollar" | "bracket" | "double-dollar";
}

export function latexVisualMathSource(
  attributes: LatexVisualMathAttributes,
  display: boolean,
): string {
  const tex = attributes.tex;
  if (display && attributes.environment)
    return `\\begin{${attributes.environment}}\n${tex}\n\\end{${attributes.environment}}`;
  if (display && attributes.wrapper === "double-dollar") return `$$\n${tex}\n$$`;
  if (display) return `\\[\n${tex}\n\\]`;
  if (attributes.wrapper === "dollar") return `$${tex}$`;
  return `\\(${tex}\\)`;
}

export function parseLatexVisualMathSource(
  source: string,
  display: boolean,
): LatexVisualMathAttributes | null {
  const trimmed = source.trim();
  // MathLive owns mathematical input, not TeX numbering or state-changing
  // commands. Never let a math edit silently drop those semantics.
  if (/\\(?:label|tag|notag|nonumber|newcommand|renewcommand|def|catcode)\b/u.test(trimmed))
    return null;
  if (!display) {
    if (trimmed.startsWith("\\(") && trimmed.endsWith("\\)"))
      return { tex: trimmed.slice(2, -2), wrapper: "paren" };
    if (
      trimmed.startsWith("$") &&
      !trimmed.startsWith("$$") &&
      trimmed.endsWith("$") &&
      !trimmed.endsWith("$$")
    )
      return { tex: trimmed.slice(1, -1), wrapper: "dollar" };
    return null;
  }
  if (trimmed.startsWith("\\[") && trimmed.endsWith("\\]")) {
    return { tex: trimmed.slice(2, -2).trim(), wrapper: "bracket" };
  }
  if (trimmed.startsWith("$$") && trimmed.endsWith("$$") && trimmed.length >= 4) {
    return { tex: trimmed.slice(2, -2).trim(), wrapper: "double-dollar" };
  }
  const environment = /^\\begin\{([^}]+)\}([\s\S]*)\\end\{\1\}$/u.exec(trimmed);
  if (!environment || !DISPLAY_MATH_ENVIRONMENTS.test(environment[1]!)) return null;
  return {
    tex: environment[2]!.trim(),
    environment: environment[1]!,
  };
}

function parseDisplayMath(source: string): JSONContent | null {
  const attributes = parseLatexVisualMathSource(source, true);
  return attributes === null ? null : { type: "latexDisplayMath", attrs: attributes };
}

export function parseStructuredMathEnvironment(source: string): string | null {
  const trimmed = source.trim();
  const environment = /^\\begin\{([^}]+)\}([\s\S]*)\\end\{\1\}$/u.exec(trimmed);
  if (!environment || !STRUCTURED_MATH_ENVIRONMENT.test(environment[1]!)) return null;
  if (/\\(?:label|tag|newcommand|renewcommand|def|catcode)\b/u.test(trimmed)) return null;
  return trimmed;
}

function matchingEnvironmentEnd(source: string, from: number, depth = 0): number | null {
  if (depth > 64) return null;
  const opening = /^\\begin\{([^}]+)\}/u.exec(source.slice(from));
  if (!opening) return null;
  const name = opening[1]!;
  const closing = `\\end{${name}}`;
  if (["verbatim", "verbatim*", "lstlisting", "minted"].includes(name)) {
    for (let cursor = from + opening[0].length; cursor < source.length;) {
      const newline = source.indexOf("\n", cursor);
      if (newline < 0) return null;
      const lineStart = newline + 1;
      const next = source.indexOf("\n", lineStart);
      const line = source.slice(lineStart, next < 0 ? source.length : next);
      if (line.trim() === closing) return lineStart + line.indexOf(closing) + closing.length;
      cursor = lineStart;
    }
    return null;
  }
  for (let cursor = from + opening[0].length; cursor < source.length; cursor++) {
    if (source[cursor] === "%") {
      const newline = source.indexOf("\n", cursor);
      if (newline < 0) return null;
      cursor = newline;
    } else if (source.startsWith(closing, cursor)) return cursor + closing.length;
    else if (source.startsWith("\\begin{", cursor)) {
      const end = matchingEnvironmentEnd(source, cursor, depth + 1);
      if (end === null) return null;
      cursor = end - 1;
    } else if (source[cursor] === "\\") cursor++;
  }
  return null;
}

function findDelimiter(source: string, delimiter: string, from: number): number {
  for (let index = from; index < source.length; index++) {
    if (source[index] === "%") {
      const end = source.indexOf("\n", index);
      if (end < 0) return -1;
      index = end;
      continue;
    }
    if (source.startsWith(delimiter, index)) return index;
    if (source[index] === "\\") index++;
  }
  return -1;
}

function nextBlockEnd(body: string, from: number): number {
  if (body[from] === "%") {
    const end = body.indexOf("\n", from);
    return end < 0 ? body.length : end;
  }
  if (body.startsWith("\\begin{", from)) return matchingEnvironmentEnd(body, from) ?? body.length;
  if (body.startsWith("\\[", from)) {
    const close = findDelimiter(body, "\\]", from + 2);
    return close < 0 ? body.length : close + 2;
  }
  if (body.startsWith("$$", from)) {
    const close = findDelimiter(body, "$$", from + 2);
    return close < 0 ? body.length : close + 2;
  }
  const standalone = /^\\(?:maketitle|tableofcontents|newpage|clearpage)\b/u.exec(body.slice(from));
  if (standalone) return from + standalone[0].length;
  if (
    /^\\(?:part|chapter|section|subsection|subsubsection|paragraph|subparagraph)\*?\{/u.test(
      body.slice(from),
    )
  ) {
    const opening = body.indexOf("{", from);
    const close = closingBrace(body, opening);
    if (close === null) return body.length;
    const label = /^\s*\\label\{[^{}\\%\s]+\}/u.exec(body.slice(close + 1));
    return close + 1 + (label?.[0].length ?? 0);
  }
  let depth = 0;
  for (let index = from; index < body.length; index++) {
    if (body[index] === "%") {
      const end = body.indexOf("\n", index);
      if (end < 0) return body.length;
      index = end - 1;
      continue;
    }
    if (depth === 0 && index > from) {
      if (body.startsWith("\\end{document}", index)) return index;
      if (/^\r?\n[\t ]*\r?\n/u.test(body.slice(index))) return index;
      if (
        /^\\(?:begin\{|\[|(?:part|chapter|section|subsection|subsubsection|paragraph|subparagraph)\*?\{)/u.test(
          body.slice(index),
        )
      )
        return index;
    }
    if (body[index] === "\\") index++;
    else if (body[index] === "{") depth++;
    else if (body[index] === "}") depth--;
  }
  return body.length;
}

function previewText(source: string): string {
  let value = source.replace(/%[^\r\n]*/gu, " ");
  for (let pass = 0; pass < 8; pass++) {
    const previous = value;
    value = value
      .replace(/\\href\{[^{}]*\}\{([^{}]*)\}/gu, "$1")
      .replace(
        /\\(?:textbf|textit|emph|texttt|textsc|underline|mbox|url|footnote)\{([^{}]*)\}/gu,
        "$1",
      );
    if (value === previous) break;
  }
  return value
    .replace(/\$\$|\\\[|\\\]|\\\(|\\\)|\$/gu, "")
    .replace(/\\(?:toprule|midrule|bottomrule|hline|centering|small|footnotesize)\b/gu, " ")
    .replace(/\\(?:cite\w*|ref|eqref|autoref|pageref|label)\{([^{}]*)\}/gu, "$1")
    .replace(/\\([%&_#${}])/gu, "$1")
    .replace(/~/gu, " ")
    .replace(/\\\\/gu, " ")
    .replace(/\\[A-Za-z]+\*?/gu, " ")
    .replace(/[{}]/gu, "")
    .replace(/\s+/gu, " ")
    .trim();
}

function parseDescriptionPreview(source: string): JSONContent | null {
  const opening = /^\\begin\{description\}(?:\[([^\]]*)\])?/u.exec(source);
  const ending = source.lastIndexOf("\\end{description}");
  if (!opening || ending < opening[0].length) return null;
  const bodyFrom = opening[0].length;
  const body = source.slice(bodyFrom, ending);
  const item = /\\item\s*\[([^\]]*)\]/gu;
  const matches = [...body.matchAll(item)];
  if (matches.length === 0 || matches.length > 100) return null;
  let editable = true;
  const originalItems = matches.map((match, index) => {
    const itemFrom = match.index!;
    const itemTo = index + 1 < matches.length ? matches[index + 1]!.index! : body.length;
    const raw = body.slice(itemFrom, itemTo);
    const labelStart = match[0].indexOf("[") + 1;
    const label = editableTableCell(match[1]!, labelStart);
    const bodyStart = match[0].length;
    const itemBody = editableTableCell(raw.slice(bodyStart), bodyStart);
    if (!label || !itemBody) editable = false;
    return {
      id: `description-${index}`,
      raw,
      label: label?.display ?? previewText(match[1]!),
      body: itemBody?.display ?? previewText(raw.slice(bodyStart)),
      labelFrom: label?.from ?? 0,
      labelTo: label?.to ?? 0,
      bodyFrom: itemBody?.from ?? 0,
      bodyTo: itemBody?.to ?? 0,
    };
  });
  const items = originalItems.map(({ label, body: itemBody }) => ({
    label,
    body: itemBody,
  }));
  return {
    type: "latexRichPreview",
    attrs: {
      kind: "description",
      raw: source,
      items,
      itemIds: originalItems.map((entry) => entry.id),
      caption: null,
      rows: null,
      descriptionStyle: /(?:^|,)\s*style\s*=\s*nextline(?:\s*,|$)/u.test(opening[1] ?? "")
        ? "nextline"
        : "standard",
      descriptionLeftMargin:
        /(?:^|,)\s*leftmargin\s*=\s*((?:\d+(?:\.\d*)?|\.\d+)\s*(?:in|cm|mm|pt|em))(?:\s*,|$)/u
          .exec(opening[1] ?? "")?.[1]
          ?.replace(/\s+/gu, "") ?? null,
      editable,
      sourceMeta: {
        head: source.slice(0, bodyFrom + matches[0]!.index!),
        tail: source.slice(ending),
        originalItems,
      },
    },
  };
}

function currentDateLabel(): string {
  return new Intl.DateTimeFormat("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
  }).format(new Date());
}

// Read metadata from earlier candidates without writing new private comments.
const HIDDEN_AUTHOR_COMMENT = /^% scient-hidden-author: (.*)(?:\r?\n|$)/mu;

function hiddenAuthor(source: string): string {
  const begin = findDelimiter(source, "\\begin{document}", 0);
  const match = HIDDEN_AUTHOR_COMMENT.exec(begin < 0 ? source : source.slice(0, begin));
  if (!match) return "";
  try {
    const value: unknown = JSON.parse(match[1]!);
    return typeof value === "string" ? value : "";
  } catch {
    return "";
  }
}

/** Decode editable metadata without treating escaped percent signs as comments. */
export function metadataText(value: string): string | null {
  const nodes = parseInline(value);
  if (
    !nodes ||
    nodes.some((node) => (node.type !== "text" && node.type !== "hardBreak") || node.marks?.length)
  )
    return null;
  return nodes.map((node) => (node.type === "hardBreak" ? "\n" : (node.text ?? ""))).join("");
}

export function titleMetadata(source: string) {
  const begin = findDelimiter(source, "\\begin{document}", 0);
  const preamble = begin < 0 ? source : source.slice(0, begin);
  const title = commandArgument(preamble, "title");
  const author = commandArgument(preamble, "author");
  const date = commandArgument(preamble, "date");
  const dateMode =
    date === null
      ? "default"
      : date.trim() === "\\today"
        ? "today"
        : date.trim() === ""
          ? "hidden"
          : "explicit";
  return {
    title: title === null ? "" : (metadataText(title) ?? previewText(title)),
    author:
      author === null || !author.trim()
        ? hiddenAuthor(preamble)
        : (metadataText(author) ?? previewText(author)),
    authorEnabled: author !== null && author.trim() !== "",
    date:
      dateMode === "default" || dateMode === "today"
        ? currentDateLabel()
        : (metadataText(date ?? "") ?? previewText(date ?? "")),
    dateEnabled: dateMode !== "hidden",
    dateMode,
    sourceMeta: {
      titleEditable: title === null || metadataText(title) !== null,
      authorEditable: author === null || metadataText(author) !== null,
      dateEditable: dateMode !== "explicit" || metadataText(date ?? "") !== null,
    },
  };
}

/** Restore the printed title without replacing existing document metadata. */
export function ensureLatexTitleBlock(source: string, defaultTitle: string): string | null {
  const begin = /\\begin\s*\{document\}/u.exec(source);
  if (!begin) return null;
  if (/\\maketitle\b/u.test(source.slice(begin.index + begin[0].length))) return source;
  const eol = source.includes("\r\n") ? "\r\n" : "\n";
  let changed = source;
  if (commandArgument(source.slice(0, begin.index), "title") === null)
    changed =
      setPreambleCommandArgument(changed, "title", escapeText(defaultTitle), eol) ?? changed;
  for (const command of ["author", "date"]) {
    if (commandArgument(source.slice(0, begin.index), command) === null)
      changed = setPreambleCommandArgument(changed, command, "", eol) ?? changed;
  }
  const insertion = /\\begin\s*\{document\}/u.exec(changed)!;
  const at = insertion.index + insertion[0].length;
  return changed.slice(0, at) + eol + "\\maketitle" + eol + changed.slice(at);
}

function parseDocumentFrontMatter(source: string, documentSource: string): JSONContent | null {
  if (source.trim() === "\\maketitle") {
    return {
      type: "latexRichPreview",
      attrs: {
        kind: "title",
        raw: source,
        ...titleMetadata(documentSource),
        editable: true,
      },
    };
  }
  if (source.trim() === "\\tableofcontents") {
    return {
      type: "latexRichPreview",
      attrs: { kind: "toc", raw: source, editable: true },
    };
  }
  if (/^\\(?:newpage|clearpage)$/u.test(source.trim())) {
    return {
      type: "latexRichPreview",
      attrs: { kind: "pagebreak", raw: source, editable: true },
    };
  }
  const opening = /^\\begin\{abstract\}/u.exec(source);
  const ending = source.lastIndexOf("\\end{abstract}");
  if (!opening || ending < opening[0].length) return null;
  const body = editableTableCell(source.slice(opening[0].length, ending), opening[0].length);
  return {
    type: "latexRichPreview",
    attrs: {
      kind: "abstract",
      raw: source,
      body: body?.display ?? previewText(source.slice(opening[0].length, ending)),
      editable: body !== null,
    },
  };
}

const SIMPLE_LAYOUT_ENVIRONMENTS = new Set([
  "quotation",
  "verse",
  "verbatim",
  "verbatim*",
  "alltt",
  "lstlisting",
  "flushleft",
  "flushright",
]);

function parseSimpleLayout(source: string): JSONContent | null {
  const opening = /^\\begin\{([^}]+)\}/u.exec(source);
  const environment = opening?.[1] ?? "";
  if (!opening || !SIMPLE_LAYOUT_ENVIRONMENTS.has(environment)) return null;
  const closing = `\\end{${environment}}`;
  if (!source.endsWith(closing)) return null;
  const interior = source
    .slice(opening[0].length, -closing.length)
    .replace(/^\r?\n/u, "")
    .replace(/\r?\n$/u, "");
  const code = ["verbatim", "verbatim*", "alltt", "lstlisting"].includes(environment);
  const inline = code
    ? null
    : parseInline(
        interior
          .trim()
          .replace(/\\par\b/gu, "\n\n")
          .replace(/\\\\\s*\r?\n/gu, "\n"),
      );
  const editable =
    code ||
    (inline !== null && inline.every((node) => node.type === "text" || node.type === "hardBreak"));
  const body = code
    ? interior
    : editable
      ? inline!.map((node) => (node.type === "hardBreak" ? "\n" : (node.text ?? ""))).join("")
      : previewText(interior);
  return {
    type: "latexRichPreview",
    attrs: { kind: "simple", environment, body, raw: source, editable },
  };
}

function parsePartPreview(source: string): JSONContent | null {
  const opening = /^\\part(\*)?\{/u.exec(source);
  if (!opening) return null;
  const close = closingBrace(source, opening[0].length - 1);
  if (close === null) return null;
  const label = /^\s*\\label\{([^{}\\%\s]+)\}$/u.exec(source.slice(close + 1).trim());
  if (source.slice(close + 1).trim() && !label) return null;
  const inline = parseInline(source.slice(opening[0].length, close));
  const editable = inline !== null && inline.every((node) => node.type === "text");
  return {
    type: "latexRichPreview",
    attrs: {
      kind: "part",
      title: editable ? inline!.map((node) => node.text ?? "").join("") : previewText(source),
      unnumbered: Boolean(opening[1]),
      label: label?.[1] ?? "",
      raw: source,
      editable,
    },
  };
}

export function latexRomanNumber(value: number): string {
  let remaining = value;
  let result = "";
  for (const [amount, numeral] of [
    [1000, "M"],
    [900, "CM"],
    [500, "D"],
    [400, "CD"],
    [100, "C"],
    [90, "XC"],
    [50, "L"],
    [40, "XL"],
    [10, "X"],
    [9, "IX"],
    [5, "V"],
    [4, "IV"],
    [1, "I"],
  ] as const) {
    while (remaining >= amount) {
      result += numeral;
      remaining -= amount;
    }
  }
  return result;
}

function parseBibliographyPreview(source: string): JSONContent | null {
  const opening = /^\\begin\{thebibliography\}\{([^{}]*)\}/u.exec(source);
  const closing = "\\end{thebibliography}";
  if (!opening || !source.endsWith(closing)) return null;
  const body = source.slice(opening[0].length, -closing.length);
  if (/%/u.test(body)) return null;
  const matches = [...body.matchAll(/\\bibitem\{([^{}\\\s]+)\}/gu)];
  if (matches.length === 0 || matches.length > 100) return null;
  let editable = !body.slice(0, matches[0]!.index).trim();
  const items = matches.map((match, index) => {
    const end = matches[index + 1]?.index ?? body.length;
    const raw = body.slice(match.index! + match[0].length, end).trim();
    const inline = parseInline(raw);
    if (!inline || inline.some((node) => node.type !== "text" && node.type !== "hardBreak"))
      editable = false;
    return {
      label: match[1]!,
      body: inline
        ? inline.map((node) => (node.type === "hardBreak" ? "\n" : (node.text ?? ""))).join("")
        : previewText(raw),
    };
  });
  return {
    type: "latexRichPreview",
    attrs: {
      kind: "bibliography",
      raw: source,
      items,
      widestLabel: opening[1],
      editable,
    },
  };
}

function commandArgument(source: string, command: string): string | null {
  const match = new RegExp(`\\\\${command}\\s*\\{`, "u").exec(source);
  if (!match) return null;
  const opening = match.index + match[0].lastIndexOf("{");
  const close = closingBrace(source, opening);
  return close === null ? null : source.slice(opening + 1, close);
}

function commandArgumentRange(
  source: string,
  command: string,
): { source: string; from: number; to: number } | null {
  const match = new RegExp(`\\\\${command}\\s*\\{`, "u").exec(source);
  if (!match) return null;
  const opening = match.index + match[0].lastIndexOf("{");
  const close = closingBrace(source, opening);
  return close === null
    ? null
    : { source: source.slice(opening + 1, close), from: opening + 1, to: close };
}

interface TabularBody {
  readonly source: string;
  readonly from: number;
  readonly to: number;
  readonly environment: string;
  readonly openingFrom: number;
  readonly openingTo: number;
  readonly endingFrom: number;
  readonly endingTo: number;
  readonly columnSpec: string;
}

function requiredArgument(
  source: string,
  cursor: number,
): { source: string; from: number; to: number; next: number } | null {
  while (/\s/u.test(source[cursor] ?? "")) cursor++;
  if (source[cursor] !== "{") return null;
  const close = closingBrace(source, cursor);
  return close === null
    ? null
    : { source: source.slice(cursor + 1, close), from: cursor + 1, to: close, next: close + 1 };
}

function tabularBody(source: string): TabularBody | null {
  const opening = /\\begin\{(tabularx|tabular|tabulary|longtable)\}/u.exec(source);
  if (!opening) return null;
  const name = opening[1]!;
  let cursor = opening.index + opening[0].length;
  if (name === "tabularx" || name === "tabulary") {
    const width = requiredArgument(source, cursor);
    if (!width) return null;
    cursor = width.next;
  }
  const columnSpec = requiredArgument(source, cursor);
  if (!columnSpec) return null;
  cursor = columnSpec.next;
  const ending = `\\end{${name}}`;
  const end = source.lastIndexOf(ending);
  return end <= cursor
    ? null
    : {
        source: source.slice(cursor, end),
        from: cursor,
        to: end,
        environment: name,
        openingFrom: opening.index,
        openingTo: cursor,
        endingFrom: end,
        endingTo: end + ending.length,
        columnSpec: columnSpec.source,
      };
}

type TableAlignment = "left" | "center" | "right";
const TABLE_PARAGRAPH_COLUMNS = new Set(["X", "p", "m", "b"]);
const TABLE_MODIFIER_ALIGNMENTS: readonly (readonly [string, TableAlignment])[] = [
  ["\\centering", "center"],
  ["\\raggedleft", "right"],
  ["\\raggedright", "left"],
];

function tableAlignments(columnSpec: string, width: number): TableAlignment[] {
  const alignments: TableAlignment[] = [];
  let pendingAlignment: TableAlignment | null = null;
  let depth = 0;
  for (let index = 0; index < columnSpec.length && alignments.length < width; index++) {
    const character = columnSpec[index]!;
    if (depth === 0 && character === ">" && columnSpec[index + 1] === "{") {
      const close = closingBrace(columnSpec, index + 1);
      if (close !== null) {
        const modifier = columnSpec.slice(index + 2, close);
        pendingAlignment =
          TABLE_MODIFIER_ALIGNMENTS.find(([command]) => modifier.indexOf(command) >= 0)?.[1] ??
          null;
        index = close;
      }
    } else if (character === "{") depth++;
    else if (character === "}") depth = Math.max(0, depth - 1);
    else if (character === "\\") index++;
    else if (depth === 0 && character === "l") {
      alignments.push(pendingAlignment ?? "left");
      pendingAlignment = null;
    } else if (depth === 0 && character === "c") {
      alignments.push(pendingAlignment ?? "center");
      pendingAlignment = null;
    } else if (depth === 0 && character === "r") {
      alignments.push(pendingAlignment ?? "right");
      pendingAlignment = null;
    } else if (depth === 0 && TABLE_PARAGRAPH_COLUMNS.has(character)) {
      alignments.push(pendingAlignment ?? "left");
      pendingAlignment = null;
    }
  }
  return Array.from({ length: width }, (_, index) => alignments[index] ?? "left");
}

/** Read presentation from the preserved table source; never serialize it as edits. */
export function latexVisualTablePresentation(source: string) {
  const body = tabularBody(source);
  const prefix = body ? source.slice(0, body.openingFrom) : "";
  const size =
    [...prefix.matchAll(/\\(tiny|scriptsize|footnotesize|small|normalsize)\b/gu)].at(-1)?.[1] ??
    "normalsize";
  const columnWidths: (number | null)[] = [];
  const spec = body?.columnSpec ?? "";
  for (let index = 0; index < spec.length; index++) {
    const character = spec[index]!;
    // Skip modifier groups so the letters of \\raggedright are not columns.
    if (character === "{") {
      const close = closingBrace(spec, index);
      if (close === null) break;
      index = close;
    } else if (character === "\\") index++;
    else if ("pmb".includes(character)) {
      const argument = requiredArgument(spec, index + 1);
      columnWidths.push(argument ? latexLengthInches(argument.source) : null);
      if (argument) index = argument.next - 1;
    } else if ("lcrX".includes(character)) columnWidths.push(null);
  }
  return {
    size,
    columnWidths,
    trimLeft: /^\s*@\{\}/u.test(spec),
    trimRight: /@\{\}\s*$/u.test(spec),
  };
}

interface TableSourceSlice {
  readonly source: string;
  readonly from: number;
  readonly to: number;
}

interface EditableTableCell {
  readonly display: string;
  readonly from: number;
  readonly to: number;
}

function splitTable(source: string, delimiter: "row" | "cell"): TableSourceSlice[] {
  const values: TableSourceSlice[] = [];
  let from = 0;
  let depth = 0;
  for (let index = 0; index < source.length; index++) {
    if (source[index] === "%") {
      const newline = source.indexOf("\n", index);
      if (newline < 0) break;
      index = newline;
      continue;
    }
    if (source[index] === "{") depth++;
    else if (source[index] === "}") depth = Math.max(0, depth - 1);
    else if (depth === 0 && delimiter === "cell" && source[index] === "&") {
      values.push({ source: source.slice(from, index), from, to: index });
      from = index + 1;
    } else if (
      depth === 0 &&
      delimiter === "row" &&
      source[index] === "\\" &&
      source[index + 1] === "\\"
    ) {
      values.push({ source: source.slice(from, index), from, to: index });
      index++;
      from = index + 1;
    } else if (source[index] === "\\") index++;
  }
  values.push({ source: source.slice(from), from, to: source.length });
  return values;
}

const TABLE_CELL_WRAPPER = /^(?:\\(?:textbf|textit|emph|texttt|textsc|underline|mbox))\s*\{/u;
const TABLE_RULE_PREFIX = /^(?:\\(?:toprule|midrule|bottomrule|hline)\b\s*)+/u;
const TABLE_RULE_SUFFIX = /(?:\s*\\(?:toprule|midrule|bottomrule|hline)\b)+\s*$/u;

function trimSourceRange(source: string, from: number, to: number): [number, number] {
  while (from < to && /\s/u.test(source[from]!)) from++;
  while (to > from && /\s/u.test(source[to - 1]!)) to--;
  return [from, to];
}

function editableTableCell(source: string, offset: number): EditableTableCell | null {
  let [from, to] = trimSourceRange(source, 0, source.length);
  // Retain whitespace after a rule when the first cell is empty. Trimming the
  // right edge before consuming it puts the insertion point inside the TeX
  // control word: typing "a" would turn \hline into \hlinea.
  const prefix = TABLE_RULE_PREFIX.exec(source.slice(from));
  if (prefix) {
    const start = from + prefix[0].length;
    [from, to] = trimSourceRange(source, start, Math.max(start, to));
  }
  const suffix = TABLE_RULE_SUFFIX.exec(source.slice(from, to));
  if (suffix) [from, to] = trimSourceRange(source, from, from + suffix.index);

  for (let depth = 0; depth < 8; depth++) {
    const wrapper = TABLE_CELL_WRAPPER.exec(source.slice(from, to));
    if (!wrapper) break;
    const opening = from + wrapper[0].lastIndexOf("{");
    const close = closingBrace(source, opening);
    if (close === null || close !== to - 1) return null;
    [from, to] = trimSourceRange(source, opening + 1, close);
  }

  const core = source.slice(from, to);
  const display = metadataText(core);
  if (display === null || display.includes("\n")) return null;
  return {
    display: display.replace(/\s+/gu, " ").trim(),
    from: offset + from,
    to: offset + to,
  };
}

function parseTablePreview(source: string): JSONContent | null {
  if (!/\\begin\{(?:table\*?|tabularx|tabular|tabulary|longtable)\}/u.test(source)) return null;
  const body = tabularBody(source);
  if (body === null || body.source.length > 100_000) return null;
  const parsedRows = splitTable(body.source, "row")
    .map((row) => {
      const cells = splitTable(row.source, "cell");
      const editableCells = cells.map((cell) =>
        editableTableCell(cell.source, body.from + row.from + cell.from),
      );
      return {
        rows: cells.map((cell, index) => editableCells[index]?.display ?? previewText(cell.source)),
        sources: cells.map((cell) => {
          const clean = cell.source
            .trim()
            .replace(TABLE_RULE_PREFIX, "")
            .replace(TABLE_RULE_SUFFIX, "")
            .trim();
          const core = editableTableCell(clean, 0);
          return core ? { raw: clean, ...core } : null;
        }),
        ranges: editableCells.map((cell) =>
          cell ? { from: cell.from, to: cell.to, original: cell.display } : null,
        ),
        end: body.from + row.to + (row.to < body.source.length ? 2 : 0),
        terminated: row.to < body.source.length,
      };
    })
    .filter((row) => row.terminated || row.rows.some(Boolean));
  const rows = parsedRows.slice(0, 100).map((row) => row.rows);
  const width = Math.max(0, ...rows.map((row) => row.length));
  if (rows.length === 0 || width === 0 || width > 20) return null;
  const editable =
    parsedRows.length <= 100 &&
    rows.every((row) => row.length === width) &&
    parsedRows.every((row) => row.ranges.every((cell) => cell !== null));
  const captionArgument = commandArgumentRange(source, "caption");
  const captionCell = captionArgument
    ? editableTableCell(captionArgument.source, captionArgument.from)
    : null;
  const labelArgument = commandArgumentRange(source, "label");
  const labelCell =
    labelArgument && safeLatexLabel(labelArgument.source) !== null
      ? { display: labelArgument.source, from: labelArgument.from, to: labelArgument.to }
      : null;
  const hasFloat = /\\begin\{table\*?\}/u.test(source);
  const tableStyle = /\\(?:toprule|midrule|bottomrule)\b/u.test(body.source)
    ? "booktabs"
    : /\\hline\b/u.test(body.source) || body.columnSpec.includes("|")
      ? "grid"
      : "plain";
  const tableKind =
    body.environment === "tabularx" || body.environment === "tabulary"
      ? "stretch"
      : body.environment === "longtable"
        ? "long"
        : "fixed";
  return {
    type: "latexRichPreview",
    attrs: {
      kind: "table",
      raw: source,
      caption: captionCell?.display ?? previewText(commandArgument(source, "caption") ?? ""),
      label: labelCell?.display ?? previewText(commandArgument(source, "label") ?? ""),
      rows,
      cellRanges: editable ? parsedRows.map((row) => row.ranges) : null,
      rowIds: rows.map((_, index) => `table-row-${index}`),
      columnIds: Array.from({ length: width }, (_, index) => `table-column-${index}`),
      columnAlignments: tableAlignments(body.columnSpec, width),
      tableStyle,
      tableKind,
      hasHeader:
        rows.length > 0 &&
        (/\\midrule\b/u.test(body.source) ||
          splitTable(body.source, "row")[0]?.source.includes("\\textbf") === true),
      tableCanonical: false,
      sourceMeta: editable
        ? {
            originalCells: parsedRows.map((row) => row.sources),
            originalHasHeader:
              /\\midrule\b/u.test(body.source) ||
              splitTable(body.source, "row")[0]?.source.includes("\\textbf") === true,
            captionRange: captionCell
              ? { from: captionCell.from, to: captionCell.to, original: captionCell.display }
              : null,
            insertAt: parsedRows.at(-1)!.end,
            originalRowCount: rows.length,
            bodyFrom: body.from,
            bodyTo: body.to,
            openingFrom: body.openingFrom,
            openingTo: body.openingTo,
            endingFrom: body.endingFrom,
            endingTo: body.endingTo,
            hasFloat,
            outerInsertAt: body.openingFrom,
            labelRange: labelCell
              ? { from: labelCell.from, to: labelCell.to, original: labelCell.display }
              : null,
          }
        : null,
      editable,
      items: null,
    },
  };
}

const SCIENTIFIC_ENVIRONMENTS = new Set([
  "theorem",
  "lemma",
  "proposition",
  "corollary",
  "claim",
  "definition",
  "example",
  "remark",
  "remarks",
  "proof",
]);

interface OptionalArgumentRange {
  readonly source: string;
  readonly from: number;
  readonly to: number;
  readonly end: number;
}

function optionalArgumentRange(source: string, cursor: number): OptionalArgumentRange | null {
  while (/\s/u.test(source[cursor] ?? "")) cursor++;
  if (source[cursor] !== "[") return null;
  const close = source.indexOf("]", cursor + 1);
  if (close < 0 || source.slice(cursor + 1, close).includes("[")) return null;
  return { source: source.slice(cursor + 1, close), from: cursor + 1, to: close, end: close + 1 };
}

function commandFullRange(
  source: string,
  command: string,
): { source: string; from: number; to: number; argument: OptionalArgumentRange } | null {
  const match = new RegExp(`\\\\${command}\\s*\\{`, "u").exec(source);
  if (!match) return null;
  const opening = match.index + match[0].lastIndexOf("{");
  const close = closingBrace(source, opening);
  if (close === null) return null;
  return {
    source: source.slice(match.index, close + 1),
    from: match.index,
    to: close + 1,
    argument: {
      source: source.slice(opening + 1, close),
      from: opening + 1,
      to: close,
      end: close + 1,
    },
  };
}

function parseScientificEnvironment(source: string): JSONContent | null {
  const opening = /^\\begin\{([A-Za-z*]+)\}/u.exec(source);
  const environment = opening?.[1] ?? "";
  if (!opening || !SCIENTIFIC_ENVIRONMENTS.has(environment)) return null;
  const titleRange = optionalArgumentRange(source, opening[0].length);
  const openingTo = titleRange?.end ?? opening[0].length;
  const endingSource = `\\end{${environment}}`;
  const endingFrom = source.lastIndexOf(endingSource);
  if (endingFrom < openingTo) return null;
  const interior = source.slice(openingTo, endingFrom);
  const labelCommand = commandFullRange(interior, "label");
  const bodySource = labelCommand
    ? interior.slice(0, labelCommand.from) +
      " ".repeat(labelCommand.to - labelCommand.from) +
      interior.slice(labelCommand.to)
    : interior;
  const body = editableTableCell(bodySource, openingTo);
  const title = titleRange ? editableTableCell(titleRange.source, titleRange.from) : null;
  const label = labelCommand
    ? editableTableCell(labelCommand.argument.source, openingTo + labelCommand.argument.from)
    : null;
  const editable =
    body !== null &&
    (titleRange === null || title !== null) &&
    (labelCommand === null || label !== null) &&
    !/\\[A-Za-z]+/u.test(
      bodySource.replace(/\\(?:textbackslash|textasciitilde|textasciicircum)\{\}/gu, ""),
    );
  return {
    type: "latexRichPreview",
    attrs: {
      kind: "scientific",
      raw: source,
      environment,
      title: title?.display ?? previewText(titleRange?.source ?? ""),
      body: body?.display ?? previewText(bodySource),
      label: label?.display ?? previewText(labelCommand?.argument.source ?? ""),
      editable,
      sourceMeta: editable
        ? {
            originalEnvironment: environment,
            openingTo,
            endingFrom,
            titleRange: title ? { from: title.from, to: title.to, original: title.display } : null,
            bodyRange: body ? { from: body.from, to: body.to, original: body.display } : null,
            labelCommandRange: labelCommand
              ? {
                  from: openingTo + labelCommand.from,
                  to: openingTo + labelCommand.to,
                  argumentFrom: openingTo + labelCommand.argument.from,
                  argumentTo: openingTo + labelCommand.argument.to,
                  original: label?.display ?? "",
                }
              : null,
          }
        : null,
    },
  };
}

function graphicsWidth(options: string): string {
  return (
    options
      .split(",")
      .map((option) => option.trim())
      .find((option) => option.startsWith("width="))
      ?.slice("width=".length) ?? ""
  );
}

function parseFigurePreview(source: string): JSONContent | null {
  const opening = /^\\begin\{(figure\*?)\}(?:\[([^\]]*)\])?/u.exec(source);
  if (!opening) return null;
  const environment = opening[1]!;
  const endingSource = `\\end{${environment}}`;
  const endingFrom = source.lastIndexOf(endingSource);
  if (endingFrom < opening[0].length) return null;
  const include = /\\includegraphics(?:\[([^\]]*)\])?\s*\{/u.exec(source);
  if (!include || source.slice(include.index + include[0].length).includes("\\includegraphics"))
    return null;
  const pathOpening = include.index + include[0].lastIndexOf("{");
  const pathClose = closingBrace(source, pathOpening);
  if (pathClose === null || pathClose > endingFrom) return null;
  const path = editableTableCell(source.slice(pathOpening + 1, pathClose), pathOpening + 1);
  const captionRange = commandArgumentRange(source, "caption");
  const labelRange = commandArgumentRange(source, "label");
  const caption = captionRange ? editableTableCell(captionRange.source, captionRange.from) : null;
  const label = labelRange ? editableTableCell(labelRange.source, labelRange.from) : null;
  const options = include[1] ?? "";
  const captionCommand = commandFullRange(source, "caption");
  const labelCommand = commandFullRange(source, "label");
  const known = [
    { from: 0, to: opening[0].length },
    { from: include.index, to: pathClose + 1 },
    ...(captionCommand ? [{ from: captionCommand.from, to: captionCommand.to }] : []),
    ...(labelCommand ? [{ from: labelCommand.from, to: labelCommand.to }] : []),
    { from: endingFrom, to: endingFrom + endingSource.length },
  ].sort((left, right) => right.from - left.from);
  let residual = source;
  for (const range of known) residual = residual.slice(0, range.from) + residual.slice(range.to);
  residual = residual.replace(/\\(?:centering|raggedleft|raggedright)\b/gu, "").trim();
  const editable =
    path !== null &&
    (captionRange === null || caption !== null) &&
    (labelRange === null || label !== null) &&
    residual === "";
  const alignment = /\\raggedleft\b/u.test(source)
    ? "right"
    : /\\raggedright\b/u.test(source)
      ? "left"
      : "center";
  return {
    type: "latexRichPreview",
    attrs: {
      kind: "figure",
      raw: source,
      path: path?.display ?? previewText(source.slice(pathOpening + 1, pathClose)),
      caption: caption?.display ?? previewText(captionRange?.source ?? ""),
      label: label?.display ?? previewText(labelRange?.source ?? ""),
      figureWidth: graphicsWidth(options),
      figureOptions: options,
      figurePlacement: opening[2] ?? "",
      figureAlignment: alignment,
      figureStarred: environment.endsWith("*"),
      editable,
      sourceMeta: editable
        ? {
            pathRange: { from: path!.from, to: path!.to, original: path!.display },
            captionRange: caption
              ? { from: caption.from, to: caption.to, original: caption.display }
              : null,
            labelRange: label ? { from: label.from, to: label.to, original: label.display } : null,
            includeFrom: include.index,
            includeTo: pathClose + 1,
            outerInsertAt: include.index,
            originalOptions: options,
            originalPlacement: opening[2] ?? "",
            openingFrom: 0,
            openingTo: opening[0].length,
          }
        : null,
    },
  };
}

export function latexVisualScientificSource(environment: string): string | null {
  if (!SCIENTIFIC_ENVIRONMENTS.has(environment)) return null;
  return `\\begin{${environment}}\n\n\\end{${environment}}`;
}

export function latexVisualFigureSource(): string {
  return [
    "\\begin{figure}[htbp]",
    "\\centering",
    "\\includegraphics[width=0.8\\textwidth]{figures/image.png}",
    "\\caption{Figure caption}",
    "\\label{fig:image}",
    "\\end{figure}",
  ].join("\n");
}

function parseRichPreview(source: string, documentSource: string): JSONContent | null {
  return (
    parseDocumentFrontMatter(source, documentSource) ??
    parsePartPreview(source) ??
    parseSimpleLayout(source) ??
    parseBibliographyPreview(source) ??
    parseDescriptionPreview(source) ??
    parseTablePreview(source) ??
    parseFigurePreview(source) ??
    parseScientificEnvironment(source)
  );
}

function classifyBlock(source: string, depth: number): JSONContent | null {
  if (source.trim() === "\\par") return { type: "paragraph", content: [] };
  return (
    parseHeading(source) ??
    parseList(source, depth) ??
    (() => {
      if (depth > 32 || !source.startsWith("\\begin{quote}") || !source.endsWith("\\end{quote}"))
        return null;
      const inner = projectLatexVisualDocument(source.slice(13, -11), depth + 1);
      return inner.rawBlocks === 0
        ? { type: "blockquote", content: inner.content.content ?? [] }
        : null;
    })() ??
    parseDisplayMath(source) ??
    (() => {
      const content = parseInline(source.trim());
      return content === null ? null : { type: "paragraph", content };
    })()
  );
}

export function projectLatexVisualDocument(source: string, depth = 0): LatexVisualDocument {
  const beginMarker = "\\begin{document}";
  const endMarker = "\\end{document}";
  const begin = findDelimiter(source, beginMarker, 0);
  const bodyFrom = begin < 0 ? 0 : begin + beginMarker.length;
  const body = source.slice(bodyFrom);
  const blocks: LatexVisualSourceBlock[] = [];
  let dynamicSyntax = /\\catcode\b/u.test(source.slice(0, bodyFrom));
  let cursor = 0;
  while (cursor < body.length) {
    const whitespace = /^\s+/u.exec(body.slice(cursor));
    if (whitespace) cursor += whitespace[0].length;
    if (cursor >= body.length) break;
    if (body.startsWith(endMarker, cursor)) break;
    const relativeEnd = nextBlockEnd(body, cursor);
    const rawEnd = Math.max(cursor + 1, relativeEnd);
    const raw = body.slice(cursor, rawEnd).replace(/[\r\n]+$/u, "");
    const from = bodyFrom + cursor;
    const to = from + raw.length;
    const id = sourceId(blocks.length);
    dynamicSyntax ||=
      /\\(?:catcode|def|gdef|edef|xdef|let|newcommand|renewcommand|newenvironment|renewenvironment)\b/u.test(
        raw,
      );
    const classified = dynamicSyntax ? null : classifyBlock(raw, depth);
    const preview = classified === null && !dynamicSyntax ? parseRichPreview(raw, source) : null;
    const node = withSourceId(
      classified ?? preview ?? { type: "latexRawBlock", attrs: { raw, label: "Raw LaTeX" } },
      id,
    );
    blocks.push({
      id,
      from,
      to,
      node,
      source: raw,
      editable: classified !== null || preview?.attrs?.editable === true,
    });
    cursor = rawEnd;
  }
  let section = 0;
  let subsection = 0;
  let subsubsection = 0;
  let chapter = 0;
  let part = 0;
  const chapters =
    /\\documentclass(?:\[[^\]]*\])?\{(?:book|report|memoir|scrbook|scrreprt)\}/u.test(source);
  const tocEntries = blocks.flatMap((block) => {
    if (block.node.type === "latexRichPreview" && block.node.attrs?.kind === "part") {
      if (block.node.attrs.unnumbered === true) return [];
      part += 1;
      return [
        { level: 0, number: latexRomanNumber(part), title: String(block.node.attrs.title ?? "") },
      ];
    }
    if (block.node.type !== "heading" || block.node.attrs?.unnumbered === true) return [];
    const level = Number(block.node.attrs?.level ?? 1);
    // The standard classes omit run-in headings from the contents by default.
    if (level === 4 || level === 5) return [];
    if (level === 6) {
      chapter += 1;
      section = 0;
      subsection = 0;
      subsubsection = 0;
    } else if (level === 1) {
      section += 1;
      subsection = 0;
      subsubsection = 0;
    } else if (level === 2) {
      subsection += 1;
      subsubsection = 0;
    } else subsubsection += 1;
    const localNumber =
      level === 1
        ? `${section}`
        : level === 2
          ? `${section}.${subsection}`
          : `${section}.${subsection}.${subsubsection}`;
    const number = level === 6 ? String(chapter) : (chapters ? `${chapter}.` : "") + localNumber;
    const title = (block.node.content ?? [])
      .map((child) =>
        child.type === "text"
          ? (child.text ?? "")
          : child.type === "latexInlineMath"
            ? String(child.attrs?.tex ?? "")
            : String(child.attrs?.argument ?? ""),
      )
      .join("");
    return [{ level: level === 6 ? 0 : level, number, title }];
  });
  for (const [index, block] of blocks.entries()) {
    if (block.node.type !== "latexRichPreview" || block.node.attrs?.kind !== "toc") continue;
    blocks[index] = {
      ...block,
      node: { ...block.node, attrs: { ...block.node.attrs, tocEntries } },
    };
  }
  if (blocks.length === 0) {
    const id = sourceId(0);
    blocks.push({
      id,
      from: bodyFrom,
      to: bodyFrom,
      source: "",
      editable: true,
      node: { type: "paragraph", attrs: { sourceId: id }, content: [] },
    });
  }
  return {
    source,
    content: { type: "doc", content: blocks.map((block) => block.node) },
    blocks,
    supportedBlocks: blocks.filter((block) => block.editable).length,
    rawBlocks: blocks.filter((block) => !block.editable).length,
  };
}

export function escapeText(text: string): string {
  const escapes: Readonly<Record<string, string>> = {
    "\\": "\\textbackslash{}",
    "%": "\\%",
    "&": "\\&",
    _: "\\_",
    "#": "\\#",
    $: "\\$",
    "{": "\\{",
    "}": "\\}",
    "~": "\\textasciitilde{}",
    "^": "\\textasciicircum{}",
    "\u00a0": "~",
  };
  return text.replace(/[\\%&_#${}~^\u00a0]/gu, (character) => escapes[character]!);
}

function serializeInline(nodes: readonly JSONContent[] | undefined): string {
  return (nodes ?? [])
    .map((node) => {
      if (node.type === "latexInlineMath")
        return latexVisualMathSource(
          {
            tex: String(node.attrs?.tex ?? ""),
            wrapper: node.attrs?.wrapper === "dollar" ? "dollar" : "paren",
          },
          false,
        );
      if (node.type === "latexInlineCommand") return String(node.attrs?.raw ?? "");
      if (node.type === "hardBreak") return "\\\\\n";
      if (node.type !== "text") return "";
      let value = escapeText(node.text ?? "");
      for (const mark of (node.marks ?? []).toReversed()) {
        if (mark.type === "bold") value = `\\textbf{${value}}`;
        else if (mark.type === "italic") value = `\\emph{${value}}`;
        else if (mark.type === "code") value = `\\texttt{${value}}`;
      }
      return value;
    })
    .join("");
}

function canonicalTableColumnSpec(
  alignments: readonly TableAlignment[],
  kind: string,
  style: string,
): string {
  const columns = alignments.map((alignment) => {
    if (kind !== "stretch") return alignment === "center" ? "c" : alignment === "right" ? "r" : "l";
    if (alignment === "center") return ">{\\centering\\arraybackslash}X";
    if (alignment === "right") return ">{\\raggedleft\\arraybackslash}X";
    return ">{\\raggedright\\arraybackslash}X";
  });
  return style === "grid" ? `|${columns.join("|")}|` : columns.join(" ");
}

function canonicalTableBody(
  rows: readonly (readonly string[])[],
  style: string,
  hasHeader: boolean,
  eol: string,
  sourceCells?: readonly (readonly string[])[],
): string {
  const serializedRows = rows.map((row, rowIndex) => {
    const cells = row.map((cell, columnIndex) => {
      if (sourceCells) return sourceCells[rowIndex]![columnIndex]!;
      const value = escapeText(cell);
      return hasHeader && rowIndex === 0 ? `\\textbf{${value}}` : value;
    });
    return `${cells.join(" & ")} \\\\`;
  });
  if (style === "booktabs") {
    const lines = ["\\toprule"];
    serializedRows.forEach((row, index) => {
      lines.push(row);
      if (hasHeader && index === 0) lines.push("\\midrule");
    });
    lines.push("\\bottomrule");
    return `${eol}${lines.join(eol)}${eol}`;
  }
  if (style === "grid") {
    const lines = ["\\hline"];
    for (const row of serializedRows) lines.push(row, "\\hline");
    return `${eol}${lines.join(eol)}${eol}`;
  }
  return `${eol}${serializedRows.join(eol)}${eol}`;
}

export type LatexVisualTablePreset = "plain" | "booktabs" | "grid" | "stretch";

export function latexVisualTableSource(
  rowCount: number,
  columnCount: number,
  preset: LatexVisualTablePreset,
): string {
  const safeRows = Math.max(1, Math.min(20, Math.trunc(rowCount)));
  const safeColumns = Math.max(1, Math.min(12, Math.trunc(columnCount)));
  const rows = Array.from({ length: safeRows }, (_, rowIndex) =>
    Array.from({ length: safeColumns }, (_, columnIndex) =>
      rowIndex === 0 ? `Column ${columnIndex + 1}` : "",
    ),
  );
  const kind = preset === "stretch" ? "stretch" : "fixed";
  const style = preset === "stretch" ? "booktabs" : preset;
  const alignments = Array.from({ length: safeColumns }, () => "left" as const);
  const columnSpec = canonicalTableColumnSpec(alignments, kind, style);
  const environment = kind === "stretch" ? "tabularx" : "tabular";
  const opening =
    kind === "stretch"
      ? `\\begin{${environment}}{\\textwidth}{${columnSpec}}`
      : `\\begin{${environment}}{${columnSpec}}`;
  return [
    "\\begin{table}[htbp]",
    "\\centering",
    "\\caption{Table title}",
    opening,
    canonicalTableBody(rows, style, true, "\n").trim(),
    `\\end{${environment}}`,
    "\\end{table}",
  ].join("\n");
}

function preservedTableCells(node: JSONContent, rows: string[][]): string[][] {
  const originals = node.attrs?.sourceMeta?.originalCells;
  return rows.map((row, rowIndex) =>
    row.map((text, columnIndex) => {
      const rowId = /^table-row-(\d+)$/u.exec(String(node.attrs?.rowIds?.[rowIndex]));
      const columnId = /^table-column-(\d+)$/u.exec(String(node.attrs?.columnIds?.[columnIndex]));
      const cell = rowId && columnId ? originals?.[Number(rowId[1])]?.[Number(columnId[1])] : null;
      if (
        !cell ||
        typeof cell.raw !== "string" ||
        typeof cell.from !== "number" ||
        typeof cell.to !== "number"
      ) {
        const value = escapeText(text);
        return node.attrs?.hasHeader && rowIndex === 0 ? `\\textbf{${value}}` : value;
      }
      let value =
        text === cell.display
          ? cell.raw
          : cell.raw.slice(0, cell.from) + escapeText(text) + cell.raw.slice(cell.to);
      if (
        rowIndex === 0 &&
        (node.attrs?.hasHeader !== node.attrs?.sourceMeta?.originalHasHeader ||
          (node.attrs?.hasHeader && rowId?.[1] !== "0"))
      ) {
        if (node.attrs?.hasHeader) value = `\\textbf{${value}}`;
        else if (/^\\textbf\{[\s\S]*\}$/u.test(value)) value = value.slice(8, -1);
      }
      return value;
    }),
  );
}

function tableRows(value: unknown): string[][] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const rows = value.map((row) => (Array.isArray(row) ? row : null));
  const width = rows[0]?.length ?? 0;
  if (
    width === 0 ||
    rows.some(
      (row) => row === null || row.length !== width || row.some((cell) => typeof cell !== "string"),
    )
  )
    return null;
  return rows as string[][];
}

function safeLatexArgument(value: unknown): string | null {
  if (typeof value !== "string" || /[{}%\r\n]/u.test(value)) return null;
  return value.trim();
}

function safeLatexLabel(value: unknown): string | null {
  const argument = safeLatexArgument(value);
  return argument !== null && !/[\s\\]/u.test(argument) ? argument : null;
}

function safeGraphicsWidth(value: unknown): string | null {
  const argument = safeLatexArgument(value);
  return argument !== null &&
    argument.indexOf(",") < 0 &&
    argument.indexOf("[") < 0 &&
    argument.indexOf("]") < 0
    ? argument
    : null;
}

function figureOptionsWithWidth(options: string, width: string): string {
  const retained = options
    .split(",")
    .map((option) => option.trim())
    .filter((option) => option && !option.startsWith("width="));
  if (width) retained.unshift(`width=${width}`);
  return retained.join(",");
}

function serializeScientificPreview(node: JSONContent): string | null {
  const environment = safeLatexArgument(node.attrs?.environment);
  if (!environment || !SCIENTIFIC_ENVIRONMENTS.has(environment)) return null;
  const title = typeof node.attrs?.title === "string" ? node.attrs.title : "";
  const body = typeof node.attrs?.body === "string" ? node.attrs.body : null;
  const label = safeLatexLabel(node.attrs?.label ?? "");
  if (body === null || label === null) return null;
  const eol = String(node.attrs?.raw ?? "").includes("\r\n") ? "\r\n" : "\n";
  return [
    `\\begin{${environment}}${title ? `[${escapeText(title)}]` : ""}`,
    ...(label ? [`\\label{${label}}`] : []),
    escapeText(body),
    `\\end{${environment}}`,
  ].join(eol);
}

function serializeFigurePreview(node: JSONContent): string | null {
  const path = safeLatexArgument(node.attrs?.path);
  const width = safeGraphicsWidth(node.attrs?.figureWidth ?? "");
  const placement = safeLatexArgument(node.attrs?.figurePlacement ?? "");
  const label = safeLatexLabel(node.attrs?.label ?? "");
  const caption = typeof node.attrs?.caption === "string" ? node.attrs.caption : "";
  const originalOptions =
    typeof node.attrs?.figureOptions === "string" ? node.attrs.figureOptions : "";
  if (
    path === null ||
    width === null ||
    placement === null ||
    label === null ||
    !/^[htbpH!]*$/u.test(placement)
  )
    return null;
  const environment = node.attrs?.figureStarred === true ? "figure*" : "figure";
  const alignment =
    node.attrs?.figureAlignment === "left"
      ? "\\raggedright"
      : node.attrs?.figureAlignment === "right"
        ? "\\raggedleft"
        : "\\centering";
  const options = figureOptionsWithWidth(originalOptions, width);
  const eol = String(node.attrs?.raw ?? "").includes("\r\n") ? "\r\n" : "\n";
  return [
    `\\begin{${environment}}${placement ? `[${placement}]` : ""}`,
    alignment,
    `\\includegraphics${options ? `[${options}]` : ""}{${path}}`,
    ...(caption ? [`\\caption{${escapeText(caption)}}`] : []),
    ...(label ? [`\\label{${label}}`] : []),
    `\\end{${environment}}`,
  ].join(eol);
}

export function serializeLatexVisualBlock(node: JSONContent): string | null {
  if (node.type === "paragraph") return serializeInline(node.content) || "\\par";
  if (node.type === "heading") {
    const command =
      LATEX_HEADING_STYLES.find((style) => style.level === node.attrs?.level)?.command ?? "section";
    const star = node.attrs?.unnumbered === true ? "*" : "";
    const label = node.attrs?.referenceLabel;
    if (label && (typeof label !== "string" || /[{}\\%\s#$&~^]/u.test(label))) return null;
    return `\\${command}${star}{${serializeInline(node.content)}}${label ? `\\label{${label}}` : ""}`;
  }
  if (node.type === "blockquote") {
    const blocks = (node.content ?? []).map(serializeLatexVisualBlock);
    if (blocks.some((block) => block === null)) return null;
    return `\\begin{quote}\n${blocks.join("\n\n")}\n\\end{quote}`;
  }
  if (node.type === "latexDisplayMath") {
    return latexVisualMathSource(
      {
        tex: String(node.attrs?.tex ?? ""),
        environment: node.attrs?.environment ? String(node.attrs.environment) : null,
        wrapper: node.attrs?.wrapper === "double-dollar" ? "double-dollar" : "bracket",
      },
      true,
    );
  }
  if (node.type === "latexRawBlock") return String(node.attrs?.raw ?? "");
  if (node.type === "latexRichPreview") {
    const raw = String(node.attrs?.raw ?? "");
    if (node.attrs?.editable !== true) return raw;
    if (["title", "toc", "pagebreak"].includes(String(node.attrs.kind))) return raw;
    if (node.attrs.kind === "part") {
      const title = typeof node.attrs.title === "string" ? node.attrs.title : null;
      const label = safeLatexLabel(node.attrs.label ?? "");
      if (title === null || label === null) return null;
      return `\\part${node.attrs.unnumbered === true ? "*" : ""}{${escapeText(title)}}${label ? `\\label{${label}}` : ""}`;
    }
    if (node.attrs.kind === "simple") {
      const environment = String(node.attrs.environment ?? "");
      const body = typeof node.attrs.body === "string" ? node.attrs.body : null;
      if (!SIMPLE_LAYOUT_ENVIRONMENTS.has(environment) || body === null) return null;
      const code = ["verbatim", "verbatim*", "alltt", "lstlisting"].includes(environment);
      const text = code
        ? body
        : environment === "verse"
          ? body.split("\n").map(escapeText).join(" \\\\\n")
          : escapeText(body);
      return `\\begin{${environment}}\n${text}\n\\end{${environment}}`;
    }
    if (node.attrs.kind === "bibliography") {
      const items = Array.isArray(node.attrs.items) ? node.attrs.items : null;
      const widestLabel = safeLatexArgument(node.attrs.widestLabel ?? "99");
      if (!items || items.length === 0 || widestLabel === null) return null;
      const entries: string[] = [];
      for (const item of items) {
        if (!item || typeof item !== "object" || !("label" in item) || !("body" in item))
          return null;
        const key = safeLatexLabel(item.label);
        if (!key || typeof item.body !== "string") return null;
        entries.push(`\\bibitem{${key}} ${escapeText(item.body)}`);
      }
      return `\\begin{thebibliography}{${widestLabel}}\n${entries.join("\n")}\n\\end{thebibliography}`;
    }
    if (node.attrs.kind === "abstract") {
      if (typeof node.attrs.body !== "string") return null;
      const eol = raw.includes("\r\n") ? "\r\n" : "\n";
      return `\\begin{abstract}${eol}${escapeText(node.attrs.body)}${eol}\\end{abstract}`;
    }
    if (node.attrs.kind === "scientific") return serializeScientificPreview(node);
    if (node.attrs.kind === "figure") return serializeFigurePreview(node);
    if (node.attrs.kind === "description") {
      const items = Array.isArray(node.attrs.items) ? node.attrs.items : null;
      const itemIds = Array.isArray(node.attrs.itemIds) ? node.attrs.itemIds : null;
      const sourceMeta = node.attrs.sourceMeta;
      if (
        !items ||
        !itemIds ||
        items.length === 0 ||
        items.length !== itemIds.length ||
        !sourceMeta ||
        typeof sourceMeta !== "object" ||
        !("head" in sourceMeta) ||
        !("tail" in sourceMeta) ||
        !("originalItems" in sourceMeta) ||
        typeof sourceMeta.head !== "string" ||
        typeof sourceMeta.tail !== "string" ||
        !Array.isArray(sourceMeta.originalItems)
      )
        return null;
      const originals = new Map<string, Record<string, unknown>>();
      for (const candidate of sourceMeta.originalItems as unknown[]) {
        if (
          candidate &&
          typeof candidate === "object" &&
          "id" in candidate &&
          typeof candidate.id === "string"
        )
          originals.set(candidate.id, candidate as Record<string, unknown>);
      }
      const eol = raw.includes("\r\n") ? "\r\n" : "\n";
      const chunks: string[] = [];
      for (const [index, item] of items.entries()) {
        const id = itemIds[index];
        if (
          !item ||
          typeof item !== "object" ||
          !("label" in item) ||
          !("body" in item) ||
          typeof item.label !== "string" ||
          typeof item.body !== "string" ||
          typeof id !== "string"
        )
          return null;
        const original = originals.get(id);
        if (!original) {
          chunks.push(`\\item[${escapeText(item.label)}] ${escapeText(item.body)}${eol}`);
          continue;
        }
        if (
          !("raw" in original) ||
          !("label" in original) ||
          !("body" in original) ||
          !("labelFrom" in original) ||
          !("labelTo" in original) ||
          !("bodyFrom" in original) ||
          !("bodyTo" in original) ||
          typeof original.raw !== "string" ||
          typeof original.label !== "string" ||
          typeof original.body !== "string" ||
          typeof original.labelFrom !== "number" ||
          typeof original.labelTo !== "number" ||
          typeof original.bodyFrom !== "number" ||
          typeof original.bodyTo !== "number"
        )
          return null;
        const replacements = [
          ...(item.label === original.label
            ? []
            : [{ from: original.labelFrom, to: original.labelTo, value: escapeText(item.label) }]),
          ...(item.body === original.body
            ? []
            : [{ from: original.bodyFrom, to: original.bodyTo, value: escapeText(item.body) }]),
        ].sort((left, right) => right.from - left.from);
        let chunk = original.raw;
        for (const replacement of replacements) {
          if (
            replacement.from < 0 ||
            replacement.to < replacement.from ||
            replacement.to > chunk.length
          )
            return null;
          chunk =
            chunk.slice(0, replacement.from) + replacement.value + chunk.slice(replacement.to);
        }
        chunks.push(chunk);
      }
      return sourceMeta.head + chunks.join("") + sourceMeta.tail;
    }
    if (node.attrs.kind !== "table") return raw;
    const rows = tableRows(node.attrs.rows);
    const ranges = Array.isArray(node.attrs.cellRanges) ? node.attrs.cellRanges : null;
    const sourceMeta = node.attrs.sourceMeta;
    if (!rows) return null;
    if (node.attrs.tableCanonical === true) {
      if (
        !sourceMeta ||
        typeof sourceMeta !== "object" ||
        !("bodyFrom" in sourceMeta) ||
        !("bodyTo" in sourceMeta) ||
        !("openingFrom" in sourceMeta) ||
        !("openingTo" in sourceMeta) ||
        !("endingFrom" in sourceMeta) ||
        !("endingTo" in sourceMeta) ||
        !("captionRange" in sourceMeta) ||
        !("labelRange" in sourceMeta) ||
        !("hasFloat" in sourceMeta) ||
        typeof sourceMeta.bodyFrom !== "number" ||
        typeof sourceMeta.bodyTo !== "number" ||
        typeof sourceMeta.openingFrom !== "number" ||
        typeof sourceMeta.openingTo !== "number" ||
        typeof sourceMeta.endingFrom !== "number" ||
        typeof sourceMeta.endingTo !== "number" ||
        typeof sourceMeta.hasFloat !== "boolean"
      )
        return null;
      const style = ["plain", "booktabs", "grid"].includes(String(node.attrs.tableStyle))
        ? String(node.attrs.tableStyle)
        : "plain";
      const kind = ["fixed", "stretch", "long"].includes(String(node.attrs.tableKind))
        ? String(node.attrs.tableKind)
        : "fixed";
      const alignments = Array.isArray(node.attrs.columnAlignments)
        ? node.attrs.columnAlignments.map((alignment) =>
            alignment === "center" || alignment === "right" ? alignment : "left",
          )
        : [];
      if (alignments.length !== rows[0]!.length) return null;
      const eol = raw.includes("\r\n") ? "\r\n" : "\n";
      const environment =
        kind === "stretch" ? "tabularx" : kind === "long" ? "longtable" : "tabular";
      const columnSpec = canonicalTableColumnSpec(alignments, kind, style);
      const caption = typeof node.attrs.caption === "string" ? node.attrs.caption : "";
      const label = safeLatexLabel(node.attrs.label ?? "");
      if (label === null) return null;
      let insertedMetadata = "";
      if (sourceMeta.hasFloat && sourceMeta.captionRange === null && caption)
        insertedMetadata += `\\caption{${escapeText(caption)}}${eol}`;
      if (sourceMeta.hasFloat && sourceMeta.labelRange === null && label)
        insertedMetadata += `\\label{${label}}${eol}`;
      const opening =
        insertedMetadata +
        (kind === "stretch"
          ? `\\begin{${environment}}{\\textwidth}{${columnSpec}}`
          : `\\begin{${environment}}{${columnSpec}}`);
      const replacements: { from: number; to: number; value: string }[] = [
        { from: sourceMeta.openingFrom, to: sourceMeta.openingTo, value: opening },
        {
          from: sourceMeta.bodyFrom,
          to: sourceMeta.bodyTo,
          value: canonicalTableBody(
            rows,
            style,
            node.attrs.hasHeader === true,
            eol,
            preservedTableCells(node, rows),
          ),
        },
        {
          from: sourceMeta.endingFrom,
          to: sourceMeta.endingTo,
          value: `\\end{${environment}}`,
        },
      ];
      for (const [rangeName, value] of [
        ["captionRange", caption],
        ["labelRange", label],
      ] as const) {
        const range = sourceMeta[rangeName];
        if (range === null) continue;
        if (
          !range ||
          typeof range !== "object" ||
          !("from" in range) ||
          !("to" in range) ||
          typeof range.from !== "number" ||
          typeof range.to !== "number"
        )
          return null;
        replacements.push({
          from: range.from,
          to: range.to,
          value: rangeName === "labelRange" ? value : escapeText(value),
        });
      }
      replacements.sort((left, right) => right.from - left.from);
      let serialized = raw;
      for (const replacement of replacements) {
        if (
          replacement.from < 0 ||
          replacement.to < replacement.from ||
          replacement.to > raw.length
        )
          return null;
        serialized =
          serialized.slice(0, replacement.from) +
          replacement.value +
          serialized.slice(replacement.to);
      }
      return serialized;
    }
    if (
      !ranges ||
      rows.length < ranges.length ||
      !sourceMeta ||
      typeof sourceMeta !== "object" ||
      !("originalRowCount" in sourceMeta) ||
      !("insertAt" in sourceMeta) ||
      !("captionRange" in sourceMeta) ||
      typeof sourceMeta.originalRowCount !== "number" ||
      typeof sourceMeta.insertAt !== "number" ||
      sourceMeta.originalRowCount !== ranges.length ||
      sourceMeta.insertAt < 0 ||
      sourceMeta.insertAt > raw.length
    )
      return null;
    const replacements: { from: number; to: number; value: string }[] = [];
    for (const [rowIndex, row] of rows.slice(0, ranges.length).entries()) {
      const rowRanges = ranges[rowIndex];
      if (!Array.isArray(row) || !Array.isArray(rowRanges) || row.length !== rowRanges.length)
        return null;
      for (const [cellIndex, value] of row.entries()) {
        const range = rowRanges[cellIndex];
        if (
          !range ||
          typeof range !== "object" ||
          !("from" in range) ||
          !("to" in range) ||
          !("original" in range) ||
          typeof range.from !== "number" ||
          typeof range.to !== "number" ||
          typeof range.original !== "string" ||
          range.from < 0 ||
          range.to < range.from ||
          range.to > raw.length ||
          typeof value !== "string"
        )
          return null;
        if (value === range.original) continue;
        const escaped = escapeText(value);
        const needsRuleSeparator =
          range.from === range.to &&
          /\\(?:toprule|midrule|bottomrule|hline)$/u.test(raw.slice(0, range.from));
        replacements.push({
          from: range.from,
          to: range.to,
          value: needsRuleSeparator && escaped ? ` ${escaped}` : escaped,
        });
      }
    }
    const caption = node.attrs.caption;
    const captionRange = sourceMeta.captionRange;
    if (captionRange !== null) {
      if (
        !captionRange ||
        typeof captionRange !== "object" ||
        !("from" in captionRange) ||
        !("to" in captionRange) ||
        !("original" in captionRange) ||
        typeof captionRange.from !== "number" ||
        typeof captionRange.to !== "number" ||
        typeof captionRange.original !== "string" ||
        typeof caption !== "string" ||
        captionRange.from < 0 ||
        captionRange.to < captionRange.from ||
        captionRange.to > raw.length
      )
        return null;
      if (caption !== captionRange.original)
        replacements.push({
          from: captionRange.from,
          to: captionRange.to,
          value: escapeText(caption),
        });
    }
    const label = safeLatexLabel(node.attrs.label ?? "");
    if (label === null) return null;
    const labelRange = "labelRange" in sourceMeta ? sourceMeta.labelRange : null;
    if (labelRange !== null) {
      if (
        !labelRange ||
        typeof labelRange !== "object" ||
        !("from" in labelRange) ||
        !("to" in labelRange) ||
        !("original" in labelRange) ||
        typeof labelRange.from !== "number" ||
        typeof labelRange.to !== "number" ||
        typeof labelRange.original !== "string" ||
        typeof label !== "string" ||
        labelRange.from < 0 ||
        labelRange.to < labelRange.from ||
        labelRange.to > raw.length
      )
        return null;
      if (label !== labelRange.original)
        replacements.push({
          from: labelRange.from,
          to: labelRange.to,
          value: label,
        });
    }
    const width = Array.isArray(rows[0]) ? rows[0].length : 0;
    const addedRows = rows.slice(ranges.length);
    if (width === 0) return null;
    if (addedRows.length > 0) {
      const eol = raw.includes("\r\n") ? "\r\n" : "\n";
      const lines: string[] = [];
      for (const row of addedRows) {
        if (
          !Array.isArray(row) ||
          row.length !== width ||
          row.some((cell) => typeof cell !== "string")
        )
          return null;
        lines.push(`${row.map((cell) => escapeText(cell)).join(" & ")} \\\\`);
      }
      replacements.push({
        from: sourceMeta.insertAt,
        to: sourceMeta.insertAt,
        value: `${eol}${lines.join(eol)}`,
      });
    }
    replacements.sort((left, right) => right.from - left.from);
    let serialized = raw;
    for (const replacement of replacements)
      serialized =
        serialized.slice(0, replacement.from) +
        replacement.value +
        serialized.slice(replacement.to);
    return serialized;
  }
  if (node.type === "bulletList" || node.type === "orderedList") {
    const environment = node.type === "bulletList" ? "itemize" : "enumerate";
    const items = (node.content ?? []).map((item) => {
      const children = (item.content ?? []).map(serializeLatexVisualBlock);
      if (children.some((child) => child === null)) return null;
      return `\\item ${children.join("\n\n")}`;
    });
    if (items.some((item) => item === null)) return null;
    const options = environment === "enumerate" && node.attrs?.resume === true ? "[resume]" : "";
    return `\\begin{${environment}}${options}\n${items.join("\n")}\n\\end{${environment}}`;
  }
  return null;
}

interface ComparableVisualNode {
  readonly type?: string;
  readonly text?: string;
  readonly attrs?: Readonly<Record<string, unknown>>;
  readonly marks?: readonly ComparableVisualNode[];
  readonly content?: readonly ComparableVisualNode[];
}

function comparableNode(node: JSONContent): ComparableVisualNode {
  const attrs = Object.fromEntries(
    Object.entries(node.attrs ?? {})
      .filter(([key, value]) => {
        if (
          key === "sourceId" ||
          key === "latexCommand" ||
          (node.type === "latexRichPreview" &&
            (key === "raw" ||
              key === "cellRanges" ||
              key === "editable" ||
              key === "sourceMeta" ||
              key === "tocEntries" ||
              key === "itemIds" ||
              key === "rowIds" ||
              key === "columnIds" ||
              key === "tableCanonical" ||
              (node.attrs?.kind === "figure" && key === "figureOptions") ||
              (node.attrs?.kind !== "figure" &&
                (key === "path" ||
                  key === "figureWidth" ||
                  key === "figureOptions" ||
                  key === "figurePlacement" ||
                  key === "figureAlignment" ||
                  key === "figureStarred")) ||
              (!["scientific", "simple"].includes(String(node.attrs?.kind)) &&
                key === "environment") ||
              (!["scientific", "title", "part"].includes(String(node.attrs?.kind)) &&
                key === "title") ||
              (!["scientific", "abstract", "simple"].includes(String(node.attrs?.kind)) &&
                key === "body") ||
              (node.attrs?.kind !== "bibliography" && key === "widestLabel") ||
              (node.attrs?.kind !== "title" &&
                ["author", "authorEnabled", "date", "dateEnabled", "dateMode"].includes(key)) ||
              (node.attrs?.kind !== "description" &&
                ["descriptionStyle", "descriptionLeftMargin"].includes(key)) ||
              (node.attrs?.kind !== "table" &&
                (key === "columnAlignments" ||
                  key === "tableStyle" ||
                  key === "tableKind" ||
                  key === "hasHeader")))) ||
          value === null ||
          value === undefined
        )
          return false;
        if ((key === "unnumbered" || key === "resume") && value === false) return false;
        if (key === "referenceLabel" && value === "") return false;
        if (key === "start" && value === 1) return false;
        if (key === "wrapper" && (value === "paren" || value === "bracket")) return false;
        return true;
      })
      .sort(([left], [right]) => left.localeCompare(right)),
  );
  const content: ComparableVisualNode[] = [];
  for (const child of node.content ?? []) {
    const item = comparableNode(child);
    const last = content.at(-1);
    if (
      last?.type === "text" &&
      item.type === "text" &&
      JSON.stringify(last.marks) === JSON.stringify(item.marks)
    ) {
      content[content.length - 1] = { ...last, text: (last.text ?? "") + (item.text ?? "") };
    } else content.push(item);
  }
  const marks =
    node.marks?.map(comparableNode).sort((a, b) => (a.type ?? "").localeCompare(b.type ?? "")) ??
    [];
  return {
    ...(node.type === undefined ? {} : { type: node.type }),
    ...(node.text === undefined ? {} : { text: node.text }),
    ...(Object.keys(attrs).length === 0 ? {} : { attrs }),
    ...(marks.length === 0 ? {} : { marks }),
    ...(content.length === 0 ? {} : { content }),
  };
}

const nodeSignatures = new WeakMap<JSONContent, string>();
export function latexVisualNodeSignature(node: JSONContent): string {
  const cached = nodeSignatures.get(node);
  if (cached !== undefined) return cached;
  const signature = JSON.stringify(comparableNode(node));
  nodeSignatures.set(node, signature);
  return signature;
}

/** TeX collapses ordinary whitespace. Keep the live editor's whitespace in its
 * session projection, while checking structural round trips using TeX semantics. */
const roundTripSignatures = new WeakMap<JSONContent, string>();
function roundTripSignature(node: JSONContent): string {
  const cached = roundTripSignatures.get(node);
  if (cached !== undefined) return cached;
  const prose = (text: string) =>
    text
      .replace(/---/gu, "\u2014")
      .replace(/--/gu, "\u2013")
      .replace(/[\t\r\n ]+/gu, " ");
  const normalize = (value: JSONContent): JSONContent => {
    const children = value.content?.map(normalize);
    if (children) {
      for (const [index, child] of children.entries()) {
        if (child.type !== "text") continue;
        let text = child.text ?? "";
        if (index === 0) text = text.trimStart();
        if (index === children.length - 1) text = text.trimEnd();
        child.text = text;
      }
    }
    return {
      ...value,
      ...(value.type === "latexRichPreview" && value.attrs
        ? {
            attrs: Object.fromEntries(
              Object.entries(value.attrs).map(([key, item]) => [
                key,
                ["title", "author", "date", "caption", "body"].includes(key) &&
                typeof item === "string"
                  ? key === "author" && value.attrs?.authorEnabled === false
                    ? ""
                    : value.attrs?.kind === "simple" &&
                        ["verbatim", "verbatim*", "alltt", "lstlisting"].includes(
                          String(value.attrs.environment),
                        )
                      ? item
                      : prose(item).trim()
                  : item,
              ]),
            ),
          }
        : {}),
      ...(value.type === "latexRichPreview" && value.attrs?.kind === "table"
        ? {
            attrs: {
              ...value.attrs,
              // The live cell keeps exactly what was typed. Compare the
              // reparsed TeX using its whitespace semantics, just like prose.
              ...(Array.isArray(value.attrs.rows)
                ? {
                    rows: value.attrs.rows.map((row: unknown) =>
                      Array.isArray(row)
                        ? row.map((cell: unknown) =>
                            typeof cell === "string" ? prose(cell).trim() : cell,
                          )
                        : row,
                    ),
                  }
                : {}),
              ...(typeof value.attrs.caption === "string"
                ? { caption: prose(value.attrs.caption).trim() }
                : {}),
            },
          }
        : {}),
      ...(value.type === "latexRichPreview" && value.attrs?.kind === "bibliography"
        ? {
            attrs: {
              ...value.attrs,
              items: Array.isArray(value.attrs.items)
                ? value.attrs.items.map((item: unknown) =>
                    item &&
                    typeof item === "object" &&
                    "body" in item &&
                    typeof item.body === "string"
                      ? { ...item, body: prose(item.body).trim() }
                      : item,
                  )
                : value.attrs.items,
            },
          }
        : {}),
      ...(value.text === undefined ? {} : { text: prose(value.text) }),
      ...(children
        ? { content: children.filter((child) => child.type !== "text" || child.text !== "") }
        : {}),
    };
  };
  const signature = latexVisualNodeSignature(normalize(node));
  roundTripSignatures.set(node, signature);
  return signature;
}

export function adoptLatexVisualContent(
  source: string,
  content: JSONContent,
  parsed = projectLatexVisualDocument(source),
): LatexVisualDocument {
  return {
    ...parsed,
    content,
    blocks: parsed.blocks.map((block, index) => ({
      ...block,
      node: content.content?.[index] ?? block.node,
    })),
  };
}

function scientificEnvironments(content: readonly JSONContent[]): Set<string> {
  return new Set(
    content
      .flatMap((node) => [
        ...(node.type === "latexRichPreview" && node.attrs?.kind === "scientific"
          ? [String(node.attrs?.environment ?? "")]
          : []),
        ...scientificEnvironments(node.content ?? []),
      ])
      .filter((environment) => SCIENTIFIC_ENVIRONMENTS.has(environment)),
  );
}

function ensureScientificEnvironmentDeclarations(
  source: string,
  environments: ReadonlySet<string>,
  eol: string,
): string {
  if (environments.size === 0) return source;
  const begin = findDelimiter(source, "\\begin{document}", 0);
  if (begin < 0) return source;
  const preamble = source.slice(0, begin).replace(/(?<!\\)%[^\r\n]*/gu, "");
  const declarations: string[] = [];
  for (const environment of environments) {
    const declared = new RegExp(
      `\\\\(?:newtheorem|newenvironment)\\*?\\s*\\{${environment}\\}`,
      "u",
    ).test(preamble);
    if (
      declared ||
      (environment === "proof" &&
        /\\(?:usepackage|RequirePackage)\s*(?:\[[^\]]*\])?\s*\{[^{}]*\bamsthm\b[^{}]*\}/u.test(
          preamble,
        ))
    )
      continue;
    if (environment === "proof") {
      declarations.push(
        "\\newenvironment{proof}{\\par\\noindent\\textit{Proof.}\\ }{\\hfill\\rule{0.6em}{0.6em}\\par}",
      );
      continue;
    }
    const label = environment[0]!.toUpperCase() + environment.slice(1);
    declarations.push(`\\newtheorem{${environment}}{${label}}`);
  }
  if (declarations.length === 0) return source;
  const boundary = begin > 0 && !/[\r\n]/u.test(source[begin - 1]!) ? eol : "";
  const insertion = [`% Scient visual statement environments`, ...declarations, ""].join(eol);
  return source.slice(0, begin) + boundary + insertion + source.slice(begin);
}

function requiredObjectPackages(nodes: readonly JSONContent[]): Set<string> {
  const packages = new Set<string>();
  for (const node of nodes) {
    if (node.attrs?.kind === "figure") {
      packages.add("graphicx");
      if (String(node.attrs.figurePlacement ?? "").includes("H")) packages.add("float");
    }
    if (node.attrs?.kind === "table") {
      if (node.attrs.tableStyle === "booktabs") packages.add("booktabs");
      if (node.attrs.tableKind === "stretch") packages.add("tabularx");
      if (node.attrs.tableKind === "long") packages.add("longtable");
    }
    if (
      node.attrs?.kind === "description" &&
      (node.attrs.descriptionStyle === "nextline" || node.attrs.descriptionLeftMargin)
    )
      packages.add("enumitem");
    if (node.type === "orderedList" && node.attrs?.resume === true) packages.add("enumitem");
    if (node.attrs?.kind === "simple" && node.attrs.environment === "alltt") packages.add("alltt");
    if (node.attrs?.kind === "simple" && node.attrs.environment === "lstlisting")
      packages.add("listings");
    if (node.type === "latexInlineCommand") {
      if (node.attrs?.name === "eqref") packages.add("amsmath");
      if (node.attrs?.name === "autoref") packages.add("hyperref");
    }
    requiredObjectPackages(node.content ?? []).forEach((name) => packages.add(name));
  }
  return packages;
}

function ensureMathSymbolDefinitions(source: string, nextMath: string, eol: string): string {
  const { preamble, end } = latexPackageInventory(source);
  // wasysym's nointegrals option leaves these variants under private names.
  const definitions = ["varint", "varoint"]
    .filter(
      (name) =>
        new RegExp(`\\\\${name}\\b`, "u").test(nextMath) &&
        !preamble.includes(`\\providecommand{\\${name}}`),
    )
    .map((name) => `\\providecommand{\\${name}}{\\csname wasy@${name.slice(3)}\\endcsname}${eol}`)
    .join("");
  if (!definitions) return source;
  const boundary = end > 0 && !/[\r\n]/u.test(source[end - 1]!) ? eol : "";
  return source.slice(0, end) + boundary + definitions + source.slice(end);
}

function setPreambleCommandArgument(
  source: string,
  command: string,
  value: string,
  eol: string,
): string | null {
  const begin = findDelimiter(source, "\\begin{document}", 0);
  if (begin < 0) return null;
  const range = commandArgumentRange(source.slice(0, begin), command);
  if (range) return source.slice(0, range.from) + value + source.slice(range.to);
  return replaceOrInsertPreambleLine(
    source,
    new RegExp("(?!)", "u"),
    `\\${command}{${value}}`,
    begin,
    eol,
  );
}

function updateTitleMetadata(
  source: string,
  previous: JSONContent,
  node: JSONContent,
): string | null {
  if (
    typeof node.attrs?.title !== "string" ||
    typeof node.attrs?.author !== "string" ||
    typeof node.attrs?.authorEnabled !== "boolean" ||
    typeof node.attrs?.date !== "string" ||
    typeof node.attrs?.dateEnabled !== "boolean" ||
    !["default", "today", "explicit", "hidden"].includes(String(node.attrs?.dateMode))
  )
    return null;
  const eol = source.includes("\r\n") ? "\r\n" : "\n";
  let changed = source;
  const authorSource = node.attrs.author.split(/\r?\n/u).map(escapeText).join(`\\\\${eol}`);
  if (node.attrs.title !== previous.attrs?.title)
    changed =
      setPreambleCommandArgument(
        changed,
        "title",
        node.attrs.title.split(/\r?\n/u).map(escapeText).join(`\\\\${eol}`),
        eol,
      ) ?? changed;
  if (
    node.attrs.authorEnabled !== previous.attrs?.authorEnabled ||
    node.attrs.author !== previous.attrs?.author
  ) {
    const begin = findDelimiter(changed, "\\begin{document}", 0);
    if (begin < 0) return null;
    changed = changed.slice(0, begin).replace(HIDDEN_AUTHOR_COMMENT, "") + changed.slice(begin);
    changed =
      setPreambleCommandArgument(
        changed,
        "author",
        node.attrs.authorEnabled ? authorSource : "",
        eol,
      ) ?? changed;
  }
  if (
    node.attrs.dateMode !== previous.attrs?.dateMode ||
    (node.attrs.dateMode === "explicit" && node.attrs.date !== previous.attrs?.date)
  ) {
    const dateValue =
      node.attrs.dateMode === "hidden"
        ? ""
        : node.attrs.dateMode === "today" || node.attrs.dateMode === "default"
          ? "\\today"
          : escapeText(node.attrs.date);
    changed = setPreambleCommandArgument(changed, "date", dateValue, eol) ?? changed;
  }
  return changed;
}

interface InlineSourceUnit {
  key: string;
  node: JSONContent;
  from: number;
  to: number;
  marks: readonly string[];
}

/** A source map for supported inline content, including TeX whitespace and aliases. */
function inlineSourceUnits(
  source: string,
  offset = 0,
  marks: readonly string[] = [],
): InlineSourceUnit[] | null {
  const units: InlineSourceUnit[] = [];
  for (let at = 0; at < source.length;) {
    const rest = source.slice(at);
    const wrapper = /^\\(textbf|textit|emph|texttt)\{/u.exec(rest);
    if (wrapper) {
      const open = at + wrapper[0].length - 1;
      const close = closingBrace(source, open);
      if (close === null) return null;
      const children = inlineSourceUnits(source.slice(open + 1, close), offset + open + 1, [
        ...marks,
        INLINE_MARKS[wrapper[1]!]!,
      ]);
      if (!children) return null;
      units.push(...children);
      at = close + 1;
      continue;
    }
    let end = at + 1;
    if (rest.startsWith("\\(")) {
      const close = findDelimiter(source, "\\)", at + 2);
      if (close < 0) return null;
      end = close + 2;
    } else if (rest.startsWith("$")) {
      const close = findDelimiter(source, "$", at + 1);
      if (close < 0) return null;
      end = close + 1;
    } else {
      const token =
        /^(?:\\(?:textbackslash|textasciitilde|textasciicircum)\{\}|\\[A-Za-z]+\{|\\\\(?:\r?\n)?|\\.|---|--|[\t\r\n ]+)/u.exec(
          rest,
        );
      if (token) {
        end = at + token[0].length;
        if (token[0].endsWith("{") && !token[0].endsWith("{}")) {
          const close = closingBrace(source, end - 1);
          if (close === null) return null;
          end = close + 1;
        }
      }
    }
    const parsed = parseInline(source.slice(at, end), marks);
    if (!parsed || parsed.length !== 1) return null;
    const node = parsed[0]!;
    units.push({
      key: latexVisualNodeSignature(node),
      node,
      from: offset + at,
      to: offset + end,
      marks,
    });
    at = end;
  }
  return units;
}

function inlineEditorUnits(nodes: readonly JSONContent[]): JSONContent[] {
  return nodes.flatMap((node) =>
    node.type === "text" ? (node.text ?? "").split("").map((text) => ({ ...node, text })) : [node],
  );
}

function minimallyPatchedBlock(block: LatexVisualSourceBlock, next: JSONContent): string | null {
  if (block.node.type !== next.type || !["paragraph", "heading"].includes(next.type ?? ""))
    return null;
  if (
    latexVisualNodeSignature({ ...block.node, content: [] }) !==
    latexVisualNodeSignature({ ...next, content: [] })
  )
    return null;
  const heading =
    next.type === "heading"
      ? /^\\(?:chapter|section|subsection|subsubsection|paragraph|subparagraph)\*?\{/u.exec(
          block.source,
        )
      : null;
  const from = heading?.[0].length ?? 0;
  const to = heading ? closingBrace(block.source, from - 1) : block.source.length;
  if (to === null) return null;
  // Plain prose needs no per-character LaTeX tokenization. Keep the general
  // mapper for commands, marks, nonbreaking spaces and original TeX spelling.
  const plainText = (nodes: readonly JSONContent[] | undefined) =>
    (nodes ?? []).every((node) => node.type === "text" && !node.marks?.length)
      ? (nodes ?? []).map((node) => node.text ?? "").join("")
      : null;
  const before = plainText(block.node.content);
  const after = plainText(next.content);
  if (before !== null && after !== null && block.source.slice(from, to) === escapeText(before))
    return block.source.slice(0, from) + escapeText(after) + block.source.slice(to);
  const oldUnits = inlineSourceUnits(block.source.slice(from, to), from);
  if (!oldUnits) return null;
  const nextUnits = inlineEditorUnits(next.content ?? []);
  const keys = nextUnits.map(latexVisualNodeSignature);
  let prefix = 0;
  while (prefix < oldUnits.length && prefix < keys.length && oldUnits[prefix]!.key === keys[prefix])
    prefix++;
  let suffix = 0;
  while (
    suffix < oldUnits.length - prefix &&
    suffix < keys.length - prefix &&
    oldUnits.at(-1 - suffix)!.key === keys.at(-1 - suffix)
  )
    suffix++;
  const oldEnd = oldUnits.length - suffix;
  const changed = nextUnits.slice(prefix, keys.length - suffix);
  const left = oldUnits[prefix - 1];
  const right = oldUnits[oldEnd];
  const starts = prefix < oldEnd ? [oldUnits[prefix]!.from] : [left?.to ?? from, right?.from ?? to];
  const ends = prefix < oldEnd ? [oldUnits[oldEnd - 1]!.to] : starts;
  const contexts = [oldUnits[prefix]?.marks ?? [], left?.marks ?? [], right?.marks ?? [], []];
  for (const start of starts)
    for (const end of ends)
      for (const context of contexts) {
        if (
          start > end ||
          changed.some((node) =>
            context.some((mark) => !node.marks?.some((item) => item.type === mark)),
          )
        )
          continue;
        const inserted = serializeInline(
          changed.map((node) => ({
            ...node,
            marks: (node.marks ?? []).filter((mark) => !context.includes(mark.type)),
          })),
        );
        const candidate = block.source.slice(0, start) + inserted + block.source.slice(end);
        const reparsed = classifyBlock(candidate, 0);
        if (reparsed && roundTripSignature(reparsed) === roundTripSignature(next)) return candidate;
      }
  return null;
}

export function applyLatexVisualDocumentChange(
  source: string,
  projection: LatexVisualDocument,
  nextContent: JSONContent,
  context?: {
    rootSource?: string | null;
    allowRootUpdates?: boolean;
    onMissingRequirement?: (message: string) => void;
  },
): {
  source: string;
  structural: boolean;
  projection: LatexVisualDocument;
  rootUpdate?: LatexRootUpdate;
  origin?: number;
} | null {
  if (projection.source !== source) return null;
  const previous = projection.blocks;
  const next = nextContent.content ?? [];
  let prefix = 0;
  while (
    prefix < previous.length &&
    prefix < next.length &&
    latexVisualNodeSignature(previous[prefix]!.node) === latexVisualNodeSignature(next[prefix]!)
  )
    prefix++;
  let suffix = 0;
  while (
    suffix < previous.length - prefix &&
    suffix < next.length - prefix &&
    latexVisualNodeSignature(previous[previous.length - 1 - suffix]!.node) ===
      latexVisualNodeSignature(next[next.length - 1 - suffix]!)
  )
    suffix++;
  if (prefix === previous.length && prefix === next.length)
    return { source, structural: false, projection };
  const oldChanged = previous.slice(prefix, previous.length - suffix);
  const newChanged = next.slice(prefix, next.length - suffix);
  if (oldChanged.some((block) => !block.editable)) return null;
  if (
    oldChanged.length === 1 &&
    newChanged.length === 1 &&
    oldChanged[0]?.node.type === "latexRichPreview" &&
    oldChanged[0]?.node.attrs?.kind === "title" &&
    newChanged[0]?.type === "latexRichPreview" &&
    newChanged[0]?.attrs?.kind === "title"
  ) {
    const changedSource = updateTitleMetadata(source, oldChanged[0]!.node, newChanged[0]);
    if (changedSource === null) return null;
    const projected = projectLatexVisualDocument(changedSource);
    if (roundTripSignature(projected.content) !== roundTripSignature(nextContent)) return null;
    return {
      source: changedSource,
      projection: adoptLatexVisualContent(changedSource, nextContent, projected),
      structural: false,
    };
  }
  const eol = source.includes("\r\n") ? "\r\n" : "\n";
  const serialized = newChanged.map((node, index) => {
    const minimal =
      oldChanged.length === newChanged.length && oldChanged[index]
        ? minimallyPatchedBlock(oldChanged[index]!, node)
        : null;
    return minimal ?? serializeLatexVisualBlock(node)?.replace(/\r?\n/gu, eol) ?? null;
  });
  if (serialized.some((value) => value === null)) return null;
  let from = oldChanged[0]?.from ?? previous[prefix]?.from ?? previous.at(-1)?.to ?? source.length;
  let to = oldChanged.at(-1)?.to ?? from;
  const origin = oldChanged[0]?.from ?? previous[prefix - 1]?.from ?? from;
  let replacement = serialized.join(eol + eol);
  // Own only whitespace at the edited boundaries. Otherwise inserting/deleting
  // a block leaves old separators behind and blank lines accumulate over time.
  if (oldChanged.length !== 1 || newChanged.length !== 1) {
    const before = previous[prefix - 1];
    const after = previous[previous.length - suffix];
    if (before && /^\s*$/u.test(source.slice(before.to, from))) from = before.to;
    if (after && /^\s*$/u.test(source.slice(to, after.from))) to = after.from;
    const gap = eol + eol;
    if (replacement) {
      if (before && from === before.to) replacement = gap + replacement;
      if (after && to === after.from) replacement += gap;
    } else if (before && after && from === before.to && to === after.from) replacement = gap;
  }
  let changedSource = source.slice(0, from) + replacement + source.slice(to);
  let rootUpdate: LatexRootUpdate | undefined;
  const previousNodes = oldChanged.map((block) => block.node);
  const ownPreamble = findDelimiter(source, "\\begin{document}", 0) >= 0;
  const root = ownPreamble ? changedSource : context?.rootSource;
  const previousEnvironments = scientificEnvironments(previousNodes);
  const addedEnvironments = new Set(
    [...scientificEnvironments(newChanged)].filter(
      (environment) => !previousEnvironments.has(environment),
    ),
  );
  // Inspect newly introduced source and structures. Existing commands must not
  // make an ordinary text edit depend on resolving the root document.
  const previousSource = oldChanged.map((block) => block.source).join(eol + eol);
  const previousPackages = requiredObjectPackages(previousNodes);
  const requiredPackages = new Set([
    ...[...requiredObjectPackages(newChanged)].filter((name) => !previousPackages.has(name)),
    ...newMathSymbolPackages(previousSource, replacement),
    ...newLatexCommandPackages(previousSource, replacement),
  ]);
  if (addedEnvironments.size || requiredPackages.size) {
    if (!root || findDelimiter(root, "\\begin{document}", 0) < 0) {
      context?.onMissingRequirement?.(
        "Choose the root document before inserting content that needs LaTeX packages or declarations.",
      );
      return null;
    }
    let prepared = ensureLatexPackages(root, requiredPackages, eol);
    prepared = ensureLatexMenuColors(prepared, replacement, eol);
    prepared = ensureMathSymbolDefinitions(prepared, replacement, eol);
    prepared = ensureScientificEnvironmentDeclarations(prepared, addedEnvironments, eol);
    if (!ownPreamble && prepared !== root && !context?.allowRootUpdates) {
      context?.onMissingRequirement?.(
        "This insertion needs packages or declarations in the root document. Add them in the root's Source view, then try again.",
      );
      return null;
    }
    if (!ownPreamble && prepared !== root) rootUpdate = { expected: root, next: prepared };
    if (ownPreamble) changedSource = prepared;
  }
  // Local edits cannot change neighboring syntax. Validate only the replacement
  // block; keep the original source and mappings for all unaffected blocks.
  if (
    oldChanged.length === 1 &&
    newChanged.length === 1 &&
    changedSource === source.slice(0, from) + replacement + source.slice(to) &&
    !["heading", "bulletList", "orderedList"].includes(newChanged[0]!.type ?? "") &&
    !["title", "toc"].includes(String(newChanged[0]!.attrs?.kind))
  ) {
    const parsed = projectLatexVisualDocument(replacement);
    if (
      parsed.blocks.length === 1 &&
      roundTripSignature(parsed.blocks[0]!.node) === roundTripSignature(newChanged[0]!)
    ) {
      const delta = replacement.length - (to - from);
      const blocks = previous.map((block, index) =>
        index === prefix
          ? {
              ...parsed.blocks[0]!,
              id: block.id,
              from,
              to: from + replacement.length,
              source: replacement,
              node: newChanged[0]!,
            }
          : index > prefix
            ? { ...block, from: block.from + delta, to: block.to + delta }
            : block,
      );
      return {
        source: changedSource,
        ...(rootUpdate ? { rootUpdate } : {}),
        origin,
        structural: false,
        projection: {
          ...projection,
          source: changedSource,
          content: nextContent,
          blocks,
          supportedBlocks:
            projection.supportedBlocks -
            Number(oldChanged[0]!.editable) +
            Number(parsed.blocks[0]!.editable),
          rawBlocks:
            projection.rawBlocks +
            Number(oldChanged[0]!.editable) -
            Number(parsed.blocks[0]!.editable),
        },
      };
    }
  }
  // Reject a transaction that the supported projection cannot round-trip.
  const projected = projectLatexVisualDocument(changedSource);
  if (roundTripSignature(projected.content) !== roundTripSignature(nextContent)) {
    const oldBlock = oldChanged[0];
    const newBlock = newChanged[0];
    const nonText = (node: JSONContent): JSONContent => ({
      ...node,
      ...(node.content
        ? { content: node.content.filter((child) => child.type !== "text").map(nonText) }
        : {}),
    });
    const hasMultilineText = (node: JSONContent): boolean =>
      (node.type === "text" && /[\r\n]/u.test(node.text ?? "")) ||
      (node.content?.some(hasMultilineText) ?? false);
    if (
      oldChanged.length !== 1 ||
      newChanged.length !== 1 ||
      !oldBlock?.editable ||
      !newBlock ||
      !["paragraph", "heading", "blockquote", "bulletList", "orderedList"].includes(
        newBlock.type ?? "",
      ) ||
      latexVisualNodeSignature(nonText(oldBlock.node)) !==
        latexVisualNodeSignature(nonText(newBlock)) ||
      hasMultilineText(newBlock) ||
      rootUpdate ||
      changedSource !== source.slice(0, from) + replacement + source.slice(to)
    )
      return null;
    // Text is escaped by serializeInline. Preserve the unchanged inline atoms
    // and source ranges even when the general parser cannot compare this edit.
    const delta = replacement.length - (to - from);
    const blocks = previous.map((block, index) =>
      index === prefix
        ? { ...block, from, to: from + replacement.length, source: replacement, node: newBlock }
        : index > prefix
          ? { ...block, from: block.from + delta, to: block.to + delta }
          : block,
    );
    return {
      source: changedSource,
      origin,
      structural: false,
      projection: { ...projection, source: changedSource, content: nextContent, blocks },
    };
  }
  return {
    source: changedSource,
    ...(rootUpdate ? { rootUpdate } : {}),
    origin,
    projection: adoptLatexVisualContent(changedSource, nextContent, projected),
    structural: oldChanged.length !== 1 || newChanged.length !== 1,
  };
}
