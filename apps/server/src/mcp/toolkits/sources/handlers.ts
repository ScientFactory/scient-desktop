// @effect-diagnostics nodeBuiltinImport:off -- Idempotent Scient source operation IDs use the existing synchronous content fingerprint.
import * as NodeCrypto from "node:crypto";
import * as NodePath from "node:path";

import {
  citationKeyValidationMessage,
  takenCitationKeys,
  compileScientSourceFilter,
  normalizeScientSourceEditableMetadata,
  scientSourceCategoryBasis,
  scientSourceCategoryCounts,
  scientSourceTagCounts,
  validateScientSourceEditableMetadata,
  type ScientSourceCandidate,
  type ScientSourceEditableMetadata,
  type ScientSourceRecord,
  type ScientSourceFilter,
  type ScientSourcesBulkRequestChange,
  type ScientSourcesOrganizeAction,
  scientSourceReadingState,
  type ScientSourceReadingStatus,
  type ScientSourceStudyDesign,
  type ScientSourceType,
} from "@scientfactory/scient-sources";
import { readScientSourcesOrganization } from "@scientfactory/scient-sources/collections";
import {
  currentScientSourceCategories,
  readScientSourceCategories,
  scientSourceCategorySummaryFor,
} from "@scientfactory/scient-sources/categories-store";
import {
  clearScientLibrarySourcesDistinct,
  markScientLibrarySourcesDistinct,
  mergeScientLibrarySources,
  undoScientLibraryMerge,
} from "@scientfactory/scient-sources/library-merge";
import { dismissScientLibraryMoveSummary } from "@scientfactory/scient-sources/library-move";
import {
  scientLibraryLocation,
  scientLibraryRootFor,
} from "@scientfactory/scient-sources/library-root";
import {
  pinScientLibrarySource,
  readScientProjectPinNoteHistory,
  renameScientProjectPinKey,
  setScientProjectPinNote,
  unpinScientLibrarySource,
} from "@scientfactory/scient-sources/project-pins";
import {
  readScientSourceIntakeAssessor,
  resolveScientSourceInputPdf,
  updateScientSourceMetadata,
} from "@scientfactory/scient-sources/store";
import {
  deleteTrashedScientSource,
  listScientSourceRecords,
  listScientSourceRevisions,
  readScientSourceRecord,
  readScientSourceTrashEntries,
  restoreScientSource,
  revertScientSource,
} from "@scientfactory/scient-sources/store";
import type { ScientProjectCitationStyle, ScientSourceLibraryMatch } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { AgentInvocationContext } from "../../../scient/operations/AgentInvocationContext.ts";
import { consumeAgentWorkspace } from "../../../scient/operations/AgentWorkspaceScope.ts";
import {
  resolveScientSourcesStoreFor,
  ScientSourcesBackend,
  type ScientSourcesLibraryStore,
  type ScientSourcesStore,
} from "../../../scient/sources/SourcesBackend.ts";
import {
  alsoPinnedIn,
  distinctPinnedWorks,
  listProjectPinnedWorks,
  projectPinsByLibraryId,
  refreshProjectAfterLibraryChange,
  resolveLibrarySourceId,
  setLibraryReadingState,
  syncProjectBibliography,
} from "../../../scient/sources/LibraryProjectSources.ts";

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
import { keyedBatchLookup, keyedIdentifierLookup } from "../../../scient/sources/researchKeys.ts";
import * as ServerConfig from "../../../config.ts";
import {
  citationStyleCacheRoot,
  readProjectCitationStyle,
  searchCitationStyles,
  setProjectCitationStyle,
} from "../../../scient/sources/CitationStyles.ts";
import {
  addScientSourcesByIdentifier,
  identifierOnlyCandidate,
  selectIdentifierCopy,
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
  ScientSourcesLibraryToolkit,
  ScientSourcesToolError,
  ScientSourcesToolkit,
  type ScientSourceAddInput as ScientSourceAddInputType,
  type ScientSourcesLibraryOrganizeAction,
} from "./tools.ts";
import {
  addAgentSource,
  checkSourceIdentifier,
  refreshAndCheckSourceMetadata,
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
import {
  citeLibrarySources,
  citePinnedSources,
  renameCitationKeyInProject,
  scanCitationKeyRenameDocuments,
} from "../../../scient/sources/LibraryCitation.ts";
import { syncPinnedBibliography } from "../../../scient/sources/ManagedBibliography.ts";
import {
  exportLibraryProjectPackage,
  importLibraryProjectPackage,
} from "../../../scient/sources/LibraryProjectPackage.ts";
import {
  moveProjectBackIntoProject,
  restoreProjectPreMoveArchive,
  readLibraryMoveStatus,
  scientLibraryMoveNotice,
} from "../../../scient/sources/LibraryMove.ts";
import {
  bothInLibrary,
  libraryDuplicates,
  libraryMergeReceipt,
  libraryPinMatches,
  isPinRepairAction,
  repairLibraryPin,
  moveBackResult,
} from "../../../scient/sources/LibrarySourcesRoutes.ts";
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
    catch: () => toolError("operation-failed", "The Library operation could not be completed."),
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

const supplied = (value: unknown) =>
  value !== undefined &&
  value !== null &&
  (typeof value !== "string" || value.trim() !== "") &&
  !(Array.isArray(value) && value.length === 0);

/** Identifiers and nothing else that describes the work; type `other` unnamed is no type. */
function identifierOnlyInput(input: ScientSourceAddInputType): boolean {
  return (
    supplied(input.identifiers) &&
    !supplied(input.pdfRelativePath) &&
    (input.type === undefined || input.type === "other") &&
    [
      input.customType,
      input.title,
      input.creators,
      input.issuedRaw,
      input.issuedYear,
      input.abstract,
      input.abstractSections,
      input.containerTitle,
      input.publisher,
      input.volume,
      input.issue,
      input.pages,
      input.language,
      input.url,
      input.tags,
    ].every((value) => !supplied(value))
  );
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

/**
 * The project and, in library mode, the library a call works on. Write access is the
 * invocation's `sources:write`; without it a library-mode call writes nothing at all.
 */
export const resolveScientSourcesStore = Effect.fn("ScientSourcesToolkit.resolveStore")(
  function* () {
    const project = yield* resolveScientSourcesProject();
    const invocation = yield* AgentInvocationContext;
    return yield* resolveScientSourcesStoreFor(
      project,
      invocation.capabilities.has("sources:write") ? "write" : "read",
      "agent",
    ).pipe(
      // The move goes on; the message names its progress so the agent can say so and retry.
      Effect.catchTags({
        ScientLibraryMoveBusyError: (busy) =>
          Effect.fail(
            new ScientSourcesToolError({ code: "operation-failed", message: busy.message }),
          ),
      }),
    );
  },
);

/** Library backend only: the project's move while it has something to say. Reads only. */
const libraryMoveNotice = Effect.fn("ScientSourcesToolkit.moveNotice")(function* (root: string) {
  if ((yield* ScientSourcesBackend) !== "library") return null;
  const config = yield* Effect.serviceOption(ServerConfig.ServerConfig);
  if (Option.isNone(config)) return null;
  const status = yield* readLibraryMoveStatus({
    root,
    library: scientLibraryLocation(scientLibraryRootFor(config.value.stateDir)),
  });
  return scientLibraryMoveNotice(status);
});

/** A library ID, or a project source ID of this project resolved to one; v1 keeps the ID. */
const sourceIdIn = (store: ScientSourcesStore, sourceId: string) =>
  store.kind === "library"
    ? attempt(() => resolveLibrarySourceId(store, sourceId)).pipe(
        Effect.map((resolved) => resolved ?? sourceId),
      )
    : Effect.succeed(sourceId);

const reachOf = (store: ScientSourcesStore, sourceId: string) =>
  store.kind === "library"
    ? attempt(() => alsoPinnedIn(store, sourceId))
    : Effect.succeed<{ readonly alsoPinnedIn?: number }>({});

// The edit has landed; a snapshot that fails to refresh is refreshed on the next write call.
const afterLibraryChange = (store: ScientSourcesStore, sourceIds: ReadonlyArray<string>) =>
  store.kind === "library"
    ? Effect.promise(() =>
        refreshProjectAfterLibraryChange(store, sourceIds, "agent").catch(() => undefined),
      )
    : Effect.void;

/** False for a read-only library call: it reads PDF text without storing it in the shared library. */
const storesFullText = (store: ScientSourcesStore) =>
  !(store.kind === "library" && store.access === "read");

/** Intake from a project pins what it added, so the person sees it here. */
const pinAdded = (store: ScientSourcesStore, sourceIds: ReadonlyArray<string | null>) =>
  store.kind === "library"
    ? attempt(() => pinSources(store, sourceIds))
    : Effect.succeed(new Map<string, string>());

async function pinSources(
  store: Extract<ScientSourcesStore, { readonly kind: "library" }>,
  sourceIds: ReadonlyArray<string | null>,
): Promise<ReadonlyMap<string, string>> {
  const keys = new Map<string, string>();
  for (const sourceId of new Set(sourceIds)) {
    if (!sourceId) continue;
    const pinned = await pinScientLibrarySource({
      projectRoot: store.root,
      library: store.library,
      sourceId,
      actor: "agent",
    });
    if (pinned.outcome !== "not-found") keys.set(sourceId, pinned.pin.citationKey);
  }
  if (keys.size > 0) await syncProjectBibliography(store, "agent");
  return keys;
}

type ListedRecord = Awaited<ReturnType<typeof listScientSourceRecords>>[number];

const creatorName = (record: Pick<ListedRecord, "creators">) => {
  const creator = record.creators[0];
  return creator?.familyName ?? creator?.literalName ?? creator?.givenName ?? null;
};

const doiValue = (record: Pick<ListedRecord, "identifiers">) =>
  record.identifiers.find((identifier) => identifier.scheme.toLowerCase() === "doi")?.value ?? null;

/** Without the server's state folder (tests), the style catalogue is kept in memory only. */
const citationStyleDependencies = Effect.map(
  Effect.serviceOption(ServerConfig.ServerConfig),
  (config) => ({
    cacheRoot: Option.isSome(config) ? citationStyleCacheRoot(config.value.stateDir) : null,
  }),
);

/** At most this many pairs and merges per page of a list call with duplicates. */
const AGENT_DUPLICATE_PAIRS = 25;
const AGENT_UNDOABLE_MERGES = 10;

type DuplicateRow = Awaited<ReturnType<typeof libraryDuplicates>>["pairs"][number]["sources"][0];

/** A Library row of the duplicates screen, as the list tool summarizes a source. */
const agentSummaryOfRow = (row: DuplicateRow) => ({
  sourceId: row.sourceId,
  revision: row.revision,
  ...(row.citationKey ? { citationKey: row.citationKey } : {}),
  type: row.type,
  title: row.title,
  creator: creatorName(row),
  issuedYear: row.issuedYear,
  containerTitle: row.containerTitle,
  doi: doiValue(row),
  hasPdf: row.attachments.some((attachment) => attachment.kind === "pdf"),
  addedBy: row.origin?.actor ?? "user",
  ...(row.verification ? { verification: row.verification.state } : {}),
  ...(row.editorialStatus && row.editorialStatus.state !== "none"
    ? { editorialStatus: row.editorialStatus.state }
    : {}),
  ...(row.tags && row.tags.length > 0 ? { tags: row.tags } : {}),
  pinned: row.pinned === true,
  ...(row.readingStatus ? { readingStatus: row.readingStatus } : {}),
  ...(row.starred !== undefined ? { starred: row.starred } : {}),
});

const agentCitationStyle = (style: ScientProjectCitationStyle) =>
  style._tag === "none"
    ? null
    : style._tag === "ready"
      ? {
          id: style.id,
          title: style.title,
          parentId: style.parent?.id ?? null,
          state: "ready" as const,
        }
      : {
          id: style.id,
          title: style.title,
          parentId: null,
          state: "unavailable" as const,
          message: style.message,
        };

export const listScientSourcesForInvocation = Effect.fn("ScientSourcesToolkit.list")(
  function* (input: {
    readonly query?: string;
    readonly tags?: ReadonlyArray<string>;
    readonly collectionId?: string;
    readonly type?: ScientSourceType;
    readonly hasPdf?: boolean;
    readonly studyDesign?: ScientSourceStudyDesign;
    readonly topic?: string;
    readonly savedSearchId?: string;
    readonly inTrash?: boolean;
    readonly citationStyles?: string;
    readonly offset?: number;
    readonly limit?: number;
    readonly scope?: "project" | "library";
    readonly readingStatus?: ScientSourceReadingStatus;
    readonly starred?: boolean;
    readonly duplicates?: boolean;
    readonly mergeOffset?: number;
    readonly allMerges?: boolean;
    readonly revision?: string;
    readonly mergeId?: string;
  }) {
    const store = yield* resolveScientSourcesStore();
    const root = store.store;
    const library = store.kind === "library" ? store : null;
    if (input.duplicates || input.mergeId !== undefined) {
      if (!library) {
        return yield* toolError(
          "operation-failed",
          "Possible duplicates need the personal Library.",
        );
      }
      if (input.mergeId !== undefined) {
        const mergeId = input.mergeId;
        const receipt = yield* attempt(() => libraryMergeReceipt(library, mergeId));
        if (!receipt) return yield* toolError("not-found", "No merge has this ID.");
        const { kept, keptSourceId, ...rest } = receipt;
        return {
          records: [],
          total: 0,
          nextOffset: null,
          mergeReceipt: {
            ...rest,
            survivorId: keptSourceId,
            kept: kept ? agentSummaryOfRow(kept) : null,
          },
        };
      }
      const found = yield* attempt(() =>
        libraryDuplicates(library, undefined, {
          pairLimit: AGENT_DUPLICATE_PAIRS,
          mergeLimit: AGENT_UNDOABLE_MERGES,
          ...(input.offset === undefined ? {} : { pairOffset: input.offset }),
          ...(input.mergeOffset === undefined ? {} : { mergeOffset: input.mergeOffset }),
          ...(input.revision === undefined ? {} : { revision: input.revision }),
          ...(input.allMerges ? { merges: "all" as const } : {}),
        }),
      );
      const next = (offset: number, shown: number, total: number) =>
        offset + shown < total ? offset + shown : null;
      return {
        records: [],
        total: found.pairsTotal,
        nextOffset: next(found.pairOffset, found.pairs.length, found.pairsTotal),
        duplicates: {
          revision: found.revision,
          ...(found.restarted ? { restarted: true as const } : {}),
          pairs: found.pairs.map((pair) => ({
            kind: pair.kind,
            ...(pair.reason ? { reason: pair.reason } : {}),
            sources: [
              agentSummaryOfRow(pair.sources[0]),
              agentSummaryOfRow(pair.sources[1]),
            ] as const,
            keptByDefault: pair.keptByDefault,
          })),
          pairsTotal: found.pairsTotal,
          merges: found.merges.map((merge) => ({
            mergeId: merge.mergeId,
            mergedAt: merge.mergedAt,
            survivorId: merge.keptSourceId,
            mergedSourceId: merge.mergedSourceId,
            mergedTitle: merge.mergedTitle,
            keptDifferent: merge.keptDifferent,
            undo: merge.undo,
          })),
          mergesTotal: found.mergesTotal,
          nextMergeOffset: next(found.mergeOffset, found.merges.length, found.mergesTotal),
          ...(found.damagedReceipts ? { damagedReceipts: found.damagedReceipts } : {}),
        },
      };
    }
    if (input.citationStyles !== undefined) {
      const query = input.citationStyles;
      const deps = yield* citationStyleDependencies;
      const found = yield* attempt(() => searchCitationStyles({ root: store.root, query }, deps));
      // Total counts this project's sources: its pins on a library, its records otherwise.
      const total = library
        ? (yield* attempt(() => projectPinsByLibraryId(library))).size
        : (yield* attempt(() => listScientSourceRecords(root))).length;
      return {
        records: [],
        total,
        nextOffset: null,
        citationStyle: agentCitationStyle(found.current),
        citationStyles: found.results,
        ...(found.catalogueMessage ? { catalogueMessage: found.catalogueMessage } : {}),
      };
    }
    // A read on a computer with no library yet still lists the project's pins from snapshots.
    const readable = library === null || library.exists;
    const listsPins = library !== null && !input.inTrash && input.scope !== "library";
    const trash =
      input.inTrash && readable
        ? new Map(
            (yield* attempt(() => readScientSourceTrashEntries(root))).map((entry) => [
              entry.record.sourceId,
              entry,
            ]),
          )
        : input.inTrash
          ? new Map<string, Awaited<ReturnType<typeof readScientSourceTrashEntries>>[number]>()
          : null;
    const pinnedWorks =
      listsPins && library
        ? distinctPinnedWorks(yield* attempt(() => listProjectPinnedWorks(library, "agent")))
        : null;
    const records = trash
      ? [...trash.values()].map((entry) => entry.record)
      : pinnedWorks
        ? pinnedWorks.map((work) => work.record)
        : readable
          ? yield* attempt(() => listScientSourceRecords(root))
          : [];
    const pins =
      library && !pinnedWorks ? yield* attempt(() => projectPinsByLibraryId(library)) : null;
    const fromSnapshot = new Set(
      (pinnedWorks ?? []).flatMap((work) =>
        work.from === "snapshot" ? [work.record.sourceId] : [],
      ),
    );
    const categories = readable ? yield* attempt(() => readScientSourceCategories(root)) : {};
    const all = records.map((record) => {
      const category = scientSourceCategorySummaryFor(record, categories);
      return category ? { ...record, categories: category } : record;
    });
    const narrowsByOrganization =
      input.collectionId !== undefined || input.savedSearchId !== undefined;
    const organization =
      narrowsByOrganization && readable
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
        ...(input.studyDesign ? { studyDesign: input.studyDesign } : {}),
        ...(input.topic ? { topic: input.topic } : {}),
      },
    ];
    const predicates = filters.map((filter) => compileScientSourceFilter(filter, organization));
    const readingMatches = (record: (typeof all)[number]) => {
      if (input.readingStatus === undefined && input.starred === undefined) return true;
      const state = scientSourceReadingState(record);
      return (
        state !== null &&
        (input.readingStatus === undefined || state.readingStatus === input.readingStatus) &&
        (input.starred === undefined || state.starred === input.starred)
      );
    };
    const matching = all.filter(
      (record) => predicates.every((matches) => matches(record)) && readingMatches(record),
    );
    // The public schema rejects invalid values. Clamp here as a second
    // boundary so internal callers cannot accidentally create an unbounded
    // model payload by bypassing MCP decoding.
    const offset = Math.max(0, input.offset ?? 0);
    const limit = Math.min(50, Math.max(1, input.limit ?? 25));
    const page = matching.slice(offset, offset + limit);
    const move = yield* libraryMoveNotice(store.root);
    const snapshotIds = new Set(
      page.flatMap((record) => (fromSnapshot.has(record.sourceId) ? [record.sourceId] : [])),
    );
    const matches =
      library && snapshotIds.size > 0
        ? yield* attempt(() => libraryPinMatches(library, snapshotIds))
        : new Map<string, ScientSourceLibraryMatch>();
    const pinOf = (sourceId: string) => (pins ? pins.get(sourceId) : undefined);
    const citationKeyOf = (record: (typeof page)[number]) =>
      pinOf(record.sourceId)?.citationKey ?? record.citationKey;
    return {
      records: page.map((record) => ({
        sourceId: record.sourceId,
        revision: record.revision,
        ...(citationKeyOf(record) ? { citationKey: citationKeyOf(record) } : {}),
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
        ...("categories" in record && record.categories.studyDesign
          ? { studyDesign: record.categories.studyDesign }
          : {}),
        ...("categories" in record && record.categories.topics
          ? { topics: record.categories.topics.map((topic) => topic.name) }
          : {}),
        ...(library
          ? { pinned: pinnedWorks !== null || pinOf(record.sourceId) !== undefined }
          : {}),
        ...(fromSnapshot.has(record.sourceId) ? { fromSnapshot: true } : {}),
        ...(matches.has(record.sourceId) ? { libraryMatch: matches.get(record.sourceId)! } : {}),
        ...(library ? scientSourceReadingState(record) : null),
      })),
      total: matching.length,
      ...(move ? { move } : {}),
      nextOffset: offset + page.length < matching.length ? offset + page.length : null,
    };
  },
);

