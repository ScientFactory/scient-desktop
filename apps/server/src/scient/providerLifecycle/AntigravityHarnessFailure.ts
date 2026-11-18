// @effect-diagnostics nodeBuiltinImport:off -- reads Antigravity's own small config file once per failure.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import type { OrchestrationV2ProviderFailure } from "@t3tools/contracts";
import { makeProviderFailure } from "@t3tools/provider-core/server/failure";

import { redactFailureDetail } from "./providerFailureText.ts";

// The trajectory's error step: field 1 is this headline, field 2 the harness's error chain
// without the Go stack trace that field 3 repeats it with.
const HEADLINE = Buffer.from("Agent execution terminated due to error.");
const ERROR_CHAIN_FIELD = 0x12;
const MAX_DETAIL_CHARACTERS = 600;
const EXECUTOR_PREFIX = /^(?:failed to construct executor|agent executor error):\s*/u;
const MCP_LOAD_FAILED = /^MCP load failed for (.+?): (?:calling "[^"]*": )?(.+)$/u;
const GENERIC_MESSAGE = "Antigravity stopped this turn because of an error.";

function errorChain(payload: Uint8Array): string | undefined {
  const bytes = Buffer.from(payload.buffer, payload.byteOffset, payload.byteLength);
  const headline = bytes.indexOf(HEADLINE);
  if (headline < 0) return undefined;
  let offset = headline + HEADLINE.length;
  if (bytes[offset++] !== ERROR_CHAIN_FIELD) return undefined;
  let length = 0;
  for (let shift = 0; ; shift += 7) {
    const byte = bytes[offset++];
    if (byte === undefined || shift > 21) return undefined;
    length += (byte & 0x7f) * 2 ** shift;
    if (byte < 0x80) break;
  }
  const line = bytes
    .subarray(offset, offset + length)
    .toString("utf8")
    .split(/\r?\n/u, 1)[0]
    ?.replace(EXECUTOR_PREFIX, "")
    .trim();
  return line ? redactFailureDetail(line) : undefined;
}

const bounded = (text: string) => {
  const characters = [...text];
  return characters.length <= MAX_DETAIL_CHARACTERS
    ? text
    : `${characters.slice(0, MAX_DETAIL_CHARACTERS - 1).join("")}…`;
};

/** The tool servers a session was given, and those the user configured in Antigravity itself. */
export interface AntigravityToolServers {
  /** Scient's connectors delivered to this session, by server name. */
  readonly connectorServerNames: ReadonlySet<string>;
  /** Servers in the profile's own `mcp_config.json`; undefined when it could not be read. */
  readonly userServerNames: ReadonlySet<string> | undefined;
}

const SCIENT_SERVER_NAME = "scient";
const SCIENT_BRIDGE_HTTP_STATUS = /\bScient MCP endpoint responded with HTTP (\d{3})\b/u;
const MAX_CONFIG_BYTES = 64_000;

/** Whose server a name is. A name two sources share, or one none lists, stays unknown. */
function toolServerOwner(
  name: string,
  servers: AntigravityToolServers | undefined,
): NonNullable<OrchestrationV2ProviderFailure["toolServerOwner"]> {
  if (servers?.userServerNames === undefined) return "unknown";
  const owners: ReadonlyArray<"scient" | "connector" | "user"> = [
    ...(name === SCIENT_SERVER_NAME ? (["scient"] as const) : []),
    ...(servers.connectorServerNames.has(name) ? (["connector"] as const) : []),
    ...(servers.userServerNames.has(name) ? (["user"] as const) : []),
  ];
  return owners.length === 1 ? owners[0]! : "unknown";
}

/** The server names in the profile's own `mcp_config.json`, or undefined when unreadable. */
export async function readAntigravityUserToolServers(
  profileDirectory: string,
): Promise<ReadonlySet<string> | undefined> {
  try {
    const configPath = NodePath.join(profileDirectory, "config", "mcp_config.json");
    const info = await NodeFSP.lstat(configPath).catch(() => undefined);
    // No file means the user configured none.
    if (info === undefined) return new Set();
    if (!info.isFile() || info.size > MAX_CONFIG_BYTES) return undefined;
    const text = await NodeFSP.readFile(configPath, "utf8");
    // Antigravity writes an empty file before any server exists.
    if (text.trim().length === 0) return new Set();
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== "object" || parsed === null) return undefined;
    const servers = (parsed as { readonly mcpServers?: unknown }).mcpServers ?? parsed;
    return typeof servers === "object" && servers !== null && !Array.isArray(servers)
      ? new Set(Object.keys(servers))
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The failure for an Antigravity error step that is not a Google API error. A tool server that
 * fails to start aborts the whole turn, so the message names it and analytics says whose it was.
 */
export function antigravityHarnessFailure(
  payload: Uint8Array | null,
  servers?: AntigravityToolServers,
): OrchestrationV2ProviderFailure {
  const chain = payload === null ? undefined : errorChain(payload);
  const mcp = chain === undefined ? null : MCP_LOAD_FAILED.exec(chain);
  if (mcp !== null) {
    const bridgeStatus = SCIENT_BRIDGE_HTTP_STATUS.exec(mcp[2]!)?.[1];
    return {
      ...makeProviderFailure({
        class: "provider_error",
        message: bounded(
          `Antigravity could not start the tool server "${mcp[1]}", so it stopped this turn: ${mcp[2]}`,
        ),
        code: "mcp_load_failed",
        retryable: false,
        ...(bridgeStatus === undefined ? {} : { httpStatus: Number(bridgeStatus) }),
      }),
      toolServerOwner: toolServerOwner(mcp[1]!, servers),
    };
  }
  return makeProviderFailure({
    class: "provider_error",
    message:
      chain === undefined
        ? GENERIC_MESSAGE
        : bounded(`Antigravity stopped this turn because of an error: ${chain}`),
    code: "harness_error",
  });
}
