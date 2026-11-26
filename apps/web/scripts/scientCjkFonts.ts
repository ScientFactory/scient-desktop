// @effect-diagnostics nodeBuiltinImport:off - Vite build plugin compresses immutable package assets.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeModule from "node:module";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeUtil from "node:util";
import * as NodeZlib from "node:zlib";

import type { Plugin } from "vite-plus";

const VIRTUAL_ID = "virtual:scient-cjk-fonts";
const RESOLVED_VIRTUAL_ID = `\0${VIRTUAL_ID}`;
const require = NodeModule.createRequire(import.meta.url);
const cjkAssetRoot = NodePath.join(
  NodePath.dirname(require.resolve("@betteroffice/fonts-cjk/package.json")),
  "assets",
);
const cacheRoot = NodeURL.fileURLToPath(
  new URL("../node_modules/.cache/scient-cjk-fonts/", import.meta.url),
);
const addonStub = NodeURL.fileURLToPath(
  new URL("../src/scient/office/fontsCjkAddon.ts", import.meta.url),
);
const brotliCompress = NodeUtil.promisify(NodeZlib.brotliCompress);

// Builds use Brotli's best setting (about 36 s for the five faces, cached afterwards); the dev server
// favours a fast first start. Both decode to the same bytes.
const BUILD_QUALITY = 11;
const DEV_QUALITY = 5;

const compressions = new Map<number, Promise<ReadonlyArray<readonly [string, string]>>>();

/** Each face's Brotli copy on disk, keyed by the face's file name, compressed once per content and quality. */
function compressedFaces(quality: number) {
  const existing = compressions.get(quality);
  if (existing) return existing;
  const compressing = (async () => {
    const files = (await NodeFSP.readdir(cjkAssetRoot)).filter((file) => file.endsWith(".otf"));
    return Promise.all(
      files.map(async (file) => {
        const source = await NodeFSP.readFile(NodePath.join(cjkAssetRoot, file));
        const digest = NodeCrypto.createHash("sha256").update(source).digest("hex").slice(0, 16);
        // Not `.br`: static servers, Vite's included, send that with `Content-Encoding: br`, and the browser would
        // hand over the decoded bytes.
        const target = NodePath.join(cacheRoot, `${digest}-q${quality}`, `${file}.brotli`);
        const cached = await NodeFSP.stat(target).catch(() => null);
        if (!cached?.isFile()) {
          const compressed = await brotliCompress(source, {
            params: {
              [NodeZlib.constants.BROTLI_PARAM_QUALITY]: quality,
              [NodeZlib.constants.BROTLI_PARAM_LGWIN]: NodeZlib.constants.BROTLI_MAX_WINDOW_BITS,
              [NodeZlib.constants.BROTLI_PARAM_SIZE_HINT]: source.byteLength,
            },
          });
          await NodeFSP.mkdir(NodePath.dirname(target), { recursive: true });
          // Concurrent builds may race; a rename never exposes a partial file.
          const partial = `${target}.${process.pid}.partial`;
          await NodeFSP.writeFile(partial, compressed);
          await NodeFSP.rename(partial, target);
        }
        return [file, target.split(NodePath.sep).join("/")] as const;
      }),
    );
  })();
  compressing.catch(() => compressions.delete(quality));
  compressions.set(quality, compressing);
  return compressing;
}

/**
 * Ships `@betteroffice/fonts-cjk`'s faces Brotli-compressed instead of as raw OTF. The add-on itself resolves to an
 * empty stub, so its raw files are never emitted; `virtual:scient-cjk-fonts` maps each face's file name to the URL
 * of its compressed copy, which `src/scient/office/cjkFonts.ts` fetches and decodes back to the original bytes.
 * Mount it in both the app's and the workers' plugin lists: the office engines load fonts in workers.
 */
export function scientCjkFonts(): Plugin {
  let quality = BUILD_QUALITY;
  return {
    name: "scient:cjk-fonts",
    enforce: "pre",
    config() {
      // An alias, unlike resolveId, also reaches `@betteroffice/fonts` when the dependency optimizer bundles it.
      return { resolve: { alias: { "@betteroffice/fonts-cjk": addonStub } } };
    },
    configResolved(config) {
      quality = config.command === "build" ? BUILD_QUALITY : DEV_QUALITY;
    },
    resolveId(id) {
      return id === VIRTUAL_ID ? RESOLVED_VIRTUAL_ID : undefined;
    },
    async load(id) {
      if (id !== RESOLVED_VIRTUAL_ID) return undefined;
      const faces = await compressedFaces(quality);
      const imports = faces.map(
        ([, path], index) => `import face${index} from ${JSON.stringify(`${path}?url`)};`,
      );
      const entries = faces.map(([file], index) => `  ${JSON.stringify(file)}: face${index},`);
      const code = [...imports, "export const CJK_FONT_BROTLI_URLS = {", ...entries, "};"];
      // Generated code has no source to map back to.
      return { code: code.join("\n"), map: { mappings: "" } };
    },
  };
}
