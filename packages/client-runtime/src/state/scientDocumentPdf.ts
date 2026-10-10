import { WS_METHODS } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "./runtime.ts";

/**
 * Document PDF export is two commands: capture a saved document on the server,
 * then publish the page the desktop printed from that capture, or release the
 * capture when the desktop refused to print it. None caches
 * results; the published generated-document descriptor is the reader's input,
 * and the PDF bytes never enter React state or a persisted atom.
 */
export function createScientDocumentPdfEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  return {
    hostRequests: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "environment-data:scient-document-pdf:host-requests",
      tag: WS_METHODS.documentsHostConnect,
      idleTtlMs: 0,
    }),
    respondToHost: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:scient-document-pdf:host-response",
      tag: WS_METHODS.documentsHostRespond,
    }),
    prepareMarkdown: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:scient-document-pdf:prepare-markdown",
      tag: WS_METHODS.documentsPrepareMarkdownPdf,
      concurrency: {
        mode: "serial",
        key: ({ environmentId, input }) =>
          JSON.stringify([environmentId, input.cwd, input.relativePath]),
      },
    }),
    prepareConversation: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:scient-document-pdf:prepare-conversation",
      tag: WS_METHODS.documentsPrepareConversationPdf,
      concurrency: {
        mode: "serial",
        key: ({ environmentId, input }) => JSON.stringify([environmentId, input.threadId]),
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
    release: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:scient-document-pdf:release",
      tag: WS_METHODS.documentsReleaseDocumentPdf,
      concurrency: {
        mode: "serial",
        key: ({ environmentId, input }) => JSON.stringify([environmentId, input.captureId]),
      },
    }),
  };
}
