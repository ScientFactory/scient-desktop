import {
  numericKeys,
  REFERENCE_HEADING,
  referenceIdentifiers,
  type ReferenceCitation,
  type ReferenceEntry,
} from "./referenceDocuments.ts";

/** One paragraph of a Word document as it reads: field results in, deleted text out. */
export interface WordParagraph {
  readonly text: string;
  /** The text of each superscript run, where numbered citations often sit. */
  readonly superscripts: ReadonlyArray<string>;
  readonly heading: boolean;
  readonly inTable: boolean;
}

/** What a reference manager stored: a field instruction, a Zotero bookmark's code or a content control's tag. */
export interface WordCode {
  readonly instruction: string;
  /** The field's `w:fldData` (base64), where EndNote keeps a citation too long for the instruction. */
  readonly data: string | null;
}

export interface WordContent {
  /** The body, in order: text, tables and text boxes. */
  readonly paragraphs: ReadonlyArray<WordParagraph>;
  /** Footnotes and endnotes: they can cite, but hold no reference list. */
  readonly notes: ReadonlyArray<WordParagraph>;
  readonly codes: ReadonlyArray<WordCode>;
}

export interface WordCitedWork {
  /** Tells the cited works apart: the reference manager's address for the work, else its DOI or title. */
  readonly id: string;
  /** Every address the reference manager gave the work, in its order. */
  readonly addresses: ReadonlyArray<string>;
  /** The details the document holds for the work, as a CSL-JSON item. */
  readonly item: Readonly<Record<string, unknown>>;
  /** False when the reference manager's list was told to leave the work out. */
  readonly listed: boolean;
}

export type WordReferences =
  | {
      /** Citations inserted with a reference manager: read from their data, not from the text. */
      readonly kind: "managed";
      readonly works: ReadonlyArray<WordCitedWork>;
      readonly citations: number;
      readonly hasList: boolean;
      /** Works the list holds without a citation; the document has no details for them. */
      readonly listedOnly: number;
      /** Cited works whose stored details could not be read. */
      readonly unreadable: number;
    }
  | {
      readonly kind: "text";
      readonly citations: ReadonlyArray<ReferenceCitation>;
      readonly entries: ReadonlyArray<ReferenceEntry>;
    };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const text = (value: unknown): string | null =>
  typeof value === "string" && value.trim() ? value.trim() : null;

/** The first JSON object in the text; reference managers write other text around it. */
function jsonObject(source: string): Record<string, unknown> | null {
  const start = source.indexOf("{");
  let depth = 0;
  let quoted = false;
  for (let at = start; at >= 0 && at < source.length; at++) {
    const character = source[at];
    if (quoted) {
      if (character === "\\") at++;
      else if (character === '"') quoted = false;
    } else if (character === '"') quoted = true;
    else if (character === "{") depth++;
    else if (character === "}" && --depth === 0) {
      try {
        const value: unknown = JSON.parse(source.slice(start, at + 1));
        return isRecord(value) ? value : null;
      } catch {
        return null;
      }
    }
  }
  return null;
}

function base64Text(value: string): string | null {
  try {
    const bytes = Uint8Array.from(atob(value.replace(/\s+/gu, "")), (character) =>
      character.charCodeAt(0),
    );
    return new TextDecoder(bytes[1] === 0 ? "utf-16le" : "utf-8").decode(bytes);
  } catch {
    return null;
  }
}

interface Cited {
  readonly id: string;
  /** Every address the reference manager gave the work; Zotero's list names works by these. */
  readonly addresses: ReadonlyArray<string>;
  readonly item: Readonly<Record<string, unknown>>;
}

/** A work without the manager's ID: by DOI, else by every detail, so look-alikes stay apart. */
function identityOf(item: Readonly<Record<string, unknown>>): string {
  const doi = text(item.DOI);
  if (doi) return `doi:${doi.toLowerCase()}`;
  // Mendeley Desktop numbers a citation's items ITEM-1, ITEM-2: not the work's.
  const { id: _id, ...details } = item;
  return `details:${JSON.stringify(details)}`;
}

/**
 * The works of one CSL citation, as Zotero and Mendeley store it; null for one without details.
 * Zotero and Mendeley Desktop name a work by its address, Mendeley Cite by its item ID.
 */
