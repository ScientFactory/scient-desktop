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
  | { readonly type: "unreachable"; readonly message: string };

const PROBE_REQUEST_ID = 1;

interface JsonRpcInitializeResponse {
  readonly id?: unknown;
  readonly result?: {
    readonly protocolVersion?: unknown;
    readonly serverInfo?: { readonly name?: unknown; readonly version?: unknown };
  };
  readonly error?: unknown;
}

/** A reply candidate, or `undefined` when the data is not JSON. */
const parseReply = (data: string): JsonRpcInitializeResponse | undefined => {
  try {
    const parsed: unknown = JSON.parse(data);
    return typeof parsed === "object" && parsed !== null ? parsed : undefined;
  } catch {
    return undefined;
  }
};

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
      const message = parseReply(data);
      if (message === undefined) return false;
      if (message.id !== PROBE_REQUEST_ID) return true;
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
  try {
    response = await input.fetch(input.url, {
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
    return { type: "unreachable", message: describeEgressFailure(error) };
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
    reply = contentType.includes("text/event-stream")
      ? response.body
        ? await readEventStreamReply(response.body)
        : undefined
      : ((await response.json()) as JsonRpcInitializeResponse);
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
