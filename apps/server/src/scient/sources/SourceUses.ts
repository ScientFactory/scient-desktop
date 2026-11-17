// @effect-diagnostics nodeBuiltinImport:off -- Reads project documents beside the Promise-based Sources store.
import * as NodePath from "node:path";

import {
  citationKeyComparisonValue,
  referenceDocumentKind,
  type ScientSourceCitationKeys,
  type ScientSourceUses,
} from "@scientfactory/scient-sources";
import type { ScientLibraryLocation } from "@scientfactory/scient-sources/library-root";
import { resolveScientProjectFile } from "@scientfactory/scient-sources/project-files";
import { listScientProjectPinnedWorks } from "@scientfactory/scient-sources/project-pins";
import {
  canonicalizeScientSourceRoot,
  listScientSourceRecords,
  readScientSourceRecord,
} from "@scientfactory/scient-sources/store";

import { citationContext, citationOccurrences } from "./citationOccurrences.ts";
import {
  createProjectCitationContext,
  isManagedBibliography,
  type ProjectWork,
} from "./documentCitationContext.ts";
import { scanCitationKeyRenameDocuments, type CitationKeyRenameSkip } from "./LibraryCitation.ts";

type Occurrence = ScientSourceUses["occurrences"][number];
type Through = Occurrence["through"];

/**
 * Every place the project's Markdown and LaTeX documents cite one source by one of its keys,
 * each read with its bibliographies as `documentCitationContext.ts` resolves them: a key that
 * names the source counts (unconfirmed when they leave its work open), one a bibliography
 * gives to another work is listed in `elsewhere`. Anything not read makes the answer incomplete.
 */
async function findSourceUses(
  root: string,
  sourceId: string,
  works: ReadonlyArray<ProjectWork>,
): Promise<ScientSourceUses> {
  const citationKeys = [
    ...new Set(works.filter((work) => work.sourceId === sourceId).map((work) => work.citationKey)),
  ].toSorted();
  if (citationKeys.length === 0) {
    return {
      citationKeys,
      occurrences: [],
      listed: [],
      elsewhere: [],
      documents: 0,
      skipped: [],
      complete: true,
    };
  }
  const base = await canonicalizeScientSourceRoot(root);
  const scan = await scanCitationKeyRenameDocuments(base);
  const project = createProjectCitationContext({
    root: base,
    latexPaths: scan.paths.filter((path) => referenceDocumentKind(path) === "latex"),
    works,
  });
  const wanted = new Set(citationKeys.map(citationKeyComparisonValue));
  const occurrences: Occurrence[] = [];
  const listed: ScientSourceUses["listed"][number][] = [];
  const elsewhere = new Map<string, ScientSourceUses["elsewhere"][number]>();
  const skipped: CitationKeyRenameSkip[] = [...scan.skipped];
  const reported = new Set<string>();
  let documents = 0;

  for (const path of scan.paths) {
    const kind = referenceDocumentKind(path);
    if (kind !== "markdown" && kind !== "latex") continue;
    const text = await project.text(path);
    if (typeof text !== "string") {
      skipped.push({ path, reason: text.problem });
      continue;
    }
    documents++;
    const lower = text.toLowerCase();
    if (![...wanted].some((key) => lower.includes(key))) continue;
    const cited = citationOccurrences(kind, text).filter((occurrence) =>
      wanted.has(citationKeyComparisonValue(occurrence.key)),
    );
    if (cited.length === 0) continue;
    const document = await project.document(path, kind, text);

    for (const occurrence of cited) {
      const resolution = document.resolve(occurrence.key);
      let through: Through;
      if (!resolution.sourceIds.includes(sourceId)) {
        // The bibliography gives the key to another work.
        if (resolution.bibliography !== null) {
          const comparable = citationKeyComparisonValue(occurrence.key);
          elsewhere.set(`${path}\n${comparable}\n${resolution.bibliography}`, {
            path,
            key: occurrence.key,
            bibliography: resolution.bibliography,
          });
        }
        continue;
      } else if (resolution.status === "library") {
        through =
          resolution.bibliography === null || isManagedBibliography(resolution.bibliography)
            ? { kind: "project" }
            : { kind: "bibliography", path: resolution.bibliography, confirmed: true };
      } else {
        through = { kind: "bibliography", path: resolution.bibliography ?? path, confirmed: false };
      }
      if (occurrence.listedOnly) {
        listed.push({ path, line: occurrence.line, citationKey: occurrence.key });
        continue;
      }
      const context = citationContext(text, occurrence.start, occurrence.end);
      occurrences.push({
        path,
        line: occurrence.line,
        column: occurrence.column,
        citationKey: occurrence.key,
        locator: occurrence.locator,
        context: context.text,
        contextCitation: { start: context.start, end: context.end },
        through,
      });
    }
    for (const problem of document.problems) {
      if (reported.has(problem.path)) continue;
      reported.add(problem.path);
      skipped.push({ path: problem.path, reason: problem.reason });
    }
  }

  return {
    citationKeys,
    occurrences,
    listed,
    elsewhere: [...elsewhere.values()],
    documents,
    skipped,
    complete: skipped.length === 0,
  };
}

