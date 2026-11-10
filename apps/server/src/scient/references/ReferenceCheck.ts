// @effect-diagnostics nodeBuiltinImport:off -- Reference checks read project files and keep an ignore list on disk.
// @effect-diagnostics globalDate:off -- Reports and ignore entries carry interoperable timestamps.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import {
  missingBibtexFields,
  normalizePersistentIdentifier,
  readReferenceDocument,
  referenceDocumentKind,
  SCIENT_REFERENCE_CHECK_LIMITS,
  SCIENT_REFERENCE_FINDING_SEVERITY,
  SCIENT_REFERENCE_IGNORE_FILE,
  ScientReferenceIgnoreList,
  type ReferenceEntry,
  type ScientReferenceCheckReport,
  type ScientReferenceCheckTarget,
  type ScientReferenceFinding,
  type ScientReferenceFix,
  type ScientReferenceLedgerEntry,
  type ScientReferenceLocation,
  type ScientReferenceStatus,
  type ScientSourceIdentifier,
  type ScientSourceRecord,
  type ScientSourceType,
  sourceIdentifierLabel,
  sourceIdentifierRegistryName,
} from "@scientfactory/scient-sources";
import { resolveScientProjectFile } from "@scientfactory/scient-sources/project-files";
import { listScientSourceRecords } from "@scientfactory/scient-sources/store";
import * as Context from "effect/Context";
import * as Schema from "effect/Schema";

import {
  resolveSourceIdentifierBatch,
  verifiableSourceIdentifier,
  type SourceIdentifierResolution,
} from "../sources/SourceIdentifierResolver.ts";
import {
  BIBTEX_FIELD_FOR,
  describesDifferentWork,
  detailFindings,
  registryCitation,
  registryCreators,
  registryStatusFindings,
  registryValue,
  SOURCE_FIELD_FOR,
  type ClaimedReference,
  type ComparableField,
  type FindingDraft,
} from "./referenceComparison.ts";

/** A user-safe failure: its message names project paths only, never absolute ones. */
export class ReferenceCheckError extends Schema.TaggedError<ReferenceCheckError>()(
  "ReferenceCheckError",
  { message: Schema.String },
) {}

export const isReferenceCheckError = Schema.is(ReferenceCheckError);

const MAX_DOCUMENT_BYTES = 5 * 1024 * 1024;
const MAX_IGNORE_BYTES = 1024 * 1024;
const MAX_IGNORED_FINDINGS = 5_000;
const LOOKUP_CHUNK = 24;
const PARALLEL_CHUNKS = 2;
/** Lookups not started by then count as unavailable, so a slow registry cannot hold a check open. */
const LOOKUP_BUDGET_MS = 90_000;
const DOCUMENT_EXTENSIONS = [".md", ".markdown", ".qmd", ".rmd", ".tex", ".ltx", ".bib"];
export const SKIPPED_DIRECTORIES = new Set([
  "node_modules",
  "__pycache__",
  "venv",
  "build",
  "dist",
]);

/** The shared resolver's batch lookup; each identifier resolves as its own work. */
export type ResolveIdentifierBatch = (
  identifiers: ReadonlyArray<ScientSourceIdentifier>,
) => Promise<ReadonlyArray<SourceIdentifierResolution>>;

export const ReferenceIdentifierLookup = Context.Reference<ResolveIdentifierBatch>(
  "scient/references/ReferenceIdentifierLookup",
  { defaultValue: () => (identifiers) => resolveSourceIdentifierBatch(identifiers) },
);

export interface ReferenceCheckOptions {
  readonly resolveIdentifiers: ResolveIdentifierBatch;
  readonly now?: () => Date;
}

type MissingField = { readonly name: string; readonly field: ComparableField | "author" | null };

