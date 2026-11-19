// @effect-diagnostics nodeBuiltinImport:off -- Reads project documents and bibliographies beside the Promise-based Sources store.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import {
  citationKeyComparisonValue,
  normalizePersistentIdentifier,
  readReferenceDocument,
  type ReferenceDocument,
  type ScientSourceIdentifier,
} from "@scientfactory/scient-sources";
import { resolveScientProjectFile } from "@scientfactory/scient-sources/project-files";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { maskLatexComments } from "./citationKeyRename.ts";
import { MANAGED_BIBLIOGRAPHY_FILES } from "./ManagedBibliography.ts";

const MAX_DOCUMENT_BYTES = 16 * 1024 * 1024;
const MANAGED_FILES: ReadonlySet<string> = new Set(MANAGED_BIBLIOGRAPHY_FILES);
/** The identifiers that tell two references apart; ISBNs name editions, not works. */
const COMPARED_SCHEMES: ReadonlySet<string> = new Set(["doi", "pmid", "arxiv"]);

/** The file's text, or why it was not read. */
async function readProjectText(
  absolutePath: string,
): Promise<string | { readonly problem: string }> {
  const stats = await NodeFSP.lstat(absolutePath).catch(() => null);
  if (!stats?.isFile()) return { problem: "The file could not be read." };
  if (stats.size > MAX_DOCUMENT_BYTES) return { problem: "Larger than 16 MB." };
  return NodeFSP.readFile(absolutePath, "utf8").catch(() => ({
    problem: "The file could not be read.",
  }));
}

/** True for the project's own `references.bib` or `references.json`, at its top folder. */
export function isManagedBibliography(path: string): boolean {
  return MANAGED_FILES.has(path.toLowerCase());
}

/** A work the project cites under one of its keys. */
export interface ProjectWork {
  readonly sourceId: string;
  readonly citationKey: string;
  readonly identifiers: ReadonlyArray<ScientSourceIdentifier>;
  readonly title: string | null;
  readonly year: number | null;
}

export type CitationKeyStatus = "library" | "unconfirmed" | "other-work" | "not-library";

/**
 * What one key names in one document (`CitationKeyStatus`, defined on `ScientSourceCitationKeys`).
 * `sourceIds` are the project works it may name (library and unconfirmed only); `bibliography`
 * the file that defines it or leaves it open, when there is one.
 */
export interface CitationKeyResolution {
  readonly status: CitationKeyStatus;
  readonly sourceIds: ReadonlyArray<string>;
  readonly bibliography: string | null;
}

interface BibliographyEntry {
  /** `scheme:normalized value` for the compared schemes. */
  readonly identifiers: ReadonlySet<string>;
  readonly title: string | null;
  readonly year: number | null;
}

/** A bibliography a document is read with: its keys, or why it was not read in full. */
interface Bibliography {
  readonly path: string;
  readonly entries: ReadonlyMap<string, BibliographyEntry> | null;
  readonly problem: string | null;
}

const CslEntry = Schema.Struct({
  id: Schema.Union([Schema.String, Schema.Number]),
  DOI: Schema.optionalKey(Schema.String),
  PMID: Schema.optionalKey(Schema.String),
  title: Schema.optionalKey(Schema.String),
  issued: Schema.optionalKey(Schema.Unknown),
});
const decodeCslItems = Schema.decodeUnknownSync(Schema.Array(Schema.Unknown));
const decodeCslEntry = Schema.decodeUnknownOption(CslEntry);

function comparableIdentifiers(identifiers: ReadonlyArray<ScientSourceIdentifier>) {
  return new Set(
    identifiers.flatMap(({ scheme, value }) => {
      const lower = scheme.toLowerCase();
      return COMPARED_SCHEMES.has(lower)
        ? [`${lower}:${normalizePersistentIdentifier(lower, value)}`]
        : [];
    }),
  );
}

/** A title compared without case, accents, punctuation or spacing. */
function comparableTitle(title: string | null | undefined): string | null {
  const value = (title ?? "")
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
  return value.length > 0 ? value : null;
}

