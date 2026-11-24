/** Lossless, bounded argument and command scanning shared by authoring operations. */
export interface LatexSourceRange {
  from: number;
  to: number;
}
export interface LatexSourceArgument extends LatexSourceRange {
  open: number;
  end: number;
  value: string;
}

function skipSourceTrivia(source: string, at: number): number {
  while (at < source.length) {
    if (/\s/u.test(source[at]!)) at++;
    else if (source[at] === "%") {
      const end = source.indexOf("\n", at);
      if (end < 0) return source.length;
      at = end + 1;
    } else break;
  }
  return at;
}

export function latexSourceArgument(
  source: string,
  at: number,
  open = "{",
  close = "}",
): LatexSourceArgument | null {
  at = skipSourceTrivia(source, at);
  if (source[at] !== open) return null;
  const start = at;
  let depth = 1,
    braces = 0;
  for (at++; at < source.length; at++) {
    const ch = source[at];
    if (ch === "\\") at++;
    else if (ch === "%") {
      const newline = source.indexOf("\n", at);
      if (newline < 0) return null;
      at = newline;
    } else if (open === "[" && ch === "{") braces++;
    else if (open === "[" && ch === "}") braces--;
    else if (!braces && ch === open) depth++;
    else if (!braces && ch === close && --depth === 0)
      return {
        open: start,
        from: start + 1,
        to: at,
        end: at + 1,
        value: source.slice(start + 1, at),
      };
  }
  return null;
}

interface LatexLexicalFacts {
  commands: { name: string; from: number; to: number; depth: number }[];
  comments: LatexSourceRange[];
  literals: LatexSourceRange[];
}

