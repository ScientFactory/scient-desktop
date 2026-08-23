import type { HtmlPdfSourceRelation } from "./htmlPdfSourceStore";

function comparableDocumentUrl(value: string): string | null {
  try {
    const url = new URL(value);
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}

export function isTrackedDocumentUrl(relation: HtmlPdfSourceRelation, pageUrl: string): boolean {
  if (relation.authorizedUrl === null) return false;
  return comparableDocumentUrl(relation.authorizedUrl) === comparableDocumentUrl(pageUrl);
}
