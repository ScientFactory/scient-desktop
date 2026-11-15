import { describe, expect, it } from "@effect/vitest";

import type { ConnectorFetch } from "./ConnectorOutbound.ts";
import { connectorRetryDelay, probeConnector } from "./ConnectorProbe.ts";

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

describe("probeConnector's time budget", () => {
  const url = "https://mcp.example.com/mcp";
  const late = {
    type: "unreachable",
    message:
      "The service did not answer within 0 seconds. Hosted servers sometimes take a while to wake up: try once more in a minute.",
  };
  /** A fetch that never answers, as a real one would: only its signal ends it. */
  const stalledFetch: ConnectorFetch = (_url, init) =>
    new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
    });

  it("tells a server that misses its budget to try again", async () => {
    // regression: a literal five-second deadline ignored the budget it was given.
    expect(await probeConnector({ url, fetch: stalledFetch, timeoutMs: 100 })).toEqual(late);
  });

  it("bounds the reply body too, not only its headers", async () => {
    // Headers arrive at once; the event stream then says nothing.
    const stalled: ConnectorFetch = async () =>
      new Response(new ReadableStream<Uint8Array>({ start() {} }), {
        headers: { "content-type": "text/event-stream" },
      });
    expect(await probeConnector({ url, fetch: stalled, timeoutMs: 100 })).toEqual(late);
  });

  it("stops when the caller stops waiting", async () => {
    const stopped = new AbortController();
    let aborted = false;
    const fetch: ConnectorFetch = (input, init) => {
      init?.signal?.addEventListener("abort", () => {
        aborted = true;
      });
      return stalledFetch(input, init);
    };
    const probing = probeConnector({ url, fetch, signal: stopped.signal, timeoutMs: 60_000 });
    stopped.abort();
    expect((await probing).type).toBe("unreachable");
    expect(aborted).toBe(true);
  });

  it("answers without waiting for the server to end the session it opened", async () => {
    const fetch: ConnectorFetch = async (_input, init) =>
      init?.method === "DELETE"
        ? new Promise<Response>(() => undefined)
        : new Response(REPLY, {
            headers: { "content-type": "application/json", "mcp-session-id": "probe-session" },
          });
    expect(await probeConnector({ url, fetch, timeoutMs: 60_000 })).toEqual(OPEN);
  });
});

it("retries only temporary handshake failures within the retry budget", () => {
  expect(connectorRetryDelay(429, null, 0, 0, 5000)).toBe(500);
  expect(connectorRetryDelay(429, null, 1, 0, 5000)).toBe(1000);
  expect(connectorRetryDelay(429, "2", 0, 0, 5000)).toBe(2000);
  expect(connectorRetryDelay(503, "Thu, 01 Jan 1970 00:00:03 GMT", 0, 1000, 5000)).toBe(2000);
  expect(connectorRetryDelay(429, "60", 0, 0, 5000)).toBeUndefined();
  expect(connectorRetryDelay(429, "0", 2, 0, 5000)).toBeUndefined();
  expect(connectorRetryDelay(503, null, 0, 0, 5000)).toBe(500);
  expect(connectorRetryDelay(500, "1", 0, 0, 5000)).toBeUndefined();
});
