import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  EnvironmentHttpApi,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";

import {
  annotateEnvironmentRequest,
  failEnvironmentInternal,
  requireEnvironmentScope,
} from "../../auth/http.ts";
import { issueAssetUrl } from "../../assets/AssetAccess.ts";
import {
  advanceSourceImport,
  beginLocalPdfImport,
  beginZoteroImport,
  cancelSourceImport,
  discardLocalPdfSources,
  getScientSourcesOverview,
  getScientSourceAttachmentPreviewMaterial,
  inspectZoteroConnection,
  listZoteroLibrary,
  preflightZoteroImport,
  removeSource,
  updateScientSource,
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
            const asset = yield* issueAssetUrl({
              resource: {
                _tag: "workspace-file",
                threadId: ThreadId.make(`scient-source:${args.payload.attachmentId}`),
                path: material.absolutePath,
              },
              workspaceRoot: args.payload.root,
            }).pipe(
              Effect.catch((cause) =>
                failEnvironmentInternal("scient_sources_operation_failed", cause),
              ),
            );
            return { ...asset, absolutePath: material.absolutePath };
          }),
        )
        .handle("updateMetadata", (args) =>
          handle(args.endpoint.name, AuthOrchestrationOperateScope, () =>
            updateScientSource(args.payload),
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