function yearIn(value: string | null | undefined): number | null {
  const match = /(?<!\d)(\d{4})(?!\d)/u.exec(value ?? "");
  return match ? Number(match[1]) : null;
}

function entriesByKey(
  entries: Iterable<{
    readonly key: string;
    readonly identifiers: ReadonlyArray<ScientSourceIdentifier>;
    readonly title: string | null;
    readonly year: number | null;
  }>,
) {
  const byKey = new Map<string, BibliographyEntry>();
  for (const { key, identifiers, title, year } of entries) {
    const comparable = citationKeyComparisonValue(key);
    if (!byKey.has(comparable)) {
      byKey.set(comparable, {
        identifiers: comparableIdentifiers(identifiers),
        title: comparableTitle(title),
        year,
      });
    }
  }
  return byKey;
}

function documentEntries(document: ReferenceDocument) {
  return entriesByKey(
    document.entries.map((entry) => ({
      key: entry.key,
      identifiers: entry.identifiers,
      title: entry.fields["title"] ?? null,
      year: yearIn(entry.fields["year"] ?? entry.fields["date"]),
    })),
  );
}

function cslYear(issued: unknown): number | null {
  if (typeof issued !== "object" || issued === null) return null;
  const record = issued as Record<string, unknown>;
  const parts = record["date-parts"];
  if (Array.isArray(parts) && Array.isArray(parts[0])) {
    const year = Number(parts[0][0]);
    if (Number.isInteger(year)) return year;
  }
  for (const field of ["raw", "literal"]) {
    const value = record[field];
    if (typeof value === "string") return yearIn(value);
  }
  return null;
}

function readCslJson(text: string) {
  return decodeCslItems(JSON.parse(text)).flatMap((value) =>
    Option.match(decodeCslEntry(value), {
      onNone: () => [],
      onSome: (entry) => [
        {
          key: String(entry.id),
          identifiers: [
            ...(entry.DOI?.trim() ? [{ scheme: "doi", value: entry.DOI.trim() }] : []),
            ...(entry.PMID?.trim() ? [{ scheme: "pmid", value: entry.PMID.trim() }] : []),
          ],
          title: entry.title ?? null,
          year: cslYear(entry.issued),
        },
      ],
    }),
  );
}

async function readBibliography(root: string, path: string): Promise<Bibliography> {
  const json = path.toLowerCase().endsWith(".json");
  if (!json && !path.toLowerCase().endsWith(".bib")) {
    return { path, entries: null, problem: "Only .bib and CSL-JSON bibliographies are read." };
  }
  const file = await resolveScientProjectFile(root, path, {
    extensions: [".bib", ".json"],
    description: "bibliography file",
  }).catch((error: unknown) => ({
    problem: error instanceof Error ? error.message : "The bibliography could not be read.",
  }));
  if ("problem" in file) return { path, entries: null, problem: file.problem };
  const text = await readProjectText(file.absolutePath);
  if (typeof text !== "string") return { path, entries: null, problem: text.problem };
  if (!json) {
    const bib = readReferenceDocument("bibtex", text);
    const problem = bib.parseError ? `Partly read: ${bib.parseError}` : null;
    return { path, entries: documentEntries(bib), problem };
  }
  try {
    return { path, entries: entriesByKey(readCslJson(text)), problem: null };
  } catch {
    return { path, entries: null, problem: "The bibliography could not be read as CSL-JSON." };
  }
}

interface PreparedWork {
  readonly sourceId: string;
  readonly identifiers: ReadonlySet<string>;
  readonly title: string | null;
  readonly year: number | null;
}

/**
 * True for the same work, false for another one, null when nothing can be compared. DOI, PMID
 * and arXiv ID decide; when neither side has one, the title (and the year, when both give one).
 */
function sameWork(entry: BibliographyEntry, work: PreparedWork): boolean | null {
  if ([...entry.identifiers].some((identifier) => work.identifiers.has(identifier))) return true;
  const schemes = new Set([...work.identifiers].map((identifier) => identifier.split(":")[0]));
  if ([...entry.identifiers].some((identifier) => schemes.has(identifier.split(":")[0]))) {
    return false;
  }
  if (entry.identifiers.size > 0 || work.identifiers.size > 0) return null;
  if (entry.title === null || work.title === null) return null;
  if (entry.title !== work.title) return false;
  return entry.year === null || work.year === null || entry.year === work.year;
}

