import type { JSONContent } from "@tiptap/core";

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

export interface LatexVisualLayoutProfile {
  readonly documentClass: string;
  readonly paper: "a4" | "letter";
  readonly baseFontPt: 10 | 11 | 12;
  readonly marginTopIn: number;
  readonly marginRightIn: number;
  readonly marginBottomIn: number;
  readonly marginLeftIn: number;
  readonly lineHeight: number;
  readonly paragraphIndentEm: number;
  readonly paragraphGapEm: number;
}

const DEFAULT_LAYOUT_PROFILE: LatexVisualLayoutProfile = {
  documentClass: "article",
  paper: "letter",
  baseFontPt: 10,
  marginTopIn: 1,
  marginRightIn: 1,
  marginBottomIn: 1,
  marginLeftIn: 1,
  lineHeight: 1.45,
  paragraphIndentEm: 1.5,
  paragraphGapEm: 0,
};

function latexLengthInches(value: string): number | null {
  const match = /^\s*(-?(?:\d+(?:\.\d*)?|\.\d+))\s*(in|cm|mm|pt)\s*$/u.exec(value);
  if (!match) return null;
  const amount = Number(match[1]);
  if (!Number.isFinite(amount)) return null;
  const scale =
    match[2] === "in" ? 1 : match[2] === "cm" ? 1 / 2.54 : match[2] === "mm" ? 1 / 25.4 : 1 / 72.27;
  return amount * scale;
}

function latexLengthEm(value: string, baseFontPt: number): number | null {
  const em = /^\s*(-?(?:\d+(?:\.\d*)?|\.\d+))\s*em\s*$/u.exec(value);
  if (em) return Number(em[1]);
  const inches = latexLengthInches(value);
  return inches === null ? null : inches / (baseFontPt / 72.27);
}

export function latexVisualLayoutProfile(source: string): LatexVisualLayoutProfile {
  const preambleEnd = source.indexOf("\\begin{document}");
  const preamble = preambleEnd < 0 ? source : source.slice(0, preambleEnd);
  const documentClass = /\\documentclass(?:\[([^\]]*)\])?\{([^{}]+)\}/u.exec(preamble);
  const classOptions = documentClass?.[1]?.split(",").map((option) => option.trim()) ?? [];
  const baseFontPt = classOptions.includes("12pt") ? 12 : classOptions.includes("11pt") ? 11 : 10;
  const paper = classOptions.includes("a4paper") ? "a4" : "letter";
  const geometry = /\\usepackage\[([^\]]*)\]\{geometry\}/u.exec(preamble)?.[1] ?? "";
  const geometryOptions = new Map(
    geometry
      .split(",")
      .map((option) => option.trim().split("=", 2) as [string, string | undefined])
      .filter((entry): entry is [string, string] => Boolean(entry[0] && entry[1])),
  );
  const allMargin = latexLengthInches(geometryOptions.get("margin") ?? "");
  const margin = (side: string) =>
    latexLengthInches(geometryOptions.get(side) ?? "") ?? allMargin ?? 1;
  const lineSpread = Number(/\\linespread\{([^{}]+)\}/u.exec(preamble)?.[1] ?? "1");
  const parindent = latexLengthEm(
    /\\setlength\{\\parindent\}\{([^{}]+)\}/u.exec(preamble)?.[1] ?? "",
    baseFontPt,
  );
  const parskip = latexLengthEm(
    /\\setlength\{\\parskip\}\{([^{}]+)\}/u.exec(preamble)?.[1] ?? "",
    baseFontPt,
  );
  return {
    ...DEFAULT_LAYOUT_PROFILE,
    documentClass: documentClass?.[2]?.trim() || "article",
    paper,
    baseFontPt,
    marginTopIn: margin("top"),
    marginRightIn: margin("right"),
    marginBottomIn: margin("bottom"),
    marginLeftIn: margin("left"),
    lineHeight: Number.isFinite(lineSpread) && lineSpread > 0 ? 1.45 * lineSpread : 1.45,
    paragraphIndentEm: parindent === null ? 1.5 : parindent,
    paragraphGapEm: parskip === null ? 0 : parskip,
  };
}

