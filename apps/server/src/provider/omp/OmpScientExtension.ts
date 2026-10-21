import { ompExtensionBootstrapPrelude } from "./OmpExtensionBootstrap.ts";
import type { OmpTarget } from "./OmpTarget.ts";

/** A connector the extension proxies, through Scient's connector endpoint. */
export interface OmpScientExtensionConnector {
  /** Unique `[a-z0-9_-]{1,48}` name; prefixes the connector's tool names. */
  readonly serverName: string;
  /** Shown to the user in tool errors and `/scient-status`. */
  readonly displayName: string;
  /** Scient's proxy endpoint for this connector; takes the session's bearer. */
  readonly url: string;
}

/** What Scient's OMP extension reads from its bootstrap file. */
export interface OmpScientExtensionBootstrap {
  /** This conversation's Scient MCP endpoint, when it has a tool session. */
  readonly endpoint: string | null;
  /** The session's MCP bearer header. */
  readonly authorization: string | null;
  /** Appended to OMP's system prompt; empty for none. */
  readonly awareness: string;
  /** The session's connectors; absent when it has none. */
  readonly connectors?: ReadonlyArray<OmpScientExtensionConnector>;
}

/**
 * The extension body. It proxies the conversation's Scient MCP tools into
 * OMP and appends Scient's awareness to the system prompt, like Pi's
 * `PiScientExtension`, with OMP's differences written out:
 *
 * - OMP presents extension tools as `discoverable` unless they declare a load
 *   mode, which hides them from the model's top-level tool list, so every
 *   tool is `essential`.
 * - OMP's `before_agent_start` passes `systemPrompt` as `string[]` and treats
 *   a returned prompt as the whole replacement, so awareness is appended as
 *   one more element, and the prompt is left alone when there is none.
 * - The MCP connection is made once per OMP process and shared with the
 *   extension's re-runs for in-process subagents, which register the same
 *   tools on their own sessions.
 *
 * Connectors are proxied the same way, each over its own Scient connector
 * endpoint with the session's bearer. OMP's extension API has no MCP server
 * registration, so each connector tool is registered as
 * `<serverName>__<tool>`, with the tool reduced to the characters model APIs
 * accept and a leading `_` when the name would not start with a letter or
 * underscore. A name over 64 characters or already taken (Scient's own tools
 * register first, then connectors in delivered order) becomes its first 55
 * characters, `_`, and the first 8 hex digits of SHA-256 of
 * `<serverName>\0<tool>`; a tool whose alias is also taken, or whose name
 * enters OMP's native `mcp__` namespace, is skipped. Calls always use the
 * connector's own tool name. A connector that fails to connect within its
 * deadline contributes no tools and leaves Scient's tools and the other
 * connectors untouched.
 */