const ids = (works: ReadonlyArray<PreparedWork>) =>
  [...new Set(works.map((work) => work.sourceId))].toSorted();

function resolveIn(
  bibliographies: ReadonlyArray<Bibliography>,
  key: string,
  works: ReadonlyArray<PreparedWork>,
): CitationKeyResolution {
  const defining = bibliographies.find((bibliography) => bibliography.entries?.has(key));
  const entry = defining?.entries?.get(key);
  if (works.length === 0) {
    return { status: "not-library", sourceIds: [], bibliography: defining?.path ?? null };
  }
  if (defining && entry) {
    const verdicts = works.map((work) => ({ work, same: sameWork(entry, work) }));
    const same = verdicts.filter((verdict) => verdict.same === true);
    const open = verdicts.filter((verdict) => verdict.same === null);
    if (same.length > 0) {
      return {
        status: "library",
        sourceIds: ids(same.map(({ work }) => work)),
        bibliography: defining.path,
      };
    }
    return open.length > 0
      ? {
          status: "unconfirmed",
          sourceIds: ids(open.map(({ work }) => work)),
          bibliography: defining.path,
        }
      : { status: "other-work", sourceIds: [], bibliography: defining.path };
  }
  // A bibliography not read in full may define the key.
  const unread = bibliographies.find(
    (bibliography) => bibliography.entries === null || bibliography.problem !== null,
  );
  if (unread) return { status: "unconfirmed", sourceIds: ids(works), bibliography: unread.path };
  if (bibliographies.length === 0) {
    return { status: "library", sourceIds: ids(works), bibliography: null };
  }
  // It names bibliographies and none defines the key: nothing says which work it names.
  return { status: "unconfirmed", sourceIds: ids(works), bibliography: bibliographies[0]!.path };
}

/** One answer from each context a document is read in: they must agree. */
function combine(
  results: ReadonlyArray<CitationKeyResolution>,
  works: ReadonlyArray<PreparedWork>,
): CitationKeyResolution {
  const [first] = results;
  if (!first) return { status: "unconfirmed", sourceIds: ids(works), bibliography: null };
  const same = (result: CitationKeyResolution) =>
    result.status === first.status && result.sourceIds.join("\n") === first.sourceIds.join("\n");
  if (results.every(same)) return first;
  const named = [...new Set(results.flatMap((result) => result.sourceIds))].toSorted();
  return {
    status: "unconfirmed",
    sourceIds: named.length > 0 ? named : ids(works),
    bibliography: results.find((result) => result.bibliography !== null)?.bibliography ?? null,
  };
}

/** A document read in its bibliography contexts. */
export interface DocumentCitationContext {
  readonly resolve: (key: string) => CitationKeyResolution;
  /** Bibliographies of its contexts that were not read in full. */
  readonly problems: ReadonlyArray<{ readonly path: string; readonly reason: string }>;
}

interface LatexFile {
  readonly document: ReferenceDocument;
  readonly includes: ReadonlyArray<{
    readonly command: string;
    readonly directory: string | null;
    readonly name: string;
  }>;
  readonly root: boolean;
}

/** One file of a LaTeX document, and the folder its `\input` paths are read from. */
interface UnitFile {
  readonly path: string;
  readonly base: string;
}

const INCLUDE = /\\(input|include|subfile)\s*\{([^{}]+)\}/gu;
const IMPORT =
  /\\(import|subimport|inputfrom|subinputfrom|includefrom|subincludefrom)\*?\s*\{([^{}]*)\}\s*\{([^{}]+)\}/gu;
const DOCUMENT_CLASS = /\\documentclass\s*(?:\[[^\]]*\])?\s*\{([^{}]*)\}/u;

