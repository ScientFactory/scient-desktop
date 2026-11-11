import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  EnvironmentHttpApi,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import {
  annotateEnvironmentRequest,
  failEnvironmentInternal,
  requireEnvironmentScope,
} from "../../auth/http.ts";
import { issueAssetUrl } from "../../assets/AssetAccess.ts";
import * as ServerConfig from "../../config.ts";
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
  cancelSourceImport,
  discardLocalPdfSources,
  getScientSourcesOverview,
  getScientSourceDetail,
  getScientSourceAttachmentPreviewMaterial,
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
  isLibraryOrganizeAction,
  changeLibraryReview,
  deleteLibrarySourcesPermanently,
  exportLibrarySources,
  libraryAttachmentMaterial,
  libraryImportTarget,
  libraryJournalIconMaterial,
  libraryOverview,
  libraryReview,
  libraryReviews,
  librarySourceDetail,
  librarySourceRevisions,
  libraryTrash,
  libraryZoteroSourceIds,
  organizeLibrarySources,
  pinLibraryIntake,
  refreshAfterLibraryChange,
  refreshLibrarySourceMetadata,
  removeLibrarySource,
  restoreLibrarySource,
  revertLibrarySource,
  updateLibraryProjectNote,
  updateLibrarySourceMetadata,
} from "./LibrarySourcesRoutes.ts";
import { resolveScientLibraryStoreAt, type ScientSourcesLibraryStore } from "./SourcesBackend.ts";

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
    Effect.catch((cause) => failEnvironmentInternal("scient_sources_operation_failed", cause)),
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

export const scientSourcesHttpApiLayer = HttpApiBuilder.group(
  EnvironmentHttpApi,
  "scientSources",
  Effect.fnUntraced(function* (handlers) {
    const observeImport = yield* makeSourceImportAnalytics("user");
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
            // A folder that is not a Scient project yet reports its state as before.
            const library = yield* resolveScientLibraryStoreAt(args.payload.root, "read").pipe(
              Effect.orElseSucceed(() => null),
            );
            return yield* sourcesOperation(() =>
              library
                ? libraryOverview(library, {
                    scope: args.payload.scope ?? "project",
                    background: session.scopes.has(AuthOrchestrationOperateScope),
                  })
                : getScientSourcesOverview(args.payload.root),
            ).pipe(
              Effect.catch((cause) =>
                failEnvironmentInternal("scient_sources_operation_failed", cause),
              ),
            );
          }),
        )
        .handle("detail", (args) =>
          route(args.endpoint.name, AuthOrchestrationReadScope, args.payload.root, (library) =>
            library
              ? librarySourceDetail(library, args.payload)
              : getScientSourceDetail({ root: args.payload.root, sourceId: args.payload.sourceId }),
          ),
        )
        .handle("attachmentPreview", (args) =>
          Effect.gen(function* () {
            yield* annotateEnvironmentRequest(args.endpoint.name);
            yield* requireEnvironmentScope(AuthOrchestrationReadScope);
            const library = yield* libraryFor(args.payload.root, AuthOrchestrationReadScope);
            const material = yield* sourcesOperation(() =>
              library
                ? libraryAttachmentMaterial(library, args.payload)
                : getScientSourceAttachmentPreviewMaterial(args.payload).then((found) => ({
                    ...found,
                    folder: args.payload.root,
                  })),
            ).pipe(
              Effect.catch((cause) =>
                failEnvironmentInternal("scient_sources_operation_failed", cause),
              ),
            );
            const path = yield* Path.Path;
            const { folder } = material;
            const asset = yield* issueAssetUrl({
              resource: {
                _tag: "workspace-file",
                cwd: folder,
                relativePath: path.relative(folder, material.absolutePath),
              },
            }).pipe(
              Effect.catch((cause) =>
                failEnvironmentInternal("scient_sources_operation_failed", cause),
              ),
            );
            const { sha256, byteLength } = material.attachment;
            return /^[0-9a-f]{64}$/u.test(sha256) && byteLength >= 1
              ? { ...asset, material: { sha256, byteLength } }
              : asset;
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
            const cacheRoot = path.join(config.stateDir, "scient", "journal-icons", "v1");
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
          route(
            args.endpoint.name,
            AuthOrchestrationOperateScope,
            args.payload.root,
            async (library) => {
              if (library) return organizeLibrarySources(library, args.payload);
              const { change } = args.payload;
              if (isLibraryOrganizeAction(change)) {
                throw new Error("Pins and merges need the personal Library.");
              }
              return organizeSources({ root: args.payload.root, change, actor: "user" });
            },
          ),
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
                    item.outcome === "imported" || item.outcome === "duplicate"
                      ? item.sourceId
                      : null,
                  ),
                );
              }
              return { results };
            },
          ),
        )
        .handle("trash", (args) =>
          route(args.endpoint.name, AuthOrchestrationReadScope, args.payload.root, (library) =>
            library ? libraryTrash(library) : listSourceTrash(args.payload),
          ),
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
            const { pin, ...payload } = args.payload;
            return beginZoteroScopedImport({ ...payload, ...importTarget(library, pin), zotero });
          }),
        )
        .handle("zoteroRefresh", (args) =>
          route(
            args.endpoint.name,
            AuthOrchestrationOperateScope,
            args.payload.root,
            async (library) => {
              const sourceIds = library
                ? await libraryZoteroSourceIds(library, args.payload.sourceIds)
                : args.payload.sourceIds;
              const result = await refreshZoteroSources({
                root: library ? library.library : args.payload.root,
                ...(sourceIds ? { sourceIds } : {}),
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
              { ...args.payload, ...(library ? { root: library.library } : {}), zotero },
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
        ),
    );
  }),
);
