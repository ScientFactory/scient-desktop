// @effect-diagnostics nodeBuiltinImport:off -- Owns the Node worker entry location.
import * as NodeSea from "node:sea";

/** Bundled modules and the executable share the emitted worker's directory. */
export function pdfValidationWorkerUrl(moduleUrl: string | URL): URL {
  const url = new URL(moduleUrl);
  return NodeSea.isSea() || url.pathname.endsWith(".mjs")
    ? new URL("./pdf-validation-worker.mjs", url)
    : new URL("../../pdf-validation-worker.ts", url);
}
