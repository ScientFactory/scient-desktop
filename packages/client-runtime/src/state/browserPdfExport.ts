import { WS_METHODS } from "@t3tools/contracts";
import { Atom } from "effect/unstable/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import { createEnvironmentRpcCommand } from "./runtime.ts";

/**
 * Browser PDF publication is deliberately a command rather than cached query
 * state: the immutable generated-document descriptor returned by the server
 * is the durable reader input, while the large PDF bytes never enter React
 * state or a persisted atom.
 */
export function createBrowserPdfExportEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  return {
    publish: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:browser-pdf-export:publish",
      tag: WS_METHODS.documentsPublishBrowserPdfExport,
      concurrency: {
        mode: "serial",
        key: ({ environmentId, input }) =>
          JSON.stringify([environmentId, input.logicalDocumentKey]),
      },
    }),
  };
}
