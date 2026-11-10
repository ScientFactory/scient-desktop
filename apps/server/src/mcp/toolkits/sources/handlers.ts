// @effect-diagnostics nodeBuiltinImport:off -- Idempotent Scient source operation IDs use the existing synchronous content fingerprint.
import * as NodeCrypto from "node:crypto";

import {
  citationKeyValidationMessage,
  takenCitationKeys,
  compileScientSourceFilter,
  normalizeScientSourceEditableMetadata,
  scientSourceTagCounts,
  validateScientSourceEditableMetadata,
  type ScientSourceCandidate,
  type ScientSourceEditableMetadata,
  type ScientSourceFilter,
  type ScientSourcesBulkRequestChange,
  type ScientSourcesOrganizeAction,
  type ScientSourceType,
} from "@scientfactory/scient-sources";
import { readScientSourcesOrganization } from "@scientfactory/scient-sources/collections";
import { resolveScientSourceInputPdf } from "@scientfactory/scient-sources/store";
import {
  deleteTrashedScientSource,
  listScientSourceRecords,
  listScientSourceRevisions,
  readScientSourceRecord,
  readScientSourceTrashEntries,
  restoreScientSource,
  revertScientSource,
} from "@scientfactory/scient-sources/store";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import { consumeAgentWorkspace } from "../../../scient/operations/AgentWorkspaceScope.ts";

import { makeSourceImportAnalytics } from "../../../telemetry/SourceImportAnalytics.ts";
import type { BibliographyFormat } from "@scientfactory/scient-sources/bibliography";
import {
  bibliographyFileErrorMessage,
  caseInsensitiveFileSystem,
  exportBibliography,
  readBibliographyFile,
  resolveProjectBibliographyFile,
  writeProjectBibliographyFile,
} from "../../../scient/sources/BibliographyFileAdapter.ts";
import { keyedIdentifierLookup } from "../../../scient/sources/researchKeys.ts";
import {
  addScientSourcesByIdentifier,
  SourceIdentifierBatchLookup,
  summarizeIdentifierAdd,
} from "../../../scient/sources/SourceIdentifierAdd.ts";
import {
  browseZoteroForInvocation,
  importZoteroForInvocation,
  refreshZoteroForInvocation,
  sendToZoteroForInvocation,
} from "./zoteroHandlers.ts";
import {
  ScientSourcesToolError,
  ScientSourcesToolkit,
  type ScientSourceAddInput as ScientSourceAddInputType,
} from "./tools.ts";
import {
  addAgentSource,
  checkSourceIdentifier,
  attachSourcePdf,
  bulkUpdateSources,
  importBibliographyFile,
  detachSourcePdf,
  organizeSources,
  prepareAgentProjectPdf,
  removeSource,
  syncManagedBibliographyWithImports,
  updateScientSource,
  updateSourceNote,
} from "../../../scient/sources/ScientSourcesCoordinator.ts";
import { citeLibrarySources } from "../../../scient/sources/LibraryCitation.ts";
import { ReferenceIdentifierLookup } from "../../../scient/references/ReferenceCheck.ts";
import {
  checkSourceQuotes,
  readSourceText,
  searchSourceFullText,
} from "../../../scient/sources/SourceFullText.ts";
import { saveWebPageSource } from "../../../scient/sources/SourceWebPage.ts";

type ErrorCode = ConstructorParameters<typeof ScientSourcesToolError>[0]["code"];

const toolError = (code: ErrorCode, message: string) =>
  new ScientSourcesToolError({ code, message });

const attempt = <A>(run: () => Promise<A>) =>
  Effect.tryPromise({
    try: run,
    // Store and filesystem errors can contain an absolute project path. MCP
    // results deliberately keep that host-only context out of model-visible
    // output.
    catch: () => toolError("operation-failed", "The Sources operation could not be completed."),
  });

// PDF-only adds often share a filename-derived title. Include the content hash
// so distinct files become distinct sources; same-pdf / same-identifier still
// collapse true duplicates. Metadata-only adds omit the hash.
function agentSourceKey(candidate: ScientSourceCandidate, pdfSha256?: string): string {
  const identity = JSON.stringify({
    identifiers: candidate.identifiers
      .map((identifier) => [
        identifier.scheme.trim().toLowerCase(),
        identifier.value.trim().toLowerCase(),
      ])
      .toSorted(([leftScheme, leftValue], [rightScheme, rightValue]) =>
        `${leftScheme}\0${leftValue}`.localeCompare(`${rightScheme}\0${rightValue}`),
      ),
    title: candidate.title?.trim().toLowerCase() ?? null,
    creators: candidate.creators
      .map((creator) => ({
        creatorType: creator.creatorType.trim().toLowerCase(),
        givenName: creator.givenName?.trim().toLowerCase() ?? null,
        familyName: creator.familyName?.trim().toLowerCase() ?? null,
        literalName: creator.literalName?.trim().toLowerCase() ?? null,
      }))
      .toSorted((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right))),
    issuedYear: candidate.issuedYear,
    ...(pdfSha256 ? { pdfSha256: pdfSha256.trim().toLowerCase() } : {}),
  });
  return `agent_${NodeCrypto.createHash("sha256").update(identity).digest("hex")}`;
}