function cslWorks(
  citation: Record<string, unknown> | null,
  mendeleyCite: boolean,
): ReadonlyArray<Cited | null> {
  const items = Array.isArray(citation?.citationItems) ? citation.citationItems : [];
  if (items.length === 0) return [null];
  return items.map((entry: unknown) => {
    if (!isRecord(entry) || !isRecord(entry.itemData)) return null;
    const listed: unknown = entry.uris ?? entry.uri;
    const addresses = Array.isArray(listed)
      ? listed.filter((address): address is string => typeof address === "string")
      : [];
    const itemId = mendeleyCite ? text(entry.id) : null;
    return {
      id: addresses[0] ?? (itemId ? `mendeley:${itemId}` : identityOf(entry.itemData)),
      addresses,
      item: entry.itemData,
    };
  });
}

const XML_ENTITIES: Readonly<Record<string, string>> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
};

/** The text of an XML fragment: EndNote wraps values in `<style>` elements. */
function xmlText(fragment: string | undefined): string | null {
  return text(
    fragment
      ?.replace(/<[^>]*>/gu, "")
      .replace(/&(?:#(\d+)|#x([0-9a-f]+)|(\w+));/giu, (whole, decimal, hex, name: string) =>
        decimal
          ? String.fromCodePoint(Number(decimal))
          : hex
            ? String.fromCodePoint(Number.parseInt(hex, 16))
            : (XML_ENTITIES[name] ?? whole),
      )
      .replace(/\s+/gu, " "),
  );
}

const element = (xml: string, name: string) =>
  new RegExp(String.raw`<${name}\b[^>]*>([\s\S]*?)</${name}>`, "u").exec(xml)?.[1];

/** An EndNote record as a CSL-JSON item; EndNote writes names as "Family, Given". */
function endNoteWork(record: string): Cited {
  const value = (name: string, within = record) => xmlText(element(within, name));
  const authors = [
    ...(element(record, "authors") ?? "").matchAll(/<author\b[^>]*>([\s\S]*?)<\/author>/gu),
  ]
    .map((match) => xmlText(match[1]))
    .filter((name): name is string => name !== null)
    .map((name) => {
      const family = name.includes(",") ? text(name.split(",")[0]) : null;
      return family && !name.endsWith(",") ? { family } : { literal: name.replace(/,$/u, "") };
    });
  const key = /<key\b[^>]*\bdb-id="([^"]*)"[^>]*>([\s\S]*?)<\/key>/u.exec(record);
  const number = key ? `${key[1]}:${xmlText(key[2])}` : value("rec-number");
  const doi = referenceIdentifiers({ doi: value("electronic-resource-num") ?? "" }, null)[0];
  const year = value("year", element(record, "dates") ?? "");
  const item = Object.fromEntries(
    Object.entries({
      title: value("title", element(record, "titles") ?? ""),
      "container-title":
        value("secondary-title") ?? value("full-title", element(record, "periodical") ?? ""),
      volume: value("volume"),
      page: value("pages"),
      DOI: doi?.value ?? null,
      author: authors.length > 0 ? authors : null,
      issued: year ? { raw: year } : null,
    }).filter(([, held]) => held !== null),
  );
  return { id: number ? `endnote:${number}` : identityOf(item), addresses: [], item };
}

function endNoteWorks(code: WordCode): ReadonlyArray<Cited | null> {
  const xml = code.instruction.includes("<EndNote")
    ? code.instruction
    : code.data
      ? base64Text(code.data)
      : null;
  const cites = [...(xml ?? "").matchAll(/<Cite\b[^>]*>([\s\S]*?)<\/Cite>/gu)];
  if (cites.length === 0) return [null];
  return cites.map((cite) => {
    const record = element(cite[1]!, "record");
    return record ? endNoteWork(record) : null;
  });
}

const CSL_CITATION =
  /^\s*(?:ADDIN\s+)?(?:ZOTERO_(?:ITEM|CITATION)\b|(?:Mendeley Citation\{[^}]*\}\s*)?CSL_CITATION\b)/u;
const MENDELEY_CITE = /^MENDELEY_CITATION_v3_/u;
// EndNote nests an EN.CITE.DATA field with the same data inside EN.CITE; only the outer one counts.
const ENDNOTE_CITATION = /^\s*ADDIN\s+EN\.CITE(?![.\w])/u;
const ZOTERO_LIST = /^\s*(?:ADDIN\s+)?ZOTERO_BIBL\b/u;
const OTHER_LIST =
  /^\s*(?:ADDIN\s+)?(?:Mendeley Bibliography\b|CSL_BIBLIOGRAPHY\b|EN\.REFLIST\b)|^MENDELEY_BIBLIOGRAPHY\b/u;