export const readScientSourceCollectionsForInvocation = Effect.fn(
  "ScientSourcesToolkit.collections",
)(function* () {
  const store = yield* resolveScientSourcesStore();
  const root = store.store;
  if (store.kind === "library" && !store.exists) {
    return { collections: [], savedSearches: [], tags: [], studyDesigns: [], topics: [] };
  }
  const records = yield* attempt(() => listScientSourceRecords(root));
  const organization = yield* attempt(() =>
    readScientSourcesOrganization(root, new Set(records.map((record) => record.sourceId))),
  );
  const categories = yield* attempt(() => readScientSourceCategories(root));
  const counts = scientSourceCategoryCounts(
    records.map((record) => {
      const category = scientSourceCategorySummaryFor(record, categories);
      return category ? { categories: category } : {};
    }),
  );
  const categorizing = records.filter(
    (record) =>
      scientSourceCategoryBasis(record.identifiers) !== null &&
      !currentScientSourceCategories(record, categories),
  ).length;
  return {
    collections: organization.collections.map((collection) => ({
      collectionId: collection.collectionId,
      name: collection.name,
      ...(collection.parentCollectionId
        ? { parentCollectionId: collection.parentCollectionId }
        : {}),
      sourceCount: collection.sourceIds.length,
    })),
    savedSearches: organization.savedSearches.map(({ searchId, name, filter }) => ({
      searchId,
      name,
      filter,
    })),
    tags: scientSourceTagCounts(records).slice(0, 200),
    studyDesigns: counts.studyDesigns,
    topics: counts.topics.slice(0, 200),
    ...(categorizing > 0 ? { categorizing } : {}),
    ...(organization.issue ? { message: organization.issue } : {}),
  };
});

