// @effect-diagnostics nodeBuiltinImport:off -- Rewrites project documents beside the Promise-based Sources store.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import {
  citationKeyComparisonValue,
  renameCitationKeyInDocument,
  type ScientReferenceFindingKind,
  type ScientReferenceStatus,
} from "@scientfactory/scient-sources";
import { listScientSourceRecords } from "@scientfactory/scient-sources/store";

import {
  checkReferences,
  listReferenceDocuments,
  type ResolveIdentifierBatch,
} from "../references/ReferenceCheck.ts";
import { syncManagedBibliography } from "./ManagedBibliography.ts";

const MAX_RENAMED_DOCUMENT_BYTES = 5 * 1024 * 1024;
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

async function writeAtomically(filePath: string, contents: string): Promise<void> {
  const temporary = `${filePath}.${NodeCrypto.randomUUID()}.tmp`;
  try {
    await NodeFSP.writeFile(temporary, contents, { encoding: "utf8", flag: "wx" });
    await NodeFSP.rename(temporary, filePath);
  } finally {
    await NodeFSP.rm(temporary, { force: true });
  }
}

/**
 * Carries a deliberate key rename into the project's Markdown and LaTeX
 * documents. Returns the project-relative paths it changed.
 */
export async function renameCitationKeyInProject(
  root: string,
  from: string,
  to: string,
): Promise<ReadonlyArray<string>> {
  if (from === to) return [];
  const { paths } = await listReferenceDocuments(root);
  const changed: string[] = [];
  for (const relativePath of paths) {
    const kind = documentKind(relativePath);
    if (kind === null) continue;
    const absolutePath = NodePath.join(root, ...relativePath.split("/"));
    const stats = await NodeFSP.lstat(absolutePath).catch(() => null);
    if (!stats?.isFile() || stats.size > MAX_RENAMED_DOCUMENT_BYTES) continue;
    const text = await NodeFSP.readFile(absolutePath, "utf8");
    if (!text.includes(from)) continue;
    const next = renameCitationKeyInDocument(kind, text, from, to);
    if (next === text) continue;
    await writeAtomically(absolutePath, next);
    changed.push(relativePath);
  }
  return changed;
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