interface Subject {
  readonly scopeKey: string;
  readonly key: string | null;
  readonly label: string | null;
  readonly location: ScientReferenceLocation | null;
  readonly sourceId: string | null;
  readonly claimed: ClaimedReference;
  readonly missing: ReadonlyArray<MissingField>;
  readonly fixFor: (field: ComparableField, value: string) => ScientReferenceFix | null;
}

interface Placed {
  readonly subject: Subject | null;
  readonly draft: FindingDraft;
  readonly registry: ScientReferenceFinding["registry"];
  /** For findings about a citation rather than a listed reference. */
  readonly citation?: { readonly key: string; readonly location: ScientReferenceLocation };
}

const text = (value: string | null | undefined) => {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
};

const parseYear = (value: string | null | undefined) => {
  const match = value?.match(/(?:^|\D)(1[5-9]\d{2}|20\d{2}|21\d{2})(?:\D|$)/u);
  return match?.[1] ? Number(match[1]) : null;
};

function bibtexFirstAuthor(authors: string | undefined): string | null {
  const first = authors?.split(/\s+and\s+/iu)[0]?.trim();
  if (!first) return null;
  return first.includes(",") ? text(first.split(",")[0]) : text(first.split(/\s+/u).at(-1));
}

function label(value: string | null): string | null {
  if (!value) return null;
  return value.length > 160 ? `${value.slice(0, 157)}…` : value;
}

const BIBTEX_MISSING_FIELD: Readonly<Record<string, ComparableField | "author">> = {
  author: "author",
  editor: "author",
  title: "title",
  journal: "container",
  booktitle: "container",
  year: "year",
  publisher: "publisher",
  pages: "pages",
};

function bibtexSubject(entry: ReferenceEntry, path: string): Subject {
  const { fields } = entry;
  const containerField =
    (["journal", "journaltitle", "booktitle"] as const).find((name) =>
      entry.fieldNames.includes(name),
    ) ??
    (/^(inproceedings|conference|incollection|inbook)$/u.test(entry.type)
      ? "booktitle"
      : "journal");
  const raw = entry.kind === "bibtex" ? null : entry.raw;
  return {
    scopeKey: `${path}#${entry.key}`,
    key: entry.key,
    label: label(text(fields.title) ?? raw),
    location: { path, line: entry.line },
    sourceId: null,
    claimed: {
      title: text(fields.title),
      firstAuthor: bibtexFirstAuthor(fields.author ?? fields.editor),
      year: parseYear(fields.year ?? fields.date),
      container: text(fields.journal ?? fields.journaltitle ?? fields.booktitle),
      volume: text(fields.volume),
      pages: text(fields.pages),
      raw,
      identifiers: entry.identifiers,
    },
    missing: missingBibtexFields(entry).map((name) => ({
      name,
      field: BIBTEX_MISSING_FIELD[name] ?? null,
    })),
    fixFor: (field, value) => {
      if (entry.kind !== "bibtex" || !path.toLowerCase().endsWith(".bib")) return null;
      const name =
        field === "container"
          ? containerField
          : (BIBTEX_FIELD_FOR[field].find((candidate) => entry.fieldNames.includes(candidate)) ??
            BIBTEX_FIELD_FOR[field][0]!);
      // A macro or concatenated value cannot be compared safely, so it is left alone.
      if (entry.fieldNames.includes(name) && fields[name] === undefined) return null;
      if (
        field === "year" &&
        !entry.fieldNames.includes("year") &&
        entry.fieldNames.includes("date")
      ) {
        return null;
      }
      return {
        kind: "bibtex-field",
        path,
        key: entry.key,
        field: name,
        current: fields[name] ?? null,
        value,
      };
    },
  };
}