export const organizeScientSourcesForInvocation = Effect.fn("ScientSourcesToolkit.organize")(
  function* (input: { readonly change: ScientSourcesOrganizeAction }) {
    const store = yield* resolveScientSourcesStore();
    return yield* attempt(() =>
      organizeSources({ root: store.store, change: input.change, actor: "agent" }),
    );
  },
);

type LibraryOrganizeChange = Exclude<
  ScientSourcesLibraryOrganizeAction,
  ScientSourcesOrganizeAction
>;

const isLibraryOrganizeChange = (
  change: ScientSourcesLibraryOrganizeAction,
): change is LibraryOrganizeChange =>
  change.action === "pin" ||
  change.action === "unpin" ||
  change.action === "merge" ||
  change.action === "undo-merge" ||
  change.action === "mark-distinct" ||
  change.action === "clear-distinct" ||
  change.action === "move-back" ||
  change.action === "dismiss-move-summary" ||
  change.action === "restore-pre-move" ||
  change.action === "export-package" ||
  change.action === "import-package" ||
  isPinRepairAction(change);

/** Library mode's organize: collections and saved searches, plus pins and merges. */
export const organizeLibrarySourcesForInvocation = Effect.fn(
  "ScientSourcesToolkit.organizeLibrary",
)(function* (input: { readonly change: ScientSourcesLibraryOrganizeAction }) {
  const { change } = input;
  if (!isLibraryOrganizeChange(change)) {
    return yield* organizeScientSourcesForInvocation({ change });
  }
  const store = yield* resolveScientSourcesStore();
  if (store.kind !== "library") {
    // Served from its own folder: not moved yet or already moved back, so nothing to move back.
    if (change.action === "move-back") return { outcome: "not-moved" as const };
    if (change.action === "restore-pre-move") return yield* restorePreMove(store.root, change);
    return yield* toolError("operation-failed", "Pins and merges need the personal Library.");
  }
  return yield* changeLibraryPinsOrMerges(store, change);
});