function readLatexFile(text: string): LatexFile {
  const code = maskLatexComments(text);
  const includes = [
    ...[...code.matchAll(INCLUDE)].map((match) => ({
      at: match.index,
      command: match[1]!,
      directory: null,
      name: match[2]!.trim(),
    })),
    ...[...code.matchAll(IMPORT)].map((match) => ({
      at: match.index,
      command: match[1]!,
      directory: match[2]!.trim(),
      name: match[3]!.trim(),
    })),
  ]
    .toSorted((left, right) => left.at - right.at)
    .map(({ command, directory, name }) => ({ command, directory, name }));
  const documentClass = DOCUMENT_CLASS.exec(code)?.[1]?.trim();
  // A `subfiles` child compiles on its own but belongs to the document that includes it.
  return {
    document: readReferenceDocument("latex", text),
    includes,
    root: documentClass !== undefined && documentClass !== "subfiles",
  };
}

const join = (...parts: ReadonlyArray<string>) =>
  NodePath.posix.normalize(NodePath.posix.join(...parts));
const directoryOf = (path: string) => NodePath.posix.dirname(path);

/**
 * Every project document's bibliography contexts. A LaTeX part included by a root (a file with
 * `\documentclass`) is read in each whole document that includes it, whose bibliographies apply
 * to every part; a file no root includes, and every Markdown file, is read on its own.
 */
