import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  EnvironmentAuthenticatedPrincipal,
  EnvironmentHttpApi,
} from "@t3tools/contracts";
import {
  scientLibraryLocation,
  scientLibraryRootFor,
} from "@scientfactory/scient-sources/library-root";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import {
  annotateEnvironmentRequest,
  failEnvironmentInternal,
  requireEnvironmentScope,
} from "../../auth/http.ts";
import { ProjectStoreV2 } from "../../orchestration-v2/ProjectStore.ts";
import { issueAssetUrl } from "../../assets/AssetAccess.ts";
import * as ServerConfig from "../../config.ts";
import { sourceAttachmentPreview } from "./SourceAttachmentPreview.ts";
import { searchSourceFullText } from "./SourceFullText.ts";
import { saveWebPageSource } from "./SourceWebPage.ts";
import { makeSourceImportAnalytics } from "../../telemetry/SourceImportAnalytics.ts";
import { zoteroKeyLookup } from "./ZoteroAccountKey.ts";
import { ZoteroTransports } from "./ZoteroConnections.ts";
import { refreshZoteroSources, sendSourcesToZotero } from "./ZoteroSync.ts";
import {
  advanceSourceImport,
  beginLocalPdfImport,
  bulkUpdateSources,
  changeSystematicReview,
  getSystematicReview,
  listSystematicReviews,
  beginZoteroImport,
  beginZoteroScopedImport,
  continueZoteroImportRun,
  cancelSourceImport,
  discardLocalPdfSources,
  getScientSourcesOverview,
  getScientSourceDetail,
  getScientSourceJournalIconMaterial,
  inspectZoteroConnection,
  listZoteroCollections,
  listZoteroLibrary,
  organizeSources,
  preflightZoteroImport,
  refreshScientSourceMetadata,
  deleteSourcesPermanently,
  listSourceRevisions,
  listSourceTrash,
  removeSource,
  restoreSource,
  retrySourceImport,
  syncManagedBibliographyWithImports,
  revertSource,
  updateScientSource,
  updateSourceNote,
  uploadLocalPdfSource,
} from "./ScientSourcesCoordinator.ts";
import {
  addScientSourcesByIdentifier,
  SourceIdentifierBatchLookup,
} from "./SourceIdentifierAdd.ts";
import { SourceIdentifierLookup } from "./SourceIdentifierResolver.ts";
import { researchKeysReader } from "./researchKeys.ts";
import { readSourceCategoryKeysFrom } from "./SourceCategories.ts";
import {
  beginBibliographyFileImport,
  exportBibliography,
  readBibliographyFile,
  verifiedUploadFolder,
} from "./BibliographyFileAdapter.ts";
import { startManagedBibliographySync } from "./ManagedBibliography.ts";
import {
  bulkUpdateLibrarySources,
  libraryRecentChanges,
  isLibraryOrganizeAction,
  changeLibraryReview,
  changeLibraryReviewConflict,
  libraryReviewConflicts,
  deleteLibrarySourcesPermanently,
  exportLibrarySources,
  libraryImportTarget,
  libraryJournalIconMaterial,
  libraryOverview,
  libraryReview,
  libraryReviews,
  librarySourceDetail,
  librarySourceRevisions,
  libraryTrash,
  libraryZoteroSourceIds,
  libraryDuplicates,
  organizeLibrarySources,
  pinLibraryIntake,
  refreshAfterLibraryChange,
  refreshLibrarySourceMetadata,
  removeLibrarySource,
  restoreLibrarySource,
  revertLibrarySource,
  updateLibraryPersonalNote,
  updateLibraryProjectNote,
  updateLibrarySourceMetadata,
} from "./LibrarySourcesRoutes.ts";
import {
  changeLibraryRestore,
  libraryRestoreStatus,
  readLibraryCopies,
} from "./LibraryRestoreRuns.ts";
import { readLibraryMoveStatus } from "./LibraryMove.ts";
import { setLibraryReadingState } from "./LibraryProjectSources.ts";
import {
  listCitationKeys,
  listProjectCitationKeys,
  listProjectSourceUses,
  listSourceUses,
} from "./SourceUses.ts";
import {
  resolveScientLibraryStoreAt,
  ScientSourcesBackend,
  type ScientSourcesLibraryStore,
} from "./SourcesBackend.ts";
import {
  citationStyleCacheRoot,
  searchCitationStyles,
  setProjectCitationStyle,
} from "./CitationStyles.ts";
import { deleteLiteratureWatch } from "@scientfactory/scient-sources/literature-watch-store";
import { ScheduledTaskService } from "../../scheduledTasks/ScheduledTaskService.ts";
import type { ScheduledTaskError } from "@t3tools/contracts";
import {
  changeLiteratureWatchItem,
  literatureWatchList,
  literatureWatchView,
  setLiteratureWatchPaused,
} from "./literatureWatch/LiteratureWatchRoutes.ts";
import {
  deleteLiteratureWatchSchedule,
  literatureWatchTaskId,
  restoreLiteratureWatchSchedules,
  runLiteratureWatchNow,
  syncLiteratureWatchSchedule,
} from "./literatureWatch/LiteratureWatchSchedule.ts";

