import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type { HttpClientResponse } from "effect/unstable/http";

type InitialResponse = Pick<HttpClientResponse.HttpClientResponse, "status" | "headers">;
type Publish = (message: string) => void;

export const HTTP_FAILURE_OBSERVATION_PREFIX = "[scient-http-initial-response-failure] ";
export const MAX_HTTP_FAILURE_OBSERVATION_BYTES = 1_024;

const decodeStatus = Schema.decodeUnknownOption(
  Schema.Int.check(Schema.isBetween({ minimum: 100, maximum: 599 })),
);
const decodeContentLength = Schema.decodeUnknownOption(
  Schema.String.check(Schema.isPattern(/^\d{1,20}$/)),
);
const decodeContentType = Schema.decodeUnknownOption(
  Schema.Literals([
    "text/html; charset=utf-8",
    "text/html",
    "text/plain; charset=utf-8",
    "application/javascript",
    "application/octet-stream",
    "application/json",
  ]),
);
const decodeContentEncoding = Schema.decodeUnknownOption(
  Schema.Literals(["identity", "gzip", "br", "deflate", "zstd"]),
);
const decodeCacheControl = Schema.decodeUnknownOption(
  Schema.Literals(["no-cache", "no-store", "public, max-age=31536000, immutable"]),
);
const decodeTransferEncoding = Schema.decodeUnknownOption(Schema.Literals(["chunked", "identity"]));

const projectHeader = (
  value: string | undefined,
  decode: (value: unknown) => Option.Option<string>,
): string | null => (value === undefined ? null : Option.getOrElse(decode(value), () => "other"));

// Only closed scalar categories are emitted; arbitrary header, body and error values are excluded.
export const reportInitialStaticHtmlFailure = (
  response: InitialResponse,
  phase: "body-read" | "assertion",
  decodedBody: string | undefined,
  publish: Publish = console.error,
): void => {
  try {
    const headers = response.headers;
    const observation = {
      phase,
      status: Option.getOrElse(decodeStatus(response.status), () => null),
      headers: {
        contentLength: projectHeader(headers["content-length"], decodeContentLength),
        contentType: projectHeader(headers["content-type"], decodeContentType),
        contentEncoding: projectHeader(headers["content-encoding"], decodeContentEncoding),
        cacheControl: projectHeader(headers["cache-control"], decodeCacheControl),
        transferEncoding: projectHeader(headers["transfer-encoding"], decodeTransferEncoding),
        etagPresent: headers.etag !== undefined,
        lastModifiedPresent: headers["last-modified"] !== undefined,
        locationPresent: headers.location !== undefined,
      },
      // Decoded text size is not a wire byte count or an execution-time filesystem observation.
      decodedBodyUtf8Bytes:
        decodedBody === undefined ? null : Buffer.byteLength(decodedBody, "utf8"),
    };
    const message = HTTP_FAILURE_OBSERVATION_PREFIX + JSON.stringify(observation);
    if (Buffer.byteLength(message, "utf8") <= MAX_HTTP_FAILURE_OBSERVATION_BYTES) publish(message);
  } catch {
    // Diagnostic construction/publication must never replace the deciding failure.
  }
};

export const observeInitialStaticHtmlBody = <E, R>(
  response: InitialResponse,
  body: Effect.Effect<string, E, R>,
  publish?: Publish,
): Effect.Effect<string, E, R> =>
  body.pipe(
    Effect.tapCause(() =>
      Effect.sync(() => reportInitialStaticHtmlFailure(response, "body-read", undefined, publish)),
    ),
  );

export const observeInitialStaticHtmlAssertion = <A>(
  response: InitialResponse,
  decodedBody: string,
  assertion: () => A,
  publish?: Publish,
): A => {
  try {
    return assertion();
  } catch (error) {
    reportInitialStaticHtmlFailure(response, "assertion", decodedBody, publish);
    throw error;
  }
};
