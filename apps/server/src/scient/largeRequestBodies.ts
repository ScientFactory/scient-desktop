import * as ByteSize from "effect/ByteSize";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import {
  HttpIncomingMessage,
  HttpRouter,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/http";

/** Scient POSTs whose JSON can exceed T3's 1 MiB API default (`layerApiBodyLimit`). */
const LARGE_BODY_PATHS = new Set([
  // Mermaid PNGs: 12 MiB holds 8 MiB of base64.
  "/api/scient/conversation-export/v1/export",
  "/api/scient/word-export/v1/file",
  // A saved page's metadata, up to 400 entries of 4,000 characters, even fully escaped.
  "/api/scient/sources/pages/save",
]);
const MAX_LARGE_BODY_BYTES = 12 * 1024 * 1024;

/**
 * Reads these bodies once under their own cap, before the API's default applies. The Node
 * request caches the read, so the API builder decodes the same bytes.
 */
export const largeRequestBodyLayer = HttpRouter.middleware(
  (httpEffect) =>
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const pathname = request.url.split("?", 1)[0];
      if (request.method !== "POST" || pathname === undefined || !LARGE_BODY_PATHS.has(pathname)) {
        return yield* httpEffect;
      }
      const maxBytes = MAX_LARGE_BODY_BYTES;
      const declared = request.headers["content-length"];
      if (
        declared !== undefined &&
        (!Number.isSafeInteger(Number(declared)) || Number(declared) > maxBytes)
      ) {
        return HttpServerResponse.text("Request is too large.", { status: 413 });
      }
      // Read here so an oversize stream gets a clean 413 before Builder's
      // decodePayload can turn a body-read error into a die.
      const bounded = yield* Effect.exit(
        Effect.provideService(
          request.text,
          HttpIncomingMessage.MaxBodySize,
          ByteSize.bytes(maxBytes),
        ),
      );
      if (Exit.isFailure(bounded)) {
        return HttpServerResponse.text("Request is too large or unreadable.", {
          status: 413,
        });
      }
      return yield* httpEffect;
    }),
  { global: true },
);
