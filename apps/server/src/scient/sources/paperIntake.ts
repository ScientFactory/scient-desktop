import type {
  ScientSourceActor,
  ScientSourceAttachmentRetrieval,
  ScientSourceCandidate,
  ScientSourceIdentifier,
  ScientSourceRecord,
} from "@scientfactory/scient-sources";
import type { ScientSourceStoreLocation } from "@scientfactory/scient-sources/library-root";
import {
  attachScientSourcePaperPdf,
  inspectScientSourcePdf,
  listScientSourceRecords,
  resolveScientSourceInputPdf,
} from "@scientfactory/scient-sources/store";

import { addAgentSource } from "./ScientSourcesCoordinator.ts";
import type { SourceImportObserver } from "./SourceImportObservation.ts";
import type { ResolveSourceIdentifier } from "./SourceIdentifierResolver.ts";

export type PaperIntakeResult =
  | {
      readonly outcome: "added" | "attached" | "already-attached";
      readonly sourceId: string;
      readonly revision: number;
    }
  | { readonly outcome: "not-added"; readonly message: string };

const ATTACH_ATTEMPTS = 3;

/**
 * Attaches to whatever revision the source has now (adding a PDF changes nothing else), once the
 * shared identity rule, rechecked under the store lock, still takes the paper for that source.
 */
async function attachToSource(input: {
  readonly root: ScientSourceStoreLocation;
  readonly record: ScientSourceRecord;
  readonly paper: ScientSourceCandidate;
  readonly pdfSha256: string;
  readonly pdfPath: string;
  readonly fileName: string;
  readonly actor: ScientSourceActor;
  readonly retrieval?: ScientSourceAttachmentRetrieval;
}): Promise<PaperIntakeResult> {
  let record = input.record;
  for (let attempt = 0; attempt < ATTACH_ATTEMPTS; attempt += 1) {
    const result = await attachScientSourcePaperPdf({
      root: input.root,
      sourceId: record.sourceId,
      expectedRevision: record.revision,
      paper: input.paper,
      pdfSha256: input.pdfSha256,
      pdfPath: input.pdfPath,
      fileName: input.fileName,
      actor: input.actor,
      ...(input.retrieval ? { retrieval: input.retrieval } : {}),
    });
    if (result.outcome === "not-same-work") {
      return {
        outcome: "not-added",
        message: `The paper was not attached to the source ${record.sourceId}: ${result.duplicate.reason}`,
      };
    }
    if (result.outcome !== "stale")
      return {
        outcome: result.outcome === "attached" ? "attached" : "already-attached",
        sourceId: result.record.sourceId,
        revision: result.record.revision,
      };
    record = result.record;
  }
  return {
    outcome: "not-added",
    message: `The source ${record.sourceId} kept changing, so the PDF was not attached to it.`,
  };
}

/**
 * A downloaded paper goes into the Library: onto the source the shared identity rule takes it for
 * (judged on the paper's own identity and the Library's decisions, never on the target's type),
 * or as a new source whose metadata comes from the identifier's registry, never from a guess.
 */
export async function addPaperToLibrary(
  input: {
    /** The project the PDF was saved in. */
    readonly root: string;
    /** Where the source goes; the project's own store when omitted. */
    readonly store?: ScientSourceStoreLocation;
    readonly pdfRelativePath: string;
    readonly doi?: string;
    readonly arxiv?: string;
    readonly actor: ScientSourceActor;
    readonly retrieval?: ScientSourceAttachmentRetrieval;
    readonly resolveIdentifier?: ResolveSourceIdentifier;
    /** What the paper lookup knew, kept only when no registry answers. */
    readonly fallback?: { readonly title?: string; readonly year?: number };
    /** Look up a missing abstract after the registry. */
    readonly enrich?: boolean;
  },
  observer?: SourceImportObserver,
): Promise<PaperIntakeResult> {
  const pdf = await resolveScientSourceInputPdf(input.root, input.pdfRelativePath);
  const store = input.store ?? input.root;
  const named: ReadonlyArray<ScientSourceIdentifier> = [
    ...(input.doi ? [{ scheme: "doi", value: input.doi }] : []),
    ...(input.arxiv ? [{ scheme: "arxiv", value: input.arxiv }] : []),
  ];
  if (named.length === 0)
    return {
      outcome: "not-added",
      message: "The paper has no DOI or arXiv ID, so add it with scient_sources_add.",
    };
  const expectedPdf = await inspectScientSourcePdf(pdf.absolutePath);
  // The paper's own identity; registry metadata replaces these only when it is added as new.
  const candidate: ScientSourceCandidate = {
    sourceKey: `paper_${expectedPdf.sha256}`,
    type: input.arxiv && !input.doi ? "preprint" : "article",
    customType: null,
    title: input.fallback?.title ?? null,
    creators: [],
    issuedRaw: input.fallback?.year ? String(input.fallback.year) : null,
    issuedYear: input.fallback?.year ?? null,
    identifiers: named,
    abstract: null,
    containerTitle: null,
    publisher: null,
    volume: null,
    issue: null,
    pages: null,
    language: null,
    url: null,
    tags: [],
    externalReferences: [],
    fieldProvenance: [
      ...named.map((_, index) => ({
        field: `identifiers.${index}`,
        origin: input.actor,
        sourceField: null,
      })),
      ...(input.fallback?.title
        ? [{ field: "title", origin: "openalex" as const, sourceField: "title" }]
        : []),
      ...(input.fallback?.year
        ? [
            { field: "issuedRaw", origin: "openalex" as const, sourceField: "publication_year" },
            { field: "issuedYear", origin: "openalex" as const, sourceField: "publication_year" },
          ]
        : []),
    ],
    pdfAvailable: true,
    pdfFileName: pdf.fileName,
    pdfAttachmentCount: 1,
  };
  const records = await listScientSourceRecords(store);
  const attach = (record: ScientSourceRecord, paper: ScientSourceCandidate) =>
    attachToSource({
      root: store,
      record,
      paper,
      pdfSha256: expectedPdf.sha256,
      pdfPath: pdf.absolutePath,
      fileName: pdf.fileName,
      actor: input.actor,
      ...(input.retrieval ? { retrieval: input.retrieval } : {}),
    });
  const result = await addAgentSource(
    {
      root: store,
      candidate,
      enrich: input.enrich ?? true,
      pdfPath: pdf.absolutePath,
      pdfFileName: pdf.fileName,
      expectedPdf,
      claimedTitle: null,
      actor: input.actor,
      intake: "paper",
      ...(input.retrieval ? { pdfRetrieval: input.retrieval } : {}),
      ...(input.resolveIdentifier ? { resolveIdentifier: input.resolveIdentifier } : {}),
    },
    observer,
  );
  if (result.outcome === "imported" && result.record)
    return { outcome: "added", sourceId: result.record.sourceId, revision: result.record.revision };
  if (result.outcome === "identifier-not-found" || result.outcome === "identifier-mismatch")
    return { outcome: "not-added", message: result.message };
  const match =
    result.outcome === "duplicate"
      ? records.find((record) => record.sourceId === result.duplicate.matchingSourceIds[0])
      : undefined;
  if (match && result.duplicate.kind !== "possible-metadata-match") {
    return attach(match, result.judged);
  }
  return {
    outcome: "not-added",
    message: match
      ? `It looks like the source ${match.sourceId} (${match.title ?? "untitled"}). If it is the same work, attach the PDF there.`
      : result.duplicate.reason,
  };
}
