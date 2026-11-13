// @effect-diagnostics nodeBuiltinImport:off -- Local servers stand in for a bundle's address.
import * as NodeFSP from "node:fs/promises";
import * as NodeHttp from "node:http";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { egressPolicyFor, makeConnectorFetch } from "./ConnectorOutbound.ts";
import { bundleFetch, downloadBundle } from "./LocalBundleDownload.ts";

const SHA256 = "0".repeat(64);

const scratch = Effect.acquireRelease(
  Effect.promise(() => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "scient-bundle-"))),
  (folder) => Effect.promise(() => NodeFSP.rm(folder, { recursive: true, force: true })),
);

/** A loopback server answering every request with `answer`; records the paths it was asked. */
const server = (answer: (response: NodeHttp.ServerResponse) => void) =>
  Effect.acquireRelease(
    Effect.promise(async () => {
      const asked: string[] = [];
      const created = NodeHttp.createServer((request, response) => {
        asked.push(request.url ?? "/");
        answer(response);
      });
      await new Promise<void>((resolve) => created.listen(0, "127.0.0.1", resolve));
      const address = created.address() as { readonly port: number };
      return { created, asked, origin: `http://127.0.0.1:${address.port}` };
    }),
    ({ created }) =>
      Effect.promise(
        () =>
          new Promise<void>((resolve) => {
            created.closeAllConnections();
            created.close(() => resolve());
          }),
      ),
  );

const left = (folder: string) => Effect.promise(() => NodeFSP.readdir(folder));

describe("registry bundle downloads", () => {
  it.effect("never fetch from a private address", () =>
    Effect.gen(function* () {
      const folder = yield* scratch;
      const refused = yield* Effect.flip(
        downloadBundle(
          { url: "https://10.1.2.3/echo.mcpb", sha256: SHA256 },
          NodePath.join(folder, "echo.mcpb"),
          bundleFetch,
        ),
      );
      expect(refused.message).toContain("private");
      expect(yield* left(folder)).toEqual([]);
    }).pipe(Effect.scoped),
  );

  it.effect("check every redirect: one to plain http elsewhere is refused unfollowed", () =>
    Effect.gen(function* () {
      const folder = yield* scratch;
      const elsewhere = yield* server((response) => response.end("bundle bytes"));
      const listed = yield* server((response) => {
        response.writeHead(302, { location: `${elsewhere.origin}/echo.mcpb` });
        response.end();
      });
      // The listed address is the one origin allowed here; the redirect leaves it for plain http.
      const fetch = makeConnectorFetch({
        policy: egressPolicyFor(`${listed.origin}/echo.mcpb`, { type: "url" }),
        redirect: "unauthenticated-get",
        timeoutMs: 30_000,
        maxResponseBytes: 1024,
      });
      const refused = yield* Effect.flip(
        downloadBundle(
          { url: `${listed.origin}/echo.mcpb`, sha256: SHA256 },
          NodePath.join(folder, "echo.mcpb"),
          fetch,
        ),
      );
      // regression: the download followed redirects itself, to any address.
      expect(refused.message).toContain("Scient could not download the bundle");
      expect(elsewhere.asked).toEqual([]);
      expect(yield* left(folder)).toEqual([]);
    }).pipe(Effect.scoped),
  );
});