export interface LatexVisualLayoutUpdate {
  readonly paper: "a4" | "letter";
  readonly baseFontPt: 10 | 11 | 12;
  readonly margin: string;
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
  update: LatexVisualLayoutUpdate,
): string | null {
  if (!/^(?:\d+(?:\.\d*)?|\.\d+)\s*(?:in|cm|mm|pt)$/u.test(update.margin)) return null;
  const documentClass = /\\documentclass(?:\[([^\]]*)\])?\{([^{}]+)\}/u.exec(source);
  const begin = source.indexOf("\\begin{document}");
  if (!documentClass || begin < 0 || documentClass.index > begin) return null;
  const eol = source.includes("\r\n") ? "\r\n" : "\n";
  const options = (documentClass[1] ?? "")
    .split(",")
    .map((option) => option.trim())
    .filter(Boolean)
    .filter((option) => !/^(?:10|11|12)pt$/u.test(option) && !/^(?:a4|letter)paper$/u.test(option));
  options.unshift(`${update.baseFontPt}pt`, `${update.paper}paper`);
  let changed =
    source.slice(0, documentClass.index) +
    `\\documentclass[${options.join(",")}]{${documentClass[2]}}` +
    source.slice(documentClass.index + documentClass[0].length);
  const changedBegin = changed.indexOf("\\begin{document}");
  const geometryPattern = /\\usepackage\[([^\]]*)\]\{geometry\}/u;
  const geometry = geometryPattern.exec(changed.slice(0, changedBegin));
  if (geometry) {
    const retained = geometry[1]!
      .split(",")
      .map((option) => option.trim())
      .filter((option) => option && !/^(?:margin|top|right|bottom|left)\s*=/u.test(option));
    retained.unshift(`margin=${update.margin.replace(/\s+/gu, "")}`);
    changed = changed.replace(geometryPattern, `\\usepackage[${retained.join(",")}]{geometry}`);
  } else {
    const insertionAt = changed.indexOf("\\begin{document}");
    const boundary = insertionAt > 0 && !/[\r\n]/u.test(changed[insertionAt - 1]!) ? eol : "";
    changed =
      changed.slice(0, insertionAt) +
      boundary +
      `\\usepackage[margin=${update.margin.replace(/\s+/gu, "")}]{geometry}${eol}` +
      changed.slice(insertionAt);
  }
  const paragraphIndent = update.paragraphStyle === "spaced" ? "0pt" : "1.5em";
  const paragraphGap = update.paragraphStyle === "spaced" ? "0.75em" : "0pt";
  let insertionAt = changed.indexOf("\\begin{document}");
  changed = replaceOrInsertPreambleLine(
    changed,
    /\\setlength\{\\parindent\}\{[^{}]+\}/u,
    `\\setlength{\\parindent}{${paragraphIndent}}`,
    insertionAt,
    eol,
  );
  insertionAt = changed.indexOf("\\begin{document}");
  changed = replaceOrInsertPreambleLine(
    changed,
    /\\setlength\{\\parskip\}\{[^{}]+\}/u,
    `\\setlength{\\parskip}{${paragraphGap}}`,
    insertionAt,
    eol,
  );
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
  const match = /^\\(section|subsection|subsubsection)(\*)?\{/u.exec(source);
  if (!match) return null;
  const opening = match[0].length - 1;
  const close = closingBrace(source, opening);
  if (close === null || source.slice(close + 1).trim() !== "") return null;
  const content = parseInline(source.slice(opening + 1, close));
  if (content === null) return null;
  const level = match[1] === "section" ? 1 : match[1] === "subsection" ? 2 : 3;
  return {
    type: "heading",
    attrs: { level, latexCommand: match[1], unnumbered: match[2] === "*" },
    content,
  };
}

