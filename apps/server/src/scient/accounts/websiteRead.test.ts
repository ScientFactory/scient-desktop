// @effect-diagnostics nodeBuiltinImport:off -- A synthetic site on this computer, for the real transport.
import * as NodeHttp from "node:http";

import { afterEach, describe, expect, it } from "@effect/vitest";

import { readSite, siteTransport } from "./websiteRead.ts";

const servers: NodeHttp.Server[] = [];
afterEach(async () => {
  await Promise.all(
    servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))),
  );
});

/** A site on 127.0.0.1 answering each path as `routes` says. */
const site = async (routes: Record<string, (response: NodeHttp.ServerResponse) => void>) => {
  const server = NodeHttp.createServer((request, response) =>
    (routes[request.url ?? ""] ?? ((answer) => answer.writeHead(404).end()))(response),
  );
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  return (path: string) => new URL(`http://127.0.0.1:${port}${path}`);
};

const none = { cookie: "", userAgent: undefined };

describe("readSite over the real transport", () => {
  it("keeps a bodiless answer and its rotation", async () => {
    const at = await site({
      "/keepalive": (response) =>
        response.writeHead(204, { "set-cookie": "sid=rotated; Path=/; Secure; HttpOnly" }).end(),
    });
    // regression: rebuilding a 204 with a body threw, so the read came back as unreachable.
    expect(await readSite(siteTransport, at("/keepalive"), none)).toMatchObject({
      status: 204,
      setCookies: ["sid=rotated; Path=/; Secure; HttpOnly"],
    });
  });

  it("stops reading past the size limit instead of holding the whole answer", async () => {
    const closed = Promise.withResolvers<boolean>();
    const at = await site({
      "/export": (response) => {
        response.writeHead(200, { "content-type": "application/octet-stream" });
        const chunk = Buffer.alloc(1024 * 1024);
        let sent = 0;
        const more = () => {
          while (sent < 64 && response.write(chunk)) sent += 1;
          if (sent < 64) response.once("drain", more);
          else response.end();
        };
        response.on("close", () => closed.resolve(sent < 64));
        more();
      },
    });
    expect(await readSite(siteTransport, at("/export"), none)).toBe("too-large");
    // The site saw the read end before it had sent all of it.
    expect(await closed.promise).toBe(true);
  });
});
