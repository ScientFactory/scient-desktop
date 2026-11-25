import { ompExtensionBootstrapPrelude } from "./OmpExtensionBootstrap.ts";
import type { OmpTarget } from "./OmpTarget.ts";
import {
  SCIENT_ALWAYS_LOADED_TOOLS,
  SCIENT_CONNECTOR_LOAD_MODE_ENV,
} from "../scient/ScientAgentToolLoading.ts";

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

/** How long startup waits for Scient's and the connectors' tool catalogs. */
const OMP_SCIENT_STARTUP_TOOL_WAIT_MS = 5_000;

/** Scient's waits block for up to an hour; stay above that, as Claude's and Codex's limits do. */
const OMP_SCIENT_TOOL_CALL_TIMEOUT_MS = 65 * 60 * 1_000;

/**
 * Older runtimes need essential tools. Supported runtimes mount optional Scient and connector
 * tools on demand, keeping a small Scient core direct. Share connections across subagent reruns.
 * before_agent_start replaces the string-array prompt. Connector aliases preserve call names;
 * one failed connector must not remove others' tools.
 */
const ompScientExtensionBody = (target: OmpTarget, workspacePath: string | undefined): string => `
import { createHash as scientCreateHash } from "node:crypto";

const SCIENT_WORKSPACE_PATH = ${JSON.stringify(workspacePath ?? null)};

// Scient rewrites this file when the thread's folders change; read it at each agent start.
const scientWorkspace = () => {
  if (SCIENT_WORKSPACE_PATH === null) return "";
  try {
    return scientReadFileSync(SCIENT_WORKSPACE_PATH, "utf8");
  } catch {
    return "";
  }
};

const scientRecord = (value) =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? value : undefined;

const scientConnect = async (endpoint, authorization, label, connectSignal) => {
  if (!endpoint || !authorization) return { tools: [], request: undefined };
  let nextId = 0;
  let sessionId;
  let protocolVersion = "2025-06-18";
  const request = async (method, params, signal, notification = false) => {
    const id = ++nextId;
    const timeout = AbortSignal.timeout(
      method === "tools/call" ? ${OMP_SCIENT_TOOL_CALL_TIMEOUT_MS} : 180_000,
    );
    const response = await fetch(endpoint, {
      method: "POST",
      redirect: "error",
      // Bun cuts a request whose answer is still pending after about 300 s; the signal below is
      // the only deadline. Node's fetch ignores this option.
      timeout: false,
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
      // A server request may reuse this id; only a response (no method) answers it.
      if (envelope?.id !== id || "method" in envelope) return undefined;
      if (envelope.error) {
        const reason = scientRecord(envelope.error)?.message;
        throw new Error(
          label + " rejected the tool request." + (typeof reason === "string" ? " " + reason : ""),
        );
      }
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
  // The server's first instruction line describes it in Scient Agent's catalog, as Codex shows it.
  const description =
    typeof initialized?.instructions === "string"
      ? initialized.instructions.split(/\\r?\\n/u).find((line) => line.trim())?.trim().slice(0, 200)
      : undefined;
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
  return { tools, request, description };
};

/** The prefix every plain tool name of the server starts with. */
const scientConnectorPrefix = (serverName) =>
  (/^[A-Za-z_]/u.test(serverName) ? serverName : "_" + serverName) + "__";

/** The tool's model-facing name, or undefined when none is usable. */
const scientConnectorToolName = (serverName, toolName, taken, serverNames = []) => {
  const prefix = scientConnectorPrefix(serverName);
  const name = prefix + toolName.replace(/[^A-Za-z0-9_-]/gu, "_");
  // An alias keeps the name's first 55 characters, so it stays in OMP's namespace too.
  if (name.startsWith("mcp__")) return undefined;
  // Catalogs arrive in any order: a name inside a longer server's namespace is that server's.
  const foreign = serverNames.some((other) => {
    const otherPrefix = scientConnectorPrefix(other);
    return otherPrefix.length > prefix.length && name.startsWith(otherPrefix);
  });
  if (name.length <= 64 && !foreign && !taken.has(name)) return name;
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
  const shared = scientOnce((bootstrap) => {
    const mode = process.env[${JSON.stringify(SCIENT_CONNECTOR_LOAD_MODE_ENV)}];
    const discoveryHint = mode === "commands"
      ? "\\nFind optional Scient and connector tools in the session's command catalog. If a service has a link, read it for the exact commands. In bash, run <command> --help for usage, then <command> <args> or <command> -j '<json>'. Call top-level tools directly."
      : mode === "discoverable"
        ? "\\nAdditional Scient and connector tools are available as xd:// devices: use read on xd:// to discover them, read xd://<name> for the schema, and write JSON arguments to xd://<name> to call them. Tools named in these instructions may be devices rather than top-level tools."
        : "";
    return {
      awareness: (typeof bootstrap.awareness === "string" ? bootstrap.awareness : "") + discoveryHint,
      connectorLoadMode: mode === "commands" || mode === "discoverable" ? "discoverable" : "essential",
      connection: scientConnect(bootstrap.endpoint, bootstrap.authorization, "Scient"),
      connectorNames: scientConnectors(bootstrap.connectors).map((connector) => connector.displayName),
      serverNames: scientConnectors(bootstrap.connectors).map((connector) => connector.serverName),
      // Every run of this process gives a catalog's tools the same names, decided on arrival.
      taken: new Set(),
      named: new Map(),
      skipped: new Map(),
      started: false,
      connectors: scientConnectors(bootstrap.connectors).map((connector) => {
        const label = "Connector " + JSON.stringify(connector.displayName);
        return scientConnect(connector.url, bootstrap.authorization, label, AbortSignal.timeout(30_000)).then(
          ({ tools, request, description }) => ({ ...connector, label, connected: true, tools, request, description }),
          () => ({ ...connector, label, connected: false, tools: [], request: undefined }),
        );
      }),
    };
  });
  const coreTools = new Set(${JSON.stringify(SCIENT_ALWAYS_LOADED_TOOLS)});
  const toolNames = new Set();
  const nameScient = ({ tools, request, description }) =>
    tools.flatMap((tool) => {
      if (shared.taken.has(tool.name)) {
        shared.skipped.set("Scient", (shared.skipped.get("Scient") ?? 0) + 1);
        return [];
      }
      shared.taken.add(tool.name);
      return [{
        ...tool, remoteName: tool.name, label: "Scient", request, serverName: "Scient", serverDescription: description ?? "Scient workspace tools",
        loadMode: coreTools.has(tool.name) ? "essential" : shared.connectorLoadMode,
      }];
    });
  const nameConnector = (connector) =>
    connector.tools.flatMap((tool) => {
      const name = scientConnectorToolName(connector.serverName, tool.name, shared.taken, shared.serverNames);
      if (name === undefined) {
        shared.skipped.set(connector.serverName, (shared.skipped.get(connector.serverName) ?? 0) + 1);
        return [];
      }
      shared.taken.add(name);
      return [{ ...tool, name, remoteName: tool.name, label: connector.label, serverName: connector.serverName, serverDescription: connector.description ?? connector.displayName + ", a Scient connector", request: connector.request, loadMode: shared.connectorLoadMode }];
    });
  const register = (index, value) => {
    if (!shared.named.has(index)) shared.named.set(index, index === 0 ? nameScient(value) : nameConnector(value));
    for (const tool of shared.named.get(index)) {
      const { name, remoteName, label, request: call } = tool;
      pi.registerTool({
        name,
        label: name,
        loadMode: tool.loadMode,
        mcpServerName: tool.serverName,
        // Scient Agent lists a described service as one catalog row.
        mcpServerDescription: tool.serverDescription,
        mcpToolName: remoteName,
        description: tool.description,
        parameters: tool.parameters,
        // A strict grammar makes models fill optional fields, and a filled field changes
        // what a Scient tool does: an invented session, or a page target instead of a URL.
        strict: false,
        async execute(_id, args, signal) {
          return scientToolResult(
            scientRecord(await call("tools/call", { name: remoteName, arguments: args }, signal)),
            label,
          );
        },
      });
      toolNames.add(name);
    }
  };
  let ended = false;
  pi.on("session_shutdown", () => {
    ended = true;
  });
  // Startup waits a bounded time for tool servers: the host times out an agent that never
  // reports ready. A server that answers later adds its tools then, for the next model call.
  const sources = [
    shared.connection.then((value) => ({ ok: true, value }), (error) => ({ ok: false, error })),
    ...shared.connectors.map((promise) => promise.then((value) => ({ ok: true, value }))),
  ].map((promise) => {
    const source = { promise };
    void promise.then((outcome) => { source.outcome = outcome; });
    return source;
  });
  let waitTimer;
  await Promise.race([
    Promise.all(sources.map((source) => source.promise)),
    new Promise((resolve) => { waitTimer = setTimeout(resolve, ${OMP_SCIENT_STARTUP_TOOL_WAIT_MS}); }),
  ]);
  clearTimeout(waitTimer);
  const scient = sources[0];
  // Once a run has started without Scient's tools, a later failure leaves later runs degraded too.
  if (scient.outcome?.ok === false && !shared.started) throw scient.outcome.error;
  shared.started = true;
  sources.forEach((source, index) => {
    if (source.outcome) {
      if (source.outcome.ok) register(index, source.outcome.value);
      return;
    }
    void source.promise.then((outcome) => {
      if (!outcome.ok || ended) return;
      try {
        register(index, outcome.value);
      } catch {
        // The session this run served has ended.
      }
    });
  });
  pi.on("tool_result", (event) => {
    if (toolNames.has(event.toolName) && scientRecord(event.details)?.isError === true)
      return { isError: true };
    return undefined;
  });
  pi.on("before_agent_start", (event) => {
    const prompt = [shared.awareness, scientWorkspace()].filter(Boolean).join("\\n\\n");
    return { systemPrompt: prompt ? [...event.systemPrompt, prompt] : undefined };
  });
  const status = () =>
    (!scient.outcome
      ? "Scient connecting."
      : !scient.outcome.ok
        ? "Scient unavailable."
        : "Scient connected: " + scient.outcome.value.tools.length + " tools.") +
    " Full access; no native sandbox." +
    sources
      .slice(1)
      .map(({ outcome }, index) => {
        const connector = outcome?.value;
        const displayName = connector?.displayName ?? shared.connectorNames[index];
        if (!connector) return " " + displayName + ": connecting.";
        if (!connector.connected) return " " + displayName + ": unavailable.";
        const omitted = shared.skipped.get(connector.serverName) ?? 0;
        return (
          " " + displayName + ": " + (connector.tools.length - omitted) + " tools" +
          (omitted > 0 ? " (" + omitted + " omitted: name unusable)" : "") + "."
        );
      })
      .join("");
  pi.registerCommand("scient-status", {
    description: ${JSON.stringify(`Show the Scient connection for this ${target.name} session`)},
    async handler(_args, ctx) {
      ctx.ui.notify(status(), "info");
    },
  });
}
`;

/**
 * Module source of Scient's OMP extension, reading `bootstrapPath` once and, at each agent
 * start, the thread's folder list from `workspacePath`.
 */
export const ompScientExtensionSource = (
  target: OmpTarget,
  bootstrapPath: string,
  workspacePath?: string,
): string =>
  `${ompExtensionBootstrapPrelude(target, bootstrapPath)}${ompScientExtensionBody(target, workspacePath)}`;
