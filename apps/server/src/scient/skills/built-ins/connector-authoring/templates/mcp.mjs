// A small MCP server over stdio, with no dependencies. Runs on Node 20+ and on Scient's own
// Electron binary in Node mode, on macOS, Windows and Linux.
//
// It speaks both protocol eras:
// - Legacy (2025-11-25 and earlier): `initialize`, then requests. Versions are negotiated.
// - Current (2026-07-28): no handshake; `server/discover`, and every request names its version
//   in `params._meta["io.modelcontextprotocol/protocolVersion"]`.
//
// You normally don't edit this file. Define tools in server.mjs and call `serve(...)`.

import * as readline from "node:readline";

/** Tool errors whose text starts with this make Scient sign the user in again and retry once. */
export const SIGN_IN_EXPIRED = "SCIENT_SIGN_IN_EXPIRED";

const MODERN_VERSIONS = ["2026-07-28"];
const LEGACY_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
const VERSION_META = "io.modelcontextprotocol/protocolVersion";
const SERVER_INFO_META = "io.modelcontextprotocol/serverInfo";
/** Agents see at most ~25k tokens of a tool result; keep well under it. */
const MAX_TEXT = 60_000;

/**
 * An error the agent should read: a plain sentence saying what went wrong and what to do next.
 * It becomes a tool result with `isError: true`, so the agent can correct itself.
 */
export class ToolError extends Error {
  constructor(message) {
    super(message);
    this.name = "ToolError";
  }
}

/** A tool error saying a setting or key is missing, pointing the agent at Scient's setup. */
export const needsSetup = (what) =>
  new ToolError(
    `${what} is not set up yet. Call scient_connector_setup for this connector; ` +
      "Scient asks the user in a private card. Never ask for keys in chat.",
  );

/** Logs go to stderr. Never write to stdout: it carries the protocol. */
export const log = (...parts) => {
  process.stderr.write(`${parts.map((p) => (typeof p === "string" ? p : inspect(p))).join(" ")}\n`);
};
const inspect = (value) => {
  if (value instanceof Error) return value.stack ?? value.message;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
};

// A stray console.log would corrupt the protocol stream; send it to stderr instead.
console.log = console.info = console.debug = (...parts) => log(...parts);

/** Cuts long text with a note that tells the agent how to get less. */
export const clip = (text, max = MAX_TEXT) =>
  text.length <= max
    ? text
    : `${text.slice(0, max)}\n\n[Cut at ${max} of ${text.length} characters. Ask for fewer results, a smaller page, or fewer fields.]`;

// ---------------------------------------------------------------------------------------------
// Input checking: a small part of JSON Schema, enough for tool arguments. Messages name the field
// and say what is allowed, so the agent can fix its call.

const typeOf = (value) => (value === null ? "null" : Array.isArray(value) ? "array" : typeof value);

const matchesType = (value, type) => {
  if (type === undefined) return true;
  if (Array.isArray(type)) return type.some((t) => matchesType(value, t));
  if (type === "integer") return Number.isInteger(value);
  if (type === "number") return typeof value === "number" && Number.isFinite(value);
  return typeOf(value) === type;
};

function checkValue(value, schema, path, problems) {
  if (!schema || typeof schema !== "object") return value;
  if (!matchesType(value, schema.type)) {
    problems.push(`${path} must be ${[].concat(schema.type).join(" or ")}, not ${typeOf(value)}`);
    return value;
  }
  if (schema.enum && !schema.enum.includes(value)) {
    problems.push(`${path} must be one of ${schema.enum.map((v) => JSON.stringify(v)).join(", ")}`);
  }
  if (typeof value === "number") {
    if (schema.minimum !== undefined && value < schema.minimum)
      problems.push(`${path} must be at least ${schema.minimum}`);
    if (schema.maximum !== undefined && value > schema.maximum)
      problems.push(`${path} must be at most ${schema.maximum}`);
  }
  if (typeof value === "string") {
    if (schema.minLength !== undefined && value.length < schema.minLength)
      problems.push(`${path} must have at least ${schema.minLength} characters`);
    if (schema.maxLength !== undefined && value.length > schema.maxLength)
      problems.push(`${path} must have at most ${schema.maxLength} characters`);
    if (schema.pattern !== undefined && !new RegExp(schema.pattern, "u").test(value))
      problems.push(`${path} does not look right (expected pattern ${schema.pattern})`);
  }
  if (Array.isArray(value)) {
    if (schema.maxItems !== undefined && value.length > schema.maxItems)
      problems.push(`${path} may have at most ${schema.maxItems} items`);
    if (schema.minItems !== undefined && value.length < schema.minItems)
      problems.push(`${path} needs at least ${schema.minItems} items`);
    return value.map((item, i) => checkValue(item, schema.items, `${path}[${i}]`, problems));
  }
  if (typeOf(value) === "object" && schema.properties) {
    return checkObject(value, schema, path, problems);
  }
  return value;
}

