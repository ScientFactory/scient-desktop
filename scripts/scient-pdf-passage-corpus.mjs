import * as NodeFSP from "node:fs/promises";
import * as NodeModule from "node:module";
import * as NodeChildProcess from "node:child_process";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { passageHash, passageText } from "../apps/web/src/scient/pdf/passages/pdfPassageModel.ts";

// Read-only extraction comparison, not a test of visible selection or relocation.
// Usage: node scripts/scient-pdf-passage-corpus.mjs <reference-pdf.mjs> <pdf>...
const requireWeb = NodeModule.createRequire(new URL("../apps/web/package.json", import.meta.url));
async function extract(engine, bytes) {
  const start = performance.now();
  const task = engine.getDocument({
    data: new Uint8Array(bytes),
    disableFontFace: true,
    useSystemFonts: false,
    verbosity: 0,
  });
  try {
    const doc = await task.promise;
    const pages = [];
    for (let number = 1; number <= doc.numPages; number += 1) {
      const page = await doc.getPage(number);
      const content = await page.getTextContent({
        includeMarkedContent: true,
        disableNormalization: true,
      });
      const text = passageText(content.items);
      pages.push({
        number,
        characters: text.length,
        textHash: passageHash(text),
        viewBox: page.view,
        rotation: page.rotate,
        userUnit: page.userUnit,
      });
      page.cleanup();
    }
    return { version: engine.version, elapsedMs: Math.round(performance.now() - start), pages };
  } finally {
    await task.destroy();
  }
}
if (process.argv[2] === "--extract") {
  // Supply the same installed canvas primitives to both isolated engines. This
  // harness extracts text only; it does not use canvas rendering as evidence.
  const requirePdf = NodeModule.createRequire(
    requireWeb.resolve("pdfjs-dist/legacy/build/pdf.mjs"),
  );
  const { DOMMatrix, ImageData, Path2D } = requirePdf("@napi-rs/canvas");
  Object.assign(globalThis, { DOMMatrix, ImageData, Path2D });
  const engine = await import(NodeURL.pathToFileURL(NodePath.resolve(process.argv[3])).href);
  const result = await extract(engine, await NodeFSP.readFile(process.argv[4]));
  console.log(`SCIENT_CORPUS_JSON:${JSON.stringify(result)}`);
} else {
  const [referencePath, ...files] = process.argv.slice(2);
  if (!referencePath || !files.length)
    throw new Error("Supply a reference PDF.js module and at least one licensed PDF fixture.");
  // PDF.js's fake-worker global is process-wide: versions must never share it.
  const isolatedExtract = (engine, file) => {
    const stdout = NodeChildProcess.execFileSync(
      process.execPath,
      [NodeURL.fileURLToPath(import.meta.url), "--extract", engine, file],
      { encoding: "utf8", timeout: 30_000, maxBuffer: 2 * 1024 * 1024 },
    );
    const result = stdout.split("\n").find((line) => line.startsWith("SCIENT_CORPUS_JSON:"));
    if (!result) throw new Error("Extractor returned no result.");
    return JSON.parse(result.slice("SCIENT_CORPUS_JSON:".length));
  };
  const currentPath = requireWeb.resolve("pdfjs-dist/legacy/build/pdf.mjs");
  const results = [];
  for (const file of files) {
    const bytes = await NodeFSP.readFile(file);
    const actual = isolatedExtract(currentPath, file);
    const comparison = isolatedExtract(NodePath.resolve(referencePath), file);
    const reopened = isolatedExtract(currentPath, file);
    const sameCurrentReopen = JSON.stringify(actual.pages) === JSON.stringify(reopened.pages);
    if (!sameCurrentReopen)
      throw new Error(`Non-deterministic current extraction: ${NodePath.basename(file)}`);
    results.push({
      file: NodePath.basename(file),
      sha256: passageHash(bytes),
      byteLength: bytes.byteLength,
      current: actual,
      reference: comparison,
      sameCurrentReopen,
      sameAcrossVersions: JSON.stringify(actual.pages) === JSON.stringify(comparison.pages),
    });
  }
  console.log(JSON.stringify({ profile: "pdfjs-text-layer-utf16-eol-v1", results }, null, 2));
}
