/** Lossless, deliberately bounded LaTeX prose projection. Shared by editing and engine conformance tests. */
export interface VisualRun {
  readonly from: number;
  readonly to: number;
  readonly text: string;
  /** UTF-16 display boundaries -> original source offsets. */
  readonly boundaries: readonly number[];
  readonly firstLine: number;
  readonly lastLine: number;
}

const TEXT_COMMANDS = new Set([
  "textbf",
  "textit",
  "texttt",
  "textnormal",
  "textrm",
  "textsf",
  "textsl",
  "textsc",
  "emph",
  "underline",
  "section",
  "subsection",
  "subsubsection",
  "paragraph",
  "caption",
  "title",
  "author",
  "footnote",
]);
const TEXT_ENVIRONMENTS = new Set(["document", "abstract", "center", "quote", "quotation"]);
const ESCAPES: Readonly<Record<string, string>> = {
  "%": "%",
  "&": "&",
  _: "_",
  "#": "#",
  $: "$",
  "{": "{",
  "}": "}",
};

function endOfMath(source: string, start: number, closing: string, limit: number): number {
  for (let i = start; i < limit; i++) {
    if (source.startsWith(closing, i)) return i + closing.length;
    if (source[i] === "\\") i++;
    else if (source[i] === "%") {
      const newline = source.indexOf("\n", i);
      if (newline < 0) return limit;
      i = newline;
    }
  }
  return limit;
}

function afterArguments(source: string, start: number, limit: number): number {
  let i = start;
  let consumed = start;
  while (i < limit) {
    while (/[\t \r\n]/u.test(source[i] ?? "") && i < limit) i++;
    if (source[i] !== "{" && source[i] !== "[") return consumed;
    const opening = source[i]!;
    const closing = opening === "{" ? "}" : "]";
    let depth = 1;
    for (i++; i < limit && depth > 0; i++) {
      if (source[i] === "\\") i++;
      else if (source[i] === "%") {
        const newline = source.indexOf("\n", i);
        i = newline < 0 ? limit : newline;
      } else if (source[i] === opening) depth++;
      else if (source[i] === closing) depth--;
    }
    consumed = i;
  }
  return limit;
}

function endOfEnvironment(source: string, start: number, name: string, limit: number): number {
  const opening = `\\begin{${name}}`;
  const closing = `\\end{${name}}`;
  let depth = 1;
  for (let i = start; i < limit; i++) {
    if (source.startsWith(opening, i)) {
      depth++;
      i += opening.length - 1;
    } else if (source.startsWith(closing, i)) {
      if (--depth === 0) return i + closing.length;
      i += closing.length - 1;
    }
  }
  return limit;
}

/** Unknown macros/environments are opaque. Source outside returned runs is immutable in Visual. */
export function visualRuns(source: string): readonly VisualRun[] {
  if (
    source.length > 1_000_000 ||
    /\\(?:catcode|def|gdef|edef|xdef|let|futurelet|obeylines|obeyspaces)\b/u.test(source)
  )
    return [];
  const begin = source.indexOf("\\begin{document}");
  const start = begin < 0 ? 0 : begin + "\\begin{document}".length;
  const end = source.indexOf("\\end{document}", start);
  const limit = end < 0 ? source.length : end;
  const runs: VisualRun[] = [];
  const lineAt: number[] = [];
  let line = 1;
  for (let i = 0; i <= source.length; i++) {
    lineAt[i] = line;
    if (source[i] === "\n") line++;
  }
  let text = "";
  let boundaries: number[] = [start];
  const flush = (to: number) => {
    const leading = text.length - text.trimStart().length;
    const trailing = text.trimEnd().length;
    if (text.trim())
      runs.push({
        from: boundaries[leading]!,
        to: boundaries[trailing]!,
        text: text.trim(),
        boundaries: boundaries.slice(leading, trailing + 1),
        firstLine: lineAt[boundaries[leading]!]!,
        lastLine: lineAt[boundaries[trailing]!]!,
      });
    text = "";
    boundaries = [to];
  };
  const reset = (to: number) => {
    text = "";
    boundaries = [to];
  };
  const append = (value: string, to: number) => {
    text += value;
    // Multi-unit Unicode remains indexed in native textarea UTF-16 coordinates.
    for (let j = 1; j <= value.length; j++)
      boundaries.push(j === value.length ? to : to - value.length + j);
  };
  let i = start;
  while (i < limit) {
    const char = source[i]!;
    if (char === "%") {
      flush(i);
      const newline = source.indexOf("\n", i);
      i = newline < 0 ? limit : newline + 1;
      reset(i);
    } else if (char === "\\" && ESCAPES[source[i + 1]!] !== undefined) {
      append(ESCAPES[source[i + 1]!]!, i + 2);
      i += 2;
    } else if (char === "\\" && (source[i + 1] === "[" || source[i + 1] === "(")) {
      flush(i);
      i = endOfMath(source, i + 2, source[i + 1] === "[" ? "\\]" : "\\)", limit);
      reset(i);
    } else if (char === "\\") {
      flush(i);
      const command = /^\\([A-Za-z]+)\*?/u.exec(source.slice(i));
      const name = command?.[1] ?? "";
      const after = i + (command?.[0].length ?? 2);
      if (TEXT_COMMANDS.has(name) && source[after] === "{") {
        i = after + 1;
      } else if (name === "begin" || name === "end") {
        const env = /^\{([^}]+)\}/u.exec(source.slice(after));
        if (env && TEXT_ENVIRONMENTS.has(env[1]!)) i = after + env[0].length;
        else if (env && name === "begin") {
          i = endOfEnvironment(source, after + env[0].length, env[1]!, limit);
        } else i = limit;
      } else {
        // An unknown command may consume unbraced arguments, change catcodes,
        // or generate text. Refuse the remainder of its paragraph, not just its braces.
        const argumentsEnd = afterArguments(source, after, limit);
        const blank = /\r?\n[\t ]*\r?\n/u.exec(source.slice(argumentsEnd));
        i = blank ? argumentsEnd + blank.index + blank[0].length : limit;
      }
      reset(i);
    } else if (char === "$" || char === "&" || char === "#" || char === "^" || char === "_") {
      flush(i);
      if (char === "$") {
        const delimiter = source[i + 1] === "$" ? "$$" : "$";
        i = endOfMath(source, i + delimiter.length, delimiter, limit);
      } else {
        const blank = source.indexOf("\n\n", i);
        i = blank < 0 ? limit : blank + 2;
      }
      reset(i);
    } else if (char === "{" || char === "}") {
      flush(i);
      reset(++i);
    } else if (/\s/u.test(char)) {
      const match = /^\s+/u.exec(source.slice(i))![0];
      if (/\n[\t \r]*\n/u.test(match)) {
        flush(i);
        i += match.length;
        reset(i);
      } else {
        i += match.length;
        append(" ", i);
      }
    } else if (char === "~") {
      append(" ", ++i);
    } else if (source.startsWith("---", i) || source.startsWith("--", i)) {
      const length = source.startsWith("---", i) ? 3 : 2;
      append(length === 3 ? "—" : "–", (i += length));
    } else if (source.startsWith("``", i) || source.startsWith("''", i)) {
      append(char === "`" ? "“" : "”", (i += 2));
    } else {
      append(char, ++i);
    }
  }
  flush(limit);
  return runs;
}