/** Definition arguments contain source to execute later, not active environments. */
function definitionEnd(source: string, at: number, command: string): number {
  if (
    !/^(?:(?:new|renew|provide)command|DeclareRobustCommand|DeclareMathOperator|(?:new|renew)environment|(?:New|Renew|Provide|Declare)DocumentCommand|[gex]?def)$/u.test(
      command,
    )
  )
    return at;
  at = skipSourceTrivia(source, at);
  if (source[at] === "*") at = skipSourceTrivia(source, at + 1);
  if (/^[gex]?def$/u.test(command)) {
    const parameters = /^\s*\\(?:[A-Za-z@]+|[^\r\n])[^{}]*?(?=\{)/u.exec(source.slice(at));
    return parameters ? (latexSourceArgument(source, at + parameters[0].length)?.end ?? at) : at;
  }
  const name = latexSourceArgument(source, at);
  const unbraced = name ? null : /^\s*\\(?:[A-Za-z@]+|[^\r\n])/u.exec(source.slice(at));
  if (!name && !unbraced) return at;
  at = name?.end ?? at + unbraced![0].length;
  for (let index = 0; index < 2; index++) {
    const option = latexSourceArgument(source, at, "[", "]");
    if (!option) break;
    at = option.end;
  }
  const argumentsCount = /environment|DocumentCommand/u.test(command) ? 2 : 1;
  for (let index = 0; index < argumentsCount; index++) {
    const argument = latexSourceArgument(source, at);
    if (!argument) return at;
    at = argument.end;
  }
  return at;
}

/** Bounded lexical facts only: alltt retains active TeX unless a display consumer opts out. */
function lexicalFacts(
  source: string,
  literalAlltt = false,
  opaqueEnvironments: readonly string[] = ["comment"],
): LatexLexicalFacts {
  const commands: LatexLexicalFacts["commands"] = [];
  const comments: LatexSourceRange[] = [],
    literals: LatexSourceRange[] = [];
  let depth = 0;
  let definitionTo = 0;
  for (let at = 0; at < source.length; at++) {
    const ch = source[at];
    if (ch === "%") {
      const end = source.slice(at).search(/[\r\n]/u);
      const to = end < 0 ? source.length : at + end;
      comments.push({ from: at, to });
      at = to - 1;
    } else if (ch === "{") depth++;
    else if (ch === "}") depth--;
    else if (ch === "\\") {
      const token = /^\\([A-Za-z@]+|[^\r\n])/u.exec(source.slice(at));
      if (!token) continue;
      const name = token[1]!,
        end = at + token[0].length;
      commands.push({ name, from: at, to: end, depth });
      if (at >= definitionTo) {
        const to = definitionEnd(source, end, name);
        if (to > end) definitionTo = to;
      }
      if (at >= definitionTo && (name === "verb" || name === "lstinline")) {
        let start = end + Number(source[end] === "*");
        const option = name === "lstinline" ? latexSourceArgument(source, start, "[", "]") : null;
        if (option) start = option.end;
        const delimiter = source[start];
        const close =
          delimiter && !/\s/u.test(delimiter) ? source.indexOf(delimiter, start + 1) : -1;
        const newline = source.indexOf("\n", start);
        const to =
          close >= 0 && (newline < 0 || close < newline)
            ? close + 1
            : newline < 0
              ? source.length
              : newline;
        literals.push({ from: at, to });
        at = to - 1;
        continue;
      }
      if (name === "begin" && at >= definitionTo) {
        const env = latexSourceArgument(source, end);
        if (
          env &&
          (/^(?:verbatim\*?|lstlisting|tcblisting|minted|Verbatim)$/u.test(env.value) ||
            (literalAlltt && env.value === "alltt") ||
            opaqueEnvironments.includes(env.value))
        ) {
          const closing = `\\end{${env.value}}`;
          const close = source.indexOf(closing, env.end);
          const to = close < 0 ? source.length : close + closing.length;
          literals.push({ from: at, to });
          at = to - 1;
          continue;
        }
      }
      at = end - 1;
    }
  }
  return { commands, comments, literals };
}

/** Comments and literal source are never command uses or declaration locations. */
export function latexSourceCommands(source: string) {
  return lexicalFacts(source).commands;
}

export function latexCommentRanges(source: string, literalAlltt = false): LatexSourceRange[] {
  return lexicalFacts(source, literalAlltt).comments;
}

/** Masks preserve both UTF-16 offsets and line endings. */
export function maskLatexSource(
  source: string,
  options: {
    literals?: boolean;
    literalAlltt?: boolean;
    opaqueEnvironments?: readonly string[];
  } = {},
): string {
  const facts = lexicalFacts(source, options.literalAlltt, options.opaqueEnvironments);
  const ranges = [...facts.comments, ...(options.literals ? facts.literals : [])].sort(
    (left, right) => left.from - right.from,
  );
  let result = "",
    cursor = 0;
  for (const range of ranges) {
    result +=
      source.slice(cursor, range.from) +
      source.slice(range.from, range.to).replace(/[^\r\n]/g, " ");
    cursor = range.to;
  }
  return cursor ? result + source.slice(cursor) : source;
}

export function latexWithoutComments(source: string): string {
  return maskLatexSource(source);
}

export function latexCommands(source: string) {
  return [...maskLatexSource(source, { literals: true }).matchAll(/\\([A-Za-z]+|[^\r\n])/gu)];
}

export function latexDocumentBoundary(
  source: string,
): { from: number; bodyFrom: number; bodyTo: number } | null {
  let boundary: { from: number; bodyFrom: number; bodyTo: number } | null = null;
  for (const command of latexSourceCommands(source)) {
    if (command.depth !== 0) continue;
    if (boundary && command.name === "endinput") {
      boundary.bodyTo = command.from;
      break;
    }
    if (command.name !== "begin" && command.name !== "end") continue;
    const arg = latexSourceArgument(source, command.to);
    if (arg?.value !== "document") continue;
    if (!boundary && command.name === "begin")
      boundary = { from: command.from, bodyFrom: arg.end, bodyTo: source.length };
    else if (boundary && command.name === "end") {
      boundary.bodyTo = command.from;
      break;
    }
  }
  return boundary;
}

export function latexPreambleEnd(source: string): number {
  // Validate only the short prefix for ordinary documents. The full boundary
  // scanner remains the authority for unusual or adversarial preambles.
  let cursor = 0;
  for (let attempt = 0; attempt < 8; attempt++) {
    const at = source.indexOf("\\begin", cursor);
    if (at < 0) return source.length;
    const argument = latexSourceArgument(source, at + 6);
    if (
      argument?.value === "document" &&
      latexSourceCommands(source.slice(0, argument.end)).some(
        (command) => command.from === at && command.name === "begin" && command.depth === 0,
      )
    )
      return at;
    cursor = at + 6;
  }
  return latexDocumentBoundary(source)?.from ?? source.length;
}

/** Standard class font sizes and baselines, in TeX points. */
export function latexVisualFontMetrics(base: 10 | 11 | 12) {
  return {
    tiny: [base === 10 ? 5 : 6, base === 10 ? 6 : 7],
    scriptsize: [base === 10 ? 7 : 8, base === 10 ? 8 : 9.5],
    footnotesize: [
      base === 10 ? 8 : base === 11 ? 9 : 10,
      base === 10 ? 9.5 : base === 11 ? 11 : 12,
    ],
    small: [base === 10 ? 9 : base === 11 ? 10 : 10.95, base === 10 ? 11 : base === 11 ? 12 : 13.6],
    normalsize: [base === 11 ? 10.95 : base, base === 10 ? 12 : base === 11 ? 13.6 : 14.5],
    large: [base === 12 ? 14.4 : 12, base === 12 ? 18 : 14],
    Large: [base === 12 ? 17.28 : 14.4, base === 12 ? 22 : 18],
    LARGE: [base === 12 ? 20.74 : 17.28, base === 12 ? 25 : 22],
    huge: [base === 12 ? 24.88 : 20.74, base === 12 ? 30 : 25],
    Huge: [24.88, 30],
  } as const;
}

export const GUARDED_MAIN_FONT =
  /\\IfFontExistsTF\{([^{}]+)\}\{\\setmainfont(?:\[[^\]{}]*\])?\{\1\}\}\{\}/gu;
