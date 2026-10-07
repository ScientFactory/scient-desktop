import { latexWithoutComments } from "./latexPackages";
import { latexColorCss, latexDocumentColors } from "./latexColorBoxes";

/** Literal contents never enter the prose, structure or package-command grammar. */
export function inlineLatexLiteral(source: string, from = 0) {
  const command = /^\\verb(?![A-Za-z])(\*)?/u.exec(source.slice(from));
  if (!command) return null;
  const opening = from + command[0].length;
  const delimiter = source[opening];
  if (!delimiter || /\s/u.test(delimiter)) return null;
  const closing = source.indexOf(delimiter, opening + 1);
  if (closing < 0 || /[\r\n]/u.test(source.slice(opening + 1, closing))) return null;
  return {
    from: opening + 1,
    to: closing,
    end: closing + 1,
    starred: !!command[1],
    delimiter,
    text: source.slice(opening + 1, closing),
  };
}

export function inlineLatexLiteralSource(text: string, raw: string) {
  if (/[\r\n]/u.test(text)) return null;
  const original = inlineLatexLiteral(raw);
  if (original?.text === text) return raw;
  const delimiter = [
    original?.delimiter,
    "|",
    "!",
    "/",
    "+",
    ";",
    ":",
    "?",
    "@",
    "=",
    "-",
    "~",
  ].find((candidate) => candidate && !text.includes(candidate));
  return delimiter ? `\\verb${original?.starred ? "*" : ""}${delimiter}${text}${delimiter}` : null;
}

function group(source: string, from: number, open = "{", close = "}") {
  if (source[from] !== open) return null;
  let depth = 1,
    braces = 0;
  for (let at = from + 1; at < source.length; at++) {
    if (source[at] === "\\") at++;
    else if (open === "[" && source[at] === "{") braces++;
    else if (open === "[" && source[at] === "}") braces--;
    else if (braces === 0 && source[at] === open) depth++;
    else if (braces === 0 && source[at] === close && --depth === 0)
      return { from: from + 1, to: at, end: at + 1 };
  }
  return null;
}

function literalOptions(source: string, from = 0, to = source.length) {
  const clean = latexWithoutComments(source);
  const entries = new Map<string, { value: string; from: number; to: number }>();
  let cursor = from;
  while (cursor < to) {
    while (/[\s,]/u.test(clean[cursor] ?? "") && cursor < to) cursor++;
    if (cursor === to) break;
    const key = /^[A-Za-z]+\s*=/u.exec(clean.slice(cursor, to));
    if (!key) return null;
    const name = key[0].split("=")[0]!.trim();
    cursor += key[0].length;
    while (/\s/u.test(clean[cursor] ?? "") && cursor < to) cursor++;
    const start = cursor;
    let depth = 0;
    for (; cursor < to; cursor++) {
      if (clean[cursor] === "\\") cursor++;
      else if (clean[cursor] === "{") depth++;
      else if (clean[cursor] === "}") depth--;
      else if (clean[cursor] === "," && depth === 0) break;
      if (depth < 0) return null;
    }
    if (depth !== 0) return null;
    let valueTo = cursor;
    while (valueTo > start && /\s/u.test(clean[valueTo - 1]!)) valueTo--;
    const braced = group(clean, start);
    const valueFrom = braced?.end === valueTo ? braced.from : start;
    if (braced?.end === valueTo) valueTo = braced.to;
    entries.set(name, { value: clean.slice(valueFrom, valueTo), from: valueFrom, to: valueTo });
  }
  return entries;
}

