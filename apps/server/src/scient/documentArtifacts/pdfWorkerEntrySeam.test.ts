// @effect-diagnostics nodeBuiltinImport:off -- Static audit for the packaged pdfjs worker seam.
import * as NodeFS from "node:fs";
import { describe, expect, it } from "vite-plus/test";

/**
 * pdfjs resolves its Node fake-worker beside the importing bundle. The server build must emit
 * pdf.worker.mjs there; dev's node_modules resolution can hide a broken packaged validation path.
 */
describe("packaged pdfjs worker seam", () => {
  // regression: 58751dd49c fix(server): ship the pdfjs worker module the packaged validator loads
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
