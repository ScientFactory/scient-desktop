import type { RefObject } from "react";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, ScopedThreadRef } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { msg } from "gt-react";
import { useRef } from "react";

import { toastManager } from "~/components/ui/toast";
import { m } from "~/i18n/messages";
import { useEnvironmentHttpBaseUrl } from "~/state/environments";
import { scientDocumentPdfEnvironment } from "~/state/scientDocumentPdf";
import { useAtomCommand } from "~/state/use-atom-command";

import { beginScientUiOperation } from "../analytics/client";
import type { ScientUiFailureCategory } from "../analytics/clientGate";
import type { MarkdownPersistenceLease } from "../markdownEditor/persistence/markdownPersistenceRegistry";
import { DocumentExportMenuItems } from "./DocumentExportMenuItems";
import { documentPdfAvailability, renderDocumentPagePdf } from "./documentPagePdf";
import {
  deliverDocumentPdf,
  documentPdfSavedNotice,
  markdownPdfFileName,
  releaseDocumentPdfCapture,
  saveDocumentPdfCopy,
} from "./documentPdfDelivery";
import { runMarkdownPdfExport } from "./markdownPdfExport";

export interface MarkdownPdfExportTarget {
  readonly environmentId: EnvironmentId;
  readonly cwd: string;
  readonly relativePath: string;
  readonly threadRef: ScopedThreadRef;
  readonly persistence: MarkdownPersistenceLease;
}

/**
 * Exports the saved file and saves the PDF through the same Save dialog as
 * every other export; the notice's Open shows it in Scient's reader.
 */
export function useMarkdownPdfExport(target: MarkdownPdfExportTarget) {
  const httpBaseUrl = useEnvironmentHttpBaseUrl(target.environmentId);
  const prepare = usePrepareMarkdownPdf();
  const publish = usePublishMarkdownPdf();
  const runningRef = useRef(false);
  const navigate = useNavigate();

  return () =>
    createMarkdownPdfExport({ target, httpBaseUrl, prepare, publish, runningRef, navigate })();
}

/** Markdown editor → More actions → Export ▸ PDF / Word. */
export function MarkdownPdfExportMenuItems(
  props: MarkdownPdfExportTarget & { readonly onWordExport: () => void },
) {
  const exportPdf = useMarkdownPdfExport(props);
  const availability = documentPdfAvailability();
  return (
    <DocumentExportMenuItems
      onPdfExport={() => void exportPdf()}
      onWordExport={props.onWordExport}
      pdfDisabled={!availability.available}
      {...(availability.available ? {} : { pdfUnavailableReason: availability.reason })}
    />
  );
}

function createMarkdownPdfExport({
  target,
  httpBaseUrl,
  prepare,
  publish,
  runningRef,
  navigate,
}: {
  target: MarkdownPdfExportTarget;
  httpBaseUrl: ReturnType<typeof useEnvironmentHttpBaseUrl>;
  prepare: ReturnType<typeof usePrepareMarkdownPdf>;
  publish: ReturnType<typeof usePublishMarkdownPdf>;
  runningRef: RefObject<boolean>;
  navigate: ReturnType<typeof useNavigate>;
}) {
  return async () => {
    if (runningRef.current) return;
    const availability = documentPdfAvailability();
    if (!availability.available) {
      toastManager.add({
        type: "error",
        title: m(msg("PDF export unavailable")),
        description: availability.reason,
      });
      return;
    }
    if (httpBaseUrl === null) {
      toastManager.add({
        type: "error",
        title: m(msg("PDF export unavailable")),
        description: m(msg("This project's Scient environment is not connected.")),
      });
      return;
    }
    runningRef.current = true;
    const finish = beginScientUiOperation(target.environmentId, "pdf-export", "user");
    // The step running when a failure is thrown; analytics names it, never the error.
    let step: ScientUiFailureCategory = "unsaved-changes";
    const toastId = toastManager.add({
      type: "loading",
      title: m(msg("Exporting PDF…")),
      timeout: 0,
    });
    try {
      const published = await runMarkdownPdfExport(
        {
          flush: () => target.persistence.flushNow(),
          snapshot: () => {
            const snapshot = target.persistence.getSnapshot();
            return {
              pending: snapshot.pending || snapshot.draftSource !== snapshot.baselineSource,
              hasProblem: snapshot.conflict !== null || snapshot.error !== null,
              baselineRevision: snapshot.baselineRevision,
            };
          },
          prepare: async (input) => {
            step = "prepare-failed";
            const result = await prepare({ environmentId: target.environmentId, input });
            if (result._tag === "Failure") throw squashAtomCommandFailure(result);
            return result.value;
          },
          render: (request) => {
            step = "render-failed";
            return renderDocumentPagePdf({ httpBaseUrl, request, bridge: availability.bridge });
          },
          publish: async (input) => {
            step = "publication-failed";
            const result = await publish({ environmentId: target.environmentId, input });
            if (result._tag === "Failure") throw squashAtomCommandFailure(result);
            return result.value;
          },
          release: (captureId) => releaseDocumentPdfCapture(target.environmentId, captureId),
        },
        target,
      );
      toastManager.close(toastId);
      step = "delivery-failed";
      const delivery = await deliverDocumentPdf(
        {
          saveCopy: (pdf, fileName) => saveDocumentPdfCopy(target.environmentId, pdf, fileName),
        },
        published,
        markdownPdfFileName(target.relativePath),
      );
      if (delivery._tag === "delivered") {
        toastManager.add(
          documentPdfSavedNotice({ delivery, published, threadRef: target.threadRef, navigate }),
        );
      }
      finish("completed");
    } catch (error) {
      toastManager.close(toastId);
      toastManager.add({
        type: "error",
        title: m(msg("Unable to export PDF")),
        description: error instanceof Error ? error.message : m(msg("The PDF export failed.")),
      });
      finish("failed", step);
    } finally {
      runningRef.current = false;
    }
  };
}

function usePrepareMarkdownPdf() {
  return useAtomCommand(scientDocumentPdfEnvironment.prepareMarkdown, { reportFailure: false });
}
function usePublishMarkdownPdf() {
  return useAtomCommand(scientDocumentPdfEnvironment.publish, { reportFailure: false });
}
