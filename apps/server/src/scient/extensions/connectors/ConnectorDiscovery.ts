/**
 * What an agent learns when it asks a connector what it offers. A connector that stopped working
 * answers discovery as a server with no tools that says why (some agents end the whole turn when
 * one server fails to initialize); a hosted connector's tools name their host.
 */
import { requestIdToken } from "./ConnectorRedaction.ts";

/** The only protocol versions passed back to the agent; anything else is dropped. */
export const KNOWN_PROTOCOL_VERSIONS: Readonly<Record<string, true>> = {
  "2024-11-05": true,
  "2025-03-26": true,
  "2025-06-18": true,
  "2025-11-25": true,
};
const LATEST_PROTOCOL_VERSION = "2025-11-25";

/** Who runs a hosted connector, and so sees what passes through it. */
export const connectorHostOf = (url: string): string | undefined =>
  URL.canParse(url) ? new URL(url).host : undefined;

/** The one JSON-RPC message an agent sent: its method, raw id text, and requested version. */
export interface DiscoveryRequest {
  readonly method: string;
  /** The id exactly as the agent wrote it; undefined for a notification. */
  readonly idToken: string | undefined;
  readonly protocolVersion?: string;
}

/** The single request or notification in a POST body; undefined for batches and non-JSON. */
export const discoveryRequestOf = (body: Uint8Array | undefined): DiscoveryRequest | undefined => {
  if (body === undefined) return undefined;
  const text = new TextDecoder().decode(body);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
  if (!("method" in parsed) || typeof parsed.method !== "string") return undefined;
  const params = "params" in parsed ? parsed.params : undefined;
  const protocolVersion =
    typeof params === "object" &&
    params !== null &&
    "protocolVersion" in params &&
    typeof params.protocolVersion === "string"
      ? params.protocolVersion
      : undefined;
  return {
    method: parsed.method,
    idToken: "id" in parsed ? requestIdToken(text) : undefined,
    ...(protocolVersion === undefined ? {} : { protocolVersion }),
  };
};

const EMPTY_LISTS: Readonly<Record<string, string>> = {
  "tools/list": `{"tools":[]}`,
  "resources/list": `{"resources":[]}`,
  "resources/templates/list": `{"resourceTemplates":[]}`,
  "prompts/list": `{"prompts":[]}`,
  ping: `{}`,
};

const initializeResult = (request: DiscoveryRequest, reason: string) =>
  JSON.stringify({
    protocolVersion:
      request.protocolVersion !== undefined && KNOWN_PROTOCOL_VERSIONS[request.protocolVersion]
        ? request.protocolVersion
        : LATEST_PROTOCOL_VERSION,
    capabilities: { tools: { listChanged: false } },
    serverInfo: { name: "scient-connector-unavailable", version: "1" },
    instructions: `${reason} It offers no tools in this chat.`,
  });

/** The empty server's answer to an initialize or list request; undefined for other methods. */
const emptyServerJson = (
  request: DiscoveryRequest & { readonly idToken: string },
  reason: string,
) => {
  const result =
    request.method === "initialize"
      ? initializeResult(request, reason)
      : EMPTY_LISTS[request.method];
  return result === undefined
    ? undefined
    : `{"jsonrpc":"2.0","id":${request.idToken},"result":${result}}`;
};

/**
 * How an unavailable connector answers a discovery message: 202 for a notification, an empty
 * server for initialize and list calls; undefined for anything else (a tool call stays refused).
 */
export const unavailableDiscoveryAnswer = (
  request: DiscoveryRequest | undefined,
  reason: string,
): { readonly status: 202 } | { readonly status: 200; readonly json: string } | undefined => {
  if (request === undefined) return undefined;
  const { idToken } = request;
  if (idToken === undefined) return { status: 202 };
  const json = emptyServerJson({ ...request, idToken }, reason);
  return json === undefined ? undefined : { status: 200, json };
};

const hostNote = (host: string) => `Hosted by ${host}.`;

const withHost = (tools: unknown, host: string): unknown =>
  Array.isArray(tools)
    ? tools.map((tool) => {
        if (typeof tool !== "object" || tool === null) return tool;
        const description =
          "description" in tool && typeof tool.description === "string" ? tool.description : "";
        if (description.includes(hostNote(host))) return tool;
        return {
          ...tool,
          description: description === "" ? hostNote(host) : `${description} (${hostNote(host)})`,
        };
      })
    : tools;

/**
 * Finishes each answer to an agent's discovery request (one JSON-RPC document at a time, after
 * redaction): an error to initialize or a list becomes the empty server, and a hosted connector's
 * tools name their host. Other requests and documents pass unchanged.
 */
export const discoveryFinisher = (
  request: DiscoveryRequest | undefined,
  options: { readonly displayName: string; readonly host?: string | undefined },
): ((document: string) => string) | undefined => {
  if (request?.idToken === undefined) return undefined;
  if (request.method !== "initialize" && !(request.method in EMPTY_LISTS)) return undefined;
  const { idToken } = request;
  return (document) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(document);
    } catch {
      return document;
    }
    if (typeof parsed !== "object" || parsed === null || !("id" in parsed)) return document;
    if ("error" in parsed && !("result" in parsed)) {
      const error = parsed.error;
      const reason =
        typeof error === "object" && error !== null && "message" in error
          ? String(error.message)
          : `${options.displayName} did not answer.`;
      return emptyServerJson({ ...request, idToken }, reason) ?? document;
    }
    if (
      request.method !== "tools/list" ||
      options.host === undefined ||
      !("result" in parsed) ||
      typeof parsed.result !== "object" ||
      parsed.result === null ||
      !("tools" in parsed.result)
    )
      return document;
    const result = { ...parsed.result, tools: withHost(parsed.result.tools, options.host) };
    return `{"jsonrpc":"2.0","id":${idToken},"result":${JSON.stringify(result)}}`;
  };
};