function candidateFromAgentInput(input: ScientSourceAddInputType): {
  readonly candidate: ScientSourceCandidate;
  readonly validationIssues: ReturnType<typeof validateScientSourceEditableMetadata>;
} {
  const normalized = normalizeScientSourceEditableMetadata({
    type: input.type ?? "other",
    customType: input.customType ?? null,
    title: input.title ?? null,
    creators: input.creators ?? [],
    issuedRaw: input.issuedRaw ?? null,
    issuedYear: input.issuedYear ?? null,
    identifiers: input.identifiers ?? [],
    abstract: input.abstract ?? null,
    containerTitle: input.containerTitle ?? null,
    publisher: input.publisher ?? null,
    volume: input.volume ?? null,
    issue: input.issue ?? null,
    pages: input.pages ?? null,
    language: input.language ?? null,
    url: input.url ?? null,
    tags: input.tags ?? [],
  });
  const candidateBase = {
    ...normalized,
    ...(input.abstractSections ? { abstractSections: input.abstractSections } : {}),
    externalReferences: [],
    fieldProvenance: [],
    pdfAvailable: false,
    pdfFileName: null,
    pdfAttachmentCount: 0,
  } satisfies Omit<ScientSourceCandidate, "sourceKey" | "fieldProvenance"> & {
    readonly fieldProvenance: [];
  };
  const candidate: ScientSourceCandidate = {
    ...candidateBase,
    sourceKey: agentSourceKey({ ...candidateBase, sourceKey: "pending" }),
    fieldProvenance: [
      ...Object.entries(normalized).flatMap(([field, value]) =>
        value === null || (Array.isArray(value) && value.length === 0)
          ? []
          : [{ field, origin: "agent" as const, sourceField: null }],
      ),
      ...(input.abstractSections && input.abstractSections.length > 0
        ? [{ field: "abstractSections", origin: "agent" as const, sourceField: null }]
        : []),
      ...normalized.identifiers.map((_, index) => ({
        field: `identifiers.${index}`,
        origin: "agent" as const,
        sourceField: null,
      })),
    ],
  };
  return { candidate, validationIssues: validateScientSourceEditableMetadata(normalized) };
}

function mergePreparedAgentPdfCandidate(
  input: ScientSourceAddInputType,
  prepared: ScientSourceCandidate,
  agent: ScientSourceCandidate,
  pdfSha256: string,
): ScientSourceCandidate {
  const merged = {
    ...prepared,
    ...(input.type ? { type: input.type } : {}),
    ...(input.customType !== undefined ? { customType: input.customType } : {}),
    ...(input.title ? { title: input.title } : {}),
    ...(input.creators && input.creators.length > 0 ? { creators: input.creators } : {}),
    ...(input.issuedRaw ? { issuedRaw: input.issuedRaw } : {}),
    ...(input.issuedYear !== undefined && input.issuedYear !== null
      ? { issuedYear: input.issuedYear }
      : {}),
    ...(input.identifiers && input.identifiers.length > 0
      ? { identifiers: input.identifiers }
      : {}),
    ...(input.abstract ? { abstract: input.abstract } : {}),
    ...(input.abstractSections && input.abstractSections.length > 0
      ? { abstractSections: input.abstractSections }
      : {}),
    ...(input.containerTitle ? { containerTitle: input.containerTitle } : {}),
    ...(input.publisher ? { publisher: input.publisher } : {}),
    ...(input.volume ? { volume: input.volume } : {}),
    ...(input.issue ? { issue: input.issue } : {}),
    ...(input.pages ? { pages: input.pages } : {}),
    ...(input.language ? { language: input.language } : {}),
    ...(input.url ? { url: input.url } : {}),
    ...(input.tags && input.tags.length > 0 ? { tags: input.tags } : {}),
    fieldProvenance: [...prepared.fieldProvenance, ...agent.fieldProvenance],
  };
  return {
    ...merged,
    sourceKey: agentSourceKey({ ...merged, sourceKey: "pending" }, pdfSha256),
  };
}

export const resolveScientSourcesProject = Effect.fn("ScientSourcesToolkit.resolveProject")(
  function* () {
    const workspace = yield* consumeAgentWorkspace().pipe(
      Effect.mapError((error) => toolError(error.code, error.message)),
    );
    return {
      projectId: workspace.binding.hostProjectId,
      root: workspace.binding.canonicalRoot,
    };
  },
);

const creatorName = (record: Awaited<ReturnType<typeof listScientSourceRecords>>[number]) => {
  const creator = record.creators[0];
  return creator?.familyName ?? creator?.literalName ?? creator?.givenName ?? null;
};

