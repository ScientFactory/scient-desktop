// @effect-diagnostics nodeBuiltinImport:off - Vite build plugin copies immutable package assets.
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeModule from "node:module";
import * as NodePath from "node:path";

import type { Connect, Plugin } from "vite-plus";

const OCR_ASSET_ROUTE = "/ocr-assets";
const require = NodeModule.createRequire(import.meta.url);
const packageRoot = (name: string) => NodePath.dirname(require.resolve(`${name}/package.json`));

/**
 * The text recognition runtime, served from the app: the tesseract.js worker, the LSTM-only
 * Tesseract cores (plain, SIMD and relaxed SIMD; the worker picks one), and English and
 * Hebrew language data. Nothing is fetched from a CDN.
 */
function ocrAssets(): ReadonlyMap<string, string> {
  const tesseract = packageRoot("tesseract.js");
  const core = packageRoot("tesseract.js-core");
  const language = (code: string) =>
    NodePath.join(
      packageRoot(`@tesseract.js-data/${code}`),
      "4.0.0_best_int",
      `${code}.traineddata.gz`,
    );
  return new Map([
    ["worker.min.js", NodePath.join(tesseract, "dist/worker.min.js")],
    ["worker.min.js.LICENSE.txt", NodePath.join(tesseract, "dist/worker.min.js.LICENSE.txt")],
    ["LICENSE-tesseract.js.md", NodePath.join(tesseract, "LICENSE.md")],
    ["core/LICENSE", NodePath.join(core, "LICENSE")],
    ...["", "-simd", "-relaxedsimd"].map(
      (variant) =>
        [
          `core/tesseract-core${variant}-lstm.wasm.js`,
          NodePath.join(core, `tesseract-core${variant}-lstm.wasm.js`),
        ] as const,
    ),
    ["lang/eng.traineddata.gz", language("eng")],
    ["lang/heb.traineddata.gz", language("heb")],
  ]);
}

const LANGUAGE_NOTICE = `English and Hebrew recognition models: tessdata_best (integer versions packaged as
@tesseract.js-data/eng and @tesseract.js-data/heb 1.0.0), from the Tesseract OCR project,
https://github.com/tesseract-ocr/tessdata_best, licensed under the Apache License 2.0
(see LICENSE-tesseract.js.md for the license text).
`;

function contentType(path: string): string {
  if (path.endsWith(".js")) return "text/javascript";
  if (path.endsWith(".gz")) return "application/gzip";
  return "text/plain; charset=utf-8";
}

/** Bundles the text recognition runtime locally and exposes the same paths in development. */
export function scientOcrAssets(): Plugin {
  return {
    name: "scient:ocr-assets",
    configureServer(server) {
      server.middlewares.use(OCR_ASSET_ROUTE, ((request, response, next) => {
        void (async () => {
          const name = decodeURIComponent((request.url ?? "").split(/[?#]/, 1)[0] ?? "").replace(
            /^\/+/,
            "",
          );
          if (name === "lang/NOTICE.txt") {
            response.statusCode = 200;
            response.setHeader("Content-Type", contentType(name));
            response.end(LANGUAGE_NOTICE);
            return;
          }
          // Only the listed files are served, so a request path never reaches the disk.
          const sourcePath = ocrAssets().get(name);
          const info = sourcePath ? await NodeFSP.stat(sourcePath).catch(() => null) : null;
          if (!sourcePath || !info?.isFile()) {
            next();
            return;
          }
          response.statusCode = 200;
          response.setHeader("Cache-Control", "no-cache");
          response.setHeader("Content-Length", String(info.size));
          response.setHeader("Content-Type", contentType(sourcePath));
          NodeFS.createReadStream(sourcePath).pipe(response);
        })().catch(next);
      }) as Connect.NextHandleFunction);
    },
    async generateBundle() {
      for (const [name, sourcePath] of ocrAssets()) {
        this.emitFile({
          type: "asset",
          fileName: `ocr-assets/${name}`,
          source: await NodeFSP.readFile(sourcePath),
        });
      }
      this.emitFile({
        type: "asset",
        fileName: "ocr-assets/lang/NOTICE.txt",
        source: LANGUAGE_NOTICE,
      });
    },
  };
}