function checkObject(value, schema, path, problems) {
  const out = { ...value };
  const properties = schema.properties ?? {};
  if (schema.additionalProperties === false) {
    for (const key of Object.keys(out)) {
      if (!(key in properties)) {
        const allowed = Object.keys(properties);
        problems.push(
          `${path === "" ? "" : `${path}.`}${key} is not an argument here` +
            (allowed.length ? ` (allowed: ${allowed.join(", ")})` : " (this tool takes none)"),
        );
      }
    }
  }
  for (const [key, child] of Object.entries(properties)) {
    const childPath = path === "" ? key : `${path}.${key}`;
    if (out[key] === undefined || out[key] === null) {
      if (child.default !== undefined) out[key] = structuredClone(child.default);
      else delete out[key];
      continue;
    }
    out[key] = checkValue(out[key], child, childPath, problems);
  }
  for (const key of schema.required ?? []) {
    if (out[key] === undefined) problems.push(`${path === "" ? "" : `${path}.`}${key} is required`);
  }
  return out;
}

/** Checks arguments against a tool's inputSchema, fills defaults, and returns them. */
export function checkArguments(args, schema) {
  if (args !== undefined && args !== null && typeOf(args) !== "object") {
    throw new ToolError(`Invalid arguments: they must be an object, not ${typeOf(args)}.`);
  }
  const problems = [];
  const value = checkObject(args ?? {}, schema ?? { type: "object" }, "", problems);
  if (problems.length > 0) {
    throw new ToolError(`Invalid arguments: ${problems.join("; ")}.`);
  }
  return value;
}

// ---------------------------------------------------------------------------------------------
// Results

/** Turns what a handler returned into a CallToolResult. */
function toResult(tool, value) {
  if (typeof value === "string") return { content: [{ type: "text", text: clip(value) }] };
  if (value && Array.isArray(value.content)) return value; // Already a CallToolResult.
  // A plain object: JSON text for every client, plus structuredContent when declared.
  const text = clip(JSON.stringify(value ?? null));
  return tool.outputSchema && typeOf(value) === "object"
    ? { content: [{ type: "text", text }], structuredContent: value }
    : { content: [{ type: "text", text }] };
}

const errorResult = (message) => ({
  content: [{ type: "text", text: clip(message) }],
  isError: true,
});

// ---------------------------------------------------------------------------------------------
// The server

/** A JSON-RPC protocol error (unknown method or tool), as opposed to a tool error. */
class ProtocolError extends Error {
  constructor(code, message, data) {
    super(message);
    this.code = code;
    this.data = data;
  }
}

/**
 * Starts the server on stdin/stdout.
 *
 * @param {object} options
 * @param {string} options.name Program name, e.g. "openalex".
 * @param {string} options.version
 * @param {string} [options.title] Name shown to people.
 * @param {string} [options.instructions] One or two sentences for the agent on using the tools.
 * @param {Array<{name: string, title?: string, description: string, inputSchema?: object,
 *   outputSchema?: object, annotations?: object,
 *   handler: (args: object, context: {signal: AbortSignal}) => unknown}>} options.tools
 */
