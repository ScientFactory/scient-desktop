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
  while (/\s/u.test(source[at] ?? "")) at++;
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

/** Comments and literal source are never command uses or declaration locations. */
export function latexSourceCommands(source: string) {
  const result: { name: string; from: number; to: number; depth: number }[] = [];
  let depth = 0;
  for (let at = 0; at < source.length; at++) {
    const ch = source[at];
    if (ch === "%") {
      const end = source.indexOf("\n", at);
      if (end < 0) break;
      at = end;
    } else if (ch === "{") depth++;
    else if (ch === "}") depth--;
    else if (ch === "\\") {
      const token = /^\\([A-Za-z@]+|[^\r\n])/u.exec(source.slice(at));
      if (!token) continue;
      const name = token[1]!;
      const end = at + token[0].length;
      if (name === "verb" || name === "lstinline") {
        result.push({ name, from: at, to: end, depth });
        let start = end + (source[end] === "*" ? 1 : 0);
        const option = name === "lstinline" ? latexSourceArgument(source, start, "[", "]") : null;
        if (option) start = option.end;
        const delimiter = source[start];
        const close = delimiter ? source.indexOf(delimiter, start + 1) : -1;
        at = close >= 0 ? close : source.length;
        continue;
      }
      if (name === "begin") {
        const env = latexSourceArgument(source, end);
        if (env && /^(?:verbatim\*?|lstlisting|tcblisting|minted|Verbatim)$/u.test(env.value)) {
          result.push({ name, from: at, to: end, depth });
          const closing = `\\end{${env.value}}`;
          const close = source.indexOf(closing, env.end);
          at = close < 0 ? source.length : close + closing.length - 1;
          continue;
        }
      }
      result.push({ name, from: at, to: end, depth });
      at = end - 1;
    }
  }
  return result;
}

export function patchLatexSource(
  source: string,
  patches: readonly (LatexSourceRange & { value: string })[],
): string | null {
  let next = source,
    boundary = source.length;
  for (const patch of [...patches].sort((a, b) => b.from - a.from || b.to - a.to)) {
    if (patch.from < 0 || patch.to < patch.from || patch.to > boundary) return null;
    next = next.slice(0, patch.from) + patch.value + next.slice(patch.to);
    boundary = patch.from;
  }
  return next;
}