const doiValue = (record: Awaited<ReturnType<typeof listScientSourceRecords>>[number]) =>
  record.identifiers.find((identifier) => identifier.scheme.toLowerCase() === "doi")?.value ?? null;

export const listScientSourcesForInvocation = Effect.fn("ScientSourcesToolkit.list")(
  function* (input: {
    readonly query?: string;
    readonly tags?: ReadonlyArray<string>;
    readonly collectionId?: string;
    readonly type?: ScientSourceType;
    readonly hasPdf?: boolean;
    readonly savedSearchId?: string;
    readonly inTrash?: boolean;
    readonly offset?: number;
    readonly limit?: number;
  }) {
    const { root } = yield* resolveScientSourcesProject();
    const trash = input.inTrash
      ? new Map(
          (yield* attempt(() => readScientSourceTrashEntries(root))).map((entry) => [
            entry.record.sourceId,
            entry,
          ]),
        )
      : null;
    const all = trash
      ? [...trash.values()].map((entry) => entry.record)
      : yield* attempt(() => listScientSourceRecords(root));
    const narrowsByOrganization =
      input.collectionId !== undefined || input.savedSearchId !== undefined;
    const organization = narrowsByOrganization
      ? yield* attempt(() => readScientSourcesOrganization(root))
      : { collections: [], savedSearches: [] };
    const saved = input.savedSearchId
      ? organization.savedSearches.find((search) => search.searchId === input.savedSearchId)
      : undefined;
    if (input.savedSearchId && !saved) {
      return yield* toolError("not-found", "The saved search was not found in this project.");
    }
    const filters: ReadonlyArray<ScientSourceFilter> = [
      ...(saved ? [saved.filter] : []),
      {
        ...(input.query ? { text: input.query } : {}),
        ...(input.tags ? { tags: input.tags } : {}),
        ...(input.collectionId ? { collectionId: input.collectionId } : {}),
        ...(input.type ? { type: input.type } : {}),
        ...(input.hasPdf !== undefined ? { hasPdf: input.hasPdf } : {}),
      },
    ];
    const predicates = filters.map((filter) => compileScientSourceFilter(filter, organization));
    const matching = all.filter((record) => predicates.every((matches) => matches(record)));
    // The public schema rejects invalid values. Clamp here as a second
    // boundary so internal callers cannot accidentally create an unbounded
    // model payload by bypassing MCP decoding.
    const offset = Math.max(0, input.offset ?? 0);
    const limit = Math.min(50, Math.max(1, input.limit ?? 25));
    const page = matching.slice(offset, offset + limit);
    return {
      records: page.map((record) => ({
        sourceId: record.sourceId,
        revision: record.revision,
        ...(record.citationKey ? { citationKey: record.citationKey } : {}),
        type: record.type,
        title: record.title,
        creator: creatorName(record),
        issuedYear: record.issuedYear,
        containerTitle: record.containerTitle,
        doi: doiValue(record),
        hasPdf: record.attachments.some((attachment) => attachment.kind === "pdf"),
        addedBy: record.origin?.actor ?? "user",
        ...(record.verification ? { verification: record.verification.state } : {}),
        ...(record.editorialStatus && record.editorialStatus.state !== "none"
          ? { editorialStatus: record.editorialStatus.state }
          : {}),
        ...(trash?.has(record.sourceId)
          ? {
              removedAt: trash.get(record.sourceId)!.removedAt,
              removedBy: trash.get(record.sourceId)!.removedBy,
            }
          : {}),
        ...(record.tags.length > 0 ? { tags: record.tags } : {}),
      })),
      total: matching.length,
      nextOffset: offset + page.length < matching.length ? offset + page.length : null,
    };
  },
);

export const readScientSourceCollectionsForInvocation = Effect.fn(
  "ScientSourcesToolkit.collections",
)(function* () {
  const { root } = yield* resolveScientSourcesProject();
  const records = yield* attempt(() => listScientSourceRecords(root));
  const organization = yield* attempt(() =>
    readScientSourcesOrganization(root, new Set(records.map((record) => record.sourceId))),
  );
  return {
    collections: organization.collections.map((collection) => ({
      collectionId: collection.collectionId,
      name: collection.name,
      sourceCount: collection.sourceIds.length,
    })),
    savedSearches: organization.savedSearches.map(({ searchId, name, filter }) => ({
      searchId,
      name,
      filter,
    })),
    tags: scientSourceTagCounts(records).slice(0, 200),
    ...(organization.issue ? { message: organization.issue } : {}),
  };
});

export const organizeScientSourcesForInvocation = Effect.fn("ScientSourcesToolkit.organize")(
  function* (input: { readonly change: ScientSourcesOrganizeAction }) {
    const { root } = yield* resolveScientSourcesProject();
    return yield* attempt(() => organizeSources({ root, change: input.change, actor: "agent" }));
  },
);

