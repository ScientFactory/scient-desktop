import { T3_MCP_TOOL_NAMES } from "@t3tools/shared/t3McpToolPresentation";
import * as Predicate from "effect/Predicate";

import type { AcpMcpToolCallIdentity, AcpToolCallState } from "./runtimeModel.ts";

/** One ACP card can represent one dispatch. Progress may still acquire more commands. */
export function scientOmpCommandIdentity(
  status: AcpToolCallState["status"],
  commands: ReadonlyArray<unknown>,
  shellResult: Record<string, unknown>,
  isT3McpServer: (name: string) => boolean,
): AcpMcpToolCallIdentity | undefined {
  if (status !== "completed" && status !== "failed") return undefined;
  const [command] = commands;
  if (
    commands.length !== 1 ||
    !Predicate.isObject(command) ||
    command.mode !== "execute" ||
    typeof command.tool !== "string" ||
    typeof command.exitCode !== "number" ||
    !Predicate.isObject(command.args)
  )
    return undefined;

  const inner = Predicate.isObject(command.inner) ? command.inner : undefined;
  let tool = command.tool;
  let output = inner ?? shellResult;
  if (tool.startsWith("mcp__")) {
    // The native MCP bridge shortens wire names and retains the original server and tool here.
    if (
      typeof inner?.serverName !== "string" ||
      !isT3McpServer(inner.serverName) ||
      typeof inner.mcpToolName !== "string"
    )
      return undefined;
    tool = inner.mcpToolName;
    output = {
      content: inner.rawContent ?? shellResult.content ?? [],
      ...(inner.structuredContent === undefined
        ? {}
        : { structuredContent: inner.structuredContent }),
      ...(inner.mcpMeta === undefined ? {} : { _meta: inner.mcpMeta }),
      ...(inner.isError === true ? { isError: true } : {}),
    };
  }
  if (!T3_MCP_TOOL_NAMES.has(tool)) return undefined;
  return {
    server: "t3-code",
    tool,
    input: command.args,
    output: command.exitCode === 0 ? output : { ...output, isError: true },
  };
}
