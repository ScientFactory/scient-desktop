/**
 * pdfjs resolves its Node "fake worker" module as a sibling of whatever bundle
 * imported it, so the packaged server needs a `dist/pdf.worker.mjs` beside the
 * validation chunk. This entry emits it; nothing imports it statically.
 */
// @ts-expect-error -- pdfjs ships no types for its worker module; only the emitted file matters.
export * from "pdfjs-dist/legacy/build/pdf.worker.mjs";
