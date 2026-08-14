import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  EnvironmentHttpApi,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";
import * as Path from "effect/Path";

import {
  annotateEnvironmentRequest,
  failEnvironmentInternal,
  requireEnvironmentScope,
} from "../../auth/http.ts";
import { issueAssetUrl } from "../../assets/AssetAccess.ts";
import * as ServerConfig from "../../config.ts";
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
  removeSource,
  updateScientSource,
  updateSourceNote,
  uploadLocalPdfSource,
} from "./ScientSourcesCoordinator.ts";

function handle<A>(
  endpointName: string,
  scope: typeof AuthOrchestrationReadScope | typeof AuthOrchestrationOperateScope,
  run: () => Promise<A>,
) {
  return Effect.gen(function* () {
    yield* annotateEnvironmentRequest(endpointName);
    yield* requireEnvironmentScope(scope);
    return yield* Effect.tryPromise(run).pipe(
      Effect.catch((cause) => failEnvironmentInternal("scient_sources_operation_failed", cause)),
    );
  });
}

export const scientSourcesHttpApiLayer = HttpApiBuilder.group(
  EnvironmentHttpApi,
  "scientSources",
  Effect.fnUntraced(function* (handlers) {
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
            const material = yield* Effect.tryPromise(() =>
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
            return { ...asset, absolutePath: material.absolutePath };
          }),
        )
        .handle("journalIcon", (args) =>
          Effect.gen(function* () {
            yield* annotateEnvironmentRequest(args.endpoint.name);
            yield* requireEnvironmentScope(AuthOrchestrationReadScope);
            const config = yield* ServerConfig.ServerConfig;
            const path = yield* Path.Path;
            const material = yield* Effect.tryPromise(() =>
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
        .handle("zoteroStatus", (args) =>
          handle(args.endpoint.name, AuthOrchestrationReadScope, () => inspectZoteroConnection()),
        )
        .handle("zoteroLibrary", (args) =>
          handle(args.endpoint.name, AuthOrchestrationReadScope, () =>
            listZoteroLibrary(args.payload),
          ),
        )
        .handle("zoteroCollections", (args) =>
          handle(args.endpoint.name, AuthOrchestrationReadScope, () => listZoteroCollections()),
        )
        .handle("preflight", (args) =>
          handle(args.endpoint.name, AuthOrchestrationReadScope, () =>
            preflightZoteroImport(args.payload),
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
        .handle("beginImport", (args) =>
          handle(args.endpoint.name, AuthOrchestrationOperateScope, () =>
            beginZoteroImport(args.payload),
          ),
        )
        .handle("beginScopedImport", (args) =>
          handle(args.endpoint.name, AuthOrchestrationOperateScope, () =>
            beginZoteroScopedImport(args.payload),
          ),
        )
        .handle("advanceImport", (args) =>
          handle(args.endpoint.name, AuthOrchestrationOperateScope, () =>
            advanceSourceImport(args.payload),
          ),
        )
        .handle("cancelImport", (args) =>
          handle(args.endpoint.name, AuthOrchestrationOperateScope, () =>
            cancelSourceImport(args.payload),
          ),
        ),
    );
  }),
);