function parseList(source: string, depth: number): JSONContent | null {
  if (depth > 32) return null;
  const opening = /^\\begin\{(itemize|enumerate)\}\s*/u.exec(source);
  if (!opening) return null;
  const environment = opening[1]!;
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
  return { type: environment === "itemize" ? "bulletList" : "orderedList", content: items };
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
  if (/^\\(?:section|subsection|subsubsection)\*?\{/u.test(body.slice(from))) {
    const opening = body.indexOf("{", from);
    const close = closingBrace(body, opening);
    return close === null ? body.length : close + 1;
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
      if (/^\\(?:begin\{|\[|(?:section|subsection|subsubsection)\*?\{)/u.test(body.slice(index)))
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
  const opening = /^\\begin\{description\}(?:\[[^\]]*\])?/u.exec(source);
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
      editable,
      sourceMeta: {
        head: source.slice(0, bodyFrom + matches[0]!.index!),
        tail: source.slice(ending),
        originalItems,
      },
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
  const prefix = TABLE_RULE_PREFIX.exec(source.slice(from, to));
  if (prefix) [from, to] = trimSourceRange(source, from + prefix[0].length, to);
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
  const withoutEscapes = core.replace(/\\[%&_#${}]/gu, "");
  if (/[\\{}$%]/u.test(withoutEscapes)) return null;
  return {
    display: core
      .replace(/\\([%&_#${}])/gu, "$1")
      .replace(/~/gu, " ")
      .replace(/\s+/gu, " ")
      .trim(),
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
  const labelCell = labelArgument
    ? editableTableCell(labelArgument.source, labelArgument.from)
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
        rows.length > 1 &&
        (/\\midrule\b/u.test(body.source) ||
          splitTable(body.source, "row")[0]?.source.includes("\\textbf") === true),
      tableCanonical: false,
      sourceMeta: editable
        ? {
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
    !/\\[A-Za-z]+/u.test(bodySource);
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
  const title = environment === "proof" ? "" : "[Title]";
  return `\\begin{${environment}}${title}\nStatement.\n\\end{${environment}}`;
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

function parseRichPreview(source: string): JSONContent | null {
  return (
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
    const preview = classified === null && !dynamicSyntax ? parseRichPreview(raw) : null;
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

function escapeText(text: string): string {
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
  };
  return text.replace(/[\\%&_#${}~^]/gu, (character) => escapes[character]!);
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
): string {
  const serializedRows = rows.map((row, rowIndex) => {
    const cells = row.map((cell) => {
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
      node.attrs?.level === 2
        ? "subsection"
        : node.attrs?.level === 3
          ? "subsubsection"
          : "section";
    const star = node.attrs?.unnumbered === true ? "*" : "";
    return `\\${command}${star}{${serializeInline(node.content)}}`;
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
      const label = typeof node.attrs.label === "string" ? node.attrs.label : "";
      let insertedMetadata = "";
      if (sourceMeta.hasFloat && sourceMeta.captionRange === null && caption)
        insertedMetadata += `\\caption{${escapeText(caption)}}${eol}`;
      if (sourceMeta.hasFloat && sourceMeta.labelRange === null && label)
        insertedMetadata += `\\label{${escapeText(label)}}${eol}`;
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
          value: canonicalTableBody(rows, style, node.attrs.hasHeader === true, eol),
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
        replacements.push({ from: range.from, to: range.to, value: escapeText(value) });
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
        replacements.push({ from: range.from, to: range.to, value: escapeText(value) });
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
    const label = node.attrs.label;
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
          value: escapeText(label),
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
    return `\\begin{${environment}}\n${items.join("\n")}\n\\end{${environment}}`;
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
              (node.attrs?.kind !== "scientific" &&
                (key === "environment" || key === "title" || key === "body")) ||
              (node.attrs?.kind !== "table" &&
                (key === "columnAlignments" ||
                  key === "tableStyle" ||
                  key === "tableKind" ||
                  key === "hasHeader")))) ||
          value === null ||
          value === undefined
        )
          return false;
        if (key === "unnumbered" && value === false) return false;
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

export function latexVisualNodeSignature(node: JSONContent): string {
  return JSON.stringify(comparableNode(node));
}

/** TeX collapses ordinary whitespace. Keep the live editor's whitespace in its
 * session projection, while checking structural round trips using TeX semantics. */
function roundTripSignature(node: JSONContent): string {
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
      ...(value.text === undefined ? {} : { text: value.text.replace(/[\t\r\n ]+/gu, " ") }),
      ...(children
        ? { content: children.filter((child) => child.type !== "text" || child.text !== "") }
        : {}),
    };
  };
  return latexVisualNodeSignature(normalize(node));
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
      .filter((node) => node.type === "latexRichPreview" && node.attrs?.kind === "scientific")
      .map((node) => String(node.attrs?.environment ?? ""))
      .filter((environment) => SCIENTIFIC_ENVIRONMENTS.has(environment)),
  );
}

function ensureScientificEnvironmentDeclarations(
  source: string,
  environments: ReadonlySet<string>,
  eol: string,
): string {
  if (environments.size === 0) return source;
  const begin = source.indexOf("\\begin{document}");
  if (begin < 0) return source;
  const preamble = source.slice(0, begin);
  const declarations: string[] = [];
  for (const environment of environments) {
    const declared = new RegExp(
      `\\\\(?:newtheorem|newenvironment)\\s*\\{${environment}\\}`,
      "u",
    ).test(preamble);
    if (
      declared ||
      (environment === "proof" && /\\usepackage(?:\[[^\]]*\])?\{amsthm\}/u.test(preamble))
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

function richPreviewCount(content: readonly JSONContent[], kind: string): number {
  return content.filter((node) => node.type === "latexRichPreview" && node.attrs?.kind === kind)
    .length;
}

function ensureFigurePackage(source: string, shouldInsert: boolean, eol: string): string {
  if (!shouldInsert) return source;
  const begin = source.indexOf("\\begin{document}");
  if (begin < 0) return source;
  const preamble = source.slice(0, begin);
  if (/\\(?:usepackage|RequirePackage)(?:\[[^\]]*\])?\{[^{}]*\bgraphicx\b[^{}]*\}/u.test(preamble))
    return source;
  const boundary = begin > 0 && !/[\r\n]/u.test(source[begin - 1]!) ? eol : "";
  return source.slice(0, begin) + boundary + `\\usepackage{graphicx}${eol}` + source.slice(begin);
}

export function applyLatexVisualDocumentChange(
  source: string,
  projection: LatexVisualDocument,
  nextContent: JSONContent,
): { source: string; structural: boolean; projection: LatexVisualDocument } | null {
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
  const serialized = newChanged.map(serializeLatexVisualBlock);
  if (serialized.some((value) => value === null)) return null;
  const from =
    oldChanged[0]?.from ?? previous[prefix]?.from ?? previous.at(-1)?.to ?? source.length;
  const to = oldChanged.at(-1)?.to ?? from;
  const eol = source.includes("\r\n") ? "\r\n" : "\n";
  let replacement = serialized.join("\n\n").replace(/\r?\n/gu, eol);
  if (oldChanged.length === 0 && replacement) {
    if (prefix === previous.length) replacement = eol + eol + replacement;
    else replacement += eol + eol;
  }
  let changedSource = source.slice(0, from) + replacement + source.slice(to);
  changedSource = ensureFigurePackage(
    changedSource,
    richPreviewCount(next, "figure") >
      richPreviewCount(
        previous.map((block) => block.node),
        "figure",
      ),
    eol,
  );
  const previousEnvironments = scientificEnvironments(previous.map((block) => block.node));
  const addedEnvironments = new Set(
    [...scientificEnvironments(next)].filter(
      (environment) => !previousEnvironments.has(environment),
    ),
  );
  changedSource = ensureScientificEnvironmentDeclarations(changedSource, addedEnvironments, eol);
  // Reject a transaction that the supported projection cannot round-trip.
  const projected = projectLatexVisualDocument(changedSource);
  if (roundTripSignature(projected.content) !== roundTripSignature(nextContent)) return null;
  return {
    source: changedSource,
    projection: adoptLatexVisualContent(changedSource, nextContent, projected),
    structural: oldChanged.length !== 1 || newChanged.length !== 1,
  };
}
