import type { ScientDocumentPageInput } from "@t3tools/contracts";

const RUNNING_HEADER_MAX_LENGTH = 90;

/** Escapes text for a CSS string literal. */
export function cssStringLiteral(value: string): string {
  const escaped = value
    .replace(/[\\"]/gu, (character) => `\\${character}`)
    .replace(/[\n\r\f\u2028\u2029]+/gu, " ");
  return `"${escaped}"`;
}

/**
 * The running header repeats the document title in the top margin of every
 * page but the first, where the title itself is printed. Chromium's page
 * margin boxes cannot read document text, so the title is written into the
 * page rule directly.
 */
export function runningHeaderCss(title: string): string {
  const trimmed = title.replace(/\s+/gu, " ").trim();
  const header =
    trimmed.length > RUNNING_HEADER_MAX_LENGTH
      ? `${trimmed.slice(0, RUNNING_HEADER_MAX_LENGTH - 1)}…`
      : trimmed;
  return `@page { @top-center { content: ${cssStringLiteral(header)}; } }\n@page :first { @top-center { content: none; } }\n`;
}

export function applyDocumentPageSetup(document: Document, page: ScientDocumentPageInput): void {
  document.title = page.title;
  if (page.language) document.documentElement.lang = page.language;
  const style = document.createElement("style");
  style.dataset.scientDocumentRunningHeader = "";
  style.textContent = runningHeaderCss(page.title);
  document.head.append(style);
}
