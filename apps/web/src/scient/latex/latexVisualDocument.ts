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
    const node = withSourceId(
      classified ?? { type: "latexRawBlock", attrs: { raw, label: "Raw LaTeX" } },
      id,
    );
    blocks.push({ id, from, to, node, source: raw, editable: classified !== null });
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
        if (key === "sourceId" || key === "latexCommand" || value === null || value === undefined)
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
  const changedSource = source.slice(0, from) + replacement + source.slice(to);
  // Reject a transaction that the supported projection cannot round-trip.
  const projected = projectLatexVisualDocument(changedSource);
  if (roundTripSignature(projected.content) !== roundTripSignature(nextContent)) return null;
  return {
    source: changedSource,
    projection: adoptLatexVisualContent(changedSource, nextContent, projected),
    structural: oldChanged.length !== 1 || newChanged.length !== 1,
  };
}