class ScientSourcesOperationError extends Schema.TaggedError<ScientSourcesOperationError>()(
  "ScientSourcesOperationError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "A sources operation failed.";
  }
}

const sourcesOperation = <A>(run: () => Promise<A>) =>
  Effect.tryPromise({ try: run, catch: (cause) => new ScientSourcesOperationError({ cause }) });

const handle = Effect.fn("ScientSourcesHttp.handle")(function* <A>(
  endpointName: string,
  scope: typeof AuthOrchestrationReadScope | typeof AuthOrchestrationOperateScope,
  run: () => Promise<A>,
) {
  yield* annotateEnvironmentRequest(endpointName);
  yield* requireEnvironmentScope(scope);
  return yield* sourcesOperation(run).pipe(
    Effect.catch((cause) => failEnvironmentInternal("scient_sources_operation_failed", cause)),
  );
});

type Scope = typeof AuthOrchestrationReadScope | typeof AuthOrchestrationOperateScope;

/**
 * The library a route works on, or null under the project backend, which reads nothing here.
 * Only change endpoints (operate) may write; reads write nothing in either tree.
 */
const libraryFor = (root: string, scope: Scope) =>
  resolveScientLibraryStoreAt(
    root,
    scope === AuthOrchestrationOperateScope ? "write" : "read",
  ).pipe(
    Effect.catch((cause) =>
      failEnvironmentInternal(
        // Retryable: the move goes on, and `moveStatus` reports its progress.
        cause._tag === "ScientLibraryMoveBusyError"
          ? "scient_sources_library_moving"
          : "scient_sources_operation_failed",
        cause,
      ),
    ),
  );

/** Like `handle`, with the store resolved the way agent tools resolve it. */
const route = Effect.fn("ScientSourcesHttp.route")(function* <A>(
  endpointName: string,
  scope: Scope,
  root: string,
  run: (library: ScientSourcesLibraryStore | null) => Promise<A>,
) {
  yield* annotateEnvironmentRequest(endpointName);
  yield* requireEnvironmentScope(scope);
  const library = yield* libraryFor(root, scope);
  return yield* sourcesOperation(() => run(library)).pipe(
    Effect.catch((cause) => failEnvironmentInternal("scient_sources_operation_failed", cause)),
  );
});

/** A project store keeps the request's own root; a library import takes its view's target. */
const importTarget = (library: ScientSourcesLibraryStore | null, pin: boolean | undefined) =>
  library ? libraryImportTarget(library, pin) : {};
const citationStyleCache = Effect.map(ServerConfig.ServerConfig, (config) => ({
  cacheRoot: citationStyleCacheRoot(config.stateDir),
}));

