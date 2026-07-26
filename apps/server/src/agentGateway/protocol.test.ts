import { describe, expect, it } from "vitest";

import {
  MCP_DEFAULT_PROTOCOL_VERSION,
  buildMcpInitializeResult,
  jsonRpcError,
  jsonRpcResult,
  mcpToolResultError,
  mcpToolResultJson,
  mcpToolResultText,
  negotiateMcpProtocolVersion,
  parseMcpMessage,
} from "./protocol.ts";

describe("parseMcpMessage", () => {
  it("marks non-object raw input as invalid with null id", () => {
    expect(parseMcpMessage("not an object")).toEqual({ kind: "invalid", id: null });
    expect(parseMcpMessage(42)).toEqual({ kind: "invalid", id: null });
    expect(parseMcpMessage(true)).toEqual({ kind: "invalid", id: null });
  });

  it("marks null as invalid with null id", () => {
    expect(parseMcpMessage(null)).toEqual({ kind: "invalid", id: null });
  });

  it("marks arrays as invalid with null id", () => {
    expect(parseMcpMessage([1, 2, 3])).toEqual({ kind: "invalid", id: null });
  });

  it("marks wrong jsonrpc version as invalid, recovering the id when present", () => {
    expect(parseMcpMessage({ jsonrpc: "1.0", id: "abc", method: "ping" })).toEqual({
      kind: "invalid",
      id: "abc",
    });
    expect(parseMcpMessage({ jsonrpc: "1.0" })).toEqual({ kind: "invalid", id: null });
  });

  it("classifies messages with result/error and no method as responses", () => {
    expect(parseMcpMessage({ jsonrpc: "2.0", id: "1", result: { ok: true } })).toEqual({
      kind: "response",
    });
    expect(parseMcpMessage({ jsonrpc: "2.0", id: "1", error: { code: -1, message: "x" } })).toEqual({
      kind: "response",
    });
  });

  it("marks a method-less, result/error-less message as invalid", () => {
    expect(parseMcpMessage({ jsonrpc: "2.0", id: "1" })).toEqual({ kind: "invalid", id: "1" });
  });

  it("classifies method present + id undefined as a notification", () => {
    expect(parseMcpMessage({ jsonrpc: "2.0", method: "notifications/initialized" })).toEqual({
      kind: "notification",
      method: "notifications/initialized",
    });
  });

  it("classifies method + valid id + object params as a request, preserving params", () => {
    const result = parseMcpMessage({
      jsonrpc: "2.0",
      id: 7,
      method: "tools/call",
      params: { name: "synara_context", arguments: { threadId: "t1" } },
    });
    expect(result).toEqual({
      kind: "request",
      request: {
        jsonrpc: "2.0",
        id: 7,
        method: "tools/call",
        params: { name: "synara_context", arguments: { threadId: "t1" } },
      },
    });
  });

  it("defaults params to {} when params is non-object", () => {
    const withArrayParams = parseMcpMessage({
      jsonrpc: "2.0",
      id: 1,
      method: "ping",
      params: [1, 2],
    });
    expect(withArrayParams).toEqual({
      kind: "request",
      request: { jsonrpc: "2.0", id: 1, method: "ping", params: {} },
    });

    const withStringParams = parseMcpMessage({
      jsonrpc: "2.0",
      id: 1,
      method: "ping",
      params: "bogus",
    });
    expect(withStringParams).toEqual({
      kind: "request",
      request: { jsonrpc: "2.0", id: 1, method: "ping", params: {} },
    });

    const withNoParams = parseMcpMessage({ jsonrpc: "2.0", id: 1, method: "ping" });
    expect(withNoParams).toEqual({
      kind: "request",
      request: { jsonrpc: "2.0", id: 1, method: "ping", params: {} },
    });
  });

  it("marks an id of an invalid type (e.g. boolean) as invalid", () => {
    expect(parseMcpMessage({ jsonrpc: "2.0", id: true, method: "ping" })).toEqual({
      kind: "invalid",
      id: null,
    });
  });
});

describe("negotiateMcpProtocolVersion", () => {
  it("passes through a supported version", () => {
    expect(negotiateMcpProtocolVersion("2025-06-18")).toBe("2025-06-18");
    expect(negotiateMcpProtocolVersion("2025-03-26")).toBe("2025-03-26");
    expect(negotiateMcpProtocolVersion("2024-11-05")).toBe("2024-11-05");
  });

  it("falls back to the default for unsupported or non-string values", () => {
    expect(negotiateMcpProtocolVersion("1999-01-01")).toBe(MCP_DEFAULT_PROTOCOL_VERSION);
    expect(negotiateMcpProtocolVersion(undefined)).toBe(MCP_DEFAULT_PROTOCOL_VERSION);
    expect(negotiateMcpProtocolVersion(42)).toBe(MCP_DEFAULT_PROTOCOL_VERSION);
    expect(negotiateMcpProtocolVersion(null)).toBe(MCP_DEFAULT_PROTOCOL_VERSION);
  });
});

describe("buildMcpInitializeResult", () => {
  it("negotiates the protocol version and shapes serverInfo/capabilities/instructions", () => {
    const result = buildMcpInitializeResult({
      requestedProtocolVersion: "2025-03-26",
      serverVersion: "1.2.3",
      instructions: "hello there",
    });
    expect(result).toEqual({
      protocolVersion: "2025-03-26",
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: "synara", title: "Synara App Control", version: "1.2.3" },
      instructions: "hello there",
    });
  });

  it("falls back to the default protocol version for unsupported requests", () => {
    const result = buildMcpInitializeResult({
      requestedProtocolVersion: "not-a-version",
      serverVersion: "0.0.1",
      instructions: "",
    });
    expect(result.protocolVersion).toBe(MCP_DEFAULT_PROTOCOL_VERSION);
  });
});

describe("mcpToolResultText / mcpToolResultError / mcpToolResultJson", () => {
  it("mcpToolResultText wraps text without isError", () => {
    expect(mcpToolResultText("hello")).toEqual({ content: [{ type: "text", text: "hello" }] });
  });

  it("mcpToolResultError wraps text and sets isError true", () => {
    expect(mcpToolResultError("boom")).toEqual({
      content: [{ type: "text", text: "boom" }],
      isError: true,
    });
  });

  it("mcpToolResultJson pretty-prints the value as JSON text", () => {
    const value = { a: 1, b: ["x", "y"] };
    expect(mcpToolResultJson(value)).toEqual({
      content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
    });
  });
});

describe("jsonRpcResult / jsonRpcError", () => {
  it("jsonRpcResult shapes a success envelope", () => {
    expect(jsonRpcResult("1", { ok: true })).toEqual({
      jsonrpc: "2.0",
      id: "1",
      result: { ok: true },
    });
  });

  it("jsonRpcError shapes an error envelope", () => {
    expect(jsonRpcError(2, -32600, "Invalid Request")).toEqual({
      jsonrpc: "2.0",
      id: 2,
      error: { code: -32600, message: "Invalid Request" },
    });
  });
});
