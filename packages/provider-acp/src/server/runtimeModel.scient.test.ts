import { expect, it } from "vite-plus/test";

import { extractMcpToolCallIdentity, mergeToolCallState } from "./runtimeModel.ts";

const args = { title: "Chart", html: "<p>Chart</p>" };
const content = [{ type: "text", text: "Rendered" }];
const command = { tool: "html_render", mode: "execute", args, exitCode: 0, inner: { content } };

function completed(commands: readonly unknown[], name = "bash") {
  return mergeToolCallState(
    {
      toolCallId: "shell",
      data: { name, rawInput: { command: `html_render -j '${JSON.stringify(args)}'` } },
    },
    {
      toolCallId: "shell",
      status: "completed",
      data: { rawOutput: { details: { toolCommands: commands } } },
    },
  );
}

it("recovers a Scient extension command's arguments and MCP output from the settled bash call", () => {
  expect(extractMcpToolCallIdentity(completed([command]))).toEqual({
    server: "t3-code",
    tool: "html_render",
    input: args,
    output: { content },
  });
});

it("uses the MCP bridge's original tool name for a shortened command", () => {
  const inner = { serverName: "scient", mcpToolName: "scient_thread_inspect", rawContent: content };
  expect(
    extractMcpToolCallIdentity(
      completed([{ ...command, tool: "mcp__scient_thread_inspect", inner }]),
    ),
  ).toMatchObject({
    server: "t3-code",
    tool: "scient_thread_inspect",
    input: args,
    output: { content },
  });
});

it("keeps help, multiple dispatches, and non-bash results out of Scient's tool cards", () => {
  expect(extractMcpToolCallIdentity(completed([{ ...command, mode: "help" }]))).toBeUndefined();
  expect(extractMcpToolCallIdentity(completed([command, command]))).toBeUndefined();
  expect(extractMcpToolCallIdentity(completed([command], "read"))).toBeUndefined();
  expect(
    extractMcpToolCallIdentity({ ...completed([command]), status: "inProgress" }),
  ).toBeUndefined();
});

it("retains the command failure when the shell exits successfully", () => {
  expect(extractMcpToolCallIdentity(completed([{ ...command, exitCode: 1 }]))).toMatchObject({
    output: { content, isError: true },
  });
});
