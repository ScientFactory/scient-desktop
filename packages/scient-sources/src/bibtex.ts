/** Positional BibTeX reading shared by the LaTeX editor and the reference checker. */
export interface BibliographyField {
  name: string;
  from: number;
  to: number;
  valueFrom: number;
  valueTo: number;
  text: string | null;
}

export interface BibliographyEntry {
  key: string;
  kind: "bibitem" | "bibtex";
  type: string;
  from: number;
  to: number;
  bodyFrom: number;
  bodyTo: number;
  body: string;
  label: string;
  fields: BibliographyField[];
  raw: string;
}

export function groupEnd(source: string, start: number, open = "{", close = "}") {
  let depth = 1,
    braces = 0,
    quoted = false;
  for (let at = start + 1; at < source.length; at++) {
    const character = source[at];
    if (character === "\\") {
      at++;
      continue;
    }
    if (open === "(") {
      if (character === "{") braces++;
      else if (character === "}") braces--;
      else if (character === '"' && braces === 0) quoted = !quoted;
      if (braces !== 0 || quoted) continue;
    }
    if (character === open) depth++;
    else if (character === close && --depth === 0) return at;
  }
  return -1;
}

function valueEnd(source: string, start: number, end: number) {
  let braces = 0,
    quoted = false;
  for (let at = start; at < end; at++) {
    const character = source[at];
    if (character === "\\") {
      at++;
      continue;
    }
    if (character === "{") braces++;
    else if (character === "}") braces--;
    else if (character === '"' && braces === 0) quoted = !quoted;
    else if (character === "," && braces === 0 && !quoted) return at;
    if (braces < 0) return -1;
  }
  return braces === 0 && !quoted ? end : -1;
}

function literalValue(value: string) {
  if (value.startsWith("{") && groupEnd(value, 0) === value.length - 1) return value.slice(1, -1);
  if (value.startsWith('"')) {
    let braces = 0;
    for (let at = 1; at < value.length; at++) {
      if (value[at] === "\\") at++;
      else if (value[at] === "{") braces++;
      else if (value[at] === "}") braces--;
      else if (value[at] === '"' && braces === 0)
        return at === value.length - 1 ? value.slice(1, -1) : null;
    }
  }
  return /^\d+$/u.test(value) ? value : null;
}

/** Parse entry boundaries and literal fields; macros and unrelated records stay untouched. */
export function bibtexEntries(source: string): {
  entries: BibliographyEntry[];
  error: string | null;
} {
  const entries: BibliographyEntry[] = [];
  for (let at = 0; at < source.length;) {
    if (source[at] === "%") {
      at = source.indexOf("\n", at);
      if (at < 0) break;
    }
    if (source[at] !== "@") {
      at++;
      continue;
    }
    const command = /^@([A-Za-z]+)\s*([({])/u.exec(source.slice(at));
    if (!command) {
      at++;
      continue;
    }
    const opening = at + command[0].length - 1;
    const end = groupEnd(source, opening, command[2]!, command[2] === "{" ? "}" : ")");
    if (end < 0)
      return {
        entries,
        error: "An entry has an unclosed group. Open the file in Source to repair it.",
      };
    const type = command[1]!;
    if (/^(comment|string|preamble)$/iu.test(type)) {
      at = end + 1;
      continue;
    }
    const key = /^\s*([^,\s{}]+)\s*,/u.exec(source.slice(opening + 1, end));
    if (!key) return { entries, error: "An entry has no valid citation key." };
    const bodyFrom = opening + 1 + key[0].length;
    const fields: BibliographyField[] = [];
    let cursor = bodyFrom;
    while (cursor < end) {
      const gap = /^[\s,]*/u.exec(source.slice(cursor, end))![0];
      cursor += gap.length;
      if (cursor >= end) break;
      if (source[cursor] === "%") {
        const lineEnd = source.indexOf("\n", cursor);
        cursor = lineEnd < 0 ? end : lineEnd + 1;
        continue;
      }
      const field = /^([A-Za-z][A-Za-z0-9_-]*)\s*=\s*/u.exec(source.slice(cursor, end));
      if (!field)
        return {
          entries,
          error: `Could not parse the fields of ${key[1]}. Its source was preserved.`,
        };
      const valueFrom = cursor + field[0].length;
      const stop = valueEnd(source, valueFrom, end);
      if (stop < 0) return { entries, error: `A field in ${key[1]} has an unclosed value.` };
      const value = source.slice(valueFrom, stop).trimEnd();
      fields.push({
        name: field[1]!.toLowerCase(),
        from: cursor,
        to: Math.min(stop + 1, end),
        valueFrom,
        valueTo: valueFrom + value.length,
        text: literalValue(value),
      });
      cursor = stop + 1;
    }
    entries.push({
      key: key[1]!,
      kind: "bibtex",
      type,
      from: at,
      to: end + 1,
      bodyFrom,
      bodyTo: end,
      body: source.slice(bodyFrom, end),
      label: "",
      fields,
      raw: source.slice(at, end + 1),
    });
    if (entries.length >= 2000 && source.slice(end + 1).includes("@"))
      return {
        entries,
        error:
          "This bibliography has more entries than the panel can manage. Edit its full Source instead.",
      };
    at = end + 1;
  }
  return { entries, error: null };
}