const ompScientExtensionBody = (target: OmpTarget): string => `
import { createHash as scientCreateHash } from "node:crypto";

const scientRecord = (value) =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? value : undefined;

const scientConnect = async (endpoint, authorization, label, connectSignal) => {
  if (!endpoint || !authorization) return { tools: [], request: undefined };
  let nextId = 0;
  let sessionId;
  let protocolVersion = "2025-06-18";
  const request = async (method, params, signal, notification = false) => {
    const id = ++nextId;
    const timeout = AbortSignal.timeout(180_000);
    const response = await fetch(endpoint, {
      method: "POST",
      redirect: "error",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization,
        "mcp-protocol-version": protocolVersion,
        ...(sessionId ? { "mcp-session-id": sessionId } : {}),
      },
      body: JSON.stringify({ jsonrpc: "2.0", ...(notification ? {} : { id }), method, params }),
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
    if (!response.ok) throw new Error(label + " tool connection returned HTTP " + response.status + ".");
    const receivedSession = response.headers.get("mcp-session-id");
    if (receivedSession) sessionId = receivedSession;
    if (notification) {
      await response.body?.cancel();
      return undefined;
    }
    if (!response.body) throw new Error(label + " tool connection returned an empty response.");
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const sse = response.headers.get("content-type")?.includes("text/event-stream") === true;
    const lineBreak = /\\r\\n|\\r|\\n/gu;
    let buffer = "";
    let bytes = 0;
    // A CR ends its line at once; an LF arriving next completes the same CRLF.
    let skipLf = false;
    let data = [];
    const result = (json) => {
      const envelope = scientRecord(JSON.parse(json));
      if (envelope?.id !== id) return undefined;
      if (envelope.error) throw new Error(label + " rejected the tool request.");
      return { value: envelope.result };
    };
    // A blank line completes an event; only data fields carry the message.
    const consume = (line) => {
      if (line.length === 0) {
        const json = data.join("\\n");
        data = [];
        return json ? result(json) : undefined;
      }
      const colon = line.indexOf(":");
      if ((colon === -1 ? line : line.slice(0, colon)) !== "data") return undefined;
      const value = colon === -1 ? "" : line.slice(colon + 1);
      data.push(value.startsWith(" ") ? value.slice(1) : value);
      return undefined;
    };
    try {
      while (true) {
        const chunk = await reader.read();
        bytes += chunk.value?.byteLength ?? 0;
        if (bytes > 16 * 1024 * 1024) throw new Error(label + " tool response exceeded its size limit.");
        let text = decoder.decode(chunk.value, { stream: !chunk.done });
        if (sse) {
          if (skipLf && text.length > 0) {
            skipLf = false;
            if (text.startsWith("\\n")) text = text.slice(1);
          }
          buffer += text;
          let start = 0;
          lineBreak.lastIndex = 0;
          for (let match = lineBreak.exec(buffer); match !== null; match = lineBreak.exec(buffer)) {
            const parsed = consume(buffer.slice(start, match.index));
            start = lineBreak.lastIndex;
            if (parsed) return parsed.value;
          }
          if (start > 0 && start === buffer.length && buffer.endsWith("\\r")) skipLf = true;
          buffer = buffer.slice(start);
          if (chunk.done) {
            // Accept a final event whose closing blank line never arrived.
            const parsed = consume(buffer) ?? consume("");
            if (parsed) return parsed.value;
          }
        } else buffer += text;
        if (chunk.done) break;
      }
      if (!sse) {
        const parsed = result(buffer);
        if (parsed) return parsed.value;
      }
      throw new Error(label + " tool response did not match its request.");
    } finally {
      await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
  };

  const initialized = scientRecord(
    await request(
      "initialize",
      {
        protocolVersion,
        capabilities: {},
        clientInfo: { name: "scient-omp", version: "1" },
      },
      connectSignal,
    ),
  );
  if (typeof initialized?.protocolVersion === "string") protocolVersion = initialized.protocolVersion;
  await request("notifications/initialized", {}, connectSignal, true);
  const tools = [];
  let cursor;
  const seen = new Set();
  for (let page = 0; page < 100; page++) {
    const listed = scientRecord(await request("tools/list", cursor ? { cursor } : {}, connectSignal));
    if (!Array.isArray(listed?.tools)) throw new Error(label + " returned an invalid tool catalog.");
    for (const value of listed.tools) {
      const tool = scientRecord(value);
      const parameters = scientRecord(tool?.inputSchema);
      if (typeof tool?.name !== "string" || !parameters || tools.some((known) => known.name === tool.name))
        throw new Error(label + " returned an invalid or duplicate tool.");
      tools.push({
        name: tool.name,
        description: typeof tool.description === "string" ? tool.description : tool.name,
        parameters,
      });
    }
    cursor = typeof listed.nextCursor === "string" ? listed.nextCursor : undefined;
    if (!cursor) break;
    if (seen.has(cursor) || page === 99) throw new Error(label + " tool catalog pagination did not finish.");
    seen.add(cursor);
  }
  return { tools, request };
};

/** The tool's model-facing name, or undefined when none is usable. */
const scientConnectorToolName = (serverName, toolName, taken) => {
  let name = serverName + "__" + toolName.replace(/[^A-Za-z0-9_-]/gu, "_");
  if (!/^[A-Za-z_]/u.test(name)) name = "_" + name;
  // An alias keeps the name's first 55 characters, so it stays in OMP's namespace too.
  if (name.startsWith("mcp__")) return undefined;
  if (name.length <= 64 && !taken.has(name)) return name;
  const digest = scientCreateHash("sha256").update(serverName + "\\u0000" + toolName).digest("hex");
  const alias = name.slice(0, 55) + "_" + digest.slice(0, 8);
  return taken.has(alias) ? undefined : alias;
};

const scientConnectors = (value) =>
  Array.isArray(value)
    ? value.flatMap((entry) => {
        const connector = scientRecord(entry);
        if (typeof connector?.serverName !== "string" || typeof connector.url !== "string") return [];
        const displayName =
          typeof connector.displayName === "string" && connector.displayName
            ? connector.displayName
            : connector.serverName;
        return [{ serverName: connector.serverName, displayName, url: connector.url }];
      })
    : [];

const scientToolResult = (output, label) => {
  if (!output || !Array.isArray(output.content)) throw new Error(label + " returned an invalid tool result.");
  const content = [];
  for (const value of output.content) {
    const part = scientRecord(value);
    if (part?.type === "text" && typeof part.text === "string") content.push({ type: "text", text: part.text });
    else if (part?.type === "image" && typeof part.data === "string" && typeof part.mimeType === "string")
      content.push({ type: "image", data: part.data, mimeType: part.mimeType });
    else content.push({ type: "text", text: JSON.stringify(value) });
  }
  // MCP content is the model-facing projection when present. Keep
  // structuredContent only as a fallback for structured-only tools.
  if (content.length === 0 && output.structuredContent !== undefined)
    content.push({ type: "text", text: JSON.stringify(output.structuredContent) });
  if (output.isError === true) content.unshift({ type: "text", text: label + " tool reported an error:" });
  return { content, details: output };
};

export default async function scientOmpExtension(pi) {
  const shared = scientOnce((bootstrap) => ({
    awareness: typeof bootstrap.awareness === "string" ? bootstrap.awareness : "",
    connection: scientConnect(bootstrap.endpoint, bootstrap.authorization, "Scient"),
    connectors: scientConnectors(bootstrap.connectors).map((connector) => {
      const label = "Connector " + JSON.stringify(connector.displayName);
      return scientConnect(connector.url, bootstrap.authorization, label, AbortSignal.timeout(30_000)).then(
        ({ tools, request }) => ({ ...connector, label, connected: true, tools, request }),
        () => ({ ...connector, label, connected: false, tools: [], request: undefined }),
      );
    }),
  }));
  const { awareness } = shared;
  const [{ tools, request }, connectors] = await Promise.all([
    shared.connection,
    Promise.all(shared.connectors),
  ]);
  const proxied = tools.map((tool) => ({ ...tool, remoteName: tool.name, label: "Scient", request }));
  const skipped = new Map();
  const taken = new Set(proxied.map((tool) => tool.name));
  for (const connector of connectors) {
    for (const tool of connector.tools) {
      const name = scientConnectorToolName(connector.serverName, tool.name, taken);
      if (name === undefined) {
        skipped.set(connector.serverName, (skipped.get(connector.serverName) ?? 0) + 1);
        continue;
      }
      taken.add(name);
      proxied.push({ ...tool, name, remoteName: tool.name, label: connector.label, request: connector.request });
    }
  }
  const toolNames = proxied.map((tool) => tool.name);
  for (const tool of proxied) {
    const { name, remoteName, label, request: call } = tool;
    pi.registerTool({
      name,
      label: name,
      loadMode: "essential",
      description: tool.description,
      parameters: tool.parameters,
      async execute(_id, args, signal) {
        return scientToolResult(
          scientRecord(await call("tools/call", { name: remoteName, arguments: args }, signal)),
          label,
        );
      },
    });
  }
  pi.on("tool_result", (event) => {
    if (toolNames.includes(event.toolName) && scientRecord(event.details)?.isError === true)
      return { isError: true };
    return undefined;
  });
  pi.on("before_agent_start", (event) => ({
    systemPrompt: awareness ? [...event.systemPrompt, awareness] : undefined,
  }));
  const status =
    "Scient connected: " + tools.length + " tools. Full access; no native sandbox." +
    connectors
      .map((connector) => {
        if (!connector.connected) return " " + connector.displayName + ": unavailable.";
        const omitted = skipped.get(connector.serverName) ?? 0;
        return (
          " " + connector.displayName + ": " + (connector.tools.length - omitted) + " tools" +
          (omitted > 0 ? " (" + omitted + " omitted: name unusable)" : "") + "."
        );
      })
      .join("");
  pi.registerCommand("scient-status", {
    description: ${JSON.stringify(`Show the Scient connection for this ${target.name} session`)},
    async handler(_args, ctx) {
      ctx.ui.notify(status, "info");
    },
  });
}
`;

/** Module source of Scient's OMP extension, reading `bootstrapPath`. */
export const ompScientExtensionSource = (target: OmpTarget, bootstrapPath: string): string =>
  `${ompExtensionBootstrapPrelude(target, bootstrapPath)}${ompScientExtensionBody(target)}`;