const REQUIRED_SOURCE_FIELDS: Readonly<Record<ScientSourceType, ReadonlyArray<MissingField>>> = {
  article: [
    { name: "author", field: "author" },
    { name: "title", field: "title" },
    { name: "journal", field: "container" },
    { name: "year", field: "year" },
  ],
  "conference-paper": [
    { name: "author", field: "author" },
    { name: "title", field: "title" },
    { name: "proceedings title", field: "container" },
    { name: "year", field: "year" },
  ],
  "book-chapter": [
    { name: "author", field: "author" },
    { name: "title", field: "title" },
    { name: "book title", field: "container" },
    { name: "year", field: "year" },
  ],
  book: [
    { name: "author", field: "author" },
    { name: "title", field: "title" },
    { name: "publisher", field: "publisher" },
    { name: "year", field: "year" },
  ],
  preprint: [
    { name: "author", field: "author" },
    { name: "title", field: "title" },
    { name: "year", field: "year" },
  ],
  thesis: [
    { name: "author", field: "author" },
    { name: "title", field: "title" },
    { name: "year", field: "year" },
  ],
  report: [
    { name: "title", field: "title" },
    { name: "year", field: "year" },
  ],
  dataset: [{ name: "title", field: "title" }],
  web: [{ name: "title", field: "title" }],
  other: [{ name: "title", field: "title" }],
};

function sourceSubject(record: ScientSourceRecord): Subject {
  const creator = record.creators[0];
  const present: Readonly<Record<ComparableField | "author", boolean>> = {
    author: record.creators.length > 0,
    title: Boolean(text(record.title)),
    container: Boolean(text(record.containerTitle)),
    year: record.issuedYear !== null,
    publisher: Boolean(text(record.publisher)),
    volume: Boolean(text(record.volume)),
    pages: Boolean(text(record.pages)),
  };
  return {
    scopeKey: `library#${record.sourceId}`,
    key: record.citationKey ?? null,
    label: label(text(record.title)),
    location: null,
    sourceId: record.sourceId,
    claimed: {
      title: text(record.title),
      firstAuthor: text(creator?.familyName ?? creator?.literalName),
      year: record.issuedYear,
      container: text(record.containerTitle),
      volume: text(record.volume),
      pages: text(record.pages),
      raw: null,
      identifiers: record.identifiers,
    },
    missing: REQUIRED_SOURCE_FIELDS[record.type].filter(({ field }) => field && !present[field]),
    fixFor: (field, value) => ({
      kind: "source-field",
      sourceId: record.sourceId,
      expectedRevision: record.revision,
      field: SOURCE_FIELD_FOR[field],
      value,
    }),
  };
}

const CslItem = Schema.Struct({
  id: Schema.Union([Schema.String, Schema.Number]),
  type: Schema.optionalKey(Schema.String),
  title: Schema.optionalKey(Schema.String),
  "container-title": Schema.optionalKey(Schema.String),
  DOI: Schema.optionalKey(Schema.String),
  PMID: Schema.optionalKey(Schema.String),
  volume: Schema.optionalKey(Schema.Union([Schema.String, Schema.Number])),
  page: Schema.optionalKey(Schema.String),
  author: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        family: Schema.optionalKey(Schema.String),
        literal: Schema.optionalKey(Schema.String),
      }),
    ),
  ),
  issued: Schema.optionalKey(
    Schema.Struct({
      "date-parts": Schema.optionalKey(
        Schema.Array(Schema.Array(Schema.Union([Schema.String, Schema.Number]))),
      ),
      raw: Schema.optionalKey(Schema.String),
    }),
  ),
});
const decodeCslItems = Schema.decodeUnknownSync(Schema.Array(Schema.Unknown));
const decodeCslItem = Schema.decodeUnknownOption(CslItem);
const decodeIgnoreList = Schema.decodeUnknownSync(ScientReferenceIgnoreList);