export function latexLiteralBlock(source: string, from = 0) {
  const opening = /^\\begin\{(verbatim\*?|lstlisting)\}/u.exec(source.slice(from));
  if (!opening) return null;
  const environment = opening[1]!;
  let bodyFrom = from + opening[0].length;
  let options = new Map<string, { value: string; from: number; to: number }>();
  if (environment === "lstlisting") {
    const gap = /^[\t ]*/u.exec(source.slice(bodyFrom))![0];
    const optional = group(source, bodyFrom + gap.length, "[", "]");
    if (source[bodyFrom + gap.length] === "[" && !optional) return null;
    if (optional) {
      const parsed = literalOptions(source, optional.from, optional.to);
      if (!parsed) return null;
      options = parsed;
      bodyFrom = optional.end;
    }
  }
  const firstBreak = /^[\t ]*\r?\n/u.exec(source.slice(bodyFrom));
  if (firstBreak) bodyFrom += firstBreak[0].length;
  const closing = `\\end{${environment}}`;
  for (let cursor = bodyFrom; cursor < source.length;) {
    const newline = source.indexOf("\n", cursor);
    const line = source.slice(cursor, newline < 0 ? source.length : newline);
    if (line.trim() === closing) {
      const at = cursor + line.indexOf(closing);
      let bodyTo = cursor;
      if (bodyTo > bodyFrom && source[bodyTo - 1] === "\n") {
        bodyTo--;
        if (source[bodyTo - 1] === "\r") bodyTo--;
      }
      return { environment, bodyFrom, bodyTo, end: at + closing.length, options };
    }
    if (newline < 0) break;
    cursor = newline + 1;
  }
  return null;
}

/** Preserve offsets and line boundaries while excluding literal code from command scans. */
export function activeLatexSource(source: string) {
  let result = "",
    cursor = 0,
    skip = 0;
  for (const token of source.matchAll(/\\([A-Za-z]+|[^\r\n])|%/gu)) {
    const at = token.index;
    if (at < skip) continue;
    if (token[0] === "%") {
      const end = source.indexOf("\n", at);
      skip = end < 0 ? source.length : end + 1;
      continue;
    }
    const inline = token[1] === "verb" ? inlineLatexLiteral(source, at) : null;
    const block = token[1] === "begin" ? latexLiteralBlock(source, at) : null;
    if (!inline && !block) continue;
    const from = inline ? at : block!.bodyFrom;
    const to = inline?.end ?? block!.bodyTo;
    result += source.slice(cursor, from) + source.slice(from, to).replace(/[^\r\n]/g, " ");
    cursor = to;
    skip = inline?.end ?? block!.end;
  }
  return result + source.slice(cursor);
}

export function latexListingDefaults(preamble: string) {
  const clean = latexWithoutComments(activeLatexSource(preamble));
  const options = new Map<string, string>();
  let skip = 0,
    depth = 0;
  for (const match of clean.matchAll(/\\([A-Za-z]+|[^\r\n])|[{}]/gu)) {
    if (match.index < skip) continue;
    if (match[0] === "{") depth++;
    else if (match[0] === "}") depth--;
    if (depth !== 0 || match[1] !== "lstset") continue;
    const opening = match.index + match[0].length;
    const gap = /^\s*/u.exec(clean.slice(opening))![0];
    const range = group(clean, opening + gap.length);
    const entries = range && literalOptions(clean, range.from, range.to);
    if (!range || !entries) return null;
    skip = range.end;
    for (const [name, entry] of entries) options.set(name, entry.value);
  }
  return options;
}

