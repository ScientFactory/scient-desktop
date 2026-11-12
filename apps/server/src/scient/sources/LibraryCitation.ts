// @effect-diagnostics nodeBuiltinImport:off -- Rewrites project documents beside the Promise-based Sources store.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import {
  citationKeyComparisonValue,
  type ScientReferenceFindingKind,
  type ScientReferenceStatus,
} from "@scientfactory/scient-sources";
import {
  publishScientProjectFile,
  ScientProjectFilePublicationError,
} from "@scientfactory/scient-sources/project-files";
import {
  canonicalizeScientSourceRoot,
  listScientSourceRecords,
} from "@scientfactory/scient-sources/store";
import * as Schema from "effect/Schema";

import {
  checkReferences,
  SKIPPED_DIRECTORIES,
  type ResolveIdentifierBatch,
} from "../references/ReferenceCheck.ts";
import { renameCitationKeyInDocument } from "./citationKeyRename.ts";
import { syncManagedBibliography } from "./ManagedBibliography.ts";

const isPublicationError = Schema.is(ScientProjectFilePublicationError);
const MAX_RENAMED_DOCUMENT_BYTES = 16 * 1024 * 1024;
const MAX_RENAME_DOCUMENTS = 20_000;
/** What matters before citing one source; document-level findings belong to a full check. */
const CITATION_FINDINGS: ReadonlySet<ScientReferenceFindingKind> = new Set([
  "identifier-not-found",
  "identifier-mismatch",
  "retracted",
  "editorial-notice",
  "published-version",
  "details-differ",
]);

function documentKind(path: string): "markdown" | "latex" | null {
  if (/\.(?:md|markdown|qmd|rmd)$/iu.test(path)) return "markdown";
  if (/\.(?:tex|ltx)$/iu.test(path)) return "latex";
  return null;
}

export interface CitationKeyRenameSkip {
  readonly path: string;
  readonly reason: string;
}

export interface CitationKeyRenameScan {
  readonly paths: ReadonlyArray<string>;
  readonly skipped: ReadonlyArray<CitationKeyRenameSkip>;
}

/**
 * Every Markdown and LaTeX document a rename must reach, at any depth. Links
 * are never followed; anything the rename cannot read is listed, not dropped.
 */
