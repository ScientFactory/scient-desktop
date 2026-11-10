// @effect-diagnostics nodeBuiltinImport:off -- Idempotent Scient source operation IDs use the existing synchronous content fingerprint.
import * as NodeCrypto from "node:crypto";

import {
  normalizeScientSourceEditableMetadata,
  validateScientSourceEditableMetadata,
  type ScientSourceCandidate,
  type ScientSourceEditableMetadata,
} from "@scientfactory/scient-sources";
import { resolveScientSourceInputPdf } from "@scientfactory/scient-sources/store";
import {
  deleteScientSourcesPermanently,
  listScientSourceRecords,
  listScientSourceRevisions,
  readScientSourceRecord,
  readScientSourceTrashEntries,
  restoreScientSource,
  revertScientSource,
} from "@scientfactory/scient-sources/store";
import * as Effect from "effect/Effect";
import { consumeAgentWorkspace } from "../../../scient/operations/AgentWorkspaceScope.ts";

import { makeSourceImportAnalytics } from "../../../telemetry/SourceImportAnalytics.ts";
import { SourceIdentifierLookup } from "../../../scient/sources/SourceIdentifierResolver.ts";
import {
  ScientSourcesToolError,
  ScientSourcesToolkit,
  type ScientSourceAddInput as ScientSourceAddInputType,
} from "./tools.ts";
import {
  addAgentSource,
  attachSourcePdf,
  detachSourcePdf,
  prepareAgentProjectPdf,
  removeSource,
  updateScientSource,
  updateSourceNote,
} from "../../../scient/sources/ScientSourcesCoordinator.ts";
import {
  checkSourceQuotes,
  readSourceText,
  searchSourceFullText,
} from "../../../scient/sources/SourceFullText.ts";

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
    const query = input.query?.trim().toLowerCase() ?? "";
    const matching =
      query.length === 0
        ? all
        : all.filter((record) =>
            [
              record.title,
              creatorName(record),
              record.issuedYear,
              record.containerTitle,
              doiValue(record),
            ]
              .filter((value) => value !== null)
              .join(" ")
              .toLowerCase()
              .includes(query),
          );
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
        type: record.type,
        title: record.title,
        creator: creatorName(record),
        issuedYear: record.issuedYear,
        containerTitle: record.containerTitle,
        doi: doiValue(record),
        hasPdf: record.attachments.some((attachment) => attachment.kind === "pdf"),
        addedBy: record.origin?.actor ?? "user",
        ...(record.verification ? { verification: record.verification.state } : {}),
        ...(trash?.has(record.sourceId)
          ? {
              removedAt: trash.get(record.sourceId)!.removedAt,
              removedBy: trash.get(record.sourceId)!.removedBy,
            }
          : {}),
      })),
      total: matching.length,
      nextOffset: offset + page.length < matching.length ? offset + page.length : null,
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
      const trashed = (yield* attempt(() => readScientSourceTrashEntries(root))).find(
        (entry) => entry.sourceId === input.sourceId,
      );
      if (!trashed) {
        return { outcome: "not-found" as const, sourceId: input.sourceId, revision: null };
      }
      if (trashed.record.revision !== input.expectedRevision) {
        return {
          outcome: "stale" as const,
          sourceId: input.sourceId,
          revision: trashed.record.revision,
        };
      }
      const deleted = yield* attempt(() =>
        deleteScientSourcesPermanently({ root, sourceIds: [input.sourceId] }),
      );
      return {
        outcome: deleted.deletedSourceIds.includes(input.sourceId)
          ? ("deleted" as const)
          : ("not-found" as const),
        sourceId: input.sourceId,
        revision: null,
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

export const addScientSourceForInvocation = Effect.fn("ScientSourcesToolkit.add")(function* (
  input: ScientSourceAddInputType,
) {
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
  const resolveIdentifier = yield* SourceIdentifierLookup;
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
  };
});

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

const handlers = {
  scient_sources_list: listScientSourcesForInvocation,
  scient_sources_get: getScientSourceForInvocation,
  scient_sources_note_update: updateScientSourceNoteForInvocation,
  scient_sources_update: updateScientSourceForInvocation,
  scient_sources_remove: removeScientSourceForInvocation,
  scient_sources_restore: restoreScientSourceForInvocation,
  scient_sources_revert: revertScientSourceForInvocation,
  scient_sources_add: addScientSourceForInvocation,
  scient_sources_attach_pdf: attachScientSourcePdfForInvocation,
  scient_sources_detach_pdf: detachScientSourcePdfForInvocation,
  scient_sources_search: searchScientSourcesForInvocation,
  scient_sources_read_text: readScientSourceTextForInvocation,
  scient_sources_quote_check: checkScientSourceQuotesForInvocation,
} satisfies Parameters<typeof ScientSourcesToolkit.toLayer>[0];

export const ScientSourcesToolkitHandlersLive = ScientSourcesToolkit.toLayer(handlers);
