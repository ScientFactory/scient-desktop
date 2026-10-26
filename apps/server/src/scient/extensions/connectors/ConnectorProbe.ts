// @effect-diagnostics globalDate:off globalTimers:off -- Promise-based MCP transport owns a bounded handshake deadline and backoff.
/**
 * Unauthenticated (or credentialed) MCP `initialize` probe: tells an open server
 * from one that needs OAuth, and reads the `WWW-Authenticate` hints
 * (`resource_metadata`, `scope`) used to start discovery. A session the probe
 * opened is ended with `DELETE`.
 */
import { extractWWWAuthenticateParams } from "@modelcontextprotocol/sdk/client/auth.js";
import { LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/sdk/types.js";

import { type ConnectorFetch, describeEgressFailure } from "./ConnectorOutbound.ts";
import { MAX_SSE_EVENT_BYTES } from "./ConnectorRedaction.ts";
import { makeSseParser, type SseSink } from "./ConnectorSse.ts";

export type ConnectorProbeResult =
  | {
      readonly type: "open";
      readonly serverName: string | undefined;
      readonly serverVersion: string | undefined;
    }
  | {
      readonly type: "auth-required";
      readonly resourceMetadataUrl: URL | undefined;
      readonly scope: string | undefined;
    }
  | { readonly type: "not-an-mcp-server"; readonly message: string }
  | { readonly type: "unreachable"; readonly message: string }
  | { readonly type: "busy"; readonly message: string };

const PROBE_REQUEST_ID = 1;

interface JsonRpcInitializeResponse {
  readonly id?: unknown;
  readonly result?: {
    readonly protocolVersion?: unknown;
    readonly serverInfo?: { readonly name?: unknown; readonly version?: unknown };
  };
  readonly error?: unknown;
}

/** A JSON object, or `undefined` when the data is not one. */
const parseObject = (data: string): object | undefined => {
  try {
    const parsed: unknown = JSON.parse(data);
    return typeof parsed === "object" && parsed !== null ? parsed : undefined;
  } catch {
    return undefined;
  }
};

/**
 * The response to `PROBE_REQUEST_ID`: a server request may reuse that id, so
 * only a message without `method` that carries `result` or `error` answers it.
 */
const isProbeResponse = (message: object): message is JsonRpcInitializeResponse =>
  "id" in message &&
  message.id === PROBE_REQUEST_ID &&
  !("method" in message) &&
  ("result" in message || "error" in message);

/**
 * The first SSE event whose data is the reply to `PROBE_REQUEST_ID`, parsed by
 * the same parser (line endings, event size bound) as the proxy. Data that is
 * not JSON, an oversized event or the end of the stream yields `undefined`.
 */
const readEventStreamReply = async (
  body: ReadableStream<Uint8Array>,
): Promise<JsonRpcInitializeResponse | undefined> => {
  const reader = body.getReader();
  const parser = makeSseParser(MAX_SSE_EVENT_BYTES);
  let reply: JsonRpcInitializeResponse | undefined;
  const sink: SseSink = {
    onEvent: (event) => {
      const data = event.data?.join("\n") ?? "";
      if (data.length === 0) return true;
      const message = parseObject(data);
      if (message === undefined) return false;
      // Server requests and notifications (even with our id) are skipped.
      if (!isProbeResponse(message)) return true;
      reply = message;
      return false;
    },
    onComment: () => undefined,
  };
  try {
    while (true) {
      const { done, value } = await reader.read();
      const feed = done ? parser.end(sink) : parser.push(value, sink);
      if (done || feed !== "continue") return reply;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
};

export const probeConnector = async (input: {
  readonly url: string;
  readonly fetch: ConnectorFetch;
  /** Credential headers for API-key servers; absent for the unauthenticated probe. */
  readonly headers?: Readonly<Record<string, string>>;
}): Promise<ConnectorProbeResult> => {
  let response: Response;
  const started = Date.now();
  const signal = AbortSignal.timeout(5_000);
  let temporary = false;
  for (let attempt = 0; ; attempt++) {
    try {
      response = await input.fetch(input.url, {
        signal,
        method: "POST",
        headers: {
          ...input.headers,
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: PROBE_REQUEST_ID,
          method: "initialize",
          params: {
            protocolVersion: LATEST_PROTOCOL_VERSION,
            capabilities: {},
            clientInfo: { name: "Scient", version: "1" },
          },
        }),
      });
    } catch (error) {
      return temporary
        ? { type: "busy", message: "The service is busy right now." }
        : { type: "unreachable", message: describeEgressFailure(error) };
    }
    temporary =
      response.status === 429 || (response.status === 503 && response.headers.has("retry-after"));
    if (!temporary) break;
    const delay = connectorRetryDelay(
      response.status,
      response.headers.get("retry-after"),
      attempt,
      Date.now(),
      5_000 - (Date.now() - started),
    );
    await response.body?.cancel().catch(() => undefined);
    if (delay === undefined) return { type: "busy", message: "The service is busy right now." };
    await new Promise<void>((resolve) => setTimeout(resolve, delay));
  }
  if (response.status === 401) {
    await response.body?.cancel().catch(() => undefined);
    const { resourceMetadataUrl, scope } = extractWWWAuthenticateParams(response);
    return { type: "auth-required", resourceMetadataUrl, scope };
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    return {
      type: "not-an-mcp-server",
      message: `The server answered the MCP handshake with HTTP ${response.status}.`,
    };
  }
  const sessionId = response.headers.get("mcp-session-id");
  const contentType = response.headers.get("content-type") ?? "";
  let reply: JsonRpcInitializeResponse | undefined;
  try {
    if (contentType.includes("text/event-stream")) {
      reply = response.body ? await readEventStreamReply(response.body) : undefined;
    } else {
      const message = parseObject(await response.text());
      reply = message !== undefined && isProbeResponse(message) ? message : undefined;
    }
  } catch (error) {
    reply = undefined;
    if (error instanceof Error && error.name === "TimeoutError") {
      return { type: "unreachable", message: describeEgressFailure(error) };
    }
  }
  if (sessionId !== null) {
    await input
      .fetch(input.url, {
        method: "DELETE",
        headers: {
          ...input.headers,
          "mcp-session-id": sessionId,
          "mcp-protocol-version": LATEST_PROTOCOL_VERSION,
        },
      })
      .then((deleted) => deleted.body?.cancel())
      .catch(() => undefined);
  }
  const result = reply?.result;
  if (result === undefined || typeof result.protocolVersion !== "string") {
    return {
      type: "not-an-mcp-server",
      message: "The address did not answer like an MCP server.",
    };
  }
  return {
    type: "open",
    serverName: typeof result.serverInfo?.name === "string" ? result.serverInfo.name : undefined,
    serverVersion:
      typeof result.serverInfo?.version === "string" ? result.serverInfo.version : undefined,
  };
};

export function connectorRetryDelay(
  status: number,
  retryAfter: string | null,
  attempt: number,
  now: number,
  remainingMs: number,
): number | undefined {
  if (attempt >= 2 || (status !== 429 && !(status === 503 && retryAfter !== null)))
    return undefined;
  const seconds = retryAfter === null ? NaN : Number(retryAfter);
  const advertised =
    retryAfter === null
      ? NaN
      : Number.isFinite(seconds)
        ? seconds * 1000
        : Date.parse(retryAfter) - now;
  const delay = Number.isFinite(advertised) ? Math.max(0, advertised) : 500 * 2 ** attempt;
  return delay + 250 < remainingMs ? delay : undefined;
}