export const bulkUpdateScientSourcesForInvocation = Effect.fn("ScientSourcesToolkit.bulkUpdate")(
  function* (input: { readonly change: ScientSourcesBulkRequestChange }) {
    const { root } = yield* resolveScientSourcesProject();
    const result = yield* attempt(() =>
      bulkUpdateSources({ root, change: input.change, actor: "agent" }),
    );
    // Store messages for a failed source may name host paths; keep them out of model output.
    return {
      ...result,
      sources: result.sources.map((entry) =>
        entry.message && (entry.message.includes(root) || /[\\/]\.scient[\\/]/u.test(entry.message))
          ? { ...entry, message: "The source could not be updated." }
          : entry,
      ),
    };
  },
);

export const getScientSourceForInvocation = Effect.fn("ScientSourcesToolkit.get")(
  function* (input: { readonly sourceId: string }) {
    const { root } = yield* resolveScientSourcesProject();
    const record = yield* attempt(() => readScientSourceRecord(root, input.sourceId));
    if (!record) return yield* toolError("not-found", "The source was not found in this project.");
    const revisions = yield* attempt(() => listScientSourceRevisions(root, input.sourceId));
    const maximumAbstractCharacters = 50_000;
    const abstract = record.abstract;
    const abstractTruncated = abstract !== null && abstract.length > maximumAbstractCharacters;
    return {
      ...record,
      abstract: abstractTruncated ? abstract.slice(0, maximumAbstractCharacters) : abstract,
      abstractTruncated,
      note: record.note ?? null,
      revisions: revisions ?? [],
      attachments: record.attachments.map(
        ({
          attachmentId,
          kind,
          fileName,
          mediaType,
          sha256,
          byteLength,
          importedAt,
          retrieval,
        }) => ({
          attachmentId,
          kind,
          fileName,
          mediaType,
          sha256,
          byteLength,
          importedAt,
          ...(retrieval ? { retrieval } : {}),
        }),
      ),
    };
  },
);

export const updateScientSourceNoteForInvocation = Effect.fn("ScientSourcesToolkit.updateNote")(
  function* (input: {
    readonly sourceId: string;
    readonly expectedRevision: number;
    readonly note: string | null;
  }) {
    const { root } = yield* resolveScientSourcesProject();
    const current = yield* attempt(() => readScientSourceRecord(root, input.sourceId));
    if (!current) return yield* toolError("not-found", "The source was not found in this project.");
    const result = yield* attempt(() =>
      updateSourceNote({
        root,
        sourceId: input.sourceId,
        expectedRevision: input.expectedRevision,
        note: input.note,
        actor: "agent",
      }),
    );
    return {
      outcome: result.outcome,
      sourceId: result.record.sourceId,
      revision: result.record.revision,
      note: result.record.note ?? null,
    };
  },
);

export const updateScientSourceForInvocation = Effect.fn("ScientSourcesToolkit.update")(
  function* (input: {
    readonly sourceId: string;
    readonly expectedRevision: number;
    readonly metadata: ScientSourceEditableMetadata;
    readonly allowPossibleMetadataMatch?: boolean;
  }) {
    const { root } = yield* resolveScientSourcesProject();
    const citationKey = input.metadata.citationKey?.trim();
    if (citationKey) {
      const records = yield* attempt(() => listScientSourceRecords(root));
      const current = records.find((record) => record.sourceId === input.sourceId);
      const message =
        current?.citationKey === citationKey
          ? null
          : citationKeyValidationMessage(citationKey, takenCitationKeys(records, input.sourceId));
      if (message) return yield* toolError("operation-failed", message);
    }
    const result = yield* attempt(() =>
      updateScientSource({
        root,
        sourceId: input.sourceId,
        expectedRevision: input.expectedRevision,
        metadata: input.metadata,
        allowPossibleMetadataMatch: input.allowPossibleMetadataMatch ?? false,
        actor: "agent",
      }),
    );
    return {
      outcome: result.outcome,
      sourceId: result.record.sourceId,
      revision: result.record.revision,
      duplicate: result.duplicate,
      validationIssues: result.validationIssues,
      ...(result.citationKeyRenamedIn ? { citationKeyRenamedIn: result.citationKeyRenamedIn } : {}),
      ...(result.citationKeyRenameSkipped
        ? { citationKeyRenameSkipped: result.citationKeyRenameSkipped }
        : {}),
    };
  },
);

