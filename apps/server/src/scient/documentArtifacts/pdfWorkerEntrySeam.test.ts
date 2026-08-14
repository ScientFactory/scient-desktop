// @effect-diagnostics nodeBuiltinImport:off -- Static audit for the packaged pdfjs worker seam.
import * as NodeFS from "node:fs";
import { describe, expect, it } from "vite-plus/test";

/**
 * pdfjs resolves its Node fake-worker as `./pdf.worker.mjs` beside the bundle
 * that imported it. The packaged validation worker therefore needs the server
 * build to emit that sibling; dropping the entry ships an app whose every PDF
 * publish fails validation — found in production, never in dev, because dev
 * resolves the worker from node_modules.
 */
describe("packaged pdfjs worker seam", () => {
  it("keeps the pdf.worker entry in the server bundle", () => {
    const viteConfig = NodeFS.readFileSync(
      new URL("../../../vite.config.ts", import.meta.url),
      "utf8",
    );
    expect(viteConfig).toContain('"src/pdf.worker.ts"');
    const entrySource = NodeFS.readFileSync(
      new URL("../../pdf.worker.ts", import.meta.url),
      "utf8",
    );
    expect(entrySource).toContain('export * from "pdfjs-dist/legacy/build/pdf.worker.mjs"');
  });
});
