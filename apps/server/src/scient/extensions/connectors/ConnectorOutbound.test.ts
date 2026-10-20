// @effect-diagnostics nodeBuiltinImport:off -- Tests run real local HTTP origins.
import * as NodeHttp from "node:http";

import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

import {
  checkConnectorUrl,
  controlFetch,
  ConnectorEgressRejected,
  describeEgressFailure,
  egressPolicyFor,
  isPublicAddress,
  makeConnectorFetch,
  STRICT_EGRESS_POLICY,
} from "./ConnectorOutbound.ts";

interface Received {
  readonly path: string;
  readonly method: string;
  readonly authorization: string | undefined;
  readonly apiKey: string | undefined;
  readonly body: string;
}

interface TestOrigin {
  readonly server: NodeHttp.Server;
  readonly received: Received[];
  readonly origin: string;
}

const startOrigin = async (
  handle: (path: string, response: NodeHttp.ServerResponse) => void,
): Promise<TestOrigin> => {
  const received: Received[] = [];
  const server = NodeHttp.createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => {
      received.push({
        path: request.url ?? "/",
        method: request.method ?? "GET",
        authorization: request.headers.authorization,
        apiKey: request.headers["x-api-key"] as string | undefined,
        body,
      });
      handle(request.url ?? "/", response);
    });
  });
  const listening = Promise.withResolvers<void>();
  server.listen(0, "127.0.0.1", listening.resolve);
  await listening.promise;
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no port");
  return { server, received, origin: `http://127.0.0.1:${address.port}` };
};

let other: TestOrigin;
let typed: TestOrigin;

