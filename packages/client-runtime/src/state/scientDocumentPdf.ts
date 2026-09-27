import { WS_METHODS } from "@t3tools/contracts";
import { Atom } from "effect/unstable/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import { createEnvironmentRpcCommand } from "./runtime.ts";

/**
 * Document PDF export is two commands: capture a saved document on the server,
 * then publish the page the desktop printed from that capture. Neither caches
 * results; the published generated-document descriptor is the reader's input,
 * and the PDF bytes never enter React state or a persisted atom.
 */
export function createScientDocumentPdfEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  return {
    prepareMarkdown: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:scient-document-pdf:prepare-markdown",
      tag: WS_METHODS.documentsPrepareMarkdownPdf,
      concurrency: {
        mode: "serial",
        key: ({ environmentId, input }) =>
          JSON.stringify([environmentId, input.cwd, input.relativePath]),
      },
    }),
    publish: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:scient-document-pdf:publish",
      tag: WS_METHODS.documentsPublishDocumentPdf,
      concurrency: {
        mode: "serial",
        key: ({ environmentId, input }) => JSON.stringify([environmentId, input.captureId]),
      },
    }),
  };
}