function cslSubjects(source: string, path: string): ReadonlyArray<Subject> {
  return decodeCslItems(JSON.parse(source)).flatMap((value) => {
    const item = decodeCslItem(value);
    if (item._tag === "None") return [];
    const csl = item.value;
    const key = String(csl.id);
    const at = source.indexOf(JSON.stringify(key));
    const line = at < 0 ? 1 : source.slice(0, at).split("\n").length;
    const identifiers: Array<ScientSourceIdentifier> = [];
    if (text(csl.DOI)) identifiers.push({ scheme: "doi", value: csl.DOI!.trim() });
    if (text(csl.PMID)) identifiers.push({ scheme: "pmid", value: csl.PMID!.trim() });
    const issued = csl.issued?.["date-parts"]?.[0]?.[0];
    return [
      {
        scopeKey: `${path}#${key}`,
        key,
        label: label(text(csl.title)),
        location: { path, line },
        sourceId: null,
        claimed: {
          title: text(csl.title),
          firstAuthor: text(csl.author?.[0]?.family ?? csl.author?.[0]?.literal),
          year: issued === undefined ? parseYear(csl.issued?.raw) : parseYear(String(issued)),
          container: text(csl["container-title"]),
          volume: csl.volume === undefined ? null : text(String(csl.volume)),
          pages: text(csl.page),
          raw: null,
          identifiers,
        },
        missing: [],
        fixFor: () => null,
      },
    ];
  });
}

function findingId(scope: string, subjectKey: string, kind: string, detail: string): string {
  return NodeCrypto.createHash("sha256")
    .update(JSON.stringify([scope, subjectKey, kind, detail.toLowerCase()]))
    .digest("hex")
    .slice(0, 24);
}

async function canonicalRoot(root: string): Promise<string> {
  return NodeFSP.realpath(root).catch(() => {
    throw new ReferenceCheckError({ message: "The project folder could not be opened." });
  });
}

async function readProjectText(root: string, relativePath: string, description: string) {
  const file = await resolveScientProjectFile(root, relativePath, {
    extensions: DOCUMENT_EXTENSIONS.concat(".json"),
    description,
  }).catch((error: unknown) => {
    throw new ReferenceCheckError({
      message: error instanceof Error ? error.message : "The file could not be read.",
    });
  });
  const stats = await NodeFSP.stat(file.absolutePath);
  if (stats.size > MAX_DOCUMENT_BYTES) {
    throw new ReferenceCheckError({
      message: `${file.relativePath} is too large to check (over 5 MB).`,
    });
  }
  return { ...file, text: await NodeFSP.readFile(file.absolutePath, "utf8") };
}

async function readIgnoreList(root: string): Promise<ScientReferenceIgnoreList> {
  const path = NodePath.join(root, ...SCIENT_REFERENCE_IGNORE_FILE.split("/"));
  try {
    const stats = await NodeFSP.lstat(path);
    if (!stats.isFile() || stats.size > MAX_IGNORE_BYTES) return { formatVersion: 1, findings: [] };
    return decodeIgnoreList(JSON.parse(await NodeFSP.readFile(path, "utf8")));
  } catch {
    return { formatVersion: 1, findings: [] };
  }
}

