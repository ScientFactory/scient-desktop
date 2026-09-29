/**
 * Conversation import over HTTP: the `scientConversationImport` group
 * (create-upload, preview, import, cancel) and the signed upload route the
 * file itself streams through. Every endpoint requires
 * `SCIENT_CONVERSATION_IMPORT_REQUIRED_SCOPE`; the upload route is authorized
 * by its signed, single-use URL, which only `createUpload` issues.
 */
import { EnvironmentHttpApi, SCIENT_CONVERSATION_IMPORT_REQUIRED_SCOPE } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";

import {
  annotateEnvironmentRequest,
  failEnvironmentInternal,
  requireEnvironmentScope,
} from "../../auth/http.ts";
import {
  CONVERSATION_IMPORT_UPLOAD_ROUTE_PREFIX,
  ConversationImportStaging,
} from "./ConversationImportStaging.ts";

export const scientConversationImportHttpApiLayer = HttpApiBuilder.group(
  EnvironmentHttpApi,
  "scientConversationImport",
  Effect.fnUntraced(function* (handlers) {
    const staging = yield* ConversationImportStaging;
    const internal = (cause: unknown) =>
      failEnvironmentInternal("scient_conversation_import_failed", cause);
    const authorize = (name: string) =>
      annotateEnvironmentRequest(name).pipe(
        Effect.andThen(requireEnvironmentScope(SCIENT_CONVERSATION_IMPORT_REQUIRED_SCOPE)),
      );
    return handlers
      .handle("createUpload", ({ endpoint, payload }) =>
        authorize(endpoint.name).pipe(
          Effect.andThen(staging.createUpload(payload)),
          Effect.catchTag("ConversationImportStagingFailure", internal),
        ),
      )
      .handle("preview", ({ endpoint, payload }) =>
        authorize(endpoint.name).pipe(
          Effect.andThen(staging.preview(payload.importId)),
          Effect.catchTag("ConversationImportStagingFailure", internal),
        ),
      )
      .handle("import", ({ endpoint, payload }) =>
        Effect.gen(function* () {
          const principal = yield* authorize(endpoint.name);
          return yield* staging.confirm(payload, principal);
        }).pipe(Effect.catchTag("ConversationImportStagingFailure", internal)),
      )
      .handle("cancel", ({ endpoint, payload }) =>
        authorize(endpoint.name).pipe(
          Effect.andThen(staging.cancel(payload.importId)),
          Effect.catchTag("ConversationImportStagingFailure", internal),
        ),
      );
  }),
);

/**
 * Receives the bytes of a `.scic` for an import `createUpload` admitted. The
 * staging service is captured when the route is built, so requests need
 * nothing from the request context beyond the request itself.
 */
export const conversationImportUploadRouteLayer = Layer.unwrap(
  Effect.gen(function* () {
    const staging = yield* ConversationImportStaging;
    return HttpRouter.add(
      "POST",
      `${CONVERSATION_IMPORT_UPLOAD_ROUTE_PREFIX}/*`,
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const url = HttpServerRequest.toURL(request);
        if (Option.isNone(url)) return HttpServerResponse.text("Bad Request", { status: 400 });
        const token = url.value.pathname.slice(
          `${CONVERSATION_IMPORT_UPLOAD_ROUTE_PREFIX}/`.length,
        );
        const claims = token ? yield* staging.validateUploadToken(token) : null;
        if (!claims) return HttpServerResponse.text("Not Found", { status: 404 });
        const contentLength = request.headers["content-length"];
        if (
          contentLength !== undefined &&
          (!Number.isInteger(Number(contentLength)) || Number(contentLength) !== claims.sizeBytes)
        ) {
          return HttpServerResponse.text("Content-Length must match the upload size.", {
            status: 400,
          });
        }
        // Keep the request stream in the route scope until the response is sent.
        const bodyPull = yield* Stream.toPull(request.stream);
        const stored = yield* staging.receiveUpload(
          claims,
          Stream.fromPull(Effect.succeed(bodyPull)),
        );
        return stored.ok
          ? HttpServerResponse.empty({ status: 204 })
          : HttpServerResponse.text(stored.detail, { status: stored.status });
      }),
    );
  }),
);
