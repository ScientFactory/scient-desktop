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
import { makeSourceImportAnalytics } from "../../telemetry/SourceImportAnalytics.ts";
import { zoteroKeyLookup } from "./ZoteroAccountKey.ts";
import {
  advanceSourceImport,
  beginLocalPdfImport,
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
  preflightZoteroImport,
  refreshScientSourceMetadata,
  deleteSourcesPermanently,
  listSourceRevisions,
  listSourceTrash,
  removeSource,
  restoreSource,
  retrySourceImport,
  revertSource,
  updateScientSource,
  updateSourceNote,
  uploadLocalPdfSource,
} from "./ScientSourcesCoordinator.ts";
import { addScientSourcesByIdentifier } from "./SourceIdentifierAdd.ts";
import {
  beginBibliographyFileImport,
  exportBibliography,
  readBibliographyFile,
} from "./BibliographyFileAdapter.ts";
import { startManagedBibliographySync, syncManagedBibliography } from "./ManagedBibliography.ts";

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

export const scientSourcesHttpApiLayer = HttpApiBuilder.group(
  EnvironmentHttpApi,
  "scientSources",
  Effect.fnUntraced(function* (handlers) {
    const observeImport = yield* makeSourceImportAnalytics("user");
    startManagedBibliographySync();
    const zotero = { webKey: yield* zoteroKeyLookup({ actor: "user" }) };
    return yield* Effect.succeed(
      handlers
        .handle("overview", (args) =>
          handle(args.endpoint.name, AuthOrchestrationReadScope, () =>
            getScientSourcesOverview(args.payload.root),
          ),
        )
        .handle("detail", (args) =>
          handle(args.endpoint.name, AuthOrchestrationReadScope, () =>
            getScientSourceDetail(args.payload),
          ),
        )
        .handle("attachmentPreview", (args) =>
          Effect.gen(function* () {
            yield* annotateEnvironmentRequest(args.endpoint.name);
            yield* requireEnvironmentScope(AuthOrchestrationReadScope);
            const material = yield* sourcesOperation(() =>
              getScientSourceAttachmentPreviewMaterial(args.payload),
            ).pipe(
              Effect.catch((cause) =>
                failEnvironmentInternal("scient_sources_operation_failed", cause),
              ),
            );
            const path = yield* Path.Path;
            const asset = yield* issueAssetUrl({
              resource: {
                _tag: "workspace-file",
                cwd: args.payload.root,
                relativePath: path.relative(args.payload.root, material.absolutePath),
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
          handle(args.endpoint.name, AuthOrchestrationReadScope, () =>
            searchSourceFullText({
              root: args.payload.root,
              query: args.payload.query,
              limit: args.payload.limit ?? 20,
            }),
          ),
        )
        .handle("journalIcon", (args) =>
          Effect.gen(function* () {
            yield* annotateEnvironmentRequest(args.endpoint.name);
            yield* requireEnvironmentScope(AuthOrchestrationReadScope);
            const config = yield* ServerConfig.ServerConfig;
            const path = yield* Path.Path;
            const material = yield* sourcesOperation(() =>
              getScientSourceJournalIconMaterial({
                ...args.payload,
                cacheRoot: path.join(config.stateDir, "scient", "journal-icons", "v1"),
              }),
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
          handle(args.endpoint.name, AuthOrchestrationOperateScope, () =>
            updateScientSource(args.payload),
          ),
        )
        .handle("updateNote", (args) =>
          handle(args.endpoint.name, AuthOrchestrationOperateScope, () =>
            updateSourceNote(args.payload),
          ),
        )
        .handle("refreshMetadata", (args) =>
          handle(args.endpoint.name, AuthOrchestrationOperateScope, () =>
            refreshScientSourceMetadata(args.payload),
          ),
        )
        .handle("remove", (args) =>
          handle(args.endpoint.name, AuthOrchestrationOperateScope, () =>
            removeSource(args.payload),
          ),
        )
        .handle("addByIdentifier", (args) =>
          handle(args.endpoint.name, AuthOrchestrationOperateScope, async () => ({
            results: await addScientSourcesByIdentifier(
              {
                root: args.payload.root,
                entries: args.payload.entries,
                actor: "user",
                enrich: true,
              },
              observeImport,
            ),
          })),
        )
        .handle("trash", (args) =>
          handle(args.endpoint.name, AuthOrchestrationReadScope, () =>
            listSourceTrash(args.payload),
          ),
        )
        .handle("restore", (args) =>
          handle(args.endpoint.name, AuthOrchestrationOperateScope, () =>
            restoreSource(args.payload),
          ),
        )
        .handle("deletePermanently", (args) =>
          handle(args.endpoint.name, AuthOrchestrationOperateScope, () =>
            deleteSourcesPermanently(args.payload),
          ),
        )
        .handle("revisions", (args) =>
          handle(args.endpoint.name, AuthOrchestrationReadScope, () =>
            listSourceRevisions(args.payload),
          ),
        )
        .handle("revert", (args) =>
          handle(args.endpoint.name, AuthOrchestrationOperateScope, () =>
            revertSource(args.payload),
          ),
        )
        .handle("zoteroStatus", (args) =>
          handle(args.endpoint.name, AuthOrchestrationReadScope, () =>
            inspectZoteroConnection({ ...args.payload, zotero }),
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
          handle(args.endpoint.name, AuthOrchestrationReadScope, () =>
            preflightZoteroImport({ ...args.payload, zotero }),
          ),
        )
        .handle("localPdfUpload", (args) =>
          handle(args.endpoint.name, AuthOrchestrationOperateScope, () =>
            uploadLocalPdfSource({
              root: args.payload.root,
              sourcePath: args.payload.file.path,
              fileName: args.payload.file.name,
            }),
          ),
        )
        .handle("localBeginImport", (args) =>
          handle(args.endpoint.name, AuthOrchestrationOperateScope, () =>
            beginLocalPdfImport(args.payload),
          ),
        )
        .handle("localDiscard", (args) =>
          handle(args.endpoint.name, AuthOrchestrationOperateScope, () =>
            discardLocalPdfSources(args.payload),
          ),
        )
        .handle("fileImport", (args) =>
          handle(args.endpoint.name, AuthOrchestrationOperateScope, async () =>
            beginBibliographyFileImport({
              root: args.payload.root,
              operationId: args.payload.operationId,
              fileName: args.payload.file.name,
              text: await readBibliographyFile(args.payload.file.path),
              actor: "user",
            }),
          ),
        )
        .handle("export", (args) =>
          handle(args.endpoint.name, AuthOrchestrationReadScope, () =>
            exportBibliography(args.payload),
          ),
        )
        .handle("beginImport", (args) =>
          handle(args.endpoint.name, AuthOrchestrationOperateScope, () =>
            beginZoteroImport(args.payload),
          ),
        )
        .handle("beginScopedImport", (args) =>
          handle(args.endpoint.name, AuthOrchestrationOperateScope, () =>
            beginZoteroScopedImport({ ...args.payload, zotero }),
          ),
        )
        .handle("advanceImport", (args) =>
          handle(args.endpoint.name, AuthOrchestrationOperateScope, () =>
            advanceSourceImport({ ...args.payload, zotero }, observeImport),
          ),
        )
        .handle("cancelImport", (args) =>
          handle(args.endpoint.name, AuthOrchestrationOperateScope, () =>
            cancelSourceImport(args.payload),
          ),
        )
        .handle("retryImport", (args) =>
          handle(args.endpoint.name, AuthOrchestrationOperateScope, () =>
            retrySourceImport(args.payload),
          ),
        )
        .handle("syncBibliography", (args) =>
          handle(args.endpoint.name, AuthOrchestrationOperateScope, () =>
            syncManagedBibliography(args.payload.root, args.payload),
          ),
        ),
    );
  }),
);