const restorePreMove = (
  root: string,
  change: Extract<LibraryOrganizeChange, { readonly action: "restore-pre-move" }>,
) =>
  attempt(() =>
    restoreProjectPreMoveArchive({
      root,
      ...(change.archiveId ? { archiveId: change.archiveId } : {}),
    }),
  );

const changeLibraryPinsOrMerges = Effect.fn("ScientSourcesToolkit.pinsAndMerges")(function* (
  store: ScientSourcesLibraryStore,
  change: LibraryOrganizeChange,
) {
  switch (change.action) {
    case "pin": {
      const sourceId = yield* sourceIdIn(store, change.sourceId);
      const pinned = yield* attempt(() =>
        pinScientLibrarySource({
          projectRoot: store.root,
          library: store.library,
          sourceId,
          actor: "agent",
          ...(change.note !== undefined ? { note: change.note } : {}),
        }),
      );
      if (pinned.outcome === "not-found") return { outcome: "not-found" as const };
      const noted =
        pinned.outcome === "existing" && change.note !== undefined
          ? yield* attempt(() =>
              setScientProjectPinNote({
                projectRoot: store.root,
                citationKey: pinned.pin.citationKey,
                note: change.note ?? null,
                base: change.noteBase ?? null,
                actor: "agent",
              }),
            )
          : null;
      const pin = noted && noted.outcome !== "not-pinned" ? noted.pin : pinned.pin;
      if (pinned.outcome === "pinned") {
        yield* attempt(() => syncProjectBibliography(store, "agent"));
      }
      return {
        outcome:
          noted?.outcome === "stale"
            ? ("stale" as const)
            : pinned.outcome === "pinned"
              ? ("pinned" as const)
              : ("existing" as const),
        pin: pinSummary(pin),
      };
    }
    case "unpin": {
      const unpinned = yield* attempt(() =>
        unpinScientLibrarySource({
          projectRoot: store.root,
          citationKey: change.citationKey,
          actor: "agent",
        }),
      );
      if (unpinned.outcome === "not-pinned") return { outcome: "not-pinned" as const };
      yield* attempt(() => syncProjectBibliography(store, "agent"));
      return { outcome: "unpinned" as const, pin: pinSummary(unpinned.pin) };
    }
    case "merge": {
      const sourceIds = yield* Effect.forEach(change.sourceIds, (sourceId) =>
        sourceIdIn(store, sourceId),
      );
      const requested = change.survivorId ? yield* sourceIdIn(store, change.survivorId) : undefined;
      const [first, ...rest] = sourceIds;
      let survivorId = requested ?? first!;
      const merges: Array<{
        readonly mergeId: string;
        readonly survivorId: string;
        readonly mergedSourceId: string;
        readonly keptDifferent: ReadonlyArray<string>;
      }> = [];
      const others = (requested ? sourceIds : rest).filter((other) => other !== survivorId);
      let notMerged: ReadonlyArray<string> = [];
      for (const [index, other] of others.entries()) {
        const merged = yield* attempt(() =>
          mergeScientLibrarySources({
            library: store.library,
            sourceIds: [survivorId, other],
            ...(requested ? { survivorId } : {}),
            actor: "agent",
          }),
        ).pipe(
          // Earlier merges of this call have landed: report them and their undo IDs.
          Effect.catch((error) =>
            merges.length > 0 ? Effect.succeed({ outcome: "failed" as const }) : Effect.fail(error),
          ),
        );
        if (merged.outcome === "not-found" || merged.outcome === "failed") {
          if (merges.length === 0) return { outcome: "not-found" as const };
          notMerged = others.slice(index);
          break;
        }
        if (merged.outcome === "already-merged") continue;
        survivorId = merged.merge.survivorId;
        merges.push({
          mergeId: merged.merge.mergeId,
          survivorId: merged.merge.survivorId,
          mergedSourceId: merged.merge.loserId,
          keptDifferent: merged.merge.conflicts.map((conflict) => conflict.field),
        });
      }
      if (merges.length === 0) return { outcome: "already-merged" as const, survivorId };
      yield* afterLibraryChange(store, [survivorId]);
      return {
        outcome: "merged" as const,
        survivorId,
        merges,
        ...(notMerged.length > 0 ? { notMerged } : {}),
        ...(yield* reachOf(store, survivorId).pipe(Effect.orElseSucceed(() => ({})))),
      };
    }
    case "undo-merge": {
      const undone = yield* attempt(() =>
        undoScientLibraryMerge({ library: store.library, mergeId: change.mergeId, actor: "agent" }),
      );
      if (undone.outcome !== "undone") return { outcome: undone.outcome };
      yield* afterLibraryChange(store, [undone.survivor.sourceId, undone.loser.sourceId]);
      return {
        outcome: "undone" as const,
        survivorId: undone.survivor.sourceId,
        unrevertedFields: undone.unrevertedFields,
      };
    }
    case "mark-distinct":
    case "clear-distinct": {
      const sourceIds = [
        yield* sourceIdIn(store, change.sourceIds[0]!),
        yield* sourceIdIn(store, change.sourceIds[1]!),
      ] as const;
      if (change.action === "mark-distinct") {
        if (!(yield* attempt(() => bothInLibrary(store, sourceIds)))) {
          return { outcome: "not-found" as const };
        }
        return yield* attempt(() =>
          markScientLibrarySourcesDistinct({ library: store.library, sourceIds, actor: "agent" }),
        );
      }
      const cleared = yield* attempt(() =>
        clearScientLibrarySourcesDistinct({ library: store.library, sourceIds }),
      );
      return { outcome: cleared.outcome === "cleared" ? cleared.outcome : ("unchanged" as const) };
    }
    case "move-back":
      return moveBackResult(
        yield* attempt(() =>
          moveProjectBackIntoProject({ root: store.root, library: store.library, actor: "agent" }),
        ),
      );
    case "dismiss-move-summary":
      return {
        outcome: yield* attempt(() =>
          dismissScientLibraryMoveSummary({ library: store.library, projectRoot: store.root }),
        ),
      };
    case "link-pin":
    case "unlink-pin":
    case "keep-pin-separate":
    case "clear-pin-separate":
      return yield* attempt(() => repairLibraryPin(store, change, "agent"));
    case "restore-pre-move":
      return yield* restorePreMove(store.root, change);
    case "export-package":
      return yield* attempt(() => exportLibraryProjectPackage(store, change));
    case "import-package":
      return yield* attempt(() => importLibraryProjectPackage(store, change, "agent"));
  }
});

