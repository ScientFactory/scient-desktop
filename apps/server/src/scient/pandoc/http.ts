import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  EnvironmentFilePath,
  EnvironmentHttpApi,
  type ScientWordFileExportResult,
} from "@t3tools/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";

import { issueAssetUrl } from "../../assets/AssetAccess.ts";
import {
  annotateEnvironmentRequest,
  failEnvironmentInternal,
  requireEnvironmentScope,
} from "../../auth/http.ts";
import { CONVERSATION_EXPORT_RETENTION } from "../conversationExport/ConversationExportFiles.ts";
import { PandocManagedTool } from "./PandocManagedTool.ts";
import { DOCX_MEDIA_TYPE } from "./PandocWordConverter.ts";
import { WordFileExport } from "./WordFileExport.ts";

/**
 * Word export over HTTP: the managed Pandoc's status and install, and project
 * Markdown files to Word. Reading the tool and exporting only read the
 * project; installing changes this server, so it needs the operate scope. A
 * produced file is returned as a signed asset URL that expires with it.
 */
export const scientWordExportHttpApiLayer = HttpApiBuilder.group(
  EnvironmentHttpApi,
  "scientWordExport",
  Effect.fnUntraced(function* (handlers) {
    const tool = yield* PandocManagedTool;
    const fileExport = yield* WordFileExport;
    const internal = (cause: unknown) =>
      failEnvironmentInternal("scient_word_export_failed", cause);
    return handlers
      .handle("tool", ({ endpoint }) =>
        Effect.gen(function* () {
          yield* annotateEnvironmentRequest(endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationReadScope);
          return yield* tool.status;
        }),
      )
      .handle("installTool", ({ endpoint }) =>
        Effect.gen(function* () {
          yield* annotateEnvironmentRequest(endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationOperateScope);
          return yield* tool.install;
        }),
      )
      .handle("exportFile", ({ endpoint, payload }) =>
        Effect.gen(function* () {
          yield* annotateEnvironmentRequest(endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationReadScope);
          const produced = yield* fileExport
            .export(payload)
            .pipe(Effect.catchTag("ConversationExportFileError", internal));
          const asset = yield* issueAssetUrl({
            resource: {
              _tag: "environment-file",
              path: EnvironmentFilePath.make(produced.path),
              access: "exact",
            },
            expiresInMs: Duration.toMillis(CONVERSATION_EXPORT_RETENTION),
          }).pipe(Effect.catch(internal));
          return {
            file: {
              fileName: produced.fileName,
              mediaType: DOCX_MEDIA_TYPE,
              byteLength: produced.byteLength,
              relativeUrl: asset.relativeUrl,
              expiresAt: asset.expiresAt,
            },
            warnings: produced.warnings,
          } satisfies ScientWordFileExportResult;
        }),
      )
      .handle("exportLatex", ({ endpoint, payload }) =>
        Effect.gen(function* () {
          yield* annotateEnvironmentRequest(endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationReadScope);
          const produced = yield* fileExport
            .exportLatex(payload)
            .pipe(Effect.catchTag("ConversationExportFileError", internal));
          const asset = yield* issueAssetUrl({
            resource: {
              _tag: "environment-file",
              path: EnvironmentFilePath.make(produced.path),
              access: "exact",
            },
            expiresInMs: Duration.toMillis(CONVERSATION_EXPORT_RETENTION),
          }).pipe(Effect.catch(internal));
          return {
            file: {
              fileName: produced.fileName,
              mediaType: DOCX_MEDIA_TYPE,
              byteLength: produced.byteLength,
              relativeUrl: asset.relativeUrl,
              expiresAt: asset.expiresAt,
            },
            warnings: produced.warnings,
          } satisfies ScientWordFileExportResult;
        }),
      );
  }),
);
