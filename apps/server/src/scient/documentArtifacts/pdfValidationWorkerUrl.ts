/** Bundled modules, including lazy CLI chunks, share the emitted worker's directory. */
export function pdfValidationWorkerUrl(moduleUrl: string | URL): URL {
  const url = new URL(moduleUrl);
  return url.pathname.endsWith(".mjs")
    ? new URL("./pdf-validation-worker.mjs", url)
    : new URL("../../pdf-validation-worker.ts", url);
}
