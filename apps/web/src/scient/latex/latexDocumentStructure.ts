/** Literal document controls. Ranges always refer to the original source. */
export function latexDocumentCommand(source: string, from = 0) {
  const match = /^\\(title|author|date|pagenumbering|appendix)\b/u.exec(source.slice(from));
  if (!match) return null;
  const name = match[1]!;
  let end = from + match[0].length;
  if (name === "appendix") return { name, from: end, to: end, end, value: "" };
  while (/\s/u.test(source[end] ?? "")) end++;
  if (source[end] !== "{") return null;
  const start = ++end;
  let depth = 1;
  for (; end < source.length; end++) {
    if (source[end] === "\\") end++;
    else if (source[end] === "%") {
      const newline = source.indexOf("\n", end);
      if (newline < 0) return null;
      end = newline;
    } else if (source[end] === "{") depth++;
    else if (source[end] === "}" && --depth === 0) {
      const value = source.slice(start, end);
      if (name === "pagenumbering" && !/^(?:arabic|roman|Roman|alph|Alph)$/u.test(value))
        return null;
      return { name, from: start, to: end, end: end + 1, value };
    }
  }
  return null;
}

/** Ignore comments and grouped macro definitions; the last declaration before maketitle wins. */
export function latexTitleDeclarations(source: string) {
  const declarations = new Map<string, NonNullable<ReturnType<typeof latexDocumentCommand>>>();
  let depth = 0;
  for (let at = 0; at < source.length; at++) {
    if (source[at] === "%") {
      const end = source.indexOf("\n", at);
      if (end < 0) break;
      at = end;
    } else if (source[at] === "{") depth++;
    else if (source[at] === "}") depth--;
    else if (source[at] === "\\") {
      if (depth === 0 && /^\\maketitle\b/u.test(source.slice(at))) break;
      const command = depth === 0 ? latexDocumentCommand(source, at) : null;
      if (command && ["title", "author", "date"].includes(command.name)) {
        declarations.set(command.name, command);
        at = command.end - 1;
      } else at++;
    }
  }
  return declarations;
}

export function latexCounterLabel(value: number, style: string): string {
  if (style === "alph" || style === "Alph") {
    // Standard LaTeX alphabetic counters are defined for 1–26.
    return value >= 1 && value <= 26
      ? String.fromCharCode((style === "alph" ? 96 : 64) + value)
      : "?";
  }
  if (style === "roman" || style === "Roman") {
    let remaining = value;
    let result = "";
    for (const [amount, numeral] of [
      [1000, "m"],
      [900, "cm"],
      [500, "d"],
      [400, "cd"],
      [100, "c"],
      [90, "xc"],
      [50, "l"],
      [40, "xl"],
      [10, "x"],
      [9, "ix"],
      [5, "v"],
      [4, "iv"],
      [1, "i"],
    ] as const) {
      while (remaining >= amount) {
        result += numeral;
        remaining -= amount;
      }
    }
    return style === "Roman" ? result.toUpperCase() : result;
  }
  return String(value);
}