export function serve({ name, version, title, instructions, tools }) {
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  const listed = tools.map(({ handler: _handler, ...tool }) => ({
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    ...tool,
  }));
  const serverInfo = { name, version, ...(title ? { title } : {}) };
  const inFlight = new Map(); // request id -> AbortController
  let open = true;

  const send = (message) => {
    if (open && message !== undefined) process.stdout.write(`${JSON.stringify(message)}\n`);
  };
  const failure = (id, code, message, data) => ({
    jsonrpc: "2.0",
    id,
    error: { code, message, ...(data === undefined ? {} : { data }) },
  });

  async function callTool(params, signal) {
    const tool = byName.get(params?.name);
    if (!tool) throw new ProtocolError(-32602, `Unknown tool: ${params?.name}`);
    let args;
    try {
      args = checkArguments(params.arguments, tool.inputSchema);
    } catch (error) {
      return errorResult(error.message);
    }
    try {
      return toResult(tool, await tool.handler(args, { signal }));
    } catch (error) {
      if (signal.aborted) return errorResult("The call was cancelled.");
      if (error instanceof ToolError) return errorResult(error.message);
      log(`${tool.name} failed:`, error);
      return errorResult(
        `${tool.name} failed unexpectedly: ${error?.message ?? String(error)}. ` +
          "The connector's log has details.",
      );
    }
  }

  async function handle(method, params, modern, signal) {
    switch (method) {
      case "initialize": {
        // Legacy handshake: answer with the client's version when we know it, else our latest.
        const asked = params?.protocolVersion;
        return {
          protocolVersion: LEGACY_VERSIONS.includes(asked) ? asked : LEGACY_VERSIONS[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo,
          ...(instructions ? { instructions } : {}),
        };
      }
      case "server/discover":
        return {
          supportedVersions: MODERN_VERSIONS,
          capabilities: { tools: { listChanged: false } },
          ...(instructions ? { instructions } : {}),
          ttlMs: 300_000,
          cacheScope: "public",
        };
      case "ping":
        return {};
      case "tools/list":
        return modern ? { tools: listed, ttlMs: 300_000, cacheScope: "public" } : { tools: listed };
      case "tools/call":
        return callTool(params, signal);
      default:
        throw new ProtocolError(-32601, `Method not found: ${method}`);
    }
  }

  /** Answers one request; resolves to the response, or undefined when nothing is sent. */
  async function onRequest({ id, method, params }) {
    const asked = params?._meta?.[VERSION_META];
    const modern = asked !== undefined || method === "server/discover";
    if (asked !== undefined && !MODERN_VERSIONS.includes(asked)) {
      return failure(id, -32022, "Unsupported protocol version", {
        supported: MODERN_VERSIONS,
        requested: asked,
      });
    }
    const controller = new AbortController();
    inFlight.set(id, controller);
    try {
      const result = await handle(method, params, modern, controller.signal);
      if (controller.signal.aborted) return undefined; // Cancelled: send nothing for it.
      return {
        jsonrpc: "2.0",
        id,
        result: modern
          ? { resultType: "complete", ...result, _meta: { [SERVER_INFO_META]: serverInfo } }
          : result,
      };
    } catch (error) {
      if (controller.signal.aborted) return undefined;
      if (error instanceof ProtocolError) return failure(id, error.code, error.message, error.data);
      log(`${method} failed:`, error);
      return failure(id, -32603, "Internal error");
    } finally {
      inFlight.delete(id);
    }
  }

  /** Resolves to the response for one message, or undefined for notifications and responses. */
  async function onMessage(message) {
    if (message === null || typeof message !== "object" || Array.isArray(message)) {
      return failure(null, -32600, "Invalid request");
    }
    if (typeof message.method !== "string") return undefined; // A response; we send no requests.
    if (message.id === undefined || message.id === null) {
      // A notification. Only cancellation matters to a tools-only server.
      if (message.method === "notifications/cancelled") {
        inFlight.get(message.params?.requestId)?.abort();
      }
      return undefined;
    }
    return onRequest(message);
  }

  const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  lines.on("line", (line) => {
    if (line.trim() === "") return;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return send(failure(null, -32700, "Parse error"));
    }
    if (!Array.isArray(message)) return void onMessage(message).then(send);
    // A JSON-RPC batch (2025-03-26 clients may send one): one array of answers back.
    if (message.length === 0) return send(failure(null, -32600, "Invalid request"));
    void Promise.all(message.map(onMessage)).then((answers) => {
      const sent = answers.filter((answer) => answer !== undefined);
      if (sent.length > 0) send(sent);
    });
  });
  // The client closes stdin to stop us: finish quietly.
  lines.on("close", () => {
    open = false;
    for (const controller of inFlight.values()) controller.abort();
    process.exit(0);
  });
  process.stdout.on("error", () => process.exit(0)); // The client went away.
  process.on("unhandledRejection", (error) => log("Unhandled rejection:", error));
  process.on("uncaughtException", (error) => log("Uncaught exception:", error));
  log(`${name} ${version} ready (${tools.length} tools).`);
}