beforeAll(async () => {
  other = await startOrigin((_path, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end("{}");
  });
  typed = await startOrigin((path, response) => {
    if (path === "/same-origin-redirect") {
      response.writeHead(307, { location: "/landing" });
      response.end();
      return;
    }
    if (path === "/cross-origin-redirect") {
      response.writeHead(307, { location: `${other.origin}/steal` });
      response.end();
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end("{}");
  });
});

afterAll(async () => {
  for (const { server } of [other, typed]) {
    server.closeAllConnections();
    const closed = Promise.withResolvers<void>();
    server.close(() => closed.resolve());
    await closed.promise;
  }
});

describe("connector egress policy", () => {
  it("allows https anywhere public and plain http only to the exact loopback origin typed", () => {
    const loopback = egressPolicyFor("http://127.0.0.1:8080/mcp", { type: "url" });
    expect(
      String(checkConnectorUrl("https://mcp.example.com/mcp#frag", STRICT_EGRESS_POLICY)),
    ).toBe("https://mcp.example.com/mcp");
    expect(checkConnectorUrl("http://127.0.0.1:8080/other", loopback)).toBeInstanceOf(URL);
    for (const url of [
      "http://127.0.0.1:8081/mcp",
      "http://localhost:8080/mcp",
      "https://127.0.0.1:8080/mcp",
      "http://mcp.example.com/mcp",
      "http://2130706433:8081/",
      "http://0x7f.1:8081/",
    ]) {
      expect(checkConnectorUrl(url, loopback)).toBeInstanceOf(ConnectorEgressRejected);
    }
  });

  it("never grants loopback to a typed public address or to registry and plugin sources", () => {
    const publicTyped = egressPolicyFor("https://mcp.example.com/mcp", { type: "url" });
    const registry = egressPolicyFor("http://127.0.0.1:8080/mcp", { type: "registry" });
    for (const policy of [publicTyped, registry]) {
      for (const url of [
        "http://127.0.0.1:8080/mcp",
        "https://localhost/mcp",
        "https://[::1]/mcp",
        "https://[::ffff:127.0.0.1]/mcp",
      ]) {
        expect(checkConnectorUrl(url, policy)).toBeInstanceOf(ConnectorEgressRejected);
      }
    }
    expect(
      checkConnectorUrl("https://user:pass@mcp.example.com/mcp", STRICT_EGRESS_POLICY),
    ).toBeInstanceOf(ConnectorEgressRejected);
    expect(checkConnectorUrl("ftp://mcp.example.com/mcp", STRICT_EGRESS_POLICY)).toBeInstanceOf(
      ConnectorEgressRejected,
    );
  });

  it("classifies special-use, translation and embedded-private IPv6 as non-public", () => {
    for (const address of [
      "::",
      "::1",
      "fc00::1",
      "fd12:3456::1",
      "fe80::1",
      "fec0::1",
      "ff02::1",
      "64:ff9b::a00:1",
      "64:ff9b:1::a00:1",
      "100::1",
      "2001:db8::1",
      "2001:0:4136:e378::1",
      "2001:2::1",
      "2002:a00:1::1",
      "3fff::1",
      "::ffff:10.0.0.1",
      "::ffff:a00:1",
      "::10.0.0.1",
      "0:0:0:0:0:ffff:7f00:1",
      "10.1.2.3",
      "100.64.0.1",
      "169.254.169.254",
      "192.88.99.1",
    ]) {
      expect(isPublicAddress(address), address).toBe(false);
    }
    for (const address of [
      "8.8.8.8",
      "2606:4700:4700::1111",
      "2002:808:808::1",
      "::ffff:8.8.8.8",
    ]) {
      expect(isPublicAddress(address), address).toBe(true);
    }
    for (const host of ["[fec0::1]", "[64:ff9b:1::a00:1]", "[2002:a00:1::1]", "[::ffff:a00:1]"]) {
      expect(checkConnectorUrl(`https://${host}/mcp`, STRICT_EGRESS_POLICY)).toBeInstanceOf(
        ConnectorEgressRejected,
      );
    }
  });

  it("checks the resolved address of a hostname before connecting", async () => {
    const fetch = makeConnectorFetch({
      policy: STRICT_EGRESS_POLICY,
      redirect: "error",
      timeoutMs: 5_000,
      maxResponseBytes: 1024,
    });
    // `localhost.` resolves to loopback but is not the loopback origin the user typed.
    const failure = await fetch("https://localhost./mcp").then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(TypeError);
    expect(failure instanceof Error ? failure.cause : undefined).toBeInstanceOf(
      ConnectorEgressRejected,
    );
    expect(describeEgressFailure(failure)).toContain("private, link-local or loopback");
  });
});

describe("connector redirects", () => {
  const policy = () => egressPolicyFor(`${typed.origin}/mcp`, { type: "url" });

  it("never replays credentials or token-request bodies through a redirect", async () => {
    const fetch = controlFetch(policy());
    const before = typed.received.length;
    for (const init of [
      {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: "refresh_token=SYNTHETIC_REFRESH&client_secret=SYNTHETIC_CLIENT",
      },
      { method: "GET", headers: { authorization: "Bearer SYNTHETIC_TOKEN" } },
      { method: "GET", headers: { "x-api-key": "SYNTHETIC_KEY" } },
    ]) {
      const failure = await fetch(`${typed.origin}/same-origin-redirect`, init).then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(failure).toBeInstanceOf(ConnectorEgressRejected);
    }
    const followed = typed.received.slice(before).map((entry) => entry.path);
    expect(followed).toEqual([
      "/same-origin-redirect",
      "/same-origin-redirect",
      "/same-origin-redirect",
    ]);
  });

  it("follows unauthenticated discovery redirects only within the policy", async () => {
    const fetch = controlFetch(policy());
    const response = await fetch(`${typed.origin}/same-origin-redirect`, {
      headers: { accept: "application/json", "mcp-protocol-version": "2025-11-25" },
    });
    expect(response.status).toBe(200);
    expect(typed.received.at(-1)?.path).toBe("/landing");

    // Another loopback origin was never typed, so even a bare GET cannot reach it.
    const crossOrigin = await fetch(`${typed.origin}/cross-origin-redirect`).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(crossOrigin).toBeInstanceOf(ConnectorEgressRejected);
    expect(other.received).toEqual([]);
  });
});