export const scientSourcesHttpApiLayer = HttpApiBuilder.group(
  EnvironmentHttpApi,
  "scientSources",
  Effect.fnUntraced(function* (handlers) {
    const observeImport = yield* makeSourceImportAnalytics("user");
    const projectStore = yield* ProjectStoreV2;
    const scheduledTasks = yield* ScheduledTaskService;
    startManagedBibliographySync();
    const zotero = {
      ...(yield* ZoteroTransports),
      webKey: yield* zoteroKeyLookup({ actor: "user" }),
    };
    const researchKeys = yield* researchKeysReader();
    readSourceCategoryKeysFrom(researchKeys);
    const lookup = yield* SourceIdentifierLookup;
    const batchLookup = yield* SourceIdentifierBatchLookup;
    const keyed = {
      resolveIdentifier: async (identifiers: Parameters<typeof lookup>[0]) =>
        lookup(identifiers, await researchKeys()),
      resolveIdentifiers: async (identifiers: Parameters<typeof batchLookup>[0]) =>
        batchLookup(identifiers, await researchKeys()),
    };
    return yield* Effect.succeed(
      handlers
        .handle("overview", (args) =>
          Effect.gen(function* () {
            yield* annotateEnvironmentRequest(args.endpoint.name);
            const session = yield* requireEnvironmentScope(AuthOrchestrationReadScope);
            const libraryBackend = (yield* ScientSourcesBackend) === "library";
            // A folder that is not a Scient project yet reports its state as before.
            const library = yield* resolveScientLibraryStoreAt(args.payload.root, "read").pipe(
              Effect.orElseSucceed(() => null),
            );
            const overview = yield* sourcesOperation(() =>
              library
                ? libraryOverview(library, {
                    scope: args.payload.scope ?? "project",
                    background: session.scopes.has(AuthOrchestrationOperateScope),
                    ...(args.payload.readingStatus
                      ? { readingStatus: args.payload.readingStatus }
                      : {}),
                    ...(args.payload.starred !== undefined
                      ? { starred: args.payload.starred }
                      : {}),
                    ...(args.payload.knownRevision
                      ? { knownRevision: args.payload.knownRevision }
                      : {}),
                  })
                : getScientSourcesOverview(args.payload.root),
            ).pipe(
              Effect.catch((cause) =>
                failEnvironmentInternal("scient_sources_operation_failed", cause),
              ),
            );
            return libraryBackend ? { ...overview, libraryBackend: true as const } : overview;
          }),
        )
        .handle("detail", (args) =>
          Effect.gen(function* () {
            // Only a session that may change the library is served the person's own note.
            const personal = (yield* EnvironmentAuthenticatedPrincipal).scopes.has(
              AuthOrchestrationOperateScope,
            );
            return yield* route(
              args.endpoint.name,
              AuthOrchestrationReadScope,
              args.payload.root,
              (library) =>
                library
                  ? librarySourceDetail(library, { ...args.payload, personal })
                  : getScientSourceDetail({
                      root: args.payload.root,
                      sourceId: args.payload.sourceId,
                    }),
            );
          }),
        )
        .handle("attachmentPreview", (args) =>
          Effect.gen(function* () {
            yield* annotateEnvironmentRequest(args.endpoint.name);
            yield* requireEnvironmentScope(AuthOrchestrationReadScope);
            const library = yield* libraryFor(args.payload.root, AuthOrchestrationReadScope);
            return yield* sourceAttachmentPreview(library, args.payload).pipe(
              Effect.catch((cause) =>
                failEnvironmentInternal("scient_sources_operation_failed", cause),
              ),
            );
          }),
        )
        .handle("fullTextSearch", (args) =>
          route(
            args.endpoint.name,
            AuthOrchestrationReadScope,
            args.payload.root,
            async (library) =>
              library && !library.exists
                ? {
                    hits: [],
                    status: { pdfs: 0, searchable: 0, pending: 0, withoutText: 0, unreadable: 0 },
                  }
                : searchSourceFullText({
                    root: library ? library.library : args.payload.root,
                    query: args.payload.query,
                    limit: args.payload.limit ?? 20,
                    ...(args.payload.sourceIds ? { sourceIds: args.payload.sourceIds } : {}),
                    // A read stores no extracted text in the shared library.
                    ...(library ? { persist: false } : {}),
                  }),
          ),
        )
        .handle("savePage", (args) =>
          route(
            args.endpoint.name,
            AuthOrchestrationOperateScope,
            args.payload.root,
            async (library) => {
              if (!library) {
                return saveWebPageSource(
                  {
                    root: args.payload.root,
                    page: args.payload.page,
                    actor: "user",
                    resolveIdentifier: keyed.resolveIdentifier,
                  },
                  observeImport,
                );
              }
              const saved = await saveWebPageSource(
                {
                  root: library.library,
                  page: args.payload.page,
                  actor: "user",
                  resolveIdentifier: keyed.resolveIdentifier,
                },
                observeImport,
              );
              if (saved.outcome !== "not-added" && args.payload.pin !== false) {
                await pinLibraryIntake(library, [saved.sourceId]);
              }
              return saved;
            },
          ),
        )
        .handle("journalIcon", (args) =>
          Effect.gen(function* () {
            yield* annotateEnvironmentRequest(args.endpoint.name);
            yield* requireEnvironmentScope(AuthOrchestrationReadScope);
            const config = yield* ServerConfig.ServerConfig;
            const path = yield* Path.Path;
            const library = yield* libraryFor(args.payload.root, AuthOrchestrationReadScope);
            const cacheRoot = path.join(config.stateDir, "scient", "journal-covers", "v1");
            const material = yield* sourcesOperation(() =>
              library
                ? libraryJournalIconMaterial(library, {
                    sourceId: args.payload.sourceId,
                    cacheRoot,
                  })
                : getScientSourceJournalIconMaterial({ ...args.payload, cacheRoot }),
            ).pipe(
              Effect.catch((cause) =>
                failEnvironmentInternal("scient_sources_operation_failed", cause),
              ),
            );
            if (!material) return { icon: null };
            const asset = yield* issueAssetUrl({
              resource: {
                _tag: "workspace-file",
                cwd: material.cacheRoot,
                relativePath: path.relative(material.cacheRoot, material.absolutePath),
              },
            }).pipe(
              Effect.catch((cause) =>
                failEnvironmentInternal("scient_sources_operation_failed", cause),
              ),
            );
            return { icon: { ...asset, journalTitle: material.journalTitle } };
          }),
        )
        .handle("updateMetadata", (args) =>
          route(args.endpoint.name, AuthOrchestrationOperateScope, args.payload.root, (library) =>
            library
              ? updateLibrarySourceMetadata(library, args.payload)
              : updateScientSource(args.payload),
          ),
        )
        .handle("updateNote", (args) =>
          route(args.endpoint.name, AuthOrchestrationOperateScope, args.payload.root, (library) =>
            library
              ? updateLibraryProjectNote(library, args.payload)
              : updateSourceNote(args.payload),
          ),
        )
        .handle("updatePersonalNote", (args) =>
          route(args.endpoint.name, AuthOrchestrationOperateScope, args.payload.root, (library) => {
            if (!library) throw new Error("The personal note needs the personal Library.");
            return updateLibraryPersonalNote(library, args.payload);
          }),
        )
        .handle("setReadingState", (args) =>
          route(args.endpoint.name, AuthOrchestrationOperateScope, args.payload.root, (library) => {
            if (!library) throw new Error("Reading state needs the personal Library.");
            return setLibraryReadingState(library, args.payload);
          }),
        )
        .handle("refreshMetadata", (args) =>
          route(args.endpoint.name, AuthOrchestrationOperateScope, args.payload.root, (library) =>
            library
              ? refreshLibrarySourceMetadata(library, {
                  ...args.payload,
                  resolveIdentifier: keyed.resolveIdentifier,
                })
              : refreshScientSourceMetadata({
                  ...args.payload,
                  resolveIdentifier: keyed.resolveIdentifier,
                }),
          ),
        )
        .handle("remove", (args) =>
          route(args.endpoint.name, AuthOrchestrationOperateScope, args.payload.root, (library) =>
            library ? removeLibrarySource(library, args.payload) : removeSource(args.payload),
          ),
        )
        .handle("organize", (args) =>
          Effect.gen(function* () {
            const libraryBackend = (yield* ScientSourcesBackend) === "library";
            return yield* route(
              args.endpoint.name,
              AuthOrchestrationOperateScope,
              args.payload.root,
              async (library) => {
                if (library) return organizeLibrarySources(library, args.payload);
                const { change } = args.payload;
                // Already moved back: the project keeps its own store, so a repeat has nothing to do.
                // A retried move that failed again leaves the project in its own store too.
                if (
                  libraryBackend &&
                  (change.action === "move-back" || change.action === "retry-move")
                ) {
                  return { outcome: "not-moved" as const };
                }
                if (isLibraryOrganizeAction(change)) {
                  throw new Error("Pins and merges need the personal Library.");
                }
                return organizeSources({ root: args.payload.root, change, actor: "user" });
              },
            );
          }),
        )
        .handle("systematicReviews", (args) =>
          route(args.endpoint.name, AuthOrchestrationReadScope, args.payload.root, (library) =>
            library ? libraryReviews(library) : listSystematicReviews(args.payload.root),
          ),
        )
        .handle("systematicReview", (args) =>
          route(args.endpoint.name, AuthOrchestrationReadScope, args.payload.root, (library) =>
            library ? libraryReview(library, args.payload) : getSystematicReview(args.payload),
          ),
        )
        .handle("literatureWatches", (args) =>
          route(args.endpoint.name, AuthOrchestrationReadScope, args.payload.root, async (library) =>
            library ? literatureWatchList(library.library) : { watches: [], unread: 0 },
          ),
        )
        .handle("literatureWatch", (args) =>
          Effect.gen(function* () {
            const { watch, view } = yield* route(
              args.endpoint.name,
              AuthOrchestrationReadScope,
              args.payload.root,
              async (library) => {
                if (!library) throw new Error("Literature watches need the personal Library.");
                return literatureWatchView(library.library, args.payload.watchId);
              },
            );
            yield* restoreLiteratureWatchSchedules([watch]).pipe(
              Effect.provideService(ScheduledTaskService, scheduledTasks),
              Effect.ignore,
            );
            const { tasks } = yield* scheduledTasks
              .list()
              .pipe(Effect.orElseSucceed(() => ({ tasks: [] })));
            const task = tasks.find((entry) => entry.id === literatureWatchTaskId(watch.watchId));
            return {
              watch: {
                ...view,
                ...(task?.threadId ? { threadId: task.threadId } : {}),
                running: task?.lastRunStatus === "running",
              },
            };
          }),
        )
        .handle("literatureWatchChange", (args) =>
          Effect.gen(function* () {
            const { watchId, change } = args.payload;
            const now = DateTime.toDateUtc(yield* DateTime.now);
            const result = yield* route(
              args.endpoint.name,
              AuthOrchestrationOperateScope,
              args.payload.root,
              async (library) => {
                if (!library) throw new Error("Literature watches need the personal Library.");
                switch (change.action) {
                  case "pause":
                  case "resume":
                    return {
                      watch: await setLiteratureWatchPaused(
                        library.library,
                        watchId,
                        change.action === "pause",
                        now,
                      ),
                    };
                  case "delete":
                    await deleteLiteratureWatch(library.library, watchId);
                    return {};
                  case "run-now":
                    return {};
                  default:
                    return {
                      result: await changeLiteratureWatchItem(
                        library.library,
                        watchId,
                        change,
                        keyed.resolveIdentifiers,
                        now,
                      ),
                    };
                }
              },
            );
            const schedule: Effect.Effect<unknown, ScheduledTaskError, ScheduledTaskService> =
              "watch" in result && result.watch
                ? syncLiteratureWatchSchedule(result.watch)
                : change.action === "delete"
                  ? deleteLiteratureWatchSchedule(watchId)
                  : change.action === "run-now"
                    ? runLiteratureWatchNow(watchId)
                    : Effect.void;
            yield* schedule.pipe(
              Effect.provideService(ScheduledTaskService, scheduledTasks),
              Effect.catch((cause) =>
                failEnvironmentInternal("scient_sources_operation_failed", cause),
              ),
            );
            return "result" in result && result.result ? result.result : {};
          }),
        )
        .handle("systematicReviewConflicts", (args) =>
          route(
            args.endpoint.name,
            AuthOrchestrationReadScope,
            args.payload.root,
            async (library) =>
              library
                ? libraryReviewConflicts(library, args.payload)
                : { current: null, versions: [], combineReport: null },
          ),
        )
        .handle("systematicReviewConflict", (args) =>
          route(
            args.endpoint.name,
            AuthOrchestrationOperateScope,
            args.payload.root,
            async (library) => {
              if (!library) {
                throw new Error("Versions of a review from copies of a project need the Library.");
              }
              return changeLibraryReviewConflict(library, args.payload);
            },
          ),
        )
        .handle("duplicates", (args) =>
          Effect.gen(function* () {
            yield* requireEnvironmentScope(AuthOrchestrationReadScope);
            // Only for naming other projects; without the list they keep their folder names.
            const projects = yield* projectStore.list().pipe(Effect.orElseSucceed(() => []));
            return yield* route(
              args.endpoint.name,
              AuthOrchestrationReadScope,
              args.payload.root,
              async (library) => {
                if (!library) throw new Error("Possible duplicates need the personal Library.");
                const { root: _root, ...page } = args.payload;
                return libraryDuplicates(library, projects, page);
              },
            );
          }),
        )
        .handle("moveStatus", (args) =>
          Effect.gen(function* () {
            yield* annotateEnvironmentRequest(args.endpoint.name);
            yield* requireEnvironmentScope(AuthOrchestrationReadScope);
            if ((yield* ScientSourcesBackend) === "project") {
              return { state: "nothing-to-move" } as const;
            }
            const config = yield* ServerConfig.ServerConfig;
            // Reads only: a library that was never created stays uncreated.
            return yield* readLibraryMoveStatus({
              root: args.payload.root,
              library: scientLibraryLocation(scientLibraryRootFor(config.stateDir)),
            });
          }),
        )
        .handle("backupStatus", (args) =>
          Effect.gen(function* () {
            yield* annotateEnvironmentRequest(args.endpoint.name);
            yield* requireEnvironmentScope(AuthOrchestrationReadScope);
            if ((yield* ScientSourcesBackend) === "project") {
              return {
                backup: { state: "none" },
                restore: { state: "none" },
                join: { state: "none" },
              } as const;
            }
            const config = yield* ServerConfig.ServerConfig;
            return yield* Effect.promise(() =>
              readLibraryCopies(scientLibraryRootFor(config.stateDir)),
            );
          }),
        )
        .handle("libraryRestore", (args) =>
          Effect.gen(function* () {
            yield* annotateEnvironmentRequest(args.endpoint.name);
            yield* requireEnvironmentScope(AuthOrchestrationOperateScope);
            if ((yield* ScientSourcesBackend) === "project") return { state: "none" } as const;
            const config = yield* ServerConfig.ServerConfig;
            // The Library's folder only: this never creates the Library or moves a project in.
            const libraryRoot = scientLibraryRootFor(config.stateDir);
            const { change } = args.payload;
            return yield* sourcesOperation(async () => {
              await changeLibraryRestore(libraryRoot, change);
              return libraryRestoreStatus(libraryRoot);
            }).pipe(
              Effect.catch((cause) =>
                failEnvironmentInternal("scient_sources_operation_failed", cause),
              ),
            );
          }),
        )
        .handle("systematicReviewChange", (args) =>
          route(args.endpoint.name, AuthOrchestrationOperateScope, args.payload.root, (library) =>
            library
              ? changeLibraryReview(library, args.payload)
              : changeSystematicReview({ ...args.payload, actor: "user" }),
          ),
        )
        .handle("bulkUpdate", (args) =>
          route(args.endpoint.name, AuthOrchestrationOperateScope, args.payload.root, (library) =>
            library
              ? bulkUpdateLibrarySources(library, args.payload)
              : bulkUpdateSources({ ...args.payload, actor: "user" }),
          ),
        )
        .handle("addByIdentifier", (args) =>
          route(
            args.endpoint.name,
            AuthOrchestrationOperateScope,
            args.payload.root,
            async (library) => {
              const results = await addScientSourcesByIdentifier(
                {
                  root: library ? library.library : args.payload.root,
                  entries: args.payload.entries,
                  actor: "user",
                  enrich: true,
                  resolveIdentifiers: keyed.resolveIdentifiers,
                },
                observeImport,
              );
              if (library && args.payload.pin !== false) {
                await pinLibraryIntake(
                  library,
                  results.map((item) =>
                    item.outcome === "imported" ||
                    (item.outcome === "duplicate" && !item.possibleMatch)
                      ? item.sourceId
                      : null,
                  ),
                );
              }
              return { results };
            },
          ),
        )
        .handle("recentChanges", (args) =>
          Effect.gen(function* () {
            // As for a source's detail: only a session that may change the Library is served
            // the person's own notes (a join's differences show both Libraries' notes).
            const personal = (yield* EnvironmentAuthenticatedPrincipal).scopes.has(
              AuthOrchestrationOperateScope,
            );
            return yield* route(
              args.endpoint.name,
              AuthOrchestrationReadScope,
              args.payload.root,
              (library) =>
                // A project that keeps its own sources has the toast's Undo and its Trash only.
                library
                  ? libraryRecentChanges(library, { ...args.payload, personal })
                  : Promise.resolve({ changes: [], more: false }),
            );
          }),
        )
        .handle("sourceUses", (args) =>
          route(args.endpoint.name, AuthOrchestrationReadScope, args.payload.root, (library) =>
            library
              ? listSourceUses({
                  root: library.root,
                  library: library.exists ? library.library : null,
                  sourceId: args.payload.sourceId,
                })
              : listProjectSourceUses(args.payload),
          ),
        )
        .handle("sourceCitationKeys", (args) =>
          route(args.endpoint.name, AuthOrchestrationReadScope, args.payload.root, (library) =>
            library
              ? listCitationKeys({
                  root: library.root,
                  library: library.exists ? library.library : null,
                  path: args.payload.path,
                  keys: args.payload.keys,
                })
              : listProjectCitationKeys(args.payload),
          ),
        )
        .handle("trash", (args) =>
          Effect.gen(function* () {
            // Only for naming the projects that cite a trashed source.
            const projects = yield* projectStore.list().pipe(Effect.orElseSucceed(() => []));
            return yield* route(
              args.endpoint.name,
              AuthOrchestrationReadScope,
              args.payload.root,
              (library) =>
                library ? libraryTrash(library, projects) : listSourceTrash(args.payload),
            );
          }),
        )
        .handle("restore", (args) =>
          route(args.endpoint.name, AuthOrchestrationOperateScope, args.payload.root, (library) =>
            library ? restoreLibrarySource(library, args.payload) : restoreSource(args.payload),
          ),
        )
        .handle("deletePermanently", (args) =>
          route(args.endpoint.name, AuthOrchestrationOperateScope, args.payload.root, (library) =>
            library
              ? deleteLibrarySourcesPermanently(library, args.payload)
              : deleteSourcesPermanently(args.payload),
          ),
        )
        .handle("revisions", (args) =>
          route(args.endpoint.name, AuthOrchestrationReadScope, args.payload.root, (library) =>
            library
              ? librarySourceRevisions(library, args.payload)
              : listSourceRevisions(args.payload),
          ),
        )
        .handle("revert", (args) =>
          route(args.endpoint.name, AuthOrchestrationOperateScope, args.payload.root, (library) =>
            library ? revertLibrarySource(library, args.payload) : revertSource(args.payload),
          ),
        )
        .handle("zoteroStatus", (args) =>
          handle(args.endpoint.name, AuthOrchestrationReadScope, () =>
            inspectZoteroConnection({ ...args.payload, zotero, groups: true }),
          ),
        )
        .handle("zoteroLibrary", (args) =>
          handle(args.endpoint.name, AuthOrchestrationReadScope, () =>
            listZoteroLibrary({ ...args.payload, zotero }),
          ),
        )
        .handle("zoteroCollections", (args) =>
          handle(args.endpoint.name, AuthOrchestrationReadScope, () =>
            listZoteroCollections({ ...args.payload, zotero }),
          ),
        )
        .handle("preflight", (args) =>
          route(args.endpoint.name, AuthOrchestrationReadScope, args.payload.root, (library) =>
            preflightZoteroImport({
              ...args.payload,
              // With no library yet, every item is new; the read creates nothing.
              ...(library
                ? { root: library.library, ...(library.exists ? {} : { existing: [] }) }
                : {}),
              zotero,
            }),
          ),
        )
        .handle("localPdfUpload", (args) =>
          route(args.endpoint.name, AuthOrchestrationOperateScope, args.payload.root, (library) =>
            uploadLocalPdfSource({
              root: library ? library.library : args.payload.root,
              sourcePath: args.payload.file.path,
              fileName: args.payload.file.name,
            }),
          ),
        )
        .handle("localBeginImport", (args) =>
          route(args.endpoint.name, AuthOrchestrationOperateScope, args.payload.root, (library) => {
            const { pin, ...payload } = args.payload;
            return beginLocalPdfImport({ ...payload, ...importTarget(library, pin) });
          }),
        )
        .handle("localDiscard", (args) =>
          route(args.endpoint.name, AuthOrchestrationOperateScope, args.payload.root, (library) =>
            discardLocalPdfSources({
              ...args.payload,
              ...(library ? { root: library.library } : {}),
            }),
          ),
        )
        .handle("fileImport", (args) =>
          route(
            args.endpoint.name,
            AuthOrchestrationOperateScope,
            args.payload.root,
            async (library) =>
              beginBibliographyFileImport({
                root: args.payload.root,
                ...(library
                  ? {
                      ...importTarget(library, args.payload.pin !== "false"),
                      projectRoot: library.root,
                    }
                  : {}),
                operationId: args.payload.operationId,
                fileName: args.payload.file.name,
                text: await readBibliographyFile(args.payload.file.path),
                ...(await verifiedUploadFolder(
                  args.payload.sourcePath,
                  args.payload.file.path,
                ).then((sourceFolder) => (sourceFolder ? { sourceFolder } : {}))),
                actor: "user",
              }),
          ),
        )
        .handle("export", (args) =>
          route(args.endpoint.name, AuthOrchestrationReadScope, args.payload.root, (library) =>
            library
              ? exportLibrarySources(library, args.payload)
              : exportBibliography(args.payload),
          ),
        )
        .handle("beginImport", (args) =>
          route(args.endpoint.name, AuthOrchestrationOperateScope, args.payload.root, (library) => {
            const { pin, ...payload } = args.payload;
            return beginZoteroImport({ ...payload, ...importTarget(library, pin) });
          }),
        )
        .handle("beginScopedImport", (args) =>
          route(args.endpoint.name, AuthOrchestrationOperateScope, args.payload.root, (library) => {
            const request = args.payload;
            if ("continueRun" in request) {
              return continueZoteroImportRun({
                root: library ? library.library : request.root,
                runId: request.continueRun,
                retryFailed: request.retryFailed === true,
                zotero,
              });
            }
            const { pin, ...payload } = request;
            return beginZoteroScopedImport({ ...payload, ...importTarget(library, pin), zotero });
          }),
        )
        .handle("zoteroRefresh", (args) =>
          route(
            args.endpoint.name,
            AuthOrchestrationOperateScope,
            args.payload.root,
            async (library) => {
              // Asked for by name; or every Zotero source of the project, or of the whole
              // Library when that is what the panel shows.
              const { after, allLibrary } = args.payload;
              const named = args.payload.sourceIds;
              const ids =
                library && (named || !allLibrary)
                  ? await libraryZoteroSourceIds(library, named)
                  : named;
              const which = !ids ? {} : named ? { sourceIds: ids } : { among: ids };
              const result = await refreshZoteroSources({
                root: library ? library.library : args.payload.root,
                ...which,
                ...(after === undefined ? {} : { after }),
                ...(args.payload.connection ? { connection: args.payload.connection } : {}),
                choices: {
                  useZotero: new Set(args.payload.useZotero ?? []),
                  keepLocal: new Set(args.payload.keepLocal ?? []),
                },
                actor: "user",
                zotero,
              });
              if (library) {
                await refreshAfterLibraryChange(
                  library,
                  result.items.flatMap((item) =>
                    item.outcome === "updated" ? [item.sourceId] : [],
                  ),
                );
              }
              return result;
            },
          ),
        )
        .handle("zoteroSend", (args) =>
          route(
            args.endpoint.name,
            AuthOrchestrationOperateScope,
            args.payload.root,
            async (library) =>
              sendSourcesToZotero({
                ...args.payload,
                ...(library
                  ? {
                      root: library.library,
                      sourceIds: await libraryZoteroSourceIds(library, args.payload.sourceIds),
                    }
                  : {}),
                actor: "user",
                zotero,
              }),
          ),
        )
        .handle("advanceImport", (args) =>
          route(args.endpoint.name, AuthOrchestrationOperateScope, args.payload.root, (library) =>
            advanceSourceImport(
              {
                ...args.payload,
                ...(library ? { root: library.library } : {}),
                zotero,
                resolveIdentifier: keyed.resolveIdentifier,
              },
              observeImport,
            ),
          ),
        )
        .handle("cancelImport", (args) =>
          route(args.endpoint.name, AuthOrchestrationOperateScope, args.payload.root, (library) =>
            cancelSourceImport({
              ...args.payload,
              ...(library ? { root: library.library } : {}),
            }),
          ),
        )
        .handle("retryImport", (args) =>
          route(args.endpoint.name, AuthOrchestrationOperateScope, args.payload.root, (library) =>
            retrySourceImport({
              ...args.payload,
              ...(library ? { root: library.library } : {}),
            }),
          ),
        )
        .handle("syncBibliography", (args) =>
          route(args.endpoint.name, AuthOrchestrationOperateScope, args.payload.root, (library) =>
            syncManagedBibliographyWithImports(
              { ...args.payload, ...(library ? { library: library.library } : {}), actor: "user" },
              observeImport,
            ),
          ),
        )
        .handle("citationStyles", (args) =>
          citationStyleCache.pipe(
            Effect.flatMap((deps) =>
              handle(args.endpoint.name, AuthOrchestrationReadScope, () =>
                searchCitationStyles(args.payload, deps),
              ),
            ),
          ),
        )
        .handle("citationStyleSet", (args) =>
          citationStyleCache.pipe(
            Effect.flatMap((deps) =>
              handle(args.endpoint.name, AuthOrchestrationOperateScope, () =>
                setProjectCitationStyle({ ...args.payload, actor: "user" }, deps),
              ),
            ),
          ),
        ),
    );
  }),
);