export const removeScientSourceForInvocation = Effect.fn("ScientSourcesToolkit.remove")(
  function* (input: {
    readonly sourceId: string;
    readonly expectedRevision: number;
    readonly permanent?: boolean;
  }) {
    const { root } = yield* resolveScientSourcesProject();
    if (input.permanent) {
      const deleted = yield* attempt(() =>
        deleteTrashedScientSource({
          root,
          sourceId: input.sourceId,
          expectedRevision: input.expectedRevision,
        }),
      );
      return {
        outcome: deleted.outcome,
        sourceId: input.sourceId,
        revision: deleted.outcome === "stale" ? deleted.revision : null,
      };
    }
    const result = yield* attempt(() =>
      removeSource({
        root,
        sourceId: input.sourceId,
        expectedRevision: input.expectedRevision,
        actor: "agent",
      }),
    );
    return {
      outcome: result.outcome,
      sourceId: result.sourceId,
      revision: result.revision,
      ...(result.restorable ? { restorable: true } : {}),
    };
  },
);

export const restoreScientSourceForInvocation = Effect.fn("ScientSourcesToolkit.restore")(
  function* (input: { readonly sourceId: string }) {
    const { root } = yield* resolveScientSourcesProject();
    const result = yield* attempt(() =>
      restoreScientSource({ root, sourceId: input.sourceId, actor: "agent" }),
    );
    return {
      outcome: result.outcome,
      sourceId: result.sourceId,
      revision: result.record?.revision ?? null,
      matchingSourceIds: result.matchingSourceIds,
    };
  },
);

export const revertScientSourceForInvocation = Effect.fn("ScientSourcesToolkit.revert")(
  function* (input: {
    readonly sourceId: string;
    readonly expectedRevision: number;
    readonly toRevision: number;
  }) {
    const { root } = yield* resolveScientSourcesProject();
    const current = yield* attempt(() => readScientSourceRecord(root, input.sourceId));
    if (!current) return yield* toolError("not-found", "The source was not found in this project.");
    const result = yield* attempt(() => revertScientSource({ root, ...input, actor: "agent" }));
    return {
      outcome: result.outcome,
      sourceId: result.record.sourceId,
      revision: result.record.revision,
      missingAttachmentCount: result.missingAttachmentCount,
      matchingSourceIds: result.matchingSourceIds,
    };
  },
);

const IDENTIFIER_LIST_OPTIONS = new Set(["identifierList", "enrich", "allowPossibleMetadataMatch"]);

const addScientSourcesByIdentifierForInvocation = Effect.fn("ScientSourcesToolkit.addByIdentifier")(
  function* (input: ScientSourceAddInputType, identifierList: ReadonlyArray<string>) {
    const { root } = yield* resolveScientSourcesProject();
    const extra = Object.keys(input).find((field) => !IDENTIFIER_LIST_OPTIONS.has(field));
    if (extra) {
      const message =
        "Give identifierList alone. Add a source from citation fields or a PDF in a separate call.";
      return {
        outcome: "invalid" as const,
        sourceId: null,
        revision: null,
        duplicate: { kind: "new" as const, matchingSourceIds: [], reason: message },
        validationIssues: [{ field: extra, message }],
      };
    }
    const resolveIdentifiers = yield* SourceIdentifierBatchLookup;
    const observeImport = yield* makeSourceImportAnalytics("agent");
    const results = yield* attempt(() =>
      addScientSourcesByIdentifier(
        {
          root,
          entries: identifierList,
          actor: "agent",
          enrich: input.enrich ?? false,
          allowPossibleMetadataMatch: input.allowPossibleMetadataMatch ?? false,
          resolveIdentifiers,
        },
        observeImport,
      ),
    );
    const summary = summarizeIdentifierAdd(results);
    return {
      outcome: "batch" as const,
      sourceId: null,
      revision: null,
      duplicate: { kind: "new" as const, matchingSourceIds: [], reason: summary },
      validationIssues: [],
      results,
      message: summary,
    };
  },
);

