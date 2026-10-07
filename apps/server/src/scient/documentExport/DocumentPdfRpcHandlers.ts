/**
 * Scient's document PDF RPCs: publishing a browser export, preparing
 * Markdown and conversation PDFs, and publishing or releasing a captured
 * document PDF.
 *
 * @module DocumentPdfRpcHandlers
 */
import { WS_METHODS, WsWorkspaceRpcGroup } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import type { ScientRpcHandlerSubset, ScientRpcObservers } from "../ScientRpcObservers.ts";
import { ConversationExportService } from "../conversationExport/ConversationExportService.ts";
import { publishBrowserPdfExport } from "../documentArtifacts/BrowserPdfExportPublication.ts";
import * as GeneratedDocumentStore from "../documentArtifacts/GeneratedDocumentStore.ts";
import { prepareConversationPdf } from "./ConversationPdfPreparation.ts";
import { removeDocumentCapture } from "./DocumentCapture.ts";
import { publishCapturedDocumentPdf } from "./DocumentPdfPublication.ts";
import { prepareMarkdownPdf } from "./MarkdownPdfPreparation.ts";

export const makeDocumentPdfRpcHandlers = ({
  observeRpcEffect,
  generatedDocuments,
  conversationExports,
}: Pick<ScientRpcObservers, "observeRpcEffect"> & {
  readonly generatedDocuments: GeneratedDocumentStore.GeneratedDocumentStore["Service"];
  readonly conversationExports: ConversationExportService["Service"];
}) =>
  ({
    [WS_METHODS.documentsPublishBrowserPdfExport]: (input) =>
      observeRpcEffect(
        WS_METHODS.documentsPublishBrowserPdfExport,
        publishBrowserPdfExport(generatedDocuments, input),
        { "rpc.aggregate": "documents" },
      ),
    [WS_METHODS.documentsPrepareMarkdownPdf]: (input) =>
      observeRpcEffect(WS_METHODS.documentsPrepareMarkdownPdf, prepareMarkdownPdf(input), {
        "rpc.aggregate": "documents",
      }),
    [WS_METHODS.documentsPrepareConversationPdf]: (input) =>
      observeRpcEffect(
        WS_METHODS.documentsPrepareConversationPdf,
        prepareConversationPdf(input).pipe(
          Effect.provideService(ConversationExportService, conversationExports),
        ),
        { "rpc.aggregate": "documents" },
      ),
    [WS_METHODS.documentsPublishDocumentPdf]: (input) =>
      observeRpcEffect(
        WS_METHODS.documentsPublishDocumentPdf,
        publishCapturedDocumentPdf(input).pipe(
          Effect.provideService(GeneratedDocumentStore.GeneratedDocumentStore, generatedDocuments),
        ),
        { "rpc.aggregate": "documents" },
      ),
    [WS_METHODS.documentsReleaseDocumentPdf]: (input) =>
      observeRpcEffect(
        WS_METHODS.documentsReleaseDocumentPdf,
        removeDocumentCapture(input.captureId),
        { "rpc.aggregate": "documents" },
      ),
  }) satisfies ScientRpcHandlerSubset<
    typeof WsWorkspaceRpcGroup,
    | typeof WS_METHODS.documentsPublishBrowserPdfExport
    | typeof WS_METHODS.documentsPrepareMarkdownPdf
    | typeof WS_METHODS.documentsPrepareConversationPdf
    | typeof WS_METHODS.documentsPublishDocumentPdf
    | typeof WS_METHODS.documentsReleaseDocumentPdf
  >;
