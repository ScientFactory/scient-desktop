import { latexWithoutComments } from "./latexPackages";

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

export interface BibliographyContainer {
  from: number;
  to: number;
  insertAt: number;
}

function groupEnd(source: string, start: number, open = "{", close = "}") {
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

/** Keep TeX offsets, labels and formatted entry bodies instead of reconstructing a list. */
export function manualBibliography(source: string) {
  const clean = latexWithoutComments(source);
  const entries: BibliographyEntry[] = [];
  const containers: BibliographyContainer[] = [];
  const pattern = /\\begin\s*\{thebibliography\}\s*\{/gu;
  let opening: RegExpExecArray | null;
  while ((opening = pattern.exec(clean))) {
    const widthEnd = groupEnd(clean, pattern.lastIndex - 1);
    const ending = /\\end\s*\{thebibliography\}/gu;
    ending.lastIndex = widthEnd + 1;
    const close = widthEnd >= 0 ? ending.exec(clean) : null;
    if (!close)
      return {
        entries,
        containers,
        error: "A manual bibliography is not closed. Repair it in Source first.",
      };
    const itemPattern = /\\bibitem\b\s*/gu;
    itemPattern.lastIndex = widthEnd + 1;
    const items: { from: number; commandEnd: number; key: string; label: string }[] = [];
    let item: RegExpExecArray | null;
    while ((item = itemPattern.exec(clean)) && item.index < close.index) {
      let cursor = itemPattern.lastIndex,
        label = "";
      if (clean[cursor] === "[") {
        // Braced text inside a label can contain literal closing brackets.
        let depth = 0,
          labelEnd = -1;
        for (let at = cursor + 1; at < close.index; at++) {
          if (clean[at] === "\\") at++;
          else if (clean[at] === "{") depth++;
          else if (clean[at] === "}") depth--;
          else if (clean[at] === "]" && depth === 0) {
            labelEnd = at;
            break;
          }
        }
        if (labelEnd < 0) return { entries, containers, error: "An entry label is not closed." };
        label = source.slice(cursor + 1, labelEnd);
        cursor = labelEnd + 1;
      }
      cursor += /^\s*/u.exec(clean.slice(cursor))![0].length;
      const end = clean[cursor] === "{" ? groupEnd(clean, cursor) : -1;
      if (end < 0 || end >= close.index)
        return { entries, containers, error: "An entry has no valid citation key." };
      const key = source.slice(cursor + 1, end);
      if (!validBibliographyKey(key))
        return { entries, containers, error: "An entry has an unsupported citation key." };
      items.push({ from: item.index, commandEnd: end + 1, key, label });
      itemPattern.lastIndex = end + 1;
    }
    items.forEach((item, index) => {
      const to = items[index + 1]?.from ?? close.index;
      const content = source.slice(item.commandEnd, to);
      const bodyFrom = item.commandEnd + /^\s*/u.exec(content)![0].length;
      const bodyTo = Math.max(bodyFrom, to - /\s*$/u.exec(content)![0].length);
      entries.push({
        key: item.key,
        kind: "bibitem",
        type: "bibitem",
        from: item.from,
        to,
        bodyFrom,
        bodyTo,
        body: source.slice(bodyFrom, bodyTo),
        label: item.label,
        fields: [],
        raw: source.slice(item.from, to),
      });
    });
    containers.push({
      from: opening.index,
      to: close.index + close[0].length,
      insertAt: close.index,
    });
    pattern.lastIndex = close.index + close[0].length;
  }
  return { entries, containers, error: null };
}

export function validBibliographyKey(key: string) {
  return !!key && !/[\s{},\\%#[\]]/u.test(key);
}

function replaceRanges(source: string, changes: { from: number; to: number; value: string }[]) {
  let next = source;
  for (const change of changes.sort((a, b) => b.from - a.from))
    next = next.slice(0, change.from) + change.value + next.slice(change.to);
  return next;
}

/** Only changed fields are replaced; unknown fields and BibTeX expressions retain their slices. */
function editedBibliographyEntrySource(
  entry: BibliographyEntry,
  draft: { type: string; fields: Record<string, string>; body: string; label: string },
) {
  if (entry.kind === "bibitem") {
    if (draft.body === entry.body && draft.label === entry.label) return entry.raw;
    if (draft.label === entry.label)
      return replaceRanges(entry.raw, [
        { from: entry.bodyFrom - entry.from, to: entry.bodyTo - entry.from, value: draft.body },
      ]);
    const eol = entry.raw.includes("\r\n") ? "\r\n" : "\n";
    return `\\bibitem${draft.label ? `[${draft.label}]` : ""}{${entry.key}} ${draft.body}${eol}`;
  }
  const changes: { from: number; to: number; value: string }[] = [];
  const additions: string[] = [];
  for (const [name, value] of Object.entries(draft.fields)) {
    const field = entry.fields.find((field) => field.name === name);
    if (field?.text === null || field?.text === value || (!field && !value)) continue;
    if (entry.fields.filter((field) => field.name === name).length > 1) return null;
    if (value && groupEnd(`{${value}}`, 0) !== value.length + 1) return null;
    if (field)
      changes.push(
        value
          ? {
              from: field.valueFrom - entry.from,
              to: field.valueTo - entry.from,
              value: `{${value}}`,
            }
          : { from: field.from - entry.from, to: field.to - entry.from, value: "" },
      );
    else additions.push(`  ${name} = {${value}},`);
  }
  if (draft.type !== entry.type) {
    if (!/^[A-Za-z]+$/u.test(draft.type)) return null;
    changes.push({ from: 1, to: 1 + entry.type.length, value: draft.type });
  }
  let next = replaceRanges(entry.raw, changes);
  if (additions.length) {
    const eol = entry.raw.includes("\r\n") ? "\r\n" : "\n";
    const end = next.length - 1;
    const before = next.slice(0, end).trimEnd();
    next = before + (before.endsWith(",") ? "" : ",") + eol + additions.join(eol) + eol + next[end];
  }
  return next;
}

export function bibliographyEntrySource(
  entry: BibliographyEntry,
  draft: {
    type: string;
    fields: Record<string, string>;
    body: string;
    label: string;
    isNew?: boolean;
    key?: string;
  },
) {
  const raw = editedBibliographyEntrySource(entry, draft);
  const key = draft.isNew ? draft.key : entry.key;
  if (!raw || key === entry.key) return raw;
  if (!key || !validBibliographyKey(key)) return null;
  return entry.kind === "bibtex"
    ? raw.replace(/^(@[A-Za-z]+\s*[({]\s*)[^,\s]+/u, (_match, prefix: string) => prefix + key)
    : raw.replace(
        /(\\bibitem\s*(?:\[[^\]]*\]\s*)?\{)[^{}]+\}/u,
        (_match, prefix: string) => prefix + key + "}",
      );
}

export function bibliographyEntryTitle(entry: BibliographyEntry) {
  return entry.kind === "bibtex"
    ? (entry.fields.find((field) => field.name === "title")?.text ?? entry.key)
    : entry.body
        .replace(/\\(?:emph|textit|textbf)\s*\{/gu, "")
        .replace(/[{}]/gu, "")
        .replace(/\s+/gu, " ")
        .slice(0, 180) || entry.key;
}

export function replaceBibliographyEntry(source: string, entry: BibliographyEntry, raw: string) {
  if (source.slice(entry.from, entry.to) !== entry.raw) return null;
  const parsed =
    entry.kind === "bibtex"
      ? bibtexEntries(raw)
      : manualBibliography(`\\begin{thebibliography}{99}\n${raw}\n\\end{thebibliography}`);
  if (parsed.error || parsed.entries.length !== 1 || parsed.entries[0]?.key !== entry.key)
    return null;
  if (entry.kind === "bibtex" && parsed.entries[0]!.raw.trim() !== raw.trim()) return null;
  return source.slice(0, entry.from) + raw + source.slice(entry.to);
}

export function addBibliographyEntry(
  source: string,
  kind: "bibitem" | "bibtex",
  key: string,
  raw: string,
  insertAt?: number,
) {
  if (!validBibliographyKey(key)) return null;
  const parsed =
    kind === "bibtex"
      ? bibtexEntries(raw)
      : manualBibliography(`\\begin{thebibliography}{99}\n${raw}\n\\end{thebibliography}`);
  if (parsed.error || parsed.entries.length !== 1 || parsed.entries[0]?.key !== key) return null;
  if (kind === "bibtex") {
    if (parsed.entries[0]!.raw.trim() !== raw.trim()) return null;
    const eol = source.includes("\r\n") ? "\r\n" : "\n";
    return (
      source +
      (source.endsWith("\n") || !source ? "" : eol) +
      eol +
      raw.trimEnd().replace(/\r?\n/gu, eol) +
      eol
    );
  }
  if (insertAt === undefined) return null;
  const eol = source.includes("\r\n") ? "\r\n" : "\n";
  return (
    source.slice(0, insertAt) + raw.trimEnd().replace(/\r?\n/gu, eol) + eol + source.slice(insertAt)
  );
}

/** Rebase one entry edit over unrelated writing; concurrent edits to that entry are rejected. */
export function mergeBibliographyChange(
  expected: string,
  next: string,
  current: string,
  kind: "bibitem" | "bibtex",
) {
  if (current === expected) return next;
  if (current === next) return current;
  const parse = (source: string) =>
    kind === "bibtex" ? bibtexEntries(source) : manualBibliography(source);
  const before = parse(expected),
    after = parse(next),
    live = parse(current);
  if (before.error || after.error || live.error) return null;
  if (
    [before, after, live].some(
      (parsed) => new Set(parsed.entries.map((entry) => entry.key)).size !== parsed.entries.length,
    )
  )
    return null;
  const keys = new Set([...before.entries, ...after.entries].map((entry) => entry.key));
  const changed = [...keys].filter(
    (key) =>
      before.entries.find((entry) => entry.key === key)?.raw !==
      after.entries.find((entry) => entry.key === key)?.raw,
  );
  if (changed.length !== 1) return null;
  const key = changed[0]!;
  const original = before.entries.find((entry) => entry.key === key);
  const replacement = after.entries.find((entry) => entry.key === key);
  const existing = live.entries.find((entry) => entry.key === key);
  if (existing && replacement && existing.raw === replacement.raw) return current;
  if (original) {
    if (!existing || existing.raw !== original.raw) return null;
    return replacement
      ? replaceBibliographyEntry(current, existing, replacement.raw)
      : current.slice(0, existing.from) + current.slice(existing.to);
  }
  if (!replacement || existing) return null;
  if (kind === "bibtex") return addBibliographyEntry(current, kind, key, replacement.raw);
  const afterContainers = manualBibliography(next).containers;
  const originalContainers = manualBibliography(expected).containers;
  const containers = manualBibliography(current).containers;
  if (
    containers.length !== originalContainers.length ||
    afterContainers.length !== containers.length
  )
    return null;
  const index = afterContainers.findIndex(
    (container) => replacement.from > container.from && replacement.to <= container.insertAt,
  );
  if (index < 0) return null;
  return addBibliographyEntry(current, kind, key, replacement.raw, containers[index]?.insertAt);
}
