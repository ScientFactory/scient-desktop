import { sha256 } from "@noble/hashes/sha2";

import {
  trackedHtmlLogicalDocumentKey,
  type TrackedHtmlSource,
} from "../documentExport/htmlPdfSource";

function sha256Hex(value: string): string {
  return [...sha256(new TextEncoder().encode(value))]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function redactSignedAssetCapability(url: URL): boolean {
  const segments = url.pathname.split("/");
  const assetsSegment = segments.findIndex(
    (segment, index) => segment === "assets" && segments[index - 1] === "api",
  );
  if (assetsSegment < 0 || !segments[assetsSegment + 1]) return false;
  segments[assetsSegment + 1] = "<signed>";
  url.pathname = segments.join("/");
  return true;
}

export function browserExportLogicalDocumentKey(
  url: string,
  trackedSource?: TrackedHtmlSource | null,
): string {
  if (trackedSource) return trackedHtmlLogicalDocumentKey(trackedSource);
  try {
    const parsed = new URL(url);
    if (redactSignedAssetCapability(parsed)) parsed.search = "";
    parsed.username = "";
    parsed.password = "";
    parsed.hash = "";
    return `browser-export:${sha256Hex(parsed.toString())}`;
  } catch {
    return `browser-export:${sha256Hex(url)}`;
  }
}

export function browserExportReceiptUrl(url: string): string {
  try {
    const parsed = new URL(url);
    redactSignedAssetCapability(parsed);
    parsed.username = "";
    parsed.password = "";
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return "browser-page";
  }
}