const pinSummary = (pin: {
  readonly citationKey: string;
  readonly sourceId: string;
  readonly note?: string;
}) => ({
  citationKey: pin.citationKey,
  sourceId: pin.sourceId,
  ...(pin.note !== undefined ? { note: pin.note } : {}),
});

export const bulkUpdateScientSourcesForInvocation = Effect.fn("ScientSourcesToolkit.bulkUpdate")(
  function* (input: { readonly change: ScientSourcesBulkRequestChange }) {
    const store = yield* resolveScientSourcesStore();
    const root = store.root;
    const change =
      store.kind === "library" && "sourceIds" in input.change
        ? {
            ...input.change,
            sourceIds: yield* Effect.forEach(input.change.sourceIds, (sourceId) =>
              sourceIdIn(store, sourceId),
            ),
          }
        : input.change;
    const result = yield* attempt(() =>
      bulkUpdateSources({ root: store.store, change, actor: "agent" }),
    );
    // A type change, or the undo of one, changes what pin and review snapshots hold.
    if ("type" in change || "undoBatchId" in change) {
      yield* afterLibraryChange(
        store,
        result.sources.flatMap((entry) => (entry.outcome === "updated" ? [entry.sourceId] : [])),
      );
    }
    // Store messages for a failed source may name host paths; keep them out of model output.
    return {
      ...result,
      sources: result.sources.map((entry) =>
        entry.message &&
        (entry.message.includes(root) ||
          (store.kind === "library" && entry.message.includes(store.library.root)) ||
          /[\\/]\.scient[\\/]/u.test(entry.message))
          ? { ...entry, message: "The source could not be updated." }
          : entry,
      ),
    };
  },
);

export const getScientSourceForInvocation = Effect.fn("ScientSourcesToolkit.get")(
  function* (input: { readonly sourceId: string }) {
    const store = yield* resolveScientSourcesStore();
    const root = store.store;
    const sourceId = yield* sourceIdIn(store, input.sourceId);
    const record =
      store.kind === "library" && !store.exists
        ? null
        : yield* attempt(() => readScientSourceRecord(root, sourceId));
    if (!record) return yield* toolError("not-found", "The source was not found in this project.");
    const revisions = yield* attempt(() => listScientSourceRevisions(root, sourceId));
    const pin =
      store.kind === "library"
        ? (yield* attempt(() => projectPinsByLibraryId(store))).get(sourceId)
        : undefined;
    const noteHistory =
      store.kind === "library" && pin
        ? yield* attempt(() =>
            readScientProjectPinNoteHistory({
              projectRoot: store.root,
              citationKey: pin.citationKey,
            }),
          )
        : null;
    const categories = currentScientSourceCategories(
      record,
      yield* attempt(() => readScientSourceCategories(root)),
    );
    const maximumAbstractCharacters = 50_000;
    const abstract = record.abstract;
    const abstractTruncated = abstract !== null && abstract.length > maximumAbstractCharacters;
    return {
      ...record,
      abstract: abstractTruncated ? abstract.slice(0, maximumAbstractCharacters) : abstract,
      abstractTruncated,
      note: record.note ?? null,
      revisions: revisions ?? [],
      ...(categories
        ? {
            categories: {
              ...(categories.studyDesign ? { studyDesign: categories.studyDesign } : {}),
              ...(categories.publicationTypes
                ? { publicationTypes: categories.publicationTypes }
                : {}),
              ...(categories.topics ? { topics: categories.topics } : {}),
              checkedAt: categories.checkedAt,
            },
          }
        : {}),
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
      ...(store.kind === "library"
        ? {
            pinned: pin !== undefined,
            ...(pin ? { citationKey: pin.citationKey, projectNote: pin.note ?? null } : {}),
            ...(noteHistory && noteHistory.length > 1
              ? {
                  projectNoteHistory: noteHistory.map(({ note, at, by }) => ({
                    note,
                    at,
                    ...(by ? { by } : {}),
                  })),
                }
              : {}),
            ...scientSourceReadingState(record),
          }
        : {}),
    };
  },
);