/** The works a Library project cites: its pins, each under its key. */
async function libraryWorks(
  root: string,
  library: ScientLibraryLocation | null,
): Promise<ReadonlyArray<ProjectWork>> {
  return (await listScientProjectPinnedWorks({ projectRoot: root, library })).map((work) => ({
    sourceId: work.record.sourceId,
    citationKey: work.citationKey,
    identifiers: work.record.identifiers,
    title: work.record.title,
    year: work.record.issuedYear,
  }));
}

/** The works a project that keeps its own sources cites: each record under its own key. */
async function projectWorks(
  root: string,
  sourceId: string | null,
): Promise<ReadonlyArray<ProjectWork>> {
  const records = [...(await listScientSourceRecords(root))];
  if (sourceId !== null && !records.some((record) => record.sourceId === sourceId)) {
    const record = await readScientSourceRecord(root, sourceId);
    if (record) records.push(record);
  }
  return records.flatMap((record) =>
    record.citationKey
      ? [
          {
            sourceId: record.sourceId,
            citationKey: record.citationKey,
            identifiers: record.identifiers,
            title: record.title,
            year: record.issuedYear,
          },
        ]
      : [],
  );
}

/** Library backend: the source's keys are those of this project's pins resolving to it. */
export async function listSourceUses(input: {
  readonly root: string;
  readonly library: ScientLibraryLocation | null;
  readonly sourceId: string;
}): Promise<ScientSourceUses> {
  return findSourceUses(input.root, input.sourceId, await libraryWorks(input.root, input.library));
}

/** A project that keeps its own sources: the record's own key. */
export async function listProjectSourceUses(input: {
  readonly root: string;
  readonly sourceId: string;
}): Promise<ScientSourceUses> {
  return findSourceUses(input.root, input.sourceId, await projectWorks(input.root, input.sourceId));
}

const DOCUMENT_EXTENSIONS = [".md", ".markdown", ".qmd", ".rmd", ".tex", ".ltx"];

/**
 * What each key names in one project document, read with that document's bibliographies the
 * way the source's "Used in this project" reads them. The text on disk is read.
 */
async function resolveCitationKeys(
  root: string,
  path: string,
  keys: ReadonlyArray<string>,
  works: ReadonlyArray<ProjectWork>,
): Promise<ScientSourceCitationKeys> {
  const kind = referenceDocumentKind(path);
  const requested = path.trim();
  if (
    (kind !== "markdown" && kind !== "latex") ||
    requested.includes("\\") ||
    NodePath.posix.isAbsolute(requested) ||
    requested.split("/").includes("..")
  ) {
    throw new Error(
      `The document path must be a relative project path ending in ${DOCUMENT_EXTENSIONS.join(", ")}.`,
    );
  }
  const base = await canonicalizeScientSourceRoot(root);
  const scan = kind === "latex" ? await scanCitationKeyRenameDocuments(base) : null;
  const project = createProjectCitationContext({
    root: base,
    latexPaths:
      scan?.paths.filter((candidate) => referenceDocumentKind(candidate) === "latex") ?? [],
    works,
  });
  const unique = [...new Set(keys)];
  // Inside the project, outside .scient, never through a link.
  const file = await resolveScientProjectFile(base, requested, {
    extensions: DOCUMENT_EXTENSIONS,
    description: "document",
  }).catch(() => null);
  const text = file ? await project.text(file.relativePath) : null;
  if (file === null || typeof text !== "string") {
    return { keys: unique.map((key) => ({ key, ...project.unread(key) })), complete: false };
  }
  const document = await project.document(file.relativePath, kind, text);
  const latexComplete =
    scan === null || (scan.skipped.length === 0 && (await project.unreadLatex()).length === 0);
  return {
    keys: unique.map((key) => ({ key, ...document.resolve(key) })),
    complete: latexComplete && document.problems.length === 0,
  };
}

/** Library backend: the project's keys are its pins' keys, aliases included. */
export async function listCitationKeys(input: {
  readonly root: string;
  readonly library: ScientLibraryLocation | null;
  readonly path: string;
  readonly keys: ReadonlyArray<string>;
}): Promise<ScientSourceCitationKeys> {
  return resolveCitationKeys(
    input.root,
    input.path,
    input.keys,
    await libraryWorks(input.root, input.library),
  );
}

/** A project that keeps its own sources: each record's own key. */
export async function listProjectCitationKeys(input: {
  readonly root: string;
  readonly path: string;
  readonly keys: ReadonlyArray<string>;
}): Promise<ScientSourceCitationKeys> {
  return resolveCitationKeys(
    input.root,
    input.path,
    input.keys,
    await projectWorks(input.root, null),
  );
}