export function createProjectCitationContext(input: {
  /** The canonical project root. */
  readonly root: string;
  /** Every LaTeX file of the project, project-relative. */
  readonly latexPaths: ReadonlyArray<string>;
  readonly works: ReadonlyArray<ProjectWork>;
}) {
  const worksByKey = new Map<string, PreparedWork[]>();
  for (const work of input.works) {
    const key = citationKeyComparisonValue(work.citationKey);
    const list = worksByKey.get(key) ?? [];
    list.push({
      sourceId: work.sourceId,
      identifiers: comparableIdentifiers(work.identifiers),
      title: comparableTitle(work.title),
      year: work.year,
    });
    worksByKey.set(key, list);
  }
  const latexSet: ReadonlySet<string> = new Set(input.latexPaths);
  const texts = new Map<string, Promise<string | { readonly problem: string }>>();
  const bibliographies = new Map<string, Promise<Bibliography>>();
  let graph: Promise<{
    readonly files: ReadonlyMap<string, LatexFile>;
    readonly memberships: ReadonlyMap<string, ReadonlyArray<ReadonlyArray<UnitFile>>>;
    readonly unread: ReadonlyArray<{ readonly path: string; readonly reason: string }>;
  }> | null = null;

  /** A project document's text; LaTeX files are kept for the include graph. */
  const text = (path: string) => {
    const known = texts.get(path);
    if (known) return known;
    const read = readProjectText(NodePath.join(input.root, ...path.split("/")));
    if (latexSet.has(path)) texts.set(path, read);
    return read;
  };

  const bibliography = (path: string) => {
    let read = bibliographies.get(path);
    if (!read) {
      read = readBibliography(input.root, path);
      bibliographies.set(path, read);
    }
    return read;
  };

  const target = (directory: string, name: string): string | null => {
    if (NodePath.posix.isAbsolute(name)) return null;
    const joined = join(directory, name);
    if (joined === ".." || joined.startsWith("../")) return null;
    const candidates = /\.(tex|ltx)$/iu.test(joined) ? [joined] : [`${joined}.tex`, joined];
    return candidates.find((candidate) => latexSet.has(candidate)) ?? null;
  };

  const buildGraph = async () => {
    const files = new Map<string, LatexFile>();
    const unread: Array<{ readonly path: string; readonly reason: string }> = [];
    for (const path of input.latexPaths) {
      const read = await text(path);
      if (typeof read === "string") files.set(path, readLatexFile(read));
      else unread.push({ path, reason: read.problem });
    }
    const memberships = new Map<string, Array<ReadonlyArray<UnitFile>>>();
    for (const [rootPath, rootFile] of files) {
      if (!rootFile.root) continue;
      const rootDirectory = directoryOf(rootPath);
      const unit: UnitFile[] = [];
      const seen = new Set<string>();
      const queue: UnitFile[] = [{ path: rootPath, base: rootDirectory }];
      while (queue.length > 0) {
        const current = queue.shift()!;
        if (seen.has(current.path)) continue;
        seen.add(current.path);
        unit.push(current);
        for (const include of files.get(current.path)?.includes ?? []) {
          let directory: string;
          if (include.command === "input" || include.command === "include") {
            directory = current.base;
          } else if (include.command === "subfile") {
            directory = directoryOf(current.path);
          } else if (include.command.startsWith("sub")) {
            directory = join(current.base, include.directory ?? "");
          } else {
            directory = join(rootDirectory, include.directory ?? "");
          }
          const found = target(directory, include.name);
          if (!found) continue;
          queue.push({
            path: found,
            base: include.command === "subfile" ? directoryOf(found) : directory,
          });
        }
      }
      for (const member of unit) {
        const list = memberships.get(member.path) ?? [];
        // The member first: its own reference list and bibliographies, then the rest.
        list.push([member, ...unit.filter((other) => other.path !== member.path)]);
        memberships.set(member.path, list);
      }
    }
    return { files, memberships, unread };
  };

  const ownBibliographies = async (
    path: string,
    document: ReferenceDocument,
    base: string,
  ): Promise<ReadonlyArray<Bibliography>> => {
    const own: Bibliography[] = [];
    // A reference list in the document itself comes first.
    if (document.entries.length > 0) {
      own.push({ path, entries: documentEntries(document), problem: null });
    }
    for (const written of document.bibliographyPaths) {
      own.push(await bibliography(join(base, written)));
    }
    return own;
  };

  /** The document's bibliography contexts; `content` is its text. */
  const contexts = async (
    path: string,
    kind: "markdown" | "latex",
    content: string,
  ): Promise<ReadonlyArray<ReadonlyArray<Bibliography>>> => {
    const document = readReferenceDocument(kind, content);
    const alone = async () => [await ownBibliographies(path, document, directoryOf(path))];
    if (kind !== "latex") return alone();
    graph ??= buildGraph();
    const { files, memberships } = await graph;
    const units = memberships.get(path);
    if (!units) return alone();
    return Promise.all(
      units.map(async (unit) => {
        const context: Bibliography[] = [];
        for (const member of unit) {
          const memberDocument = member.path === path ? document : files.get(member.path)?.document;
          if (!memberDocument) continue;
          for (const read of await ownBibliographies(member.path, memberDocument, member.base)) {
            if (!context.some((known) => known.path === read.path)) context.push(read);
          }
        }
        return context;
      }),
    );
  };

  return {
    text,
    /** LaTeX files that could not be read: a root among them would add contexts. */
    unreadLatex: async () => {
      graph ??= buildGraph();
      return (await graph).unread;
    },
    /** A document read in its contexts; `content` is its text. */
    document: async (
      path: string,
      kind: "markdown" | "latex",
      content: string,
    ): Promise<DocumentCitationContext> => {
      const found = await contexts(path, kind, content);
      const problems = new Map<string, string>();
      for (const read of found.flat()) {
        if (read.problem !== null && !problems.has(read.path))
          problems.set(read.path, read.problem);
      }
      const resolved = new Map<string, CitationKeyResolution>();
      return {
        resolve: (key) => {
          const comparable = citationKeyComparisonValue(key);
          const known = resolved.get(comparable);
          if (known) return known;
          const works = worksByKey.get(comparable) ?? [];
          const result = combine(
            found.map((context) => resolveIn(context, comparable, works)),
            works,
          );
          resolved.set(comparable, result);
          return result;
        },
        problems: [...problems].map(([problemPath, reason]) => ({ path: problemPath, reason })),
      };
    },
    /** A key in a document that could not be read: a project key's work is left open. */
    unread: (key: string): CitationKeyResolution => {
      const works = worksByKey.get(citationKeyComparisonValue(key)) ?? [];
      return works.length === 0
        ? { status: "not-library", sourceIds: [], bibliography: null }
        : { status: "unconfirmed", sourceIds: ids(works), bibliography: null };
    },
  };
}
