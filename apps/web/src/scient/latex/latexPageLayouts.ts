import { latexLengthInches } from "./latexVisualLayout";
import { latexDirectionOpening, type LatexLanguageSetup } from "./latexLanguage";

/** Balanced layout arguments retain source offsets; no TeX is evaluated. */
function argument(source: string, at: number, open = "{", close = "}") {
  while (/\s/u.test(source[at] ?? "")) at++;
  if (source[at] !== open) return null;
  let depth = 1;
  for (let cursor = at + 1; cursor < source.length; cursor++) {
    if (source[cursor] === "\\") cursor++;
    else if (source[cursor] === open) depth++;
    else if (source[cursor] === close && --depth === 0)
      return { from: at + 1, to: cursor, end: cursor + 1, value: source.slice(at + 1, cursor) };
  }
  return null;
}

/** CSS lengths for bounded literal layout dimensions, relative to the local line. */
export function latexLayoutLength(value: string): string | null {
  const relative = /^((?:\d+(?:\.\d*)?|\.\d+)?)\s*\\(?:linewidth|textwidth|columnwidth)$/u.exec(
    value.trim(),
  );
  if (relative)
    return Number(relative[1] || "1") <= 1 ? `${Number(relative[1] || "1") * 100}%` : null;
  const font = /^(\d+(?:\.\d*)?|\.\d+)\s*(em|ex)$/u.exec(value.trim());
  if (font) return `${Number(font[1])}${font[2]}`;
  const inches = latexLengthInches(value);
  return inches !== null && inches >= 0 ? `${inches}in` : null;
}

/** Read only the glue between adjacent panels; retained raw source owns its spelling. */
export function latexMinipageSeparator(source: string): { end: number; gap: string } | null {
  const trivia = (at: number) => /^(?:[\t \r\n]|%[^\r\n]*(?:\r?\n|$))*/u.exec(source.slice(at))![0];
  const before = trivia(0);
  let at = before.length;
  let gap = before.replace(/%[^\r\n]*(?:\r?\n|$)/gu, "").length ? "0.333333em" : "0px";
  if (source.startsWith("\\hfill", at) && !/[A-Za-z]/u.test(source[at + 6] ?? "")) {
    gap = "auto";
    at += 6;
  } else {
    const space = /^\\hspace\*?/u.exec(source.slice(at));
    if (space) {
      const length = argument(source, at + space[0].length);
      const width = length && latexLayoutLength(length.value);
      if (!width) return null;
      gap = width;
      at = length!.end;
    }
  }
  at += trivia(at).length;
  const clean = source.slice(0, at).replace(/%[^\r\n]*(?:\r?\n|$)/gu, "");
  if (/\r?\n[\t ]*\r?\n/u.test(clean) || !source.startsWith("\\begin{minipage}", at)) return null;
  return { end: at, gap };
}

export function latexPageLayoutOpening(source: string, setup?: LatexLanguageSetup) {
  const direction = latexDirectionOpening(source, setup);
  if (direction) return direction;
  const aligned = /^\\begin\{(flushleft|flushright|center)\}/u.exec(source);
  if (aligned)
    return {
      environment: aligned[1]!,
      from: aligned[0].length,
      layout: {
        kind: "alignment",
        alignment:
          aligned[1] === "flushleft" ? "start" : aligned[1] === "flushright" ? "end" : "center",
      },
    };
  const opening = /^\\begin\{(multicols|minipage)\}/u.exec(source);
  if (!opening) return null;
  const environment = opening[1]!;
  let from = opening[0].length;
  if (environment.startsWith("multicols")) {
    const count = argument(source, from);
    if (!count || !/^[2-9]$|^10$/u.test(count.value.trim())) return null;
    from = count.end;
    // Optional full-width headings and custom minimum heights remain source-owned.
    if (/^\s*\[/u.test(source.slice(from))) return null;
    return { environment, from, layout: { kind: "columns", columns: Number(count.value) } };
  }
  const align = argument(source, from, "[", "]");
  if (align) from = align.end;
  const alignment = align?.value.trim() ?? "c";
  if (!["t", "c", "b"].includes(alignment)) return null;
  const heightArg = argument(source, from, "[", "]");
  if (heightArg) from = heightArg.end;
  const height = heightArg ? latexLayoutLength(heightArg.value) : null;
  if (heightArg && (!height || height.endsWith("%"))) return null;
  const inner = heightArg ? argument(source, from, "[", "]") : null;
  if (inner) from = inner.end;
  const innerAlignment = inner?.value.trim() ?? alignment;
  if (!["t", "c", "b", "s"].includes(innerAlignment)) return null;
  const width = argument(source, from);
  if (!width) return null;
  const relative = /^((?:\d+(?:\.\d*)?|\.\d+)?)\s*\\(?:linewidth|textwidth|columnwidth)$/u.exec(
    width.value.trim(),
  );
  const inches = latexLengthInches(width.value);
  const amount = relative ? Number(relative[1] || "1") : inches;
  if (amount === null || amount <= 0 || (relative && amount > 1)) return null;
  return {
    environment,
    from: width.end,
    layout: {
      kind: "minipage",
      alignment,
      width: relative ? `${amount * 100}%` : `${amount}in`,
      ...(height ? { height, innerAlignment } : {}),
    },
  };
}

export function latexLayoutSpacing(source: string) {
  if (/^\\columnbreak(?:[\t ]*\[4\])?\s*$/u.test(source.trim())) return "columnbreak";
  return /^\\(smallskip|medskip|bigskip|vfill|hfill|noindent)$/u.exec(source.trim())?.[1] ?? null;
}
