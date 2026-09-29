import {
  ScientDocumentPageRenderRequest,
  type DesktopBridge,
  type ScientDocumentPageRenderOutcome,
} from "@t3tools/contracts";
import * as Encoding from "effect/Encoding";
import * as Schema from "effect/Schema";

import { resolveAssetUrl } from "~/assets/assetUrls";

/**
 * The client half of document PDF export: ask the desktop to print one
 * captured document page. PDF output is a desktop capability; a browser
 * client, or a desktop shell that predates the document page, reports why it
 * cannot export instead of trying.
 */

export type DocumentPdfAvailability =
  | { readonly available: true; readonly bridge: DesktopBridge }
  | { readonly available: false; readonly reason: string };

export const DOCUMENT_PDF_DESKTOP_REQUIRED =
  "PDF export needs the Scient desktop app. Open this project in Scient on your computer to export it.";
export const DOCUMENT_PDF_DESKTOP_OUTDATED =
  "This version of the Scient desktop app cannot export documents as PDF. Update Scient to export.";

export function documentPdfAvailability(
  bridge: DesktopBridge | undefined = typeof window === "undefined"
    ? undefined
    : window.desktopBridge,
): DocumentPdfAvailability {
  if (bridge === undefined) return { available: false, reason: DOCUMENT_PDF_DESKTOP_REQUIRED };
  if (bridge.renderDocumentPagePdf === undefined) {
    return { available: false, reason: DOCUMENT_PDF_DESKTOP_OUTDATED };
  }
  return { available: true, bridge };
}

/** Renders one captured page on this desktop and packages the result for the server. */
export async function renderDocumentPagePdf(input: {
  readonly httpBaseUrl: string;
  readonly request: ScientDocumentPageRenderRequest;
  readonly bridge?: DesktopBridge | undefined;
}): Promise<ScientDocumentPageRenderOutcome> {
  const availability = documentPdfAvailability(input.bridge);
  if (!availability.available) {
    return { _tag: "rejected", reason: "failed", detail: availability.reason };
  }
  const inputUrl = resolveAssetUrl(input.httpBaseUrl, input.request.inputRelativeUrl);
  if (inputUrl === null) {
    return { _tag: "rejected", reason: "failed", detail: "The captured document URL is invalid." };
  }
  const outcome = await availability.bridge.renderDocumentPagePdf!({
    inputUrl,
    expected: input.request.expected,
  });
  if (outcome._tag === "rejected") return outcome;
  const { artifact } = outcome;
  return {
    _tag: "rendered",
    result: {
      readiness: artifact.readiness,
      warnings: artifact.warnings,
      sourceSignals: artifact.sourceSignals,
      blockedRequestCount: artifact.blockedRequestCount,
      bytesBase64: Encoding.encodeBase64Url(artifact.data),
    },
  };
}

const decodeRenderRequest = Schema.decodeUnknownSync(ScientDocumentPageRenderRequest);

/** The desktop host's side of the server's `documentPagePdfRender` request. */
export async function renderDocumentPagePdfForHost(
  httpBaseUrl: string,
  rawInput: unknown,
): Promise<ScientDocumentPageRenderOutcome> {
  return renderDocumentPagePdf({ httpBaseUrl, request: decodeRenderRequest(rawInput) });
}
