import * as NodeCrypto from "node:crypto";

import {
  normalizeScientSourceEditableMetadata,
  validateScientSourceEditableMetadata,
  type ScientSourceCandidate,
  type ScientSourceEditableMetadata,
} from "@scientfactory/scient-sources";
import { resolveScientSourceInputPdf } from "@scientfactory/scient-sources/store";
import {
  listScientSourceRecords,
  readScientSourceRecord,
} from "@scientfactory/scient-sources/store";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as ProjectionSnapshotQuery from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
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
  updateSourceReview,
  updateSourceNote,
} from "../../../scient/sources/ScientSourcesCoordinator.ts";

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

const requireSourcesWrite = Effect.fn("ScientSourcesToolkit.requireWrite")(function* () {
  const invocation = yield* McpInvocationContext.McpInvocationContext;
  if (!invocation.capabilities.has("sources:write")) {
    return yield* toolError(
      "capability-unavailable",
      "This provider session does not grant Sources write access.",
    );
  }
  return invocation;
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
    const invocation = yield* McpInvocationContext.McpInvocationContext;
    if (!invocation.capabilities.has("sources:read")) {
      return yield* toolError(
        "capability-unavailable",
        "This provider session does not grant Sources access.",
      );
    }
    const snapshots = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
    const thread = yield* snapshots
      .getThreadShellById(invocation.threadId)
      .pipe(
        Effect.mapError(() =>
          toolError("operation-failed", "The current thread could not be resolved."),
        ),
      );
    if (Option.isNone(thread) || thread.value.projectId === null) {
      return yield* toolError(
        "project-required",
        "Sources tools require a thread that belongs to a Scient project.",
      );
    }
    const project = yield* snapshots
      .getProjectShellById(thread.value.projectId)
      .pipe(
        Effect.mapError(() =>
          toolError("operation-failed", "The current project could not be resolved."),
        ),
      );
    if (Option.isNone(project)) {
      return yield* toolError(
        "project-changed",
        "The project for this thread is no longer active.",
      );
    }
    return {
      projectId: thread.value.projectId,
      root: thread.value.worktreePath ?? project.value.workspaceRoot,
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
    readonly offset?: number;
    readonly limit?: number;
  }) {
    const { root } = yield* resolveScientSourcesProject();
    const all = yield* attempt(() => listScientSourceRecords(root));
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
        review: record.origin?.review ?? "none",
        addedBy: record.origin?.actor ?? "user",
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
    const maximumAbstractCharacters = 50_000;
    const abstract = record.abstract;
    const abstractTruncated = abstract !== null && abstract.length > maximumAbstractCharacters;
    return {
      ...record,
      abstract: abstractTruncated ? abstract.slice(0, maximumAbstractCharacters) : abstract,
      abstractTruncated,
      note: record.note ?? null,
      attachments: record.attachments.map(
        ({ attachmentId, kind, fileName, mediaType, sha256, byteLength, importedAt }) => ({
          attachmentId,
          kind,
          fileName,
          mediaType,
          sha256,
          byteLength,
          importedAt,
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
    yield* requireSourcesWrite();
    const { root } = yield* resolveScientSourcesProject();
    const current = yield* attempt(() => readScientSourceRecord(root, input.sourceId));
    if (!current) return yield* toolError("not-found", "The source was not found in this project.");
    const result = yield* attempt(() =>
      updateSourceNote({
        root,
        sourceId: input.sourceId,
        expectedRevision: input.expectedRevision,
        note: input.note,
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
    yield* requireSourcesWrite();
    const { root } = yield* resolveScientSourcesProject();
    const result = yield* attempt(() =>
      updateScientSource({
        root,
        sourceId: input.sourceId,
        expectedRevision: input.expectedRevision,
        metadata: input.metadata,
        allowPossibleMetadataMatch: input.allowPossibleMetadataMatch ?? false,
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
  function* (input: { readonly sourceId: string; readonly expectedRevision: number }) {
    yield* requireSourcesWrite();
    const { root } = yield* resolveScientSourcesProject();
    const result = yield* attempt(() =>
      removeSource({
        root,
        sourceId: input.sourceId,
        expectedRevision: input.expectedRevision,
      }),
    );
    return {
      outcome: result.outcome,
      sourceId: result.sourceId,
      revision: result.revision,
    };
  },
);

export const reviewScientSourceForInvocation = Effect.fn("ScientSourcesToolkit.review")(
  function* (input: {
    readonly sourceId: string;
    readonly expectedRevision: number;
    readonly action: "approve" | "reject";
  }) {
    yield* requireSourcesWrite();
    const { root } = yield* resolveScientSourcesProject();
    const current = yield* attempt(() => readScientSourceRecord(root, input.sourceId));
    if (!current) return yield* toolError("not-found", "The source was not found in this project.");
    if (input.action === "reject") {
      if (current.origin?.actor !== "agent" || current.origin.review !== "pending") {
        return yield* toolError(
          "operation-failed",
          "Only pending agent-added sources can be rejected through review.",
        );
      }
      const result = yield* attempt(() =>
        removeSource({
          root,
          sourceId: input.sourceId,
          expectedRevision: input.expectedRevision,
        }),
      );
      return {
        action: input.action,
        outcome: result.outcome,
        sourceId: result.sourceId,
        revision: result.revision,
      };
    }
    const result = yield* attempt(() =>
      updateSourceReview({
        root,
        sourceId: input.sourceId,
        expectedRevision: input.expectedRevision,
        review: "none",
      }),
    );
    return {
      action: input.action,
      outcome: result.outcome,
      sourceId: result.record.sourceId,
      revision: result.record.revision,
    };
  },
);

export const addScientSourceForInvocation = Effect.fn("ScientSourcesToolkit.add")(function* (
  input: ScientSourceAddInputType,
) {
  yield* requireSourcesWrite();
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
      review: "none" as const,
    };
  }
  const result = yield* attempt(() =>
    addAgentSource({
      root,
      candidate,
      enrich: input.enrich ?? false,
      allowPossibleMetadataMatch: input.allowPossibleMetadataMatch ?? false,
      ...(resolvedPdf
        ? {
            pdfPath: resolvedPdf.absolutePath,
            pdfFileName: resolvedPdf.fileName,
            ...(preparedPdf ? { expectedPdf: preparedPdf.expectedPdf } : {}),
          }
        : {}),
    }),
  );
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
    review: duplicateRecord?.origin?.review ?? "none",
  };
});

export const attachScientSourcePdfForInvocation = Effect.fn("ScientSourcesToolkit.attachPdf")(
  function* (input: {
    readonly sourceId: string;
    readonly expectedRevision: number;
    readonly pdfRelativePath: string;
  }) {
    yield* requireSourcesWrite();
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
    yield* requireSourcesWrite();
    const { root } = yield* resolveScientSourcesProject();
    const result = yield* attempt(() => detachSourcePdf({ root, ...input }));
    return {
      outcome: result.outcome,
      sourceId: result.record?.sourceId ?? input.sourceId,
      attachmentId: result.attachmentId,
      revision: result.record?.revision ?? null,
      removedAttachmentCount: result.removedAttachmentCount,
      retainedAttachmentCount: result.retainedAttachmentCount,
    };
  },
);

const handlers = {
  scient_sources_list: listScientSourcesForInvocation,
  scient_sources_get: getScientSourceForInvocation,
  scient_sources_note_update: updateScientSourceNoteForInvocation,
  scient_sources_update: updateScientSourceForInvocation,
  scient_sources_remove: removeScientSourceForInvocation,
  scient_sources_review: reviewScientSourceForInvocation,
  scient_sources_add: addScientSourceForInvocation,
  scient_sources_attach_pdf: attachScientSourcePdfForInvocation,
  scient_sources_detach_pdf: detachScientSourcePdfForInvocation,
} satisfies Parameters<typeof ScientSourcesToolkit.toLayer>[0];

export const ScientSourcesToolkitHandlersLive = ScientSourcesToolkit.toLayer(handlers);
