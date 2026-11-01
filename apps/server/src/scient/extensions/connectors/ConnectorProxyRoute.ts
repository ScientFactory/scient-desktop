/**
 * This route uses per-session MCP bearer authority rather than environment auth. Require a thread
 * session, delivery to that credential, and a still-live connected/enabled/project grant before
 * forwarding.
 */
import { ConnectorId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";

import * as McpSessionRegistry from "../../../mcp/McpSessionRegistry.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import { CONNECTOR_FORWARDED_REQUEST_HEADERS, ConnectorRuntime } from "../ExtensionsServices.ts";
import { CONNECTOR_MAX_REQUEST_BYTES } from "./ConnectorOutbound.ts";
import { connectorUnavailableResponse } from "./ConnectorRuntime.ts";

const CONNECTOR_PROXY_ROUTE_PREFIX = "/mcp/connectors";

const isConnectorId = Schema.is(ConnectorId);

class RequestTooLarge {
  readonly _tag = "RequestTooLarge";
}

const jsonError = (
  status: number,
  error: string,
  message: string,
  headers?: Record<string, string>,
) =>
  HttpServerResponse.jsonUnsafe(
    { error, message },
    { status, headers: { "cache-control": "no-store", ...headers } },
  );

const readBoundedBody = Effect.fn("ConnectorProxyRoute.readBoundedBody")(function* (
  request: HttpServerRequest.HttpServerRequest,
) {
  const chunks: Uint8Array[] = [];
  let total = 0;
  yield* request.stream.pipe(
    Stream.runForEach((chunk) => {
      total += chunk.byteLength;
      if (total > CONNECTOR_MAX_REQUEST_BYTES) return Effect.fail(new RequestTooLarge());
      chunks.push(chunk);
      return Effect.void;
    }),
  );
  return Buffer.concat(chunks);
});

const handler = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const method = request.method;
  if (method !== "GET" && method !== "POST" && method !== "DELETE") {
    return jsonError(405, "method_not_allowed", "Use GET, POST or DELETE.", {
      allow: "GET, POST, DELETE",
    });
  }
  const url = HttpServerRequest.toURL(request);
  const connectorId = Option.isSome(url)
    ? url.value.pathname.slice(CONNECTOR_PROXY_ROUTE_PREFIX.length + 1)
    : "";
  if (!isConnectorId(connectorId)) {
    return jsonError(404, "connector_not_found", "No connected service exists at this address.");
  }

  const registry = yield* McpSessionRegistry.McpSessionRegistry;
  const authorization = request.headers.authorization;
  const token =
    authorization?.startsWith("Bearer ") === true
      ? authorization.slice("Bearer ".length).trim()
      : "";
  const scope = token.length === 0 ? undefined : yield* registry.resolve(token);
  if (scope === undefined) {
    // No resource_metadata: an agent's dead session token must never start an
    // OAuth flow against Scient (see McpHttpServer `unauthorized`).
    return jsonError(401, "invalid_mcp_credential", "A valid Scient MCP credential is required.", {
      "www-authenticate": token.length === 0 ? "Bearer" : 'Bearer error="invalid_token"',
    });
  }
  if (scope.thread === undefined || scope.connectorIds?.has(connectorId) !== true) {
    return jsonError(
      403,
      "connector_not_delivered",
      "This connected service was not delivered to this agent session.",
    );
  }

  const threads = yield* ThreadManagementService.ThreadManagementService;
  const thread = yield* threads
    .getThreadShell(scope.thread.threadId)
    .pipe(Effect.orElseSucceed(() => null));
  const runtime = yield* ConnectorRuntime;

  let body: Uint8Array | undefined;
  if (method === "POST") {
    const declaredLength = Number(request.headers["content-length"] ?? "0");
    if (declaredLength > CONNECTOR_MAX_REQUEST_BYTES) {
      return jsonError(
        413,
        "request_too_large",
        "MCP requests to connected services are limited to 4 MiB.",
      );
    }
    const read = yield* readBoundedBody(request).pipe(Effect.result);
    if (read._tag === "Failure") {
      return read.failure instanceof RequestTooLarge
        ? jsonError(
            413,
            "request_too_large",
            "MCP requests to connected services are limited to 4 MiB.",
          )
        : jsonError(400, "bad_request", "The request body could not be read.");
    }
    body = read.success;
  }

  const granted =
    thread !== null && (yield* runtime.isGranted({ connectorId, projectId: thread.projectId }));
  if (!granted) {
    // Same shape as a lost upstream grant: a JSON-RPC error for POST, never 401.
    return toServerResponse(
      connectorUnavailableResponse(
        { method, body },
        "This connected service is no longer available to this project. Ask the user to enable it in Scient Settings → Extensions, then retry.",
      ),
    );
  }
  const headers: Record<string, string> = {};
  for (const name of CONNECTOR_FORWARDED_REQUEST_HEADERS) {
    const value = request.headers[name];
    if (value !== undefined) headers[name] = value;
  }
  yield* registry.touch(scope.thread.threadId);
  const response = yield* runtime.forward({ connectorId, method, headers, body, scope });
  return toServerResponse(response);
});

const toServerResponse = (response: {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Stream.Stream<Uint8Array>;
}) => {
  const headers: Record<string, string> = {
    ...response.headers,
    "cache-control": "no-store, no-transform",
  };
  if (response.status === 202 || response.status === 204) {
    return HttpServerResponse.empty({ status: response.status, headers });
  }
  return HttpServerResponse.stream(response.body, {
    status: response.status,
    headers,
    ...(headers["content-type"] === undefined ? {} : { contentType: headers["content-type"] }),
  });
};

export const layer = HttpRouter.add("*", `${CONNECTOR_PROXY_ROUTE_PREFIX}/*`, handler);