export function encodeVisualText(text: string): string {
  const escapes: Readonly<Record<string, string>> = {
    "\\": "\\textbackslash{}",
    "~": "\\textasciitilde{}",
    "^": "\\textasciicircum{}",
    "%": "\\%",
    "&": "\\&",
    _: "\\_",
    "#": "\\#",
    $: "\\$",
    "{": "\\{",
    "}": "\\}",
  };
  return text
    .replace(/\r\n?/gu, "\n")
    .replace(/[\\~^%&_#${}]/gu, (char) => escapes[char]!)
    .replace(/\n/gu, "\n\n");
}

/** Minimal splice; syntax, comments and whitespace outside the changed range survive byte-for-byte. */
export function editVisualRun(source: string, run: VisualRun, next: string): string {
  let prefix = 0;
  while (prefix < run.text.length && prefix < next.length && run.text[prefix] === next[prefix])
    prefix++;
  let suffix = 0;
  while (
    suffix < run.text.length - prefix &&
    suffix < next.length - prefix &&
    run.text[run.text.length - 1 - suffix] === next[next.length - 1 - suffix]
  )
    suffix++;
  const from = run.boundaries[prefix];
  const to = run.boundaries[run.text.length - suffix];
  if (from === undefined || to === undefined || from < run.from || to > run.to)
    throw new Error("Invalid visual source mapping");
  return (
    source.slice(0, from) +
    encodeVisualText(next.slice(prefix, next.length - suffix)) +
    source.slice(to)
  );
}

/** Comparison only: never use normalization to rewrite source. Tracks ligatures and PDF whitespace. */
export function visualCharacters(text: string): { text: string; offsets: number[] } {
  let normalized = "";
  const offsets: number[] = [];
  let offset = 0;
  for (const char of text) {
    const value = char.normalize("NFKC");
    for (const unit of value)
      if (!/\s/u.test(unit)) {
        normalized += unit;
        for (let j = 0; j < unit.length; j++) offsets.push(offset);
      }
    offset += char.length;
  }
  offsets.push(text.length);
  return { text: normalized, offsets };
}

export function matchVisualRun(
  source: string,
  pdfText: string,
  pdfOffset: number,
  sourceLine: number | null,
): { run: VisualRun; offset: number } | null {
  const needle = visualCharacters(pdfText);
  if (needle.text.length < 3) return null;
  const matches: { run: VisualRun; offset: number }[] = [];
  for (const run of visualRuns(source)) {
    if (sourceLine !== null && (sourceLine < run.firstLine - 1 || sourceLine > run.lastLine + 1))
      continue;
    const haystack = visualCharacters(run.text);
    let index = haystack.text.indexOf(needle.text);
    while (index >= 0) {
      const clicked = needle.offsets.findIndex((offset) => offset >= pdfOffset);
      const offset = haystack.offsets[index + (clicked < 0 ? needle.text.length : clicked)]!;
      matches.push({ run, offset });
      index = haystack.text.indexOf(needle.text, index + 1);
    }
  }
  return matches.length === 1 ? matches[0]! : null;
}