/** The works a code cites, or null when the code is not a citation Scient reads. */
function citedBy(code: WordCode): ReadonlyArray<Cited | null> | null {
  const { instruction } = code;
  const csl = CSL_CITATION.exec(instruction);
  if (csl) return cslWorks(jsonObject(instruction.slice(csl[0].length)), false);
  if (MENDELEY_CITE.test(instruction)) {
    const stored = base64Text(instruction.replace(MENDELEY_CITE, ""));
    return cslWorks(stored === null ? null : jsonObject(stored), true);
  }
  return ENDNOTE_CITATION.test(instruction) ? endNoteWorks(code) : null;
}

function readManaged(codes: ReadonlyArray<WordCode>): WordReferences | null {
  const works = new Map<string, Cited>();
  const leftOut = new Set<string>();
  let citations = 0;
  let unreadable = 0;
  let hasList = false;
  let listedOnly = 0;
  for (const code of codes) {
    if (ZOTERO_LIST.test(code.instruction)) {
      hasList = true;
      // Zotero's list records what its editor changed: works added without a citation, and cited works left out.
      const edits = jsonObject(code.instruction);
      const added: unknown = edits?.uncited;
      listedOnly += Array.isArray(added)
        ? added.length
        : isRecord(added)
          ? Object.keys(added).length
          : 0;
      const omitted: ReadonlyArray<unknown> = Array.isArray(edits?.omitted) ? edits.omitted : [];
      for (const address of omitted.flat()) if (typeof address === "string") leftOut.add(address);
      continue;
    }
    if (OTHER_LIST.test(code.instruction)) {
      hasList = true;
      continue;
    }
    for (const work of citedBy(code) ?? []) {
      citations++;
      if (work === null) unreadable++;
      else if (!works.has(work.id)) works.set(work.id, work);
    }
  }
  if (citations === 0) return null;
  return {
    kind: "managed",
    works: [...works.values()].map(({ id, item, addresses }) => ({
      id,
      addresses,
      item,
      listed: !addresses.some((address) => leftOut.has(address)),
    })),
    citations,
    hasList,
    listedOnly,
    unreadable,
  };
}

const NUMBERS = /\d+(?:\s*[,–—-]\s*\d+)*/u.source;
const BRACKETED = new RegExp(String.raw`\[(${NUMBERS})\]`, "gu");
const PARENTHESISED = new RegExp(String.raw`\((${NUMBERS})\)`, "gu");
const ONLY_NUMBERS = new RegExp(String.raw`^[[(]?(${NUMBERS})[\])]?$`, "u");
const TYPED_NUMBER = /^(?:\[(\d+)\]\s*|(\d+)[.)]\s+|(\d+)\t\s*)(\S[\s\S]*)$/u;

const YEAR = String.raw`(?:1[5-9]|20|21)\d{2}[a-z]?`;
const WORD = String.raw`\p{Lu}[\p{L}\p{M}'’-]+`;
const NAME = String.raw`(?:(?:van|von|de|del|della|der|den|di|da|dos|du|la|le|ten|ter|el|al|bin|ibn)\s+)*${WORD}`;
const CO_AUTHOR = String.raw`${NAME}(?:\s+${WORD})?`;
/** "Smith et al., 2020", "Smith & Lee 2019a, 2019b" (inside brackets) or "Smith and Lee's (2020)". */
const AUTHOR_YEAR = new RegExp(
  String.raw`(?<![\p{L}\p{M}'’-])(${NAME})` +
    String.raw`(?:(?:,\s*${CO_AUTHOR})*,?\s*(?:and|&)\s*${CO_AUTHOR}|\s+et\s+al\.?)?` +
    String.raw`(?:(,?\s+)|\s*\(\s*)(${YEAR}(?:\s*,\s*${YEAR})*)(?![\p{L}\d])`,
  "gu",
);
const ENTRY_YEAR = new RegExp(String.raw`(?<![\p{L}\d])(${YEAR})(?![\p{L}\d])`, "u");
/** Capitalised words that stand before a year without being an author. */
const NOT_AN_AUTHOR = new Set(
  (
    "january february march april may june july august september october november december " +
    "jan feb mar apr jun jul aug sep sept oct nov dec spring summer autumn fall winter " +
    "in since until from between during after before by circa year version copyright " +
    "updated revised accessed published received accepted"
  ).split(" "),
);

const comparable = (value: string) =>
  value
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();