export const addScientSourceForInvocation = Effect.fn("ScientSourcesToolkit.add")(function* (
  input: ScientSourceAddInputType,
) {
  if (input.identifierList) {
    return yield* addScientSourcesByIdentifierForInvocation(input, input.identifierList);
  }
  const { root } = yield* resolveScientSourcesProject();
  const { candidate: initialCandidate, validationIssues: initialIssues } =
    candidateFromAgentInput(input);
  const pdfRelativePath = input.pdfRelativePath;
  const resolvedPdf = pdfRelativePath
    ? yield* attempt(() => resolveScientSourceInputPdf(root, pdfRelativePath))
    : null;
  const preparedPdf = resolvedPdf
    ? yield* attempt(() =>
        prepareAgentProjectPdf({
          sourceKey: initialCandidate.sourceKey,
          sourcePath: resolvedPdf.absolutePath,
          fileName: resolvedPdf.fileName,
        }),
      )
    : null;
  const candidate = preparedPdf
    ? mergePreparedAgentPdfCandidate(
        input,
        preparedPdf.candidate,
        initialCandidate,
        preparedPdf.expectedPdf.sha256,
      )
    : initialCandidate;
  const hasIdentifier = candidate.identifiers.length > 0;
  const hasDescriptiveIdentity =
    Boolean(candidate.title?.trim()) &&
    candidate.creators.length > 0 &&
    candidate.issuedYear !== null;
  const validationIssues = preparedPdf
    ? []
    : hasIdentifier || hasDescriptiveIdentity
      ? initialIssues
      : [
          ...initialIssues,
          {
            field: "identity",
            message: "Provide an identifier or a title, creator, and publication year.",
          },
        ];
  if (validationIssues.length > 0) {
    return {
      outcome: "invalid" as const,
      sourceId: null,
      revision: null,
      duplicate: {
        kind: "new" as const,
        matchingSourceIds: [],
        reason: "The source metadata did not pass validation.",
      },
      validationIssues,
    };
  }
  const resolveIdentifier = yield* keyedIdentifierLookup();
  const observeImport = yield* makeSourceImportAnalytics("agent");
  const result = yield* attempt(() =>
    addAgentSource(
      {
        root,
        candidate,
        enrich: input.enrich ?? false,
        allowPossibleMetadataMatch: input.allowPossibleMetadataMatch ?? false,
        resolveIdentifier,
        claimedTitle: input.title ?? null,
        ...(resolvedPdf
          ? {
              pdfPath: resolvedPdf.absolutePath,
              pdfFileName: resolvedPdf.fileName,
              ...(preparedPdf ? { expectedPdf: preparedPdf.expectedPdf } : {}),
            }
          : {}),
      },
      observeImport,
    ),
  );
  if (result.outcome === "identifier-not-found" || result.outcome === "identifier-mismatch") {
    return {
      outcome: result.outcome,
      sourceId: null,
      revision: null,
      duplicate: { kind: "new" as const, matchingSourceIds: [], reason: result.message },
      validationIssues,
      ...(result.outcome === "identifier-mismatch" ? { resolved: result.resolved } : {}),
      message: result.message,
    };
  }
  const duplicateSourceId =
    result.record?.sourceId ?? result.duplicate.matchingSourceIds[0] ?? null;
  const duplicateRecord =
    result.record ??
    (duplicateSourceId
      ? yield* attempt(() => readScientSourceRecord(root, duplicateSourceId))
      : null);
  return {
    outcome: result.outcome,
    sourceId: duplicateSourceId,
    revision: duplicateRecord?.revision ?? null,
    duplicate: result.duplicate,
    validationIssues,
    ...(duplicateRecord?.verification ? { verification: duplicateRecord.verification.state } : {}),
    ...(duplicateRecord?.editorialStatus && duplicateRecord.editorialStatus.state !== "none"
      ? {
          editorialStatus: duplicateRecord.editorialStatus.state,
          message: `The registry reports this work as ${EDITORIAL_WORDS[duplicateRecord.editorialStatus.state]}. Tell the user before relying on it.`,
        }
      : {}),
  };
});

const EDITORIAL_WORDS = {
  retracted: "retracted",
  withdrawn: "withdrawn",
  "expression-of-concern": "under an expression of concern",
  corrected: "corrected",
} as const;

export const checkScientSourceForInvocation = Effect.fn("ScientSourcesToolkit.check")(
  function* (input: { readonly sourceId: string }) {
    const { root } = yield* resolveScientSourcesProject();
    const current = yield* attempt(() => readScientSourceRecord(root, input.sourceId));
    if (!current) return yield* toolError("not-found", "The source was not found in this project.");
    const resolveIdentifier = yield* keyedIdentifierLookup();
    const result = yield* attempt(() =>
      checkSourceIdentifier({ root, sourceId: input.sourceId, actor: "agent", resolveIdentifier }),
    );
    return {
      outcome: result.outcome,
      sourceId: result.record.sourceId,
      revision: result.record.revision,
      registry: result.registry,
      ...(result.record.verification ? { verification: result.record.verification } : {}),
      ...(result.record.editorialStatus ? { editorialStatus: result.record.editorialStatus } : {}),
    };
  },
);

export const attachScientSourcePdfForInvocation = Effect.fn("ScientSourcesToolkit.attachPdf")(
  function* (input: {
    readonly sourceId: string;
    readonly expectedRevision: number;
    readonly pdfRelativePath: string;
  }) {
    const { root } = yield* resolveScientSourcesProject();
    const resolvedPdf = yield* attempt(() =>
      resolveScientSourceInputPdf(root, input.pdfRelativePath),
    );
    const result = yield* attempt(() =>
      attachSourcePdf({
        root,
        sourceId: input.sourceId,
        expectedRevision: input.expectedRevision,
        pdfPath: resolvedPdf.absolutePath,
        fileName: resolvedPdf.fileName,
        actor: "agent",
      }),
    );
    return {
      outcome: result.outcome,
      sourceId: result.record.sourceId,
      revision: result.record.revision,
    };
  },
);

