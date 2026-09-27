import { runAtomCommand, squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type {
  ScientConversationExportRequest,
  ScientDocumentPdfPublished,
  ScopedThreadRef,
} from "@t3tools/contracts";

import { useRightPanelStore } from "~/rightPanelStore";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { scientDocumentPdfEnvironment } from "~/state/scientDocumentPdf";
import { readPreparedConnection } from "~/state/session";

import type {
  ConversationExportClientAvailability,
  ConversationExportProduced,
} from "../conversationExport/formatRegistry";
import { scientGeneratedPdfSurface } from "../rightPanel/surfaces";
import { documentPdfAvailability, renderDocumentPagePdf } from "./documentPagePdf";
import {
  printAndPublishDocumentPdf,
  type MarkdownPdfExportDependencies,
} from "./markdownPdfExport";

/**
 * Conversation → PDF from the export dialog. The server captures the
 * conversation with the dialog's options (work log, reasoning, range, time
 * zone); this desktop prints the capture; the server publishes it; and the
 * PDF opens in Scient's reader, where Save Copy keeps a copy.
 */

export const CONVERSATION_PDF_TOO_LARGE_MESSAGE =
  "The PDF is larger than Scient's 64 MiB export limit. Export a shorter range or leave out the work log.";

export function conversationPdfAvailability(): ConversationExportClientAvailability {
  const availability = documentPdfAvailability();
  return availability.available
    ? { available: true }
    : { available: false, reason: availability.reason };
}

export interface ConversationPdfExportDependencies extends Pick<
  MarkdownPdfExportDependencies,
  "render" | "publish"
> {
  readonly prepare: (
    request: ScientConversationExportRequest,
  ) => ReturnType<MarkdownPdfExportDependencies["prepare"]>;
  readonly open: (published: ScientDocumentPdfPublished) => void;
}

export async function runConversationPdfExport(
  dependencies: ConversationPdfExportDependencies,
  request: ScientConversationExportRequest,
): Promise<ConversationExportProduced> {
  const prepared = await dependencies.prepare(request);
  const published = await printAndPublishDocumentPdf(
    dependencies,
    prepared,
    CONVERSATION_PDF_TOO_LARGE_MESSAGE,
  );
  dependencies.open(published);
  return { title: "PDF exported", warnings: published.warnings };
}

const commandOptions = { reportFailure: false, reportDefect: false } as const;

/** The dialog's PDF producer, wired to this client's environment connection and desktop. */
export function exportConversationPdf(input: {
  readonly threadRef: ScopedThreadRef;
  readonly request: ScientConversationExportRequest;
}): Promise<ConversationExportProduced> {
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
      open: (published) => {
        if (published.source._tag !== "generated-pdf") return;
        useRightPanelStore
          .getState()
          .openScient(input.threadRef, scientGeneratedPdfSurface(published.source));
      },
    },
    input.request,
  );
}