/** A list entry's first author and year: "Smith JA, Lee K. 2020" and "Smith, J. A. (2020)". */
function authorYearOf(raw: string): { readonly surname: string; readonly year: string } | null {
  const surname = (/^[^,.(\d;:]+/u.exec(raw)?.[0] ?? "").replace(/(?:\s+\p{Lu}{1,3})+\s*$/u, "");
  const year = ENTRY_YEAR.exec(raw)?.[1];
  return surname.trim() && year ? { surname: surname.trim(), year } : null;
}

/** How deep inside brackets each character is, so "Smith, 2020" counts only as a citation. */
function bracketDepths(paragraph: string): ReadonlyArray<number> {
  let depth = 0;
  return [...paragraph].map((character) => {
    if (character === "(" || character === "[") depth++;
    else if ((character === ")" || character === "]") && depth > 0) depth--;
    return depth;
  });
}

function readText({ paragraphs, notes }: WordContent): WordReferences {
  const heading = paragraphs.findLastIndex((paragraph) => REFERENCE_HEADING.test(paragraph.text));
  let end = heading < 0 ? 0 : heading + 1;
  while (
    end > 0 &&
    end < paragraphs.length &&
    !paragraphs[end]!.heading &&
    !paragraphs[end]!.inTable
  )
    end++;
  const listed = paragraphs.slice(heading + 1, end).flatMap((paragraph, offset) => {
    const typed = TYPED_NUMBER.exec(paragraph.text.trim());
    const raw = (typed?.[4] ?? paragraph.text).replace(/\s+/gu, " ").trim();
    const number = typed?.[1] ?? typed?.[2] ?? typed?.[3] ?? null;
    return raw ? [{ raw, number, line: heading + 2 + offset }] : [];
  });
  const numberOf = (entry: (typeof listed)[number], index: number) =>
    entry.number ?? String(index + 1);
  const numbers = new Set(listed.map(numberOf));

  const numbered: Array<ReferenceCitation> = [];
  const named: Array<{ readonly name: string; readonly year: string; readonly line: number }> = [];
  [...paragraphs, ...notes].forEach((paragraph, index) => {
    if (heading >= 0 && index >= heading && index < end) return;
    const line = index + 1;
    for (const match of paragraph.text.matchAll(BRACKETED)) {
      for (const key of numericKeys(match[1]!)) numbered.push({ key, line });
    }
    // A superscript or a number in parentheses is a citation only when the list has that entry.
    const loose = [
      ...paragraph.superscripts.flatMap((run) => ONLY_NUMBERS.exec(run.trim())?.[1] ?? []),
      ...[...paragraph.text.matchAll(PARENTHESISED)].map((match) => match[1]!),
    ];
    for (const list of loose) {
      const keys = numericKeys(list);
      if (keys.every((key) => numbers.has(key)))
        numbered.push(...keys.map((key) => ({ key, line })));
    }
    const depths = bracketDepths(paragraph.text);
    for (const match of paragraph.text.matchAll(AUTHOR_YEAR)) {
      if (match[2] !== undefined && depths[match.index] === 0) continue;
      const name = match[1]!.replace(/[’']s$/u, "");
      if (NOT_AN_AUTHOR.has(name.toLowerCase())) continue;
      for (const year of match[3]!.split(/\s*,\s*/u)) named.push({ name, year, line });
    }
  });

  const entry = (key: string, { raw, line }: (typeof listed)[number]): ReferenceEntry => ({
    key,
    kind: "typed",
    type: "typed",
    line,
    fields: {},
    fieldNames: [],
    raw,
    identifiers: referenceIdentifiers({}, raw),
  });
  if (listed.some(({ number }) => number !== null) || numbered.length >= named.length) {
    return {
      kind: "text",
      citations: numbered,
      entries: listed.map((item, index) => entry(numberOf(item, index), item)),
    };
  }
  const authors = listed.map((item, index) => {
    const found = authorYearOf(item.raw);
    return {
      item,
      key: found ? `${found.surname} ${found.year}` : String(index + 1),
      surname: found ? comparable(found.surname) : null,
      year: found?.year ?? null,
    };
  });
  // A citation names its entry by first author and year; a surname of several words may be cited by its last.
  const keyFor = (name: string, year: string) => {
    const cited = comparable(name);
    const sameYear = authors.filter((author) => author.year === year && author.surname !== null);
    const match =
      sameYear.find((author) => author.surname === cited) ??
      sameYear.find(
        (author) => author.surname!.endsWith(` ${cited}`) || cited.endsWith(` ${author.surname}`),
      );
    return match?.key ?? `${name} ${year}`;
  };
  return {
    kind: "text",
    citations: named.map(({ name, year, line }) => ({ key: keyFor(name, year), line })),
    entries: authors.map(({ key, item }) => entry(key, item)),
  };
}

/**
 * The references of a Word document. Citations a reference manager inserted carry the cited
 * works as data and are read from it; without any, the text and its reference list are read.
 */
export function readWordReferences(content: WordContent): WordReferences {
  return readManaged(content.codes) ?? readText(content);
}