async function writeIgnoreList(root: string, list: ScientReferenceIgnoreList): Promise<void> {
  const path = NodePath.join(root, ...SCIENT_REFERENCE_IGNORE_FILE.split("/"));
  await NodeFSP.mkdir(NodePath.dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${NodeCrypto.randomUUID()}`;
  try {
    await NodeFSP.writeFile(temporary, `${JSON.stringify(list, null, 2)}\n`, { flag: "wx" });
    await NodeFSP.rename(temporary, path);
  } finally {
    await NodeFSP.rm(temporary, { force: true });
  }
}

interface Collected {
  readonly subjects: ReadonlyArray<Subject>;
  readonly files: ReadonlyArray<string>;
  readonly citations: number;
  readonly bookkeeping: ReadonlyArray<Placed>;
  readonly notes: ReadonlyArray<string>;
  readonly complete: boolean;
}

async function collectLibrary(
  root: string,
  sourceIds: ReadonlyArray<string> | undefined,
): Promise<Collected> {
  const wanted = sourceIds ? new Set(sourceIds) : null;
  const records = (await listScientSourceRecords(root)).filter(
    (record) => wanted === null || wanted.has(record.sourceId),
  );
  return {
    subjects: records.map(sourceSubject),
    files: [],
    citations: 0,
    bookkeeping: [],
    notes: records.length === 0 ? ["The Library has no sources yet."] : [],
    complete: true,
  };
}

/** The Library key a citation names; Library keys are unique without regard to case. */
function libraryKey(key: string, byKey: ReadonlyMap<string, ReadonlyArray<Subject>>): string {
  const lower = key.toLowerCase();
  for (const [listed, subjects] of byKey) {
    if (subjects[0]!.sourceId !== null && listed.toLowerCase() === lower) return listed;
  }
  return key;
}

async function collectDocument(root: string, path: string): Promise<Collected> {
  const document = await readProjectText(root, path, "document");
  const kind = referenceDocumentKind(document.relativePath);
  if (kind === null) {
    throw new ReferenceCheckError({
      message: "Choose a Markdown (.md), LaTeX (.tex) or BibTeX (.bib) file.",
    });
  }
  const parsed = readReferenceDocument(kind, document.text);
  const notes: Array<string> = [];
  let complete = true;
  if (parsed.parseError) {
    notes.push(`${document.relativePath}: ${parsed.parseError}`);
    complete = false;
  }
  const files = [document.relativePath];
  const subjects: Array<Subject> = parsed.entries.map((entry) =>
    bibtexSubject(entry, document.relativePath),
  );
  const directory = NodePath.posix.dirname(document.relativePath);
  for (const written of parsed.bibliographyPaths) {
    const relative = NodePath.posix.normalize(NodePath.posix.join(directory, written));
    if (files.includes(relative)) continue;
    const lower = relative.toLowerCase();
    if (!lower.endsWith(".bib") && !lower.endsWith(".json")) {
      notes.push(`${written} was not read: only .bib and CSL-JSON bibliographies are checked.`);
      complete = false;
      continue;
    }
    try {
      const bibliography = await readProjectText(root, relative, "bibliography file");
      files.push(bibliography.relativePath);
      if (lower.endsWith(".json")) {
        subjects.push(...cslSubjects(bibliography.text, bibliography.relativePath));
        continue;
      }
      const bib = readReferenceDocument("bibtex", bibliography.text);
      if (bib.parseError) {
        notes.push(`${bibliography.relativePath}: ${bib.parseError}`);
        complete = false;
      }
      subjects.push(...bib.entries.map((entry) => bibtexSubject(entry, bibliography.relativePath)));
    } catch (error) {
      notes.push(
        isReferenceCheckError(error)
          ? error.message
          : `The bibliography file ${written} could not be read.`,
      );
      complete = false;
    }
  }

  const citedLines = new Map<string, number>();
  for (const citation of parsed.citations) {
    if (!citedLines.has(citation.key)) citedLines.set(citation.key, citation.line);
  }
  const listedKeys = new Set(subjects.flatMap((subject) => (subject.key ? [subject.key] : [])));
  const unlisted = [...citedLines.keys()].filter((key) => !listedKeys.has(key));
  if (kind !== "bibtex" && unlisted.length > 0) {
    // Citations can name Library sources by citation key, as Markdown [@key] inserts them.
    const wanted = new Set(unlisted.map((key) => key.toLowerCase()));
    const library = await listScientSourceRecords(root).catch(() => []);
    subjects.push(
      ...library
        .filter((record) => record.citationKey && wanted.has(record.citationKey.toLowerCase()))
        .map(sourceSubject),
    );
  }

  const bookkeeping: Array<Placed> = [];
  const byKey = new Map<string, Array<Subject>>();
  for (const subject of subjects) {
    if (subject.key === null) continue;
    byKey.set(subject.key, [...(byKey.get(subject.key) ?? []), subject]);
  }
  for (const [key, listed] of byKey) {
    if (listed.length < 2) continue;
    bookkeeping.push({
      subject: listed[1]!,
      draft: {
        kind: "duplicate-key",
        message: `The key ${key} is used by ${listed.length} entries; citations can only reach one of them.`,
        detail: key,
      },
      registry: null,
    });
  }
  const hasBibliography = subjects.length > 0 || parsed.bibliographyPaths.length > 0;
  if (kind !== "bibtex" && parsed.citations.length > 0 && !hasBibliography) {
    notes.push(
      `No bibliography was found for ${document.relativePath}, so its ${parsed.citations.length} citations could not be matched.`,
    );
    complete = false;
  }
  const isListed = (key: string) => byKey.has(key) || byKey.has(libraryKey(key, byKey));
  if (hasBibliography) {
    for (const [key, line] of citedLines) {
      if (isListed(key)) continue;
      bookkeeping.push({
        subject: null,
        draft: {
          kind: "cited-not-listed",
          message: `${key} is cited but has no bibliography entry.`,
          detail: key,
        },
        registry: null,
        citation: { key, location: { path: document.relativePath, line } },
      });
    }
  }
  const citesEverything = kind === "latex" && /\\nocite\s*\{\s*\*\s*\}/u.test(document.text);
  if (kind !== "bibtex" && citedLines.size > 0 && !citesEverything) {
    for (const [key, listed] of byKey) {
      if (citedLines.has(key) || listed[0]!.sourceId !== null) continue;
      bookkeeping.push({
        subject: listed[0]!,
        draft: {
          kind: "listed-not-cited",
          message: `${key} is in the bibliography but never cited.`,
          detail: key,
        },
        registry: null,
      });
    }
  }
  return {
    subjects,
    files,
    citations: parsed.citations.length,
    bookkeeping,
    notes,
    complete,
  };
}

type Outcome = { readonly status: "no-identifier" } | SourceIdentifierResolution;

function subjectFindings(subject: Subject, outcome: Outcome): ReadonlyArray<Placed> {
  const placed = (
    draft: FindingDraft,
    registry: ScientReferenceFinding["registry"] = null,
  ): Placed => ({ subject, draft, registry });
  const findings: Array<Placed> = [];
  if (outcome.status === "not-found") {
    findings.push(
      placed({
        kind: "identifier-not-found",
        message: `${sourceIdentifierLabel(outcome.identifier)} was not found at ${sourceIdentifierRegistryName(outcome.identifier)}. Find the work's correct identifier before citing it.`,
        detail: normalizePersistentIdentifier(outcome.identifier.scheme, outcome.identifier.value),
      }),
    );
  }
  const metadata = outcome.status === "found" ? outcome.metadata : null;
  if (outcome.status === "found" && metadata) {
    const registry = {
      title: metadata.title,
      creators: registryCreators(metadata),
      issuedYear: metadata.issuedYear,
      containerTitle: metadata.containerTitle,
      identifier: outcome.identifier,
    };
    if (describesDifferentWork(subject.claimed, metadata)) {
      findings.push(
        placed(
          {
            kind: "identifier-mismatch",
            message: `${sourceIdentifierLabel(outcome.identifier)} belongs to a different work: ${registryCitation(metadata)}.`,
            detail: normalizePersistentIdentifier(
              outcome.identifier.scheme,
              outcome.identifier.value,
            ),
          },
          registry,
        ),
      );
      return findings;
    }
    for (const draft of registryStatusFindings(subject.claimed, metadata, outcome.identifier)) {
      findings.push(placed(draft, registry));
    }
    for (const draft of detailFindings(subject.claimed, metadata, outcome.identifier)) {
      findings.push(placed(draft, registry));
    }
  }
  for (const missing of subject.missing) {
    const value = metadata && missing.field ? registryValue(metadata, missing.field) : null;
    findings.push(
      placed({
        kind: "missing-field",
        message: value
          ? `The ${missing.name} is missing; the registry has “${value}”.`
          : `The ${missing.name} is missing.`,
        detail: `${missing.name}:${value ?? ""}`,
        ...(value && missing.field && missing.field !== "author"
          ? { fix: { field: missing.field, value } }
          : {}),
      }),
    );
  }
  return findings;
}