export async function scanCitationKeyRenameDocuments(root: string): Promise<CitationKeyRenameScan> {
  const base = await canonicalizeScientSourceRoot(root);
  const paths: string[] = [];
  const skipped: CitationKeyRenameSkip[] = [];
  const queue = [""];
  while (queue.length > 0) {
    const directory = queue.shift()!;
    let entries;
    try {
      entries = await NodeFSP.readdir(NodePath.join(base, ...directory.split("/")), {
        withFileTypes: true,
      });
    } catch {
      skipped.push({ path: directory || ".", reason: "The folder could not be read." });
      continue;
    }
    for (const entry of entries.toSorted((left, right) => left.name.localeCompare(right.name))) {
      if (entry.name.startsWith(".")) continue;
      const relative = directory ? `${directory}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (!SKIPPED_DIRECTORIES.has(entry.name)) queue.push(relative);
        continue;
      }
      if (documentKind(entry.name) === null) continue;
      if (!entry.isFile()) {
        skipped.push({
          path: relative,
          reason: "A link or special file; Scient does not follow it.",
        });
      } else if (paths.length >= MAX_RENAME_DOCUMENTS) {
        skipped.push({
          path: directory || ".",
          reason: `Not searched: the project has more than ${MAX_RENAME_DOCUMENTS.toLocaleString("en")} documents.`,
        });
        return { paths, skipped };
      } else {
        paths.push(relative);
      }
    }
  }
  return { paths, skipped };
}

async function renameInDocument(
  absolutePath: string,
  kind: "markdown" | "latex",
  from: string,
  to: string,
): Promise<"renamed" | "unchanged" | string> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const stats = await NodeFSP.lstat(absolutePath).catch(() => null);
    if (!stats?.isFile()) return "The file could not be read.";
    if (stats.size > MAX_RENAMED_DOCUMENT_BYTES) return "Larger than 16 MB.";
    const text = await NodeFSP.readFile(absolutePath, "utf8").catch(() => null);
    if (text === null) return "The file could not be read.";
    if (!text.includes(from)) return "unchanged";
    const next = renameCitationKeyInDocument(kind, text, from, to);
    if (next === text) return "unchanged";
    const published = await publishScientProjectFile({
      filePath: absolutePath,
      expected: text,
      contents: next,
      mode: stats.mode & 0o777,
    });
    if (published.outcome === "written") return "renamed";
    if (published.keptPath !== null) {
      return `Changed while Scient renamed the key; that version is kept in ${NodePath.basename(published.keptPath)}.`;
    }
  }
  return "The file kept changing while Scient renamed the key.";
}

/**
 * Carries a deliberate key rename into the project's Markdown and LaTeX
 * documents found by `scanCitationKeyRenameDocuments`. Returns the changed
 * project-relative paths and every document the rename could not process.
 */
export async function renameCitationKeyInProject(
  root: string,
  from: string,
  to: string,
  scan?: CitationKeyRenameScan,
): Promise<{
  readonly renamedIn: ReadonlyArray<string>;
  readonly skipped: ReadonlyArray<CitationKeyRenameSkip>;
}> {
  if (from === to) return { renamedIn: [], skipped: [] };
  const base = await canonicalizeScientSourceRoot(root);
  const { paths, skipped } = scan ?? (await scanCitationKeyRenameDocuments(base));
  const renamedIn: string[] = [];
  const notRenamed = [...skipped];
  for (const relativePath of paths) {
    const kind = documentKind(relativePath)!;
    const absolutePath = NodePath.join(base, ...relativePath.split("/"));
    const outcome = await renameInDocument(absolutePath, kind, from, to).catch((error: unknown) =>
      isPublicationError(error)
        ? `The file could not be written; its previous text is kept in ${NodePath.basename(error.recoveryPath)}.`
        : "The file could not be written.",
    );
    if (outcome === "renamed") renamedIn.push(relativePath);
    else if (outcome !== "unchanged") notRenamed.push({ path: relativePath, reason: outcome });
  }
  return { renamedIn, skipped: notRenamed };
}

export interface LibraryCitationProblem {
  readonly kind: ScientReferenceFindingKind | "not-checked" | "no-identifier";
  readonly message: string;
}

export interface LibraryCitationResult {
  /** Ready to paste: `[@a; @b]` in Markdown, `\cite{a,b}` in LaTeX. */
  readonly citation: string;
  readonly sources: ReadonlyArray<{
    readonly sourceId: string;
    readonly citationKey: string;
    readonly title: string | null;
    readonly status: ScientReferenceStatus;
    readonly problems: ReadonlyArray<LibraryCitationProblem>;
  }>;
  readonly notFound: ReadonlyArray<string>;
  readonly bibliography: "current" | "edited" | "unmanaged" | "absent";
}

/**
 * Checks Library sources before they are cited (identifier resolves to the
 * same work, no retraction or notice) and returns their citation. Problems
 * are reported; they never stop the citation.
 */
export async function citeLibrarySources(
  input: {
    readonly root: string;
    readonly sources: ReadonlyArray<string>;
    readonly format: "markdown" | "latex";
  },
  options: { readonly resolveIdentifiers: ResolveIdentifierBatch },
): Promise<LibraryCitationResult> {
  // Writing the managed files first also gives keyless older sources their key.
  const bibliography = await syncManagedBibliography(input.root);
  const records = await listScientSourceRecords(input.root);
  const notFound: string[] = [];
  const picked = input.sources.flatMap((wanted) => {
    const lower = citationKeyComparisonValue(wanted);
    const record = records.find(
      (candidate) =>
        candidate.sourceId === wanted ||
        (candidate.citationKey !== undefined &&
          citationKeyComparisonValue(candidate.citationKey) === lower),
    );
    if (!record?.citationKey) {
      notFound.push(wanted);
      return [];
    }
    return [{ record, citationKey: record.citationKey }];
  });
  const unique = [...new Map(picked.map((entry) => [entry.record.sourceId, entry])).values()];
  const report =
    unique.length === 0
      ? null
      : await checkReferences(
          {
            root: input.root,
            target: { kind: "library", sourceIds: unique.map(({ record }) => record.sourceId) },
          },
          options,
        );
  const keys = unique.map(({ citationKey }) => citationKey);
  return {
    citation:
      keys.length === 0
        ? ""
        : input.format === "latex"
          ? `\\cite{${keys.join(",")}}`
          : `[${keys.map((key) => `@${key}`).join("; ")}]`,
    sources: unique.map(({ record, citationKey }) => {
      const entry = report?.ledger.find((item) => item.sourceId === record.sourceId);
      const problems: LibraryCitationProblem[] = (report?.findings ?? [])
        .filter(
          (finding) =>
            finding.sourceId === record.sourceId &&
            !finding.ignored &&
            CITATION_FINDINGS.has(finding.kind),
        )
        .map((finding) => ({ kind: finding.kind, message: finding.message }));
      if (!entry || entry.status === "no-identifier") {
        problems.push({
          kind: "no-identifier",
          message: "This source has no DOI, PMID, arXiv ID or ISBN, so no registry could check it.",
        });
      } else if (entry.status === "unavailable") {
        problems.push({
          kind: "not-checked",
          message: "The registry did not answer, so this source could not be checked now.",
        });
      }
      return {
        sourceId: record.sourceId,
        citationKey,
        title: record.title,
        status: entry?.status ?? "no-identifier",
        problems,
      };
    }),
    notFound,
    bibliography:
      bibliography.files.find((file) => file.name === "references.bib")?.state ?? "absent",
  };
}
