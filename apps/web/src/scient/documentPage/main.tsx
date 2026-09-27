import {
  SCIENT_DOCUMENT_PAGE_READINESS_GLOBAL,
  type ScientDocumentPageInput,
  type ScientDocumentPageReadiness,
} from "@t3tools/contracts";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";

import { getScientKatexRuntimePromise } from "../math/ScientMath";
import {
  collectDocumentPageReadiness,
  DocumentPageTracker,
  failedDocumentPageReadiness,
} from "./documentPageReadiness";
import {
  DocumentPageInputError,
  loadDocumentPageInput,
  readDocumentPageInputUrl,
} from "./documentPageInput";
import { applyDocumentPageSetup } from "./documentPageSetup";
import { ScientDocumentPage } from "./ScientDocumentPage";

/**
 * Entry for the standalone document page the desktop prints. It never mounts
 * the application shell, connects to an environment, or reads settings: it
 * renders exactly one captured input and publishes a readiness report.
 */
async function renderDocumentPage(): Promise<ScientDocumentPageReadiness> {
  const tracker = new DocumentPageTracker();
  let page: ScientDocumentPageInput | null = null;
  try {
    const inputUrl = readDocumentPageInputUrl(window.location.hash);
    page = await loadDocumentPageInput(inputUrl);
    applyDocumentPageSetup(document, page);
    const katex = await getScientKatexRuntimePromise();
    const container = document.getElementById("root");
    if (container === null) throw new Error("The document page has no root element.");
    const root = createRoot(container);
    const renderPage = (renderWarnings: ReadonlyArray<string>) =>
      flushSync(() =>
        root.render(
          <ScientDocumentPage
            input={page!}
            inputUrl={inputUrl}
            katex={katex}
            tracker={tracker}
            renderWarnings={renderWarnings}
          />,
        ),
      );
    renderPage([]);
    let settled = await tracker.settle();
    const renderWarnings = tracker.diagnostics.flatMap((diagnostic) =>
      diagnostic.severity === "warning" ? [diagnostic.detail] : [],
    );
    if (renderWarnings.length > 0) {
      // Limitations found while rendering are printed with the bundle's own.
      renderPage(renderWarnings);
      settled = (await tracker.settle()) && settled;
    }
    const article = container.querySelector<HTMLElement>("article.scient-document");
    if (article === null) throw new Error("The document page did not render its article.");
    return await collectDocumentPageReadiness({ page, article, tracker, settled });
  } catch (cause) {
    if (cause instanceof DocumentPageInputError) {
      tracker.fatal(cause.code, cause.message);
    } else {
      tracker.fatal(
        "render-crashed",
        cause instanceof Error && cause.message
          ? `The document page failed: ${cause.message}`
          : "The document page failed while rendering.",
      );
    }
    return failedDocumentPageReadiness(tracker, page);
  }
}

// Published synchronously so the printer can await it as soon as the page loads.
Object.defineProperty(window, SCIENT_DOCUMENT_PAGE_READINESS_GLOBAL, {
  value: renderDocumentPage(),
  configurable: false,
  enumerable: false,
  writable: false,
});