const SEVERITY_ORDER = { problem: 0, warning: 1, note: 2 } as const;

export async function checkReferences(
  input: { readonly root: string; readonly target: ScientReferenceCheckTarget },
  options: ReferenceCheckOptions,
): Promise<ScientReferenceCheckReport> {
  const root = await canonicalRoot(input.root);
  const now = options.now ?? (() => new Date());
  const startedAt = now().getTime();
  const collected =
    input.target.kind === "library"
      ? await collectLibrary(root, input.target.sourceIds)
      : await collectDocument(root, input.target.path);
  const scope = input.target.kind === "library" ? "library" : collected.files[0]!;
  const notes = [...collected.notes];
  let complete = collected.complete;
  const subjects = collected.subjects.slice(0, SCIENT_REFERENCE_CHECK_LIMITS.references);
  if (collected.subjects.length > subjects.length) {
    notes.push(
      `Only the first ${subjects.length} of ${collected.subjects.length} references were checked.`,
    );
    complete = false;
  }

  const keyOf = (identifier: ScientSourceIdentifier) => `${identifier.scheme}:${identifier.value}`;
  const wanted = subjects.map((subject) => verifiableSourceIdentifier(subject.claimed.identifiers));
  const distinct = [
    ...new Map(
      wanted.flatMap((identifier) => (identifier ? [[keyOf(identifier), identifier]] : [])),
    ).values(),
  ];
  const chunks = Array.from({ length: Math.ceil(distinct.length / LOOKUP_CHUNK) }, (_, index) =>
    distinct.slice(index * LOOKUP_CHUNK, (index + 1) * LOOKUP_CHUNK),
  );
  const answers = new Map<string, SourceIdentifierResolution>();
  for (let start = 0; start < chunks.length; start += PARALLEL_CHUNKS) {
    if (now().getTime() - startedAt > LOOKUP_BUDGET_MS) break;
    const settled = await Promise.all(
      chunks
        .slice(start, start + PARALLEL_CHUNKS)
        .map((chunk) => options.resolveIdentifiers(chunk).catch(() => [])),
    );
    for (const resolution of settled.flat()) answers.set(keyOf(resolution.identifier), resolution);
  }
  const outcomes = wanted.map((identifier): Outcome =>
    identifier === null
      ? { status: "no-identifier" }
      : (answers.get(keyOf(identifier)) ?? { status: "unavailable", identifier }),
  );

  const placed: Array<Placed> = [...collected.bookkeeping];
  const firstByWork = new Map<string, Subject>();
  outcomes.forEach((outcome, index) => {
    const subject = subjects[index]!;
    placed.push(...subjectFindings(subject, outcome));
    if (outcome.status !== "found") return;
    const work = normalizePersistentIdentifier(outcome.identifier.scheme, outcome.identifier.value);
    const first = firstByWork.get(work);
    if (!first) {
      firstByWork.set(work, subject);
      return;
    }
    placed.push({
      subject,
      draft: {
        kind: "same-work",
        message: `This is the same work as ${first.key ?? first.label ?? "another entry"} (${sourceIdentifierLabel(outcome.identifier)}).`,
        detail: work,
      },
      registry: null,
    });
  });

  const ignored = new Set((await readIgnoreList(root)).findings.map(({ findingId }) => findingId));
  const built = placed.map((entry): ScientReferenceFinding => {
    const { subject, citation, draft } = entry;
    const id = findingId(
      scope,
      subject?.scopeKey ?? `${scope}#${citation?.key ?? ""}`,
      draft.kind,
      draft.detail,
    );
    return {
      findingId: id,
      kind: draft.kind,
      severity: SCIENT_REFERENCE_FINDING_SEVERITY[draft.kind],
      key: subject?.key ?? citation?.key ?? null,
      label: subject?.label ?? null,
      location: subject?.location ?? citation?.location ?? null,
      sourceId: subject?.sourceId ?? null,
      message: draft.message,
      registry: entry.registry,
      related: draft.related ?? null,
      fix: draft.fix && subject ? subject.fixFor(draft.fix.field, draft.fix.value) : null,
      ignored: ignored.has(id),
    };
  });
  const problemSubjects = new Set(
    placed.flatMap((entry, index) =>
      entry.subject && built[index]!.severity === "problem" && !built[index]!.ignored
        ? [entry.subject]
        : [],
    ),
  );
  const findings = built.toSorted(
    (left, right) =>
      Number(left.ignored) - Number(right.ignored) ||
      SEVERITY_ORDER[left.severity] - SEVERITY_ORDER[right.severity] ||
      (left.location?.path ?? "").localeCompare(right.location?.path ?? "") ||
      (left.location?.line ?? 0) - (right.location?.line ?? 0),
  );
  const ledger = subjects.map((subject, index): ScientReferenceLedgerEntry => {
    const outcome = outcomes[index]!;
    const status: ScientReferenceStatus = problemSubjects.has(subject)
      ? "problem"
      : outcome.status === "no-identifier" || outcome.status === "unavailable"
        ? outcome.status
        : "ok";
    const identifier = outcome.status === "no-identifier" ? null : outcome.identifier;
    return {
      key: subject.key,
      label: subject.label,
      location: subject.location,
      sourceId: subject.sourceId,
      identifier,
      status,
    };
  });
  const unavailable = outcomes.filter((outcome) => outcome.status === "unavailable").length;
  if (unavailable > 0) {
    notes.push(
      `${unavailable === 1 ? "One reference" : `${unavailable} references`} could not be checked because the registry did not answer. Check again later.`,
    );
    complete = false;
  }
  const shown = findings.slice(0, SCIENT_REFERENCE_CHECK_LIMITS.findings);
  return {
    target: input.target.kind === "library" ? { kind: "library" } : { kind: "file", path: scope },
    checkedAt: now().toISOString(),
    files: collected.files,
    references: subjects.length,
    citations: collected.citations,
    checked: outcomes.filter(
      (outcome) => outcome.status === "found" || outcome.status === "not-found",
    ).length,
    noIdentifier: outcomes.filter((outcome) => outcome.status === "no-identifier").length,
    unavailable,
    complete,
    findings: shown,
    omittedFindings: findings.length - shown.length,
    ledger,
    notes,
  };
}

