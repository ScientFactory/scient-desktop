import * as ByteSize from "effect/ByteSize";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import {
  HttpIncomingMessage,
  HttpRouter,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/unstable/http";

/** Effect's default body limit is unlimited. Apply a preparse cap only to the
 * two POSTs that can carry Mermaid PNGs: 12 MiB holds 8 MiB of base64 PNGs. */
export const wordDiagramRequestBodyLayer = HttpRouter.middleware(
  (httpEffect) =>
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const pathname = request.url.split("?", 1)[0];
      if (
        request.method !== "POST" ||
        (pathname !== "/api/scient/conversation-export/v1/export" &&
          pathname !== "/api/scient/word-export/v1/file")
      ) {
        return yield* httpEffect;
      }
      const maxBytes = 12 * 1024 * 1024;
      const declared = request.headers["content-length"];
      if (
        declared !== undefined &&
        (!Number.isSafeInteger(Number(declared)) || Number(declared) > maxBytes)
      ) {
        return HttpServerResponse.text("Word export request is too large.", { status: 413 });
      }
      // The Node request caches its bounded text read; the API builder then
      // decodes those same bytes. Read here so an oversize stream gets a clean
      // 413 before Builder's decodePayload can turn a body-read error into a die.
      const bounded = yield* Effect.exit(
        Effect.provideService(
          request.text,
          HttpIncomingMessage.MaxBodySize,
          ByteSize.bytes(maxBytes),
        ),
      );
      if (Exit.isFailure(bounded)) {
        return HttpServerResponse.text("Word export request is too large or unreadable.", {
          status: 413,
        });
      }
      return yield* httpEffect;
    }),
  { global: true },
);
