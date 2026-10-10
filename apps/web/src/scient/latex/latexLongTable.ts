import type { DocumentMathMacro } from "./latexDocumentMacros";
import { latexWithoutComments } from "./latexPackages";

function argument(source: string, from: number) {
  while (/\s/u.test(source[from] ?? "")) from++;
  if (source[from] !== "{") return null;
  let depth = 1;
  for (let at = from + 1; at < source.length; at++) {
    if (source[at] === "\\") at++;
    else if (source[at] === "{") depth++;
    else if (source[at] === "}" && --depth === 0)
      return { end: at + 1, value: source.slice(from + 1, at) };
  }
  return null;
}

/** Section delimiters are alignment commands, not rows or printed cell text. */
export function longTableSections(source: string, from: number, to: number) {
  const clean = latexWithoutComments(source);
  const sections = new Map<string, { from: number; to: number }>();
  let cursor = from,
    depth = 0;
  for (const token of clean.slice(from, to).matchAll(/\\([A-Za-z]+|[^\r\n])|[{}]/gu)) {
    if (token[0] === "{") depth++;
    else if (token[0] === "}") depth--;
    if (
      depth !== 0 ||
      !["endfirsthead", "endhead", "endfoot", "endlastfoot"].includes(token[1] ?? "")
    )
      continue;
    const at = from + token.index;
    const key = token[1]!.slice(3);
    if (sections.has(key)) return null;
    sections.set(key, { from: cursor, to: at });
    cursor = at + token[0].length;
  }
  return { sections, bodyFrom: cursor };
}

/** Expand bounded literal row templates only for projection; keep each call's physical range. */
export function expandLongTableRows(
  source: string,
  from: number,
  to: number,
  macros: Readonly<Record<string, DocumentMathMacro>>,
) {
  const clean = latexWithoutComments(source);
  const expansions: { from: number; to: number; virtualFrom: number; virtualTo: number }[] = [];
  let virtual = "",
    cursor = 0,
    skip = from,
    depth = 0;
  for (const token of clean.slice(from, to).matchAll(/\\([A-Za-z]+|[^\r\n])|[{}]/gu)) {
    const at = from + token.index;
    if (at < skip) continue;
    if (token[0] === "{") depth++;
    else if (token[0] === "}") depth--;
    if (depth !== 0 || !token[1]) continue;
    const macro = Object.hasOwn(macros, token[1]) ? macros[token[1]] : undefined;
    if (!macro || !macro.def.includes("&") || !macro.def.includes("\\\\")) continue;
    let end = at + token[0].length;
    const values: string[] = [];
    for (let index = 0; index < macro.args; index++) {
      const value = argument(source, end);
      if (!value || value.end > to) return null;
      values.push(value.value);
      end = value.end;
    }
    const text = macro.def.replace(
      /\\(?:[A-Za-z]+|[^\r\n])|#([1-9])/gu,
      (token, index: string | undefined) => (index ? (values[Number(index) - 1] ?? "") : token),
    );
    virtual += source.slice(cursor, at);
    const virtualFrom = virtual.length;
    virtual += text;
    expansions.push({ from: at, to: end, virtualFrom, virtualTo: virtual.length });
    cursor = end;
    skip = end;
    if (virtual.length + source.length - cursor > 100000) return null;
  }
  return { virtual: virtual + source.slice(cursor), expansions };
}

/** Mask non-body source while retaining the offsets used by ordinary cell patching. */
export function longTableVisibleBody(
  source: string,
  from: number,
  to: number,
  parts: NonNullable<ReturnType<typeof longTableSections>>,
) {
  const first = parts.sections.get("firsthead") ??
    parts.sections.get("head") ?? { from: parts.bodyFrom, to };
  const text = source.slice(from, to).split("");
  const mask = (start: number, end: number) => {
    for (let at = Math.max(start, from); at < Math.min(end, to); at++)
      if (!/[\r\n]/u.test(source[at]!)) text[at - from] = " ";
  };
  if (first) {
    mask(from, first.from);
    mask(first.to, parts.bodyFrom);
    const clean = latexWithoutComments(source);
    for (const command of clean.slice(first.from, first.to).matchAll(/\\(caption|label)\b/gu)) {
      const at = first.from + command.index;
      const value = argument(clean, at + command[0].length);
      if (!value) return null;
      mask(at, value.end);
    }
    // A caption is a full-width alignment row. Its row terminator is not a data row.
    const caption = /^\s*(?:\\caption\b)/u.exec(clean.slice(first.from, first.to));
    if (caption) {
      const separator = clean.indexOf("\\\\", first.from + caption[0].length);
      if (separator >= 0 && separator < first.to) mask(first.from, separator + 2);
    }
  }
  return text.join("");
}

export function physicalLongTablePatches(
  raw: string,
  virtual: string,
  expansions: NonNullable<ReturnType<typeof expandLongTableRows>>["expansions"],
  patches: { from: number; to: number; value: string; outsideExpansion?: boolean }[],
) {
  const physical: typeof patches = [];
  const grouped = new Map<number, typeof patches>();
  const offset = (position: number) =>
    position -
    expansions.reduce(
      (delta, entry) =>
        delta +
        (entry.virtualTo <= position
          ? entry.virtualTo - entry.virtualFrom - (entry.to - entry.from)
          : 0),
      0,
    );
  for (const patch of patches) {
    if (
      !Number.isInteger(patch.from) ||
      !Number.isInteger(patch.to) ||
      patch.from < 0 ||
      patch.to < patch.from ||
      patch.to > virtual.length
    )
      return null;
    const index = expansions.findIndex(
      (entry) =>
        !patch.outsideExpansion && patch.from >= entry.virtualFrom && patch.to <= entry.virtualTo,
    );
    if (index >= 0) {
      const list = grouped.get(index) ?? [];
      list.push(patch);
      grouped.set(index, list);
    } else {
      if (expansions.some((entry) => patch.from < entry.virtualTo && patch.to > entry.virtualFrom))
        return null;
      physical.push({ ...patch, from: offset(patch.from), to: offset(patch.to) });
    }
  }
  for (const [index, list] of grouped) {
    const entry = expansions[index]!;
    let value = virtual.slice(entry.virtualFrom, entry.virtualTo);
    for (const patch of list.sort((a, b) => b.from - a.from))
      value =
        value.slice(0, patch.from - entry.virtualFrom) +
        patch.value +
        value.slice(patch.to - entry.virtualFrom);
    physical.push({ from: entry.from, to: entry.to, value });
  }
  let result = raw,
    boundary = raw.length;
  for (const patch of physical.sort((a, b) => b.from - a.from || b.to - a.to)) {
    if (patch.from < 0 || patch.to > boundary || patch.to < patch.from) return null;
    result = result.slice(0, patch.from) + patch.value + result.slice(patch.to);
    boundary = patch.from;
  }
  return result;
}
