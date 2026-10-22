import { describe, expect, it } from "@effect/vitest";

import type { ConnectorFetch } from "./ConnectorOutbound.ts";
import { probeConnector } from "./ConnectorProbe.ts";

const REPLY = JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  result: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    serverInfo: { name: "synthetic", version: "1" },
  },
});
const OPEN = { type: "open", serverName: "synthetic", serverVersion: "1" } as const;

/** An SSE answer delivered as `chunks`; the stream stays open unless `close`. */
const sseFetch =
  (chunks: ReadonlyArray<string>, close = false): ConnectorFetch =>
  async (_url, init) => {
    if (init?.method === "DELETE") return new Response(null, { status: 204 });
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
        if (close) controller.close();
      },
    });
    return new Response(body, { headers: { "content-type": "text/event-stream" } });
  };

const probe = (chunks: ReadonlyArray<string>, close = false) =>
  probeConnector({ url: "https://mcp.example.com/mcp", fetch: sseFetch(chunks, close) });

describe("probeConnector over SSE", () => {
  // The stream stays open: the reply must be recognized at its own boundary,
  // not when the server hangs up.
  it("accepts LF, CRLF, CR-only and mixed line endings at every split", async () => {
    const answers = [
      `event: message\ndata: ${REPLY}\n\n`,
      `event: message\r\ndata: ${REPLY}\r\n\r\n`,
      `event: message\rdata: ${REPLY}\r\r`,
      `: hello\r\nid: 1\revent: message\ndata: ${REPLY}\r\n\r`,
    ];
    for (const answer of answers) {
      expect(await probe([answer])).toEqual(OPEN);
      for (let split = 1; split < answer.length; split += 1) {
        expect(await probe([answer.slice(0, split), answer.slice(split)])).toEqual(OPEN);
      }
    }
  });

  it("skips a CR-only priming event and a notification before the reply", async () => {
    const notification = JSON.stringify({ jsonrpc: "2.0", method: "notifications/message" });
    expect(await probe([`id: p\rdata:\r\rdata: ${notification}\r\rdata: ${REPLY}\r\r`])).toEqual(
      OPEN,
    );
  });

  it("rejects a stream whose reply never completes or is not JSON", async () => {
    const notMcp = {
      type: "not-an-mcp-server",
      message: "The address did not answer like an MCP server.",
    };
    // No terminating blank line before the server hangs up: the event is incomplete.
    expect(await probe([`data: ${REPLY}\r`], true)).toEqual(notMcp);
    expect(await probe(["data: <html>\r\r"])).toEqual(notMcp);
  });

  it("skips a server request that reuses the probe's id, at every split", async () => {
    const ping = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" });
    // Same id, but neither a request nor a result/error: not an answer either.
    const bare = JSON.stringify({ jsonrpc: "2.0", id: 1 });
    const answer = `data: ${ping}\n\ndata: ${bare}\n\nevent: message\ndata: ${REPLY}\n\n`;
    // The stream stays open after the reply: it must be recognized in place.
    expect(await probe([answer])).toEqual(OPEN);
    for (let split = 1; split < answer.length; split += 1) {
      expect(await probe([answer.slice(0, split), answer.slice(split)])).toEqual(OPEN);
    }
  });
});

describe("probeConnector over JSON", () => {
  const jsonProbe = (body: string) =>
    probeConnector({
      url: "https://mcp.example.com/mcp",
      fetch: async () => new Response(body, { headers: { "content-type": "application/json" } }),
    });
  const notMcp = {
    type: "not-an-mcp-server",
    message: "The address did not answer like an MCP server.",
  };

  it("accepts only the response envelope for its own id", async () => {
    expect(await jsonProbe(REPLY)).toEqual(OPEN);
    const result = JSON.parse(REPLY).result;
    // A server request carrying our id and an initialize-shaped payload is not the answer.
    expect(
      await jsonProbe(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping", result })),
    ).toEqual(notMcp);
    expect(await jsonProbe(JSON.stringify({ jsonrpc: "2.0", id: 2, result }))).toEqual(notMcp);
    expect(await jsonProbe("not json")).toEqual(notMcp);
  });
});
