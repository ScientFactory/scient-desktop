import {
  applyDocumentSourcePatches,
  DocumentSourcePatchError,
  type DocumentSourcePatch,
} from "@scientfactory/scient-document";

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

export function latexSourceArgument(
  source: string,
  at: number,
  open = "{",
  close = "}",
): LatexSourceArgument | null {
  while (at < source.length) {
    if (/\s/u.test(source[at]!)) at++;
    else if (source[at] === "%") {
      const end = source.indexOf("\n", at);
      if (end < 0) return null;
      at = end + 1;
    } else break;
  }
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
      if (name === "verb" || name === "lstinline") {
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
      if (name === "begin") {
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
  return latexDocumentBoundary(source)?.from ?? source.length;
}

export function latexSourcePatches(
  source: string,
  patches: readonly (LatexSourceRange & { value: string })[],
): DocumentSourcePatch[] {
  return patches.map(({ from, to, value }) => ({
    start: from,
    end: to,
    replacement: value,
    expected: source.slice(from, to),
  }));
}

export function patchLatexSource(
  source: string,
  patches: readonly (LatexSourceRange & { value: string })[],
): string | null {
  try {
    return applyDocumentSourcePatches(source, latexSourcePatches(source, patches));
  } catch (error) {
    if (error instanceof DocumentSourcePatchError) return null;
    throw error;
  }
}

/** Compose explicit ranges, retaining original coordinates without diffing the combined document. */
export function composeLatexSourcePatches(
  source: string,
  stages: readonly (readonly DocumentSourcePatch[])[],
): DocumentSourcePatch[] {
  type Piece = { text: string; from: number | null };
  let pieces: Piece[] = [{ text: source, from: 0 }];
  let current = source;
  for (const patches of stages) {
    const next = applyDocumentSourcePatches(current, patches);
    for (const patch of patches
      .toSorted((a, b) => a.start - b.start || a.end - b.end)
      .toReversed()) {
      const before: Piece[] = [],
        after: Piece[] = [];
      let offset = 0;
      for (const piece of pieces) {
        const end = offset + piece.text.length;
        if (offset < patch.start) {
          const length = Math.min(piece.text.length, patch.start - offset);
          if (length) before.push({ text: piece.text.slice(0, length), from: piece.from });
        }
        if (end > patch.end) {
          const start = Math.max(0, patch.end - offset);
          after.push({
            text: piece.text.slice(start),
            from: piece.from === null ? null : piece.from + start,
          });
        }
        offset = end;
      }
      pieces = [
        ...before,
        ...(patch.replacement ? [{ text: patch.replacement, from: null }] : []),
        ...after,
      ];
    }
    current = next;
  }
  const result: DocumentSourcePatch[] = [];
  let from = 0,
    replacement = "";
  for (const piece of pieces) {
    if (piece.from === null) replacement += piece.text;
    else {
      if (from !== piece.from || replacement)
        result.push({
          start: from,
          end: piece.from,
          replacement,
          expected: source.slice(from, piece.from),
        });
      replacement = "";
      from = piece.from + piece.text.length;
    }
  }
  if (from !== source.length || replacement)
    result.push({ start: from, end: source.length, replacement, expected: source.slice(from) });
  return result;
}
