// @effect-diagnostics nodeBuiltinImport:off -- Transport fixtures use isolated real loopback sockets.
import * as NodeHttp from "node:http";

import type { NodeHttpRequest } from "./nodeHttpResponse.ts";

export async function startHttpTransport(handle: NodeHttp.RequestListener) {
  const server = NodeHttp.createServer(handle);
  const listening = Promise.withResolvers<void>();
  server.once("error", listening.reject);
  server.listen(0, "127.0.0.1", listening.resolve);
  await listening.promise;
  server.off("error", listening.reject);
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("No fixture port.");
  const origin = `http://127.0.0.1:${address.port}`;
  const targets: URL[] = [];
  const clients = new Set<NodeHttp.ClientRequest>();
  const send: NodeHttpRequest = (url, options, onResponse) => {
    targets.push(new URL(url));
    const outgoing = NodeHttp.request(
      new URL(`${url.pathname}${url.search}`, origin),
      {
        ...options,
        agent: false,
      },
      onResponse,
    );
    clients.add(outgoing);
    outgoing.once("close", () => clients.delete(outgoing));
    return outgoing;
  };
  return {
    send,
    targets,
    async [Symbol.asyncDispose]() {
      for (const client of clients) client.destroy();
      const closed = Promise.withResolvers<void>();
      server.close((error) => (error ? closed.reject(error) : closed.resolve()));
      server.closeAllConnections();
      await closed.promise;
    },
  };
}

export function truncateHttpResponse(response: NodeHttp.ServerResponse, status = 200) {
  response.writeHead(status, {
    "Content-Length": "128",
    "Zotero-API-Version": "3",
    Connection: "close",
  });
  response.write('{"partial":', () => response.socket?.end());
}
