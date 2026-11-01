// @effect-diagnostics nodeBuiltinImport:off -- Qualifies the Vite plugin's real local HTTP and package-file boundary.
import * as NodeFSP from "node:fs/promises";
import * as NodeHttp from "node:http";
import * as NodeModule from "node:module";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { createServer } from "vite-plus";
import { expect, it } from "vite-plus/test";
import { scientPdfAssets } from "../../../scripts/scientPdfAssets.ts";

it("serves exact local PDF support bytes with decoder MIME and refuses missing or escaping assets", async () => {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "scient-pdf-assets-"));
  const server = await createServer({
    configFile: false,
    root,
    appType: "custom",
    plugins: [scientPdfAssets()],
    server: { host: "127.0.0.1", port: 0, strictPort: true },
  });
  try {
    await server.listen();
    const address = server.httpServer?.address();
    if (!address || typeof address === "string") throw new Error("Missing owned HTTP listener");
    const request = (path: string) =>
      new Promise<{ status: number | undefined; type: string | undefined; body: Buffer }>(
        (resolve, reject) => {
          const connection = NodeHttp.get(
            { hostname: "127.0.0.1", port: address.port, path },
            (response) => {
              const chunks: Buffer[] = [];
              response.on("data", (chunk: Buffer) => chunks.push(chunk));
              response.on("error", reject);
              response.on("end", () =>
                resolve({
                  status: response.statusCode,
                  type: response.headers["content-type"],
                  body: Buffer.concat(chunks),
                }),
              );
            },
          );
          connection.on("error", reject);
        },
      );
    const require = NodeModule.createRequire(import.meta.url);
    const installed = NodePath.dirname(require.resolve("pdfjs-dist/package.json"));
    for (const [asset, type] of [
      ["standard_fonts/FoxitSerif.pfb", "application/x-font-type1"],
      ["cmaps/78-EUC-H.bcmap", "application/octet-stream"],
      ["wasm/openjpeg.wasm", "application/wasm"],
      ["wasm/openjpeg_nowasm_fallback.js", "text/javascript"],
    ] as const) {
      const response = await request(`/pdfjs-assets/${asset}`);
      expect(response.status).toBe(200);
      expect(response.type).toBe(type);
      expect(response.body).toEqual(await NodeFSP.readFile(NodePath.join(installed, asset)));
    }
    for (const path of [
      "wasm/missing.wasm",
      "standard_fonts/%2e%2e/%2e%2e/package.json",
      "wasm/%ZZ",
    ]) {
      const response = await request(`/pdfjs-assets/${path}`);
      expect(response.status).toBe(404);
    }
  } finally {
    await server.close();
    await NodeFSP.rm(root, { recursive: true, force: true });
  }
});
