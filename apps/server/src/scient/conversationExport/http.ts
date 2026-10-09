import {
  AuthOrchestrationReadScope,
  EnvironmentFilePath,
  EnvironmentHttpApi,
  type ScientConversationExportResult,
} from "@t3tools/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";

import { issueAssetUrl } from "../../assets/AssetAccess.ts";
import {
  annotateEnvironmentRequest,
  failEnvironmentInternal,
  requireEnvironmentScope,
} from "../../auth/http.ts";
import { CONVERSATION_EXPORT_RETENTION } from "./ConversationExportFiles.ts";
import { ConversationExportService } from "./ConversationExportService.ts";

/**
 * Conversation export over HTTP. Both endpoints only read the conversation;
 * a produced file is returned as a signed asset URL that expires with the
 * temporary export.
 */
export const scientConversationExportHttpApiLayer = HttpApiBuilder.group(
  EnvironmentHttpApi,
  "scientConversationExport",
  Effect.fnUntraced(function* (handlers) {
    const exports = yield* ConversationExportService;
    const internal = (cause: unknown) =>
      failEnvironmentInternal("scient_conversation_export_failed", cause);
    return handlers
      .handle("prepare", ({ endpoint, payload }) =>
        Effect.gen(function* () {
          yield* annotateEnvironmentRequest(endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationReadScope);
          return yield* exports.prepare(payload.threadId).pipe(
            Effect.catchTags({
              ConversationSnapshotReadError: internal,
              ConversationExportFileError: internal,
            }),
          );
        }),
      )
      .handle("prepareWordDiagrams", ({ endpoint, payload }) =>
        Effect.gen(function* () {
          yield* annotateEnvironmentRequest(endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationReadScope);
          return yield* exports.prepareWordDiagrams(payload).pipe(
            Effect.catchTags({
              ConversationSnapshotReadError: internal,
              ConversationExportFileError: internal,
            }),
          );
        }),
      )
      .handle("export", ({ endpoint, payload }) =>
        Effect.gen(function* () {
          yield* annotateEnvironmentRequest(endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationReadScope);
          const produced = yield* exports.produce(payload).pipe(
            Effect.catchTags({
              ConversationSnapshotReadError: internal,
              ConversationExportFileError: internal,
            }),
          );
          const base = {
            exportId: produced.exportId,
            format: produced.format,
            contentDigest: produced.contentDigest,
            messageCount: produced.messageCount,
            warnings: produced.warnings,
          };
          if (produced.output._tag === "text") {
            return {
              ...base,
              file: null,
              text: produced.output.text,
            } satisfies ScientConversationExportResult;
          }
          const asset = yield* issueAssetUrl({
            resource: {
              _tag: "environment-file",
              path: EnvironmentFilePath.make(produced.output.path),
              access: "exact",
            },
            expiresInMs: Duration.toMillis(CONVERSATION_EXPORT_RETENTION),
          }).pipe(Effect.catch(internal));
          return {
            ...base,
            file: {
              fileName: produced.output.fileName,
              mediaType: produced.output.mediaType,
              byteLength: produced.output.byteLength,
              relativeUrl: asset.relativeUrl,
              expiresAt: asset.expiresAt,
            },
            text: null,
          } satisfies ScientConversationExportResult;
        }),
      );
  }),
);