export const detachScientSourcePdfForInvocation = Effect.fn("ScientSourcesToolkit.detachPdf")(
  function* (input: {
    readonly sourceId: string;
    readonly attachmentId: string;
    readonly expectedRevision: number;
  }) {
    const { root } = yield* resolveScientSourcesProject();
    const result = yield* attempt(() => detachSourcePdf({ root, ...input, actor: "agent" }));
    return {
      outcome: result.outcome,
      sourceId: result.record?.sourceId ?? input.sourceId,
      attachmentId: result.attachmentId,
      revision: result.record?.revision ?? null,
    };
  },
);

const syncScientBibliographyForInvocation = Effect.fn("ScientSourcesToolkit.bibliography")(
  function* (input: {
    readonly replaceEdited?: ReadonlyArray<"references.bib" | "references.json">;
    readonly importEdited?: ReadonlyArray<"references.bib" | "references.json">;
  }) {
    const { root } = yield* resolveScientSourcesProject();
    const observeImport = yield* makeSourceImportAnalytics("agent");
    return yield* attempt(() =>
      syncManagedBibliographyWithImports({ root, ...input, actor: "agent" }, observeImport),
    );
  },
);

const searchScientSourcesForInvocation = Effect.fn("ScientSourcesToolkit.search")(
  function* (input: {
    readonly query: string;
    readonly sourceIds?: ReadonlyArray<string>;
    readonly limit?: number;
  }) {
    const { root } = yield* resolveScientSourcesProject();
    const { hits, status } = yield* attempt(() =>
      searchSourceFullText({
        root,
        query: input.query,
        limit: Math.min(25, Math.max(1, input.limit ?? 10)),
        ...(input.sourceIds ? { sourceIds: input.sourceIds } : {}),
      }),
    );
    return {
      status,
      hits: hits.map(
        ({ sourceId, attachmentId, title, page, start, end, passage, matchedTerms }) => ({
          sourceId,
          attachmentId,
          title,
          page,
          start,
          end,
          passage,
          matchedTerms,
        }),
      ),
    };
  },
);

const readScientSourceTextForInvocation = Effect.fn("ScientSourcesToolkit.readText")(
  function* (input: {
    readonly sourceId: string;
    readonly attachmentId?: string;
    readonly fromPage?: number;
    readonly maxCharacters?: number;
  }) {
    const { root } = yield* resolveScientSourcesProject();
    return yield* attempt(() =>
      readSourceText({
        root,
        sourceId: input.sourceId,
        ...(input.attachmentId ? { attachmentId: input.attachmentId } : {}),
        fromPage: Math.max(1, input.fromPage ?? 1),
        maxCharacters: Math.min(60_000, Math.max(1_000, input.maxCharacters ?? 20_000)),
      }),
    );
  },
);

const checkScientSourceQuotesForInvocation = Effect.fn("ScientSourcesToolkit.checkQuotes")(
  function* (input: {
    readonly quotes: ReadonlyArray<{ readonly quote: string; readonly sourceId?: string }>;
  }) {
    const { root } = yield* resolveScientSourcesProject();
    const results = yield* attempt(() =>
      checkSourceQuotes({ root, quotes: input.quotes.slice(0, 25) }),
    );
    return { results };
  },
);

const saveScientSourcePageForInvocation = Effect.fn("ScientSourcesToolkit.savePage")(
  function* (input: {
    readonly url: string;
    readonly title?: string;
    readonly passage?: string;
    readonly meta?: ReadonlyArray<{ readonly name: string; readonly content: string }>;
  }) {
    const { root } = yield* resolveScientSourcesProject();
    const resolveIdentifier = yield* keyedIdentifierLookup();
    const observeImport = yield* makeSourceImportAnalytics("agent");
    const result = yield* attempt(() =>
      saveWebPageSource(
        {
          root,
          page: {
            url: input.url,
            title: input.title ?? null,
            selection: input.passage ?? null,
            meta: input.meta ?? [],
          },
          actor: "agent",
          resolveIdentifier,
        },
        observeImport,
      ),
    );
    return result.outcome === "not-added"
      ? { ...result, sourceId: null, revision: null, passageSaved: false }
      : result;
  },
);

