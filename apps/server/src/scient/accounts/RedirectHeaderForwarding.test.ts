// @effect-diagnostics nodeBuiltinImport:off globalFetch:off -- Local HTTP fixtures test the native fetch redirect behavior.
import * as NodeHttp from "node:http";
import type * as NodeNet from "node:net";

import { afterEach, describe, expect, it } from "@effect/vitest";

// D31: platform fetch drops `Authorization` on cross-origin redirects but keeps `x-api-key`,
// so shared Accounts keys stay refused on Pi/OMP `anthropic-messages` connections.
// If the x-api-key expectation flips, that refusal can be revisited.

const servers: NodeHttp.Server[] = [];

async function listen(handler: NodeHttp.RequestListener): Promise<number> {
  const server = NodeHttp.createServer(handler);
  servers.push(server);
  const listening = Promise.withResolvers<void>();
  server.listen(0, "127.0.0.1", () => listening.resolve());
  await listening.promise;
  return (server.address() as NodeNet.AddressInfo).port;
}

async function headersSeenAfterRedirect(status: number, header: Record<string, string>) {
  let seen: NodeHttp.IncomingHttpHeaders | undefined;
  const targetPort = await listen((request, response) => {
    seen = request.headers;
    response.end("{}");
  });
  const originPort = await listen((_request, response) => {
    response.writeHead(status, { location: `http://127.0.0.1:${targetPort}/v1/messages` });
    response.end();
  });
  await fetch(`http://127.0.0.1:${originPort}/v1/messages`, {
    method: "POST",
    headers: { ...header, "content-type": "application/json" },
    body: "{}",
  });
  expect(seen).toBeDefined();
  return seen!;
}

function close(server: NodeHttp.Server): Promise<void> {
  const closed = Promise.withResolvers<void>();
  server.close(() => closed.resolve());
  return closed.promise;
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map(close));
});

describe("platform fetch on cross-origin redirects", () => {
  it.each([307, 308])("drops Authorization on %i", async (status) => {
    const seen = await headersSeenAfterRedirect(status, { authorization: "Bearer synthetic" });
    expect(seen.authorization).toBeUndefined();
  });

  it.each([307, 308])(
    "keeps x-api-key on %i, so shared keys stay refused for anthropic-messages",
    async (status) => {
      const seen = await headersSeenAfterRedirect(status, { "x-api-key": "synthetic" });
      expect(seen["x-api-key"]).toBe("synthetic");
    },
  );
});
