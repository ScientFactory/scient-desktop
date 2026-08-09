// @effect-diagnostics nodeBuiltinImport:off - Vite build plugin copies immutable package assets.
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeModule from "node:module";

import type { Connect, Plugin } from "vite-plus";

const PDF_ASSET_ROUTE = "/pdfjs-assets";
const PDF_ASSET_DIRECTORIES = ["cmaps", "standard_fonts", "wasm", "web/images"] as const;
const require = NodeModule.createRequire(import.meta.url);
const pdfJsRoot = NodePath.dirname(require.resolve("pdfjs-dist/package.json"));

function outputDirectory(sourceDirectory: (typeof PDF_ASSET_DIRECTORIES)[number]): string {
  return sourceDirectory === "web/images" ? "images" : sourceDirectory;
}

async function listFiles(directory: string): Promise<ReadonlyArray<string>> {
  const entries = await NodeFSP.readdir(directory, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const absolutePath = NodePath.join(directory, entry.name);
      return entry.isDirectory() ? listFiles(absolutePath) : [absolutePath];
    }),
  );
  return files.flat();
}

function contentType(path: string): string {
  switch (NodePath.extname(path).toLowerCase()) {
    case ".svg":
      return "image/svg+xml";
    case ".png":
      return "image/png";
    case ".ttf":
      return "font/ttf";
    case ".pfb":
      return "application/x-font-type1";
    case ".wasm":
      return "application/wasm";
    default:
      return "application/octet-stream";
  }
}

function resolveDevelopmentAsset(url: string): string | null {
  const pathname = url.split(/[?#]/, 1)[0] ?? "";
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname).replace(/^\/+/, "");
  } catch {
    return null;
  }
  const normalized = NodePath.posix.normalize(decoded);
  if (normalized === ".." || normalized.startsWith("../")) return null;

  for (const sourceDirectory of PDF_ASSET_DIRECTORIES) {
    const publicDirectory = outputDirectory(sourceDirectory);
    if (normalized !== publicDirectory && !normalized.startsWith(`${publicDirectory}/`)) continue;
    const relativePath = normalized.slice(publicDirectory.length).replace(/^\/+/, "");
    const sourceRoot = NodePath.resolve(pdfJsRoot, sourceDirectory);
    const candidate = NodePath.resolve(sourceRoot, relativePath);
    const rootPrefix = sourceRoot.endsWith(NodePath.sep)
      ? sourceRoot
      : `${sourceRoot}${NodePath.sep}`;
    return candidate === sourceRoot || candidate.startsWith(rootPrefix) ? candidate : null;
  }
  return null;
}

/** Bundles PDF.js support data locally and exposes the same paths in development. */
export function scientPdfAssets(): Plugin {
  return {
    name: "scient:pdf-assets",
    configureServer(server) {
      server.middlewares.use(PDF_ASSET_ROUTE, ((request, response, next) => {
        void (async () => {
          const sourcePath = resolveDevelopmentAsset(request.url ?? "");
          if (!sourcePath) {
            next();
            return;
          }
          const info = await NodeFSP.stat(sourcePath).catch(() => null);
          if (!info?.isFile()) {
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
      this.emitFile({
        type: "asset",
        fileName: "pdfjs-assets/LICENSE",
        source: await NodeFSP.readFile(NodePath.join(pdfJsRoot, "LICENSE")),
      });
      for (const sourceDirectory of PDF_ASSET_DIRECTORIES) {
        const sourceRoot = NodePath.resolve(pdfJsRoot, sourceDirectory);
        const publicDirectory = outputDirectory(sourceDirectory);
        for (const sourcePath of await listFiles(sourceRoot)) {
          const relativePath = NodePath.relative(sourceRoot, sourcePath)
            .split(NodePath.sep)
            .join("/");
          this.emitFile({
            type: "asset",
            fileName: `pdfjs-assets/${publicDirectory}/${relativePath}`,
            source: await NodeFSP.readFile(sourcePath),
          });
        }
      }
    },
  };
}
