import { latexLengthInches } from "./latexVisualLayout";
import { latexWithoutComments } from "./latexPackages";

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

export function latexPageLayoutOpening(source: string) {
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
  const width = argument(source, from);
  if (!width) return null;
  const relative = /^(\d+(?:\.\d*)?|\.\d+)\s*\\(?:linewidth|textwidth|columnwidth)$/u.exec(
    width.value.trim(),
  );
  const inches = latexLengthInches(width.value);
  const amount = relative ? Number(relative[1]) : inches;
  if (amount === null || amount <= 0 || (relative && amount > 1)) return null;
  return {
    environment,
    from: width.end,
    layout: { kind: "minipage", alignment, width: relative ? `${amount * 100}%` : `${amount}in` },
  };
}

export function latexLayoutSpacing(source: string) {
  if (/^\\columnbreak(?:[\t ]*\[4\])?\s*$/u.test(source.trim())) return "columnbreak";
  return /^\\(smallskip|medskip|bigskip|vfill|hfill|noindent)$/u.exec(source.trim())?.[1] ?? null;
}

/** Common fancyhdr slots and geometry offsets, scoped to the literal root preamble. */
export function latexRunningPageStyle(source: string) {
  const clean = latexWithoutComments(source.split(/\\begin\{document\}/u)[0] ?? "");
  let style = "plain",
    depth = 0,
    skip = 0;
  const fields: { kind: "head" | "foot" | "hf"; places: string; source: string }[] = [];
  let headRulePt = 0.4,
    footRulePt = 0;
  let headHeightIn = 12 / 72.27,
    headSepIn = 25 / 72.27,
    footSkipIn = 30 / 72.27;
  const geometryLengths = (options: string) => {
    for (const match of options.matchAll(
      /\b(headheight|headsep|footskip)\s*=\s*([\d.]+\s*(?:in|cm|mm|pt|bp|pc))/gu,
    )) {
      const inches = latexLengthInches(match[2]!);
      if (inches === null) continue;
      if (match[1] === "headheight") headHeightIn = inches;
      if (match[1] === "headsep") headSepIn = inches;
      if (match[1] === "footskip") footSkipIn = inches;
    }
  };
  for (const match of clean.matchAll(/\\([A-Za-z]+|[^\r\n])|[{}]/gu)) {
    if (match.index < skip) continue;
    if (match[0] === "{") depth++;
    else if (match[0] === "}") depth--;
    if (depth !== 0 || !match[1]) continue;
    const at = match.index + match[0].length;
    if (match[1] === "usepackage" || match[1] === "RequirePackage") {
      const options = argument(clean, at, "[", "]");
      const names = argument(clean, options?.end ?? at);
      if (names) {
        if (names.value.split(",").some((name) => name.trim() === "geometry"))
          geometryLengths(options?.value ?? "");
        skip = names.end;
      }
    } else if (match[1] === "geometry") {
      const options = argument(clean, at);
      if (options) {
        geometryLengths(options.value);
        skip = options.end;
      }
    } else if (match[1] === "pagestyle") {
      const value = argument(clean, at);
      if (value) {
        style = value.value.trim();
        skip = value.end;
      }
    } else if (/^fancy(?:head|foot|hf)$/u.test(match[1])) {
      const places = argument(clean, at, "[", "]");
      const value = argument(clean, places?.end ?? at);
      if (!value || (places && !/^[LEORCFH,\s]*$/iu.test(places.value))) continue;
      fields.push({
        kind: match[1] === "fancyhead" ? "head" : match[1] === "fancyfoot" ? "foot" : "hf",
        places: places?.value.toUpperCase() ?? "",
        source: value.value,
      });
      skip = value.end;
    } else if (match[1] === "renewcommand") {
      const name = argument(clean, at),
        value = name && argument(clean, name.end);
      if (value) {
        const inches = latexLengthInches(value.value);
        if (inches !== null && inches >= 0) {
          if (name!.value.trim() === "\\headrulewidth") headRulePt = inches * 72.27;
          if (name!.value.trim() === "\\footrulewidth") footRulePt = inches * 72.27;
        }
        skip = value.end;
      }
    } else if (match[1] === "setlength") {
      const name = argument(clean, at),
        value = name && argument(clean, name.end);
      const inches = value && latexLengthInches(value.value);
      if (inches !== null && inches !== undefined && inches >= 0) {
        if (name!.value.trim() === "\\headheight") headHeightIn = inches;
        if (name!.value.trim() === "\\headsep") headSepIn = inches;
        if (name!.value.trim() === "\\footskip") footSkipIn = inches;
      }
      if (value) skip = value.end;
    }
  }
  return { style, fields, headRulePt, footRulePt, headHeightIn, headSepIn, footSkipIn };
}

export function latexRunningPageFields(
  setup: ReturnType<typeof latexRunningPageStyle>,
  page: number,
  leftMark: string,
  rightMark: string,
  pageLabel: string | null = String(page),
) {
  const head = ["", "", ""],
    foot = ["", setup.style === "empty" ? "" : "\\thepage", ""];
  if (setup.style === "fancy") {
    head[0] = "\\rightmark";
    head[2] = "\\leftmark";
    for (const field of setup.fields) {
      for (const place of field.places.split(",")) {
        if (place.includes("E") && !place.includes("O") && page % 2 === 1) continue;
        if (place.includes("O") && !place.includes("E") && page % 2 === 0) continue;
        const slots = ["L", "C", "R"].filter(
          (slot) => !/[LCR]/u.test(place) || place.includes(slot),
        );
        const bands =
          field.kind === "head"
            ? [head]
            : field.kind === "foot"
              ? [foot]
              : place.includes("H") && !place.includes("F")
                ? [head]
                : place.includes("F") && !place.includes("H")
                  ? [foot]
                  : [head, foot];
        for (const band of bands)
          for (const slot of slots) band[["L", "C", "R"].indexOf(slot)] = field.source;
      }
    }
  }
  const literalMark = (text: string) =>
    text.replace(/[\\{}#$%&_~^]/gu, (character) =>
      character === "\\"
        ? "\\textbackslash{}"
        : character === "~"
          ? "\\textasciitilde{}"
          : character === "^"
            ? "\\textasciicircum{}"
            : "\\" + character,
    );
  const expand = (text: string) =>
    text.replace(/\\(thepage|leftmark|rightmark)\b/gu, (_token, name: string) =>
      name === "thepage"
        ? (pageLabel ?? "")
        : literalMark(name === "leftmark" ? leftMark : rightMark),
    );
  return pageLabel === null
    ? { head: ["", "", ""], foot: ["", "", ""] }
    : { head: head.map(expand), foot: foot.map(expand) };
}
