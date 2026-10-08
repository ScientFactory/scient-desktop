import * as Schema from "effect/Schema";
import * as Rpc from "effect/rpc/Rpc";

import {
  ScientDocumentHost,
  ScientDocumentHostResponse,
  ScientDocumentHostStreamEvent,
} from "../scientDocumentHost.ts";
import { PreviewAutomationError } from "../previewAutomation.ts";

import { EnvironmentAuthorizationError } from "../auth.ts";
import {
  BrowserPdfExportError,
  BrowserPdfExportInput,
  BrowserPdfExportResult,
  ServerBrowserPdfExportInput,
  ServerBrowserDocumentNavigateInput,
} from "../browserPdfExport.ts";
import {
  ScientDocumentPdfExportError,
  ScientDocumentPdfPrepared,
  ScientDocumentPdfPublished,
  ScientDocumentPdfPublishInput,
  ScientDocumentPdfReleaseInput,
  ScientMarkdownPdfPrepareInput,
} from "../scientDocumentExport.ts";
import {
  ScientConversationExportError,
  ScientConversationExportRequest,
} from "../scientConversationExport.ts";

/** Spread into rpc.ts WS_METHODS where these methods have always been listed. */
export const SCIENT_DOCUMENT_PDF_WS_METHODS = {
  documentsHostConnect: "documents.hostConnect",
  documentsHostRespond: "documents.hostRespond",
  documentsExportServerBrowserPdf: "documents.exportServerBrowserPdf",
  documentsNavigateServerBrowser: "documents.navigateServerBrowser",
  documentsPublishBrowserPdfExport: "documents.publishBrowserPdfExport",
  documentsPrepareMarkdownPdf: "documents.prepareMarkdownPdf",
  documentsPublishDocumentPdf: "documents.publishDocumentPdf",
  documentsPrepareConversationPdf: "documents.prepareConversationPdf",
  documentsReleaseDocumentPdf: "documents.releaseDocumentPdf",
} as const;

export const WsDocumentsExportServerBrowserPdfRpc = Rpc.make(
  SCIENT_DOCUMENT_PDF_WS_METHODS.documentsExportServerBrowserPdf,
  {
    payload: ServerBrowserPdfExportInput,
    success: BrowserPdfExportResult,
    error: Schema.Union([BrowserPdfExportError, EnvironmentAuthorizationError]),
  },
);
export const WsDocumentsNavigateServerBrowserRpc = Rpc.make(
  SCIENT_DOCUMENT_PDF_WS_METHODS.documentsNavigateServerBrowser,
  {
    payload: ServerBrowserDocumentNavigateInput,
    error: Schema.Union([BrowserPdfExportError, EnvironmentAuthorizationError]),
  },
);
export const WsDocumentsPublishBrowserPdfExportRpc = Rpc.make(
  SCIENT_DOCUMENT_PDF_WS_METHODS.documentsPublishBrowserPdfExport,
  {
    payload: BrowserPdfExportInput,
    success: BrowserPdfExportResult,
    error: Schema.Union([BrowserPdfExportError, EnvironmentAuthorizationError]),
  },
);
export const WsDocumentsPrepareMarkdownPdfRpc = Rpc.make(
  SCIENT_DOCUMENT_PDF_WS_METHODS.documentsPrepareMarkdownPdf,
  {
    payload: ScientMarkdownPdfPrepareInput,
    success: ScientDocumentPdfPrepared,
    error: Schema.Union([ScientDocumentPdfExportError, EnvironmentAuthorizationError]),
  },
);
export const WsDocumentsPrepareConversationPdfRpc = Rpc.make(
  SCIENT_DOCUMENT_PDF_WS_METHODS.documentsPrepareConversationPdf,
  {
    payload: ScientConversationExportRequest,
    success: ScientDocumentPdfPrepared,
    error: Schema.Union([
      ScientDocumentPdfExportError,
      ScientConversationExportError,
      EnvironmentAuthorizationError,
    ]),
  },
);
export const WsDocumentsPublishDocumentPdfRpc = Rpc.make(
  SCIENT_DOCUMENT_PDF_WS_METHODS.documentsPublishDocumentPdf,
  {
    payload: ScientDocumentPdfPublishInput,
    success: ScientDocumentPdfPublished,
    error: Schema.Union([ScientDocumentPdfExportError, EnvironmentAuthorizationError]),
  },
);
export const WsDocumentsReleaseDocumentPdfRpc = Rpc.make(
  SCIENT_DOCUMENT_PDF_WS_METHODS.documentsReleaseDocumentPdf,
  {
    payload: ScientDocumentPdfReleaseInput,
    error: EnvironmentAuthorizationError,
  },
);

export const WsDocumentsHostConnectRpc = Rpc.make(
  SCIENT_DOCUMENT_PDF_WS_METHODS.documentsHostConnect,
  {
    payload: ScientDocumentHost,
    success: ScientDocumentHostStreamEvent,
    stream: true,
    error: Schema.Union([PreviewAutomationError, EnvironmentAuthorizationError]),
  },
);
export const WsDocumentsHostRespondRpc = Rpc.make(
  SCIENT_DOCUMENT_PDF_WS_METHODS.documentsHostRespond,
  {
    payload: ScientDocumentHostResponse,
    success: Schema.Struct({ accepted: Schema.Boolean }),
    error: Schema.Union([PreviewAutomationError, EnvironmentAuthorizationError]),
  },
);