export const updateScientSourceNoteForInvocation = Effect.fn("ScientSourcesToolkit.updateNote")(
  function* (input: {
    readonly sourceId: string;
    readonly expectedRevision: number;
    readonly note: string | null;
  }) {
    const store = yield* resolveScientSourcesStore();
    const root = store.store;
    const sourceId = yield* sourceIdIn(store, input.sourceId);
    const current = yield* attempt(() => readScientSourceRecord(root, sourceId));
    if (!current) return yield* toolError("not-found", "The source was not found in this project.");
    const result = yield* attempt(() =>
      updateSourceNote({
        root,
        sourceId,
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
      ...(yield* reachOf(store, sourceId)),
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
    const store = yield* resolveScientSourcesStore();
    if (store.kind === "library") return yield* updateLibrarySource(store, input);
    const { root } = store;
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

/**
 * Library mode: metadata as in project mode, and the person's reading state. Reading state
 * alone changes no revision, so it is not checked against `expectedRevision`.
 */
export const updateLibrarySourceForInvocation = Effect.fn("ScientSourcesToolkit.updateInLibrary")(
  function* (input: {
    readonly sourceId: string;
    readonly expectedRevision: number;
    readonly metadata?: ScientSourceEditableMetadata;
    readonly allowPossibleMetadataMatch?: boolean;
    readonly readingStatus?: ScientSourceReadingStatus;
    readonly starred?: boolean;
  }) {
    const { metadata, readingStatus, starred } = input;
    if (metadata === undefined && readingStatus === undefined && starred === undefined) {
      return yield* toolError("operation-failed", "Give metadata, readingStatus or starred.");
    }
    const store = yield* resolveScientSourcesStore();
    if (store.kind !== "library") {
      if (metadata === undefined) {
        return yield* toolError("operation-failed", "Reading state needs the personal Library.");
      }
      return yield* updateScientSourceForInvocation({ ...input, metadata });
    }
    const edited = metadata ? yield* updateLibrarySource(store, { ...input, metadata }) : null;
    // A refused edit changes nothing, reading state included.
    if (edited && (edited.outcome === "stale" || edited.outcome === "duplicate")) return edited;
    const reading =
      readingStatus !== undefined || starred !== undefined
        ? (yield* attempt(() =>
            setLibraryReadingState(store, {
              sourceIds: [input.sourceId],
              ...(readingStatus ? { readingStatus } : {}),
              ...(starred !== undefined ? { starred } : {}),
            }),
          ).pipe(
            Effect.mapError((error) =>
              edited?.outcome === "updated"
                ? toolError(
                    "operation-failed",
                    `The metadata was updated (revision ${edited.revision}); the reading state was not. Set it again.`,
                  )
                : error,
            ),
          )).sources[0]!
        : null;
    if (reading?.outcome === "not-found" && !edited) {
      return yield* toolError("not-found", "The source was not found in this project.");
    }
    const state =
      reading && reading.outcome !== "not-found"
        ? { readingStatus: reading.readingStatus, starred: reading.starred }
        : {};
    if (edited) {
      return {
        ...edited,
        ...(edited.outcome === "unchanged" && reading?.outcome === "updated"
          ? { outcome: "updated" as const }
          : {}),
        ...state,
      };
    }
    const sourceId = yield* sourceIdIn(store, input.sourceId);
    const record = yield* attempt(() => readScientSourceRecord(store.library, sourceId));
    if (!record) return yield* toolError("not-found", "The source was not found in this project.");
    return {
      outcome: reading?.outcome === "updated" ? ("updated" as const) : ("unchanged" as const),
      sourceId,
      revision: record.revision,
      ...state,
    };
  },
);

/**
 * A library record edit. A new citationKey on a source pinned here renames this project's pin
 * and documents only; the record's preferred key changes only for a source not pinned here.
 */
const updateLibrarySource = Effect.fn("ScientSourcesToolkit.updateLibrary")(function* (
  store: ScientSourcesLibraryStore,
  input: {
    readonly sourceId: string;
    readonly expectedRevision: number;
    readonly metadata: ScientSourceEditableMetadata;
    readonly allowPossibleMetadataMatch?: boolean;
  },
) {
  const sourceId = yield* sourceIdIn(store, input.sourceId);
  const pins = yield* attempt(() => projectPinsByLibraryId(store));
  const pin = pins.get(sourceId);
  const current = yield* attempt(() => readScientSourceRecord(store.library, sourceId));
  if (!current) return yield* toolError("not-found", "The source was not found in this project.");
  const requestedKey = input.metadata.citationKey?.trim();
  const renamesPin =
    pin !== undefined && requestedKey !== undefined && requestedKey !== pin.citationKey;
  if (renamesPin) {
    const message = citationKeyValidationMessage(
      requestedKey,
      takenCitationKeys([...pins.values()], pin.sourceId),
    );
    if (message) return yield* toolError("operation-failed", message);
  } else if (requestedKey && pin === undefined && requestedKey !== current.citationKey) {
    const records = yield* attempt(() => listScientSourceRecords(store.library));
    const message = citationKeyValidationMessage(
      requestedKey,
      takenCitationKeys(records, sourceId),
    );
    if (message) return yield* toolError("operation-failed", message);
  }
  // Without a key the store keeps the record's preferred key.
  const { citationKey: _projectKey, ...withoutKey } = input.metadata;
  const metadata = pin !== undefined ? withoutKey : input.metadata;
  // Found before the key changes, so a scan failure leaves the old key in place.
  const scan = renamesPin ? yield* attempt(() => scanCitationKeyRenameDocuments(store.root)) : null;
  const result = yield* attempt(() =>
    updateScientSourceMetadata({
      root: store.library,
      sourceId,
      expectedRevision: input.expectedRevision,
      metadata,
      allowPossibleMetadataMatch: input.allowPossibleMetadataMatch ?? false,
      actor: "agent",
    }),
  );
  const accepted = result.outcome === "updated" || result.outcome === "unchanged";
  const renamed =
    renamesPin && accepted && pin && requestedKey && scan
      ? yield* attempt(async () => {
          const outcome = await renameScientProjectPinKey({
            projectRoot: store.root,
            citationKey: pin.citationKey,
            to: requestedKey,
          });
          if (outcome.outcome !== "renamed") return null;
          return renameCitationKeyInProject(store.root, pin.citationKey, requestedKey, scan);
        })
      : null;
  if (result.outcome === "updated" || renamed) {
    yield* afterLibraryChange(store, [sourceId]);
  }
  return {
    outcome: renamed && result.outcome === "unchanged" ? ("updated" as const) : result.outcome,
    sourceId: result.record.sourceId,
    revision: result.record.revision,
    duplicate: result.duplicate,
    validationIssues: result.validationIssues,
    ...(renamed ? { citationKeyRenamedIn: renamed.renamedIn } : {}),
    ...(renamed && renamed.skipped.length > 0 ? { citationKeyRenameSkipped: renamed.skipped } : {}),
    ...(yield* reachOf(store, sourceId)),
  };
});

export const removeScientSourceForInvocation = Effect.fn("ScientSourcesToolkit.remove")(
  function* (input: {
    readonly sourceId: string;
    readonly expectedRevision: number;
    readonly permanent?: boolean;
  }) {
    const store = yield* resolveScientSourcesStore();
    const root = store.store;
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
    const sourceId = yield* sourceIdIn(store, input.sourceId);
    const reach = yield* reachOf(store, sourceId);
    const result = yield* attempt(() =>
      removeSource({
        root,
        sourceId,
        expectedRevision: input.expectedRevision,
        actor: "agent",
      }),
    );
    return {
      outcome: result.outcome,
      sourceId: result.sourceId,
      revision: result.revision,
      ...(result.restorable ? { restorable: true } : {}),
      ...reach,
    };
  },
);

export const restoreScientSourceForInvocation = Effect.fn("ScientSourcesToolkit.restore")(
  function* (input: { readonly sourceId: string }) {
    const store = yield* resolveScientSourcesStore();
    const root = store.store;
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
    const store = yield* resolveScientSourcesStore();
    const root = store.store;
    const sourceId = yield* sourceIdIn(store, input.sourceId);
    const current = yield* attempt(() => readScientSourceRecord(root, sourceId));
    if (!current) return yield* toolError("not-found", "The source was not found in this project.");
    const result = yield* attempt(() =>
      revertScientSource({ root, ...input, sourceId, actor: "agent" }),
    );
    if (result.outcome === "reverted") yield* afterLibraryChange(store, [sourceId]);
    return {
      outcome: result.outcome,
      sourceId: result.record.sourceId,
      revision: result.record.revision,
      missingAttachmentCount: result.missingAttachmentCount,
      matchingSourceIds: result.matchingSourceIds,
      ...(yield* reachOf(store, sourceId)),
    };
  },
);

const IDENTIFIER_LIST_OPTIONS = new Set(["identifierList", "enrich", "allowPossibleMetadataMatch"]);

const addScientSourcesByIdentifierForInvocation = Effect.fn("ScientSourcesToolkit.addByIdentifier")(
  function* (input: ScientSourceAddInputType, identifierList: ReadonlyArray<string>) {
    const store = yield* resolveScientSourcesStore();
    const root = store.store;
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
    const resolveIdentifiers = yield* keyedBatchLookup(yield* SourceIdentifierBatchLookup);
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
    yield* pinAdded(
      store,
      results.map((item) =>
        item.outcome === "imported" || (item.outcome === "duplicate" && !item.possibleMatch)
          ? item.sourceId
          : null,
      ),
    );
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
  const store = yield* resolveScientSourcesStore();
  const root = store.store;
  const fromFields = candidateFromAgentInput(input);
  // Bare identifiers select and add as the identifier list does, with no type to invent.
  const identifierOnly = identifierOnlyInput(input);
  const bare = identifierOnly
    ? identifierOnlyCandidate(fromFields.candidate.identifiers, "agent")
    : null;
  const initialCandidate = bare
    ? { ...fromFields.candidate, sourceKey: bare.sourceKey, type: bare.type }
    : fromFields.candidate;
  const initialIssues = identifierOnly
    ? fromFields.validationIssues.filter((issue) => issue.field !== "customType")
    : fromFields.validationIssues;
  const pdfRelativePath = input.pdfRelativePath;
  const resolvedPdf = pdfRelativePath
    ? yield* attempt(() => resolveScientSourceInputPdf(store.root, pdfRelativePath))
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
  const selected = identifierOnly
    ? selectIdentifierCopy(
        yield* attempt(() => readScientSourceIntakeAssessor(root).catch(() => null)),
        candidate.identifiers,
        "agent",
      )
    : undefined;
  const resolveIdentifier = yield* keyedIdentifierLookup();
  const observeImport = yield* makeSourceImportAnalytics("agent");
  const result = selected
    ? {
        outcome: "duplicate" as const,
        record: null,
        duplicate: {
          kind: "same-identifier" as const,
          matchingSourceIds: [selected.sourceId],
          reason: "A source with the same persistent identifier already exists.",
        },
      }
    : yield* attempt(() =>
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
  // A possible metadata match is not the same work, so it is not pinned for the person.
  const pinnedKeys = yield* pinAdded(store, [
    result.outcome === "imported" ||
    (result.outcome === "duplicate" && result.duplicate.kind !== "possible-metadata-match")
      ? duplicateSourceId
      : null,
  ]);
  const projectKey = duplicateSourceId ? pinnedKeys.get(duplicateSourceId) : undefined;
  return {
    outcome: result.outcome,
    sourceId: duplicateSourceId,
    revision: duplicateRecord?.revision ?? null,
    duplicate: result.duplicate,
    validationIssues,
    ...(projectKey ? { citationKey: projectKey } : {}),
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
  function* (input: { readonly sourceId: string; readonly refresh?: boolean }) {
    const store = yield* resolveScientSourcesStore();
    const root = store.store;
    const sourceId = yield* sourceIdIn(store, input.sourceId);
    const current = yield* attempt(() => readScientSourceRecord(root, sourceId));
    if (!current) return yield* toolError("not-found", "The source was not found in this project.");
    const resolveIdentifier = yield* keyedIdentifierLookup();
    if (input.refresh) {
      const { refresh, registry } = yield* attempt(() =>
        refreshAndCheckSourceMetadata({
          root,
          sourceId,
          expectedRevision: current.revision,
          actor: "agent",
          resolveIdentifier,
        }),
      );
      if (refresh.outcome === "refreshed") yield* afterLibraryChange(store, [sourceId]);
      return {
        outcome: refresh.outcome,
        sourceId: refresh.record.sourceId,
        revision: refresh.record.revision,
        ...(registry ? { registry } : {}),
        ...(refresh.record.verification ? { verification: refresh.record.verification } : {}),
        ...(refresh.record.editorialStatus
          ? { editorialStatus: refresh.record.editorialStatus }
          : {}),
        changedFields: refresh.changedFields,
        ...(refresh.message ? { message: refresh.message } : {}),
      };
    }
    const result = yield* attempt(() =>
      checkSourceIdentifier({ root, sourceId, actor: "agent", resolveIdentifier }),
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
    const store = yield* resolveScientSourcesStore();
    const sourceId = yield* sourceIdIn(store, input.sourceId);
    const resolvedPdf = yield* attempt(() =>
      resolveScientSourceInputPdf(store.root, input.pdfRelativePath),
    );
    const result = yield* attempt(() =>
      attachSourcePdf({
        root: store.store,
        sourceId,
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
      ...(yield* reachOf(store, sourceId)),
    };
  },
);

export const detachScientSourcePdfForInvocation = Effect.fn("ScientSourcesToolkit.detachPdf")(
  function* (input: {
    readonly sourceId: string;
    readonly attachmentId: string;
    readonly expectedRevision: number;
  }) {
    const store = yield* resolveScientSourcesStore();
    const sourceId = yield* sourceIdIn(store, input.sourceId);
    const result = yield* attempt(() =>
      detachSourcePdf({ root: store.store, ...input, sourceId, actor: "agent" }),
    );
    return {
      outcome: result.outcome,
      sourceId: result.record?.sourceId ?? sourceId,
      attachmentId: result.attachmentId,
      revision: result.record?.revision ?? null,
      ...(yield* reachOf(store, sourceId)),
    };
  },
);

export const syncScientBibliographyForInvocation = Effect.fn("ScientSourcesToolkit.bibliography")(
  function* (input: {
    readonly replaceEdited?: ReadonlyArray<"references.bib" | "references.json">;
    readonly importEdited?: ReadonlyArray<"references.bib" | "references.json">;
    readonly citationStyle?: string | null;
  }) {
    const store = yield* resolveScientSourcesStore();
    // The citation style is a project file, whichever store holds the sources.
    const { root } = store;
    const { citationStyle: styleId, ...files } = input;
    let style: ScientProjectCitationStyle;
    if (styleId === undefined) {
      style = yield* attempt(() => readProjectCitationStyle(root));
    } else {
      const deps = yield* citationStyleDependencies;
      const set = yield* attempt(() =>
        setProjectCitationStyle({ root, styleId, actor: "agent" }, deps),
      );
      if (set.error !== null) return yield* toolError("operation-failed", set.error);
      style = set.style;
    }
    if (store.kind === "library") {
      // Entries added to this project's file are meant for it, so they are always pinned here.
      if (files.importEdited && files.importEdited.length > 0) {
        const observeImport = yield* makeSourceImportAnalytics("agent");
        const status = yield* attempt(() =>
          syncManagedBibliographyWithImports(
            { root: store.root, library: store.library, ...files, actor: "agent" },
            observeImport,
          ),
        );
        return { ...status, citationStyle: agentCitationStyle(style) };
      }
      const status = yield* attempt(() =>
        syncPinnedBibliography({
          root: store.root,
          library: store.library,
          access: store.access,
          actor: "agent",
          ...(files.replaceEdited ? { replaceEdited: files.replaceEdited } : {}),
        }),
      );
      return { ...status, citationStyle: agentCitationStyle(style) };
    }
    const observeImport = yield* makeSourceImportAnalytics("agent");
    const status = yield* attempt(() =>
      syncManagedBibliographyWithImports({ root, ...files, actor: "agent" }, observeImport),
    );
    return { ...status, citationStyle: agentCitationStyle(style) };
  },
);

export const searchScientSourcesForInvocation = Effect.fn("ScientSourcesToolkit.search")(
  function* (input: {
    readonly query: string;
    readonly sourceIds?: ReadonlyArray<string>;
    readonly limit?: number;
  }) {
    const store = yield* resolveScientSourcesStore();
    if (store.kind === "library" && !store.exists) {
      return {
        status: { pdfs: 0, searchable: 0, pending: 0, withoutText: 0, unreadable: 0 },
        hits: [],
      };
    }
    const sourceIds = input.sourceIds
      ? yield* Effect.forEach(input.sourceIds, (sourceId) => sourceIdIn(store, sourceId))
      : undefined;
    const { hits, status } = yield* attempt(() =>
      searchSourceFullText({
        root: store.store,
        query: input.query,
        limit: Math.min(25, Math.max(1, input.limit ?? 10)),
        ...(sourceIds ? { sourceIds } : {}),
        persist: storesFullText(store),
      }),
    );
    const pins =
      store.kind === "library" ? yield* attempt(() => projectPinsByLibraryId(store)) : null;
    return {
      status,
      hits: hits.map(
        ({ sourceId, attachmentId, title, page, start, end, passage, matchedTerms }) => {
          const pin = pins?.get(sourceId);
          return {
            sourceId,
            attachmentId,
            title,
            page,
            start,
            end,
            passage,
            matchedTerms,
            ...(pins ? { pinned: pin !== undefined } : {}),
            ...(pin ? { citationKey: pin.citationKey } : {}),
          };
        },
      ),
    };
  },
);

export const readScientSourceTextForInvocation = Effect.fn("ScientSourcesToolkit.readText")(
  function* (input: {
    readonly sourceId: string;
    readonly attachmentId?: string;
    readonly fromPage?: number;
    readonly maxCharacters?: number;
  }) {
    const store = yield* resolveScientSourcesStore();
    if (store.kind === "library" && !store.exists) return { outcome: "source-not-found" as const };
    const sourceId = yield* sourceIdIn(store, input.sourceId);
    return yield* attempt(() =>
      readSourceText({
        root: store.store,
        sourceId,
        ...(input.attachmentId ? { attachmentId: input.attachmentId } : {}),
        fromPage: Math.max(1, input.fromPage ?? 1),
        maxCharacters: Math.min(30_000, Math.max(1_000, input.maxCharacters ?? 12_000)),
        persist: storesFullText(store),
      }),
    );
  },
);

export const checkScientSourceQuotesForInvocation = Effect.fn("ScientSourcesToolkit.checkQuotes")(
  function* (input: {
    readonly quotes: ReadonlyArray<{ readonly quote: string; readonly sourceId?: string }>;
  }) {
    const store = yield* resolveScientSourcesStore();
    if (store.kind === "library" && !store.exists) {
      return {
        results: input.quotes.slice(0, 25).map(() => ({ outcome: "not-indexed" as const })),
      };
    }
    const quotes = yield* Effect.forEach(input.quotes.slice(0, 25), ({ quote, sourceId }) =>
      sourceId === undefined
        ? Effect.succeed({ quote })
        : sourceIdIn(store, sourceId).pipe(
            Effect.map((resolved) => ({ quote, sourceId: resolved })),
          ),
    );
    const results = yield* attempt(() =>
      checkSourceQuotes({ root: store.store, quotes, persist: storesFullText(store) }),
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
    const store = yield* resolveScientSourcesStore();
    const root = store.store;
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
    if (result.outcome === "not-added") {
      return { ...result, sourceId: null, revision: null, passageSaved: false };
    }
    yield* pinAdded(store, [result.sourceId]);
    return result;
  },
);

export const importScientSourcesFileForInvocation = Effect.fn("ScientSourcesToolkit.importFile")(
  function* (input: {
    readonly relativePath: string;
    readonly format?: BibliographyFormat;
    /** Library mode: false brings the entries into the library without pinning them here. */
    readonly pin?: boolean;
  }) {
    const store = yield* resolveScientSourcesStore();
    const { root } = store;
    const observeImport = yield* makeSourceImportAnalytics("agent");
    const { operation, report } = yield* Effect.tryPromise({
      try: async () => {
        const file = await resolveProjectBibliographyFile(root, input.relativePath);
        return importBibliographyFile(
          {
            root: store.store,
            ...(store.kind === "library"
              ? { projectRoot: root, ...(input.pin === false ? {} : { pinInto: root }) }
              : {}),
            operationId: `agent_file_${NodeCrypto.randomUUID()}`,
            fileName: file.fileName,
            text: await readBibliographyFile(file.absolutePath),
            sourceFolder: NodePath.dirname(file.absolutePath),
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
      importedIds.length > 0 ? yield* attempt(() => listScientSourceRecords(store.store)) : [];
    // A source pinned here is cited by its pin's key, which can differ from the record's.
    const pins =
      store.kind === "library" && importedIds.length > 0
        ? yield* attempt(() => projectPinsByLibraryId(store))
        : new Map<string, { readonly citationKey: string }>();
    const keys = new Map(
      records.map((record) => [
        record.sourceId,
        pins.get(record.sourceId)?.citationKey ?? record.citationKey ?? null,
      ]),
    );
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
      pdfsAttached: records
        .filter((record) => importedIds.includes(record.sourceId))
        .reduce(
          (count, record) =>
            count + record.attachments.filter((attachment) => attachment.kind === "pdf").length,
          0,
        ),
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
    const store = yield* resolveScientSourcesStore();
    const { root } = store;
    const sourceIds = input.sourceIds
      ? yield* Effect.forEach(input.sourceIds, (sourceId) => sourceIdIn(store, sourceId))
      : undefined;
    const records =
      store.kind === "library" ? yield* attempt(() => exportableRecords(store, sourceIds)) : null;
    const exported = yield* attempt(() =>
      exportBibliography({
        root,
        format: input.format,
        ...(sourceIds ? { sourceIds } : {}),
        includeNotes: input.includeNotes ?? false,
        ...(records ? { records } : {}),
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

/**
 * Library mode exports this project's pinned works by default; named sources come from the
 * library. Either way a source pinned here is written under its project key.
 */
async function exportableRecords(
  store: ScientSourcesLibraryStore,
  sourceIds: ReadonlyArray<string> | undefined,
) {
  if (!sourceIds) {
    const works = distinctPinnedWorks(await listProjectPinnedWorks(store, "agent"));
    const records = store.exists
      ? new Map(
          (await listScientSourceRecords(store.library)).map((record) => [record.sourceId, record]),
        )
      : new Map<string, ScientSourceRecord>();
    // Pinned works leave out the personal note; includeNotes reads it from the record.
    return works.map((work) => {
      const record = records.get(work.record.sourceId);
      return record ? { ...record, citationKey: work.citationKey } : work.record;
    });
  }
  if (!store.exists) return [];
  const pins = await projectPinsByLibraryId(store);
  return (await listScientSourceRecords(store.library)).map((record) => {
    const pin = pins.get(record.sourceId);
    return pin ? { ...record, citationKey: pin.citationKey } : record;
  });
}

export const citeScientSourcesForInvocation = Effect.fn("ScientSourcesToolkit.cite")(
  function* (input: {
    readonly sources: ReadonlyArray<string>;
    readonly format?: "markdown" | "latex";
  }) {
    const store = yield* resolveScientSourcesStore();
    const resolveIdentifiers = yield* keyedBatchLookup(yield* ReferenceIdentifierLookup);
    if (store.kind === "library") {
      return yield* attempt(() =>
        citePinnedSources(
          {
            root: store.root,
            library: store.library,
            sources: input.sources,
            format: input.format ?? "markdown",
            actor: "agent",
            resolveLibraryId: (wanted) => resolveLibrarySourceId(store, wanted),
          },
          { resolveIdentifiers },
        ),
      );
    }
    const { root } = store;
    return yield* attempt(() =>
      citeLibrarySources(
        { root, sources: input.sources, format: input.format ?? "markdown" },
        { resolveIdentifiers },
      ),
    );
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

export const ScientSourcesLibraryToolkitHandlersLive = ScientSourcesLibraryToolkit.toLayer({
  ...handlers,
  scient_sources_update: updateLibrarySourceForInvocation,
  scient_sources_organize: organizeLibrarySourcesForInvocation,
});