/** Project files a reference check can read, nearest first; hidden and tool folders are skipped. */
export async function listReferenceDocuments(
  root: string,
): Promise<{ readonly paths: ReadonlyArray<string>; readonly truncated: boolean }> {
  const base = await canonicalRoot(root);
  const paths: Array<string> = [];
  const limit = 300;
  let truncated = false;
  const queue: Array<{ readonly directory: string; readonly depth: number }> = [
    { directory: "", depth: 0 },
  ];
  while (queue.length > 0) {
    const { directory, depth } = queue.shift()!;
    const entries = await NodeFSP.readdir(NodePath.join(base, ...directory.split("/")), {
      withFileTypes: true,
    }).catch(() => []);
    for (const entry of entries.toSorted((left, right) => left.name.localeCompare(right.name))) {
      if (entry.name.startsWith(".")) continue;
      const relative = directory ? `${directory}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (depth < 6 && !SKIPPED_DIRECTORIES.has(entry.name)) {
          queue.push({ directory: relative, depth: depth + 1 });
        }
      } else if (entry.isFile() && referenceDocumentKind(entry.name) !== null) {
        if (paths.length >= limit) {
          truncated = true;
          break;
        }
        paths.push(relative);
      }
    }
    if (truncated) break;
  }
  return { paths, truncated };
}

export { canonicalRoot, readIgnoreList, writeIgnoreList, MAX_IGNORED_FINDINGS };