const colors: Record<string, readonly number[]> = {
  black: [0, 0, 0],
  white: [255, 255, 255],
  red: [255, 0, 0],
  green: [0, 255, 0],
  blue: [0, 0, 255],
  cyan: [0, 255, 255],
  magenta: [255, 0, 255],
  yellow: [255, 255, 0],
  gray: [128, 128, 128],
  darkgray: [64, 64, 64],
  lightgray: [191, 191, 191],
};
function color(value: string) {
  const match = /^([a-z]+)(?:!(\d{1,3})(?:!([a-z]+))?)?$/u.exec(value);
  const first = match && colors[match[1]!],
    second = match && colors[match[3] ?? "white"];
  const fraction = match?.[2] === undefined ? 1 : Number(match[2]) / 100;
  return first && second && fraction <= 1
    ? `rgb(${first.map((channel, index) => Math.round(channel * fraction + second[index]! * (1 - fraction))).join(", ")})`
    : null;
}
function textStyle(value: string, colors: Record<string, string>) {
  const result = {
    size: "inherit",
    color: "inherit",
    bold: null as boolean | null,
    italic: null as boolean | null,
    family: "inherit",
  };
  const rest = value.replace(
    /\\color\s*\{([^{}]+)\}|\\(ttfamily|rmfamily|sffamily|tiny|scriptsize|footnotesize|small|normalsize|large|Large|bfseries|mdseries|itshape|upshape)/gu,
    (_token, name: string | undefined, command: string | undefined) => {
      if (name) result.color = color(name) ?? latexColorCss(name, colors) ?? "";
      else if (command === "bfseries" || command === "mdseries")
        result.bold = command === "bfseries";
      else if (command === "itshape" || command === "upshape")
        result.italic = command === "itshape";
      else if (command?.endsWith("family")) result.family = command.slice(0, -6);
      else if (command) result.size = command;
      return "";
    },
  );
  return rest.trim() || !result.color ? null : result;
}

/** The supported presentation stays data; it never evaluates preamble TeX. */
export function latexListingPresentation(preamble: string, local: Map<string, { value: string }>) {
  const options = latexListingDefaults(preamble);
  if (!options) return null;
  for (const [key, entry] of local) options.set(key, entry.value);
  const supported = new Set([
    "language",
    "caption",
    "label",
    "basicstyle",
    "keywordstyle",
    "commentstyle",
    "stringstyle",
    "numberstyle",
    "numbers",
    "frame",
    "breaklines",
    "showstringspaces",
    "firstnumber",
    "stepnumber",
    "numberblanklines",
    "tabsize",
    "captionpos",
  ]);
  if ([...options.keys()].some((key) => !supported.has(key))) return null;
  const colors = latexDocumentColors(preamble);
  const basic = textStyle(options.get("basicstyle") ?? "", colors),
    keyword = textStyle(options.get("keywordstyle") ?? "\\bfseries", colors),
    comment = textStyle(options.get("commentstyle") ?? "\\itshape", colors),
    string = textStyle(options.get("stringstyle") ?? "", colors),
    number = textStyle(options.get("numberstyle") ?? "", colors);
  const numbers = options.get("numbers") ?? "none",
    frame = options.get("frame") ?? "none",
    captionPosition = options.get("captionpos") ?? "t";
  const integer = (key: string, fallback: number) => {
    const value = options.get(key);
    return value === undefined || (key === "firstnumber" && value === "auto")
      ? fallback
      : /^\d+$/u.test(value) && Number(value) <= 100000
        ? Number(value)
        : -1;
  };
  const bool = (key: string, fallback: boolean) =>
    options.has(key) ? options.get(key) === "true" : fallback;
  const firstNumber = integer("firstnumber", 1),
    step = integer("stepnumber", 1),
    tabSize = integer("tabsize", 8);
  if (
    !basic ||
    !keyword ||
    !comment ||
    !string ||
    !number ||
    !["none", "left", "right"].includes(numbers) ||
    !["none", "single", "lines", "topline", "bottomline"].includes(frame) ||
    !["t", "b"].includes(captionPosition) ||
    firstNumber < 0 ||
    step < 0 ||
    tabSize < 1 ||
    tabSize > 32 ||
    ["breaklines", "showstringspaces", "numberblanklines"].some(
      (key) => options.has(key) && !["true", "false"].includes(options.get(key)!),
    )
  )
    return null;
  return {
    basic,
    keyword,
    comment,
    string,
    number,
    language: options.get("language") ?? "",
    numbers,
    frame,
    captionPosition,
    firstNumber,
    step,
    tabSize,
    breakLines: bool("breaklines", false),
    showStringSpaces: bool("showstringspaces", true),
    numberBlankLines: bool("numberblanklines", true),
  };
}
export type LatexListingPresentation = NonNullable<ReturnType<typeof latexListingPresentation>>;
