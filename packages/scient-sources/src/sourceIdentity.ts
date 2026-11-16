import { canonicalConnectorIdentifier } from "./connectorIdentifiers.ts";
import { isbn13 } from "./identifierInput.ts";
import type { ScientSourceFieldProvenance, ScientSourceIdentifier } from "./model.ts";
import { normalizePersistentIdentifier, scientSourceTitleIsFileName } from "./normalize.ts";

// These schemes identify one scholarly work. Container-level identifiers such
// as ISSN and ISBN are still preserved as metadata, but they must never prove
// that two articles or chapters are the same work. OpenAlex and Semantic Scholar IDs name one
// work in their catalogue.
const WORK_LEVEL_IDENTIFIER_SCHEMES = new Set(["arxiv", "doi", "pmcid", "pmid", "openalex", "s2"]);

/** The arXiv ID a DOI of arXiv's own names (`10.48550/arXiv.1706.03762`); null for any other DOI. */
export function arxivIdOfDoi(doi: string): string | null {
  return (
    /^doi:10\.48550\/arxiv\.(.+)$/u.exec(normalizePersistentIdentifier("doi", doi))?.[1] ?? null
  );
}

export function workLevelIdentifierKey(scheme: string, value: string): string | null {
  const normalizedScheme = scheme.trim().toLowerCase();
  if (!WORK_LEVEL_IDENTIFIER_SCHEMES.has(normalizedScheme)) return null;
  const canonical =
    normalizedScheme === "openalex" || normalizedScheme === "s2"
      ? (canonicalConnectorIdentifier(normalizedScheme, value) ?? value)
      : value;
  // arXiv's DOI for a deposit and its arXiv ID are one identity, however a source names it.
  const arxiv = normalizedScheme === "doi" ? arxivIdOfDoi(canonical) : null;
  return normalizePersistentIdentifier(arxiv ? "arxiv" : normalizedScheme, arxiv ?? canonical);
}

/**
 * Why two records were not taken for one work. Missing titles and unknown types are no
 * corroboration; `merge-undone` and `merge-record-unreadable` come from the Library's own records.
 */
export type ScientLibraryIdentityProblem =
  | "merge-undone"
  | "merge-record-unreadable"
  | "title-missing"
  | "titles-differ"
  | "type-unknown"
  | "preprint-and-published"
  | "types-differ"
  | "arxiv-versions-differ"
  | "identifiers-conflict";

function identifierKey(identifier: ScientSourceIdentifier): string {
  const scheme = identifier.scheme.trim().toLowerCase();
  // ISBN-10 and ISBN-13 spellings of one book are not two ISBNs.
  const isbn = scheme === "isbn" ? isbn13(identifier.value) : null;
  return (
    (isbn ? `isbn:${isbn}` : null) ??
    workLevelIdentifierKey(identifier.scheme, identifier.value) ??
    normalizePersistentIdentifier(identifier.scheme, identifier.value)
  );
}

function identifierKeysByScheme(
  identifiers: ReadonlyArray<ScientSourceIdentifier>,
): Map<string, Set<string>> {
  const byScheme = new Map<string, Set<string>>();
  for (const identifier of identifiers) {
    const key = identifierKey(identifier);
    const scheme = key.slice(0, key.indexOf(":"));
    const keys = byScheme.get(scheme) ?? new Set<string>();
    keys.add(key);
    byScheme.set(scheme, keys);
  }
  return byScheme;
}

/** Both name a scheme (DOI, ISBN, …) and share none of its values. */
function keysConflict(
  left: ReadonlyMap<string, ReadonlySet<string>>,
  right: ReadonlyMap<string, ReadonlySet<string>>,
): boolean {
  for (const [scheme, keys] of left) {
    const other = right.get(scheme);
    if (other && ![...keys].some((key) => other.has(key))) return true;
  }
  return false;
}

export function scientSourceIdentifiersConflict(
  left: ReadonlyArray<ScientSourceIdentifier>,
  right: ReadonlyArray<ScientSourceIdentifier>,
): boolean {
  return keysConflict(identifierKeysByScheme(left), identifierKeysByScheme(right));
}

/** The explicit arXiv versions a record names, by base ID ("2101.00001" → {"v2"}). */
function arxivVersions(identifiers: ReadonlyArray<ScientSourceIdentifier>) {
  const versions = new Map<string, Set<string>>();
  for (const identifier of identifiers) {
    if (identifier.scheme.trim().toLowerCase() !== "arxiv") continue;
    const base = normalizePersistentIdentifier("arxiv", identifier.value);
    const version = /v(\d+)$/u.exec(
      identifier.value
        .trim()
        .toLowerCase()
        .replace(/\.pdf$/u, ""),
    )?.[1];
    if (!version) continue;
    const set = versions.get(base) ?? new Set<string>();
    set.add(version);
    versions.set(base, set);
  }
  return versions;
}

