import { runAtomCommand, squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type {
  ScientConversationExportRequest,
  ScientDocumentPdfPublished,
  ScopedThreadRef,
} from "@t3tools/contracts";

import { appAtomRegistry } from "~/rpc/atomRegistry";
import { scientDocumentPdfEnvironment } from "~/state/scientDocumentPdf";
import { readPreparedConnection } from "~/state/session";

import type {
  ConversationExportClientAvailability,
  ConversationExportProduced,
} from "../conversationExport/formatRegistry";
import { documentPdfAvailability, renderDocumentPagePdf } from "./documentPagePdf";
import {
  conversationPdfFileName,
  deliverDocumentPdf,
  openDocumentPdf,
  releaseDocumentPdfCapture,
  saveDocumentPdfCopy,
  type DocumentPdfDeliveryDependencies,
} from "./documentPdfDelivery";
import {
  printAndPublishDocumentPdf,
  type MarkdownPdfExportDependencies,
} from "./markdownPdfExport";

/**
 * Conversation → PDF from the export dialog. The server captures the
 * conversation with the dialog's options (work log, reasoning, time zone); this desktop prints the capture; the server publishes it; and the
 * PDF is saved through the same Save dialog as every other format. The
 * notice's Open shows it in Scient's reader for this conversation.
 */

export const CONVERSATION_PDF_TOO_LARGE_MESSAGE =
  "This conversation is too large for a PDF. Try leaving out the work log and reasoning, or export it as Markdown.";

export function conversationPdfAvailability(): ConversationExportClientAvailability {
  const availability = documentPdfAvailability();
  return availability.available
    ? { available: true }
    : { available: false, reason: availability.reason };
}

export interface ConversationPdfExportDependencies
  extends
    Pick<MarkdownPdfExportDependencies, "render" | "publish" | "release">,
    DocumentPdfDeliveryDependencies {
  readonly prepare: (
    request: ScientConversationExportRequest,
  ) => ReturnType<MarkdownPdfExportDependencies["prepare"]>;
  readonly open: (published: ScientDocumentPdfPublished) => void;
}

/** Exports and saves the PDF; `null` when the user cancelled the Save dialog. */
export async function runConversationPdfExport(
  dependencies: ConversationPdfExportDependencies,
  request: ScientConversationExportRequest,
): Promise<ConversationExportProduced | null> {
  const prepared = await dependencies.prepare(request);
  const published = await printAndPublishDocumentPdf(
    dependencies,
    prepared,
    CONVERSATION_PDF_TOO_LARGE_MESSAGE,
  );
  const delivery = await deliverDocumentPdf(
    dependencies,
    published,
    conversationPdfFileName(published.title),
  );
  if (delivery._tag === "cancelled") return null;
  return {
    title: delivery.title,
    description: delivery.description,
    warnings: published.warnings,
    open: () => dependencies.open(published),
  };
}

const commandOptions = { reportFailure: false, reportDefect: false } as const;

/** The dialog's PDF producer, wired to this client's environment connection and desktop. */
export function exportConversationPdf(input: {
  readonly threadRef: ScopedThreadRef;
  readonly request: ScientConversationExportRequest;
}): Promise<ConversationExportProduced | null> {
  const { environmentId } = input.threadRef;
  const availability = documentPdfAvailability();
  if (!availability.available) return Promise.reject(new Error(availability.reason));
  const connection = readPreparedConnection(environmentId);
  if (connection === null) {
    return Promise.reject(new Error("The conversation's environment is not connected."));
  }
  return runConversationPdfExport(
    {
      prepare: async (request) => {
        const result = await runAtomCommand(
          appAtomRegistry,
          scientDocumentPdfEnvironment.prepareConversation,
          { environmentId, input: request },
          commandOptions,
        );
        if (result._tag === "Failure") throw squashAtomCommandFailure(result);
        return result.value;
      },
      render: (request) =>
        renderDocumentPagePdf({
          httpBaseUrl: connection.httpBaseUrl,
          request,
          bridge: availability.bridge,
        }),
      publish: async (publishInput) => {
        const result = await runAtomCommand(
          appAtomRegistry,
          scientDocumentPdfEnvironment.publish,
          { environmentId, input: publishInput },
          commandOptions,
        );
        if (result._tag === "Failure") throw squashAtomCommandFailure(result);
        return result.value;
      },
      release: (captureId) => releaseDocumentPdfCapture(environmentId, captureId),
      saveCopy: (published, fileName) => saveDocumentPdfCopy(environmentId, published, fileName),
      open: (published) => openDocumentPdf(input.threadRef, published),
    },
    input.request,
  );
}
