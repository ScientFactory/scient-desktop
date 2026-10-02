import { ompExtensionBootstrapPrelude } from "./OmpExtensionBootstrap.ts";
import type { OmpTarget } from "./OmpTarget.ts";

/** What Scient's OMP extension reads from its bootstrap file. */
export interface OmpScientExtensionBootstrap {
  /** This conversation's Scient MCP endpoint, when it has a tool session. */
  readonly endpoint: string | null;
  /** The session's MCP bearer header. */
  readonly authorization: string | null;
  /** Appended to OMP's system prompt; empty for none. */
  readonly awareness: string;
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
 */
const ompScientExtensionBody = (target: OmpTarget): string => `
const scientRecord = (value) =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? value : undefined;

const scientConnect = async (endpoint, authorization) => {
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
    if (!response.ok) throw new Error("Scient tool connection returned HTTP " + response.status + ".");
    const receivedSession = response.headers.get("mcp-session-id");
    if (receivedSession) sessionId = receivedSession;
    if (notification) {
      await response.body?.cancel();
      return undefined;
    }
    if (!response.body) throw new Error("Scient tool connection returned an empty response.");
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const sse = response.headers.get("content-type")?.includes("text/event-stream") === true;
    let buffer = "";
    let bytes = 0;
    const result = (json) => {
      const envelope = scientRecord(JSON.parse(json));
      if (envelope?.id !== id) return undefined;
      if (envelope.error) throw new Error("Scient rejected the tool request.");
      return { value: envelope.result };
    };
    try {
      while (true) {
        const chunk = await reader.read();
        bytes += chunk.value?.byteLength ?? 0;
        if (bytes > 16 * 1024 * 1024) throw new Error("Scient tool response exceeded its size limit.");
        buffer += decoder.decode(chunk.value, { stream: !chunk.done });
        if (sse) {
          let boundary;
          while ((boundary = /\\r?\\n\\r?\\n/u.exec(buffer)) !== null) {
            const frame = buffer.slice(0, boundary.index);
            buffer = buffer.slice(boundary.index + boundary[0].length);
            const data = frame
              .split(/\\r?\\n/u)
              .filter((line) => line.startsWith("data:"))
              .map((line) => line.slice(5).replace(/^ /u, ""))
              .join("\\n");
            if (data) {
              const parsed = result(data);
              if (parsed) return parsed.value;
            }
          }
        }
        if (chunk.done) break;
      }
      if (!sse) {
        const parsed = result(buffer);
        if (parsed) return parsed.value;
      }
      throw new Error("Scient tool response did not match its request.");
    } finally {
      await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
  };

  const initialized = scientRecord(
    await request("initialize", {
      protocolVersion,
      capabilities: {},
      clientInfo: { name: "scient-omp", version: "1" },
    }),
  );
  if (typeof initialized?.protocolVersion === "string") protocolVersion = initialized.protocolVersion;
  await request("notifications/initialized", {}, undefined, true);
  const tools = [];
  let cursor;
  const seen = new Set();
  for (let page = 0; page < 100; page++) {
    const listed = scientRecord(await request("tools/list", cursor ? { cursor } : {}));
    if (!Array.isArray(listed?.tools)) throw new Error("Scient returned an invalid tool catalog.");
    for (const value of listed.tools) {
      const tool = scientRecord(value);
      const parameters = scientRecord(tool?.inputSchema);
      if (typeof tool?.name !== "string" || !parameters || tools.some((known) => known.name === tool.name))
        throw new Error("Scient returned an invalid or duplicate tool.");
      tools.push({
        name: tool.name,
        description: typeof tool.description === "string" ? tool.description : tool.name,
        parameters,
      });
    }
    cursor = typeof listed.nextCursor === "string" ? listed.nextCursor : undefined;
    if (!cursor) break;
    if (seen.has(cursor) || page === 99) throw new Error("Scient tool catalog pagination did not finish.");
    seen.add(cursor);
  }
  return { tools, request };
};

const scientToolResult = (output) => {
  if (!output || !Array.isArray(output.content)) throw new Error("Scient returned an invalid tool result.");
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
  if (output.isError === true) content.unshift({ type: "text", text: "Scient tool reported an error:" });
  return { content, details: output };
};

export default async function scientOmpExtension(pi) {
  const shared = scientOnce((bootstrap) => ({
    awareness: typeof bootstrap.awareness === "string" ? bootstrap.awareness : "",
    connection: scientConnect(bootstrap.endpoint, bootstrap.authorization),
  }));
  const { awareness } = shared;
  const { tools, request } = await shared.connection;
  const toolNames = tools.map((tool) => tool.name);
  for (const tool of tools) {
    const name = tool.name;
    pi.registerTool({
      name,
      label: name,
      loadMode: "essential",
      description: tool.description,
      parameters: tool.parameters,
      async execute(_id, args, signal) {
        return scientToolResult(scientRecord(await request("tools/call", { name, arguments: args }, signal)));
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
  pi.registerCommand("scient-status", {
    description: ${JSON.stringify(`Show the Scient connection for this ${target.name} session`)},
    async handler(_args, ctx) {
      ctx.ui.notify("Scient connected: " + toolNames.length + " tools. Full access; no native sandbox.", "info");
    },
  });
}
`;

/** Module source of Scient's OMP extension, reading `bootstrapPath`. */
export const ompScientExtensionSource = (target: OmpTarget, bootstrapPath: string): string =>
  `${ompExtensionBootstrapPrelude(target, bootstrapPath)}${ompScientExtensionBody(target)}`;