/** Case, Unicode form, spacing and punctuation only; every word and number stays. */
export function scientSourceTitleKey(record: { readonly title: string | null }): string {
  return (record.title ?? "")
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/** What identity is judged on: a library record, an incoming candidate, or a project's snapshot. */
export interface ScientLibraryIdentityFields {
  readonly type: string;
  readonly title: string | null;
  readonly identifiers: ReadonlyArray<ScientSourceIdentifier>;
  /** Where its fields came from: a title that is only the file's name is no title here. */
  readonly fieldProvenance?: ReadonlyArray<
    Pick<ScientSourceFieldProvenance, "field" | "origin" | "sourceField">
  >;
}

/**
 * A source whose only DOIs are arXiv's names a deposit there, a preprint, whatever a registry
 * called it. A type a person or an agent set stands.
 */
function identityType(fields: ScientLibraryIdentityFields): string {
  const chosen = fields.fieldProvenance?.some(
    (entry) => entry.field === "type" && (entry.origin === "user" || entry.origin === "agent"),
  );
  if (chosen) return fields.type;
  const dois = fields.identifiers.filter(
    (identifier) => identifier.scheme.trim().toLowerCase() === "doi",
  );
  return dois.length > 0 && dois.every((identifier) => arxivIdOfDoi(identifier.value) !== null)
    ? "preprint"
    : fields.type;
}

export interface ScientLibraryIdentityFacts {
  readonly title: string;
  readonly type: string;
  readonly keys: ReadonlyMap<string, ReadonlySet<string>>;
  readonly arxiv: ReadonlyMap<string, ReadonlySet<string>>;
}

export function scientLibraryIdentityFacts(
  fields: ScientLibraryIdentityFields,
): ScientLibraryIdentityFacts {
  return {
    title: scientSourceTitleIsFileName(fields) ? "" : scientSourceTitleKey(fields),
    type: identityType(fields),
    keys: identifierKeysByScheme(fields.identifiers),
    arxiv: arxivVersions(fields.identifiers),
  };
}

export function scientLibraryFactsProblem(
  left: ScientLibraryIdentityFacts,
  right: ScientLibraryIdentityFacts,
): ScientLibraryIdentityProblem | null {
  if (!left.title || !right.title) return "title-missing";
  if (left.title !== right.title) return "titles-differ";
  if (left.type === "other" || right.type === "other") return "type-unknown";
  if (left.type !== right.type) {
    return left.type === "preprint" || right.type === "preprint"
      ? "preprint-and-published"
      : "types-differ";
  }
  for (const [base, versions] of left.arxiv) {
    const other = right.arxiv.get(base);
    if (other && ![...versions].some((version) => other.has(version))) {
      return "arxiv-versions-differ";
    }
  }
  if (keysConflict(left.keys, right.keys)) return "identifiers-conflict";
  return null;
}

/**
 * Null when two records corroborate being one work: titles that agree once case, Unicode form,
 * spacing and punctuation are evened out, one known type, the same explicit arXiv version, and no
 * scheme both name without a shared value. The automatic merge pass, intake and project
 * resolution all use it.
 */
export function scientLibraryIdentityProblem(
  left: ScientLibraryIdentityFields,
  right: ScientLibraryIdentityFields,
): ScientLibraryIdentityProblem | null {
  return scientLibraryFactsProblem(
    scientLibraryIdentityFacts(left),
    scientLibraryIdentityFacts(right),
  );
}

/**
 * Null when nothing supplied about an incoming source contradicts a stored one: intake's rule.
 * A missing title or an unknown type is no contradiction there (a bare DOI selects the copy that
 * carries it); two titles that differ, two known types that differ, different explicit arXiv
 * versions or a scheme both name without a shared value are.
 */
export function scientSourceIntakeProblem(
  incoming: ScientLibraryIdentityFields,
  stored: ScientLibraryIdentityFields,
): ScientLibraryIdentityProblem | null {
  const left = scientLibraryIdentityFacts(incoming);
  const right = scientLibraryIdentityFacts(stored);
  // Only facts both sides supply are compared; the rest of the rule is the merge rule's.
  const known = (value: string, other: string, unknown: string) =>
    value === unknown || other === unknown ? null : value;
  return scientLibraryFactsProblem(
    {
      ...left,
      title: known(left.title, right.title, "") ?? "?",
      type: known(left.type, right.type, "other") ?? "?",
    },
    {
      ...right,
      title: known(right.title, left.title, "") ?? "?",
      type: known(right.type, left.type, "other") ?? "?",
    },
  );
}

/** The first creator's family name (or whole name), for telling two versions of one work. */
export function scientSourceFirstCreatorKey(source: {
  readonly creators: ReadonlyArray<{
    readonly familyName: string | null;
    readonly literalName: string | null;
  }>;
}): string {
  const [first] = source.creators;
  return (first?.familyName ?? first?.literalName ?? "").trim().toLocaleLowerCase();
}

/**
 * A preprint and a paper published since, with one title and first author and no identifier
 * that disagrees: likely two versions of one work (years can differ). Listed for the person;
 * a preprint is never merged into its published paper on its own.
 */
export function scientSourcesMayBeVersions(
  left: ScientLibraryIdentityFields & Parameters<typeof scientSourceFirstCreatorKey>[0],
  right: ScientLibraryIdentityFields & Parameters<typeof scientSourceFirstCreatorKey>[0],
): boolean {
  const [one, other] = [scientLibraryIdentityFacts(left), scientLibraryIdentityFacts(right)];
  const creator = scientSourceFirstCreatorKey(left);
  const types = [one.type, other.type];
  return (
    one.title !== "" &&
    one.title === other.title &&
    creator !== "" &&
    creator === scientSourceFirstCreatorKey(right) &&
    types.filter((type) => type === "preprint").length === 1 &&
    !types.includes("other") &&
    !scientSourceIdentifiersConflict(left.identifiers, right.identifiers)
  );
}

/**
 * One PDF on two records is evidence only when it is not a book's PDF on its parts: two chapters,
 * or a chapter and its book, with different titles share it without being one work.
 */
export function scientSourcePdfIsEvidence(
  left: ScientLibraryIdentityFields,
  right: ScientLibraryIdentityFields,
): boolean {
  if (scientSourceTitleKey(left) === scientSourceTitleKey(right)) return true;
  const types = [left.type, right.type];
  return !(
    types.includes("book-chapter") &&
    types.every((type) => type === "book-chapter" || type === "book")
  );
}