export const importScientSourcesFileForInvocation = Effect.fn("ScientSourcesToolkit.importFile")(
  function* (input: { readonly relativePath: string; readonly format?: BibliographyFormat }) {
    const { root } = yield* resolveScientSourcesProject();
    const observeImport = yield* makeSourceImportAnalytics("agent");
    const { operation, report } = yield* Effect.tryPromise({
      try: async () => {
        const file = await resolveProjectBibliographyFile(root, input.relativePath);
        return importBibliographyFile(
          {
            root,
            operationId: `agent_file_${NodeCrypto.randomUUID()}`,
            fileName: file.fileName,
            text: await readBibliographyFile(file.absolutePath),
            actor: "agent",
            ...(input.format ? { format: input.format } : {}),
          },
          observeImport,
        );
      },
      catch: (error) =>
        toolError(
          "operation-failed",
          bibliographyFileErrorMessage(error, "The reference file could not be imported."),
        ),
    });
    const items = operation?.items ?? [];
    const importedIds = items.flatMap((item) =>
      item.state === "imported" && item.sourceId ? [item.sourceId] : [],
    );
    const records =
      importedIds.length > 0 ? yield* attempt(() => listScientSourceRecords(root)) : [];
    const keys = new Map(records.map((record) => [record.sourceId, record.citationKey ?? null]));
    return {
      format: report.format,
      entryCount: report.entryCount,
      importedCount: importedIds.length,
      imported: importedIds
        .slice(0, 100)
        .map((sourceId) => ({ sourceId, citationKey: keys.get(sourceId) ?? null })),
      alreadyInLibrary:
        report.alreadyInLibrary + items.filter((item) => item.state === "skipped").length,
      failed: items.flatMap((item) =>
        item.state === "failed"
          ? [
              {
                line: null,
                citationKey: null,
                reason: item.message ?? "This entry could not be imported.",
              },
            ]
          : [],
      ),
      remaining: report.remaining,
      unreadable: report.unreadable,
      notKept: report.notKept,
      withoutCitationKey: report.withoutCitationKey,
    };
  },
);

export const exportScientSourcesForInvocation = Effect.fn("ScientSourcesToolkit.export")(
  function* (input: {
    readonly relativePath: string;
    readonly format: BibliographyFormat;
    readonly sourceIds?: ReadonlyArray<string>;
    readonly includeNotes?: boolean;
    readonly overwrite?: boolean;
  }) {
    const { root } = yield* resolveScientSourcesProject();
    const exported = yield* attempt(() =>
      exportBibliography({
        root,
        format: input.format,
        ...(input.sourceIds ? { sourceIds: input.sourceIds } : {}),
        includeNotes: input.includeNotes ?? false,
      }),
    );
    const platform = yield* HostProcess.Platform;
    const written = yield* Effect.tryPromise({
      try: () =>
        writeProjectBibliographyFile({
          root,
          relativePath: input.relativePath,
          content: exported.content,
          overwrite: input.overwrite ?? false,
          caseInsensitive: caseInsensitiveFileSystem(platform),
        }),
      catch: (error) =>
        toolError(
          "operation-failed",
          bibliographyFileErrorMessage(error, "The export file could not be written."),
        ),
    });
    return {
      outcome: written.outcome,
      relativePath: written.relativePath,
      sourceCount: exported.sourceCount,
      missingSourceIds: exported.missingSourceIds,
      notKept: exported.notKept,
    };
  },
);

const citeScientSourcesForInvocation = Effect.fn("ScientSourcesToolkit.cite")(function* (input: {
  readonly sources: ReadonlyArray<string>;
  readonly format?: "markdown" | "latex";
}) {
  const { root } = yield* resolveScientSourcesProject();
  const resolveIdentifiers = yield* ReferenceIdentifierLookup;
  return yield* attempt(() =>
    citeLibrarySources(
      { root, sources: input.sources, format: input.format ?? "markdown" },
      { resolveIdentifiers },
    ),
  );
});

const handlers = {
  scient_sources_list: listScientSourcesForInvocation,
  scient_sources_get: getScientSourceForInvocation,
  scient_sources_note_update: updateScientSourceNoteForInvocation,
  scient_sources_update: updateScientSourceForInvocation,
  scient_sources_remove: removeScientSourceForInvocation,
  scient_sources_restore: restoreScientSourceForInvocation,
  scient_sources_revert: revertScientSourceForInvocation,
  scient_sources_check: checkScientSourceForInvocation,
  scient_sources_add: addScientSourceForInvocation,
  scient_sources_attach_pdf: attachScientSourcePdfForInvocation,
  scient_sources_detach_pdf: detachScientSourcePdfForInvocation,
  scient_sources_bibliography: syncScientBibliographyForInvocation,
  scient_sources_cite: citeScientSourcesForInvocation,
  scient_sources_search: searchScientSourcesForInvocation,
  scient_sources_read_text: readScientSourceTextForInvocation,
  scient_sources_quote_check: checkScientSourceQuotesForInvocation,
  scient_sources_save_page: saveScientSourcePageForInvocation,
  scient_sources_zotero_browse: browseZoteroForInvocation,
  scient_sources_zotero_import: importZoteroForInvocation,
  scient_sources_zotero_refresh: refreshZoteroForInvocation,
  scient_sources_zotero_send: sendToZoteroForInvocation,
  scient_sources_collections: readScientSourceCollectionsForInvocation,
  scient_sources_organize: organizeScientSourcesForInvocation,
  scient_sources_bulk_update: bulkUpdateScientSourcesForInvocation,
  scient_sources_import_file: importScientSourcesFileForInvocation,
  scient_sources_export: exportScientSourcesForInvocation,
} satisfies Parameters<typeof ScientSourcesToolkit.toLayer>[0];

export const ScientSourcesToolkitHandlersLive = ScientSourcesToolkit.toLayer(handlers);
