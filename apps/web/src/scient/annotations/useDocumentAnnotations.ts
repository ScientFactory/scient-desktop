import type { PdfSourceDescriptor } from "@scientfactory/document-artifacts";
import { EnvironmentId, type ScientPdfAnnotation } from "@t3tools/contracts";
import { useEffect, useState, useSyncExternalStore } from "react";

import {
  annotatedPdfKey,
  readPdfAnnotations,
  storePdfAnnotations,
  subscribePdfAnnotations,
  type AnnotatedPdf,
} from "./annotationState";
import { readDocumentAnnotations } from "./client";

interface DocumentTarget {
  readonly environmentId: EnvironmentId;
  readonly root: string;
  readonly relativePath: string;
}

/** Project PDFs can be annotated; chat attachments and generated PDFs cannot. */
function documentTarget(source: PdfSourceDescriptor | null): DocumentTarget | null {
  if (source?._tag !== "workspace-pdf") return null;
  return {
    environmentId: EnvironmentId.make(source.authority),
    root: source.workspaceRoot,
    relativePath: source.relativePath.replaceAll("\\", "/"),
  };
}

const NONE: ReadonlyArray<ScientPdfAnnotation> = [];
const noSubscription = () => () => undefined;

export function usePdfAnnotations(pdf: AnnotatedPdf | null): ReadonlyArray<ScientPdfAnnotation> {
  const key = pdf ? annotatedPdfKey(pdf) : null;
  const subscribe = (listener: () => void) =>
    key === null ? noSubscription() : subscribePdfAnnotations(key, listener);
  return useSyncExternalStore(
    subscribe,
    () => (key === null ? NONE : readPdfAnnotations(key)),
    () => NONE,
  );
}

/**
 * The annotations of the PDF a reader shows, read again when the window
 * comes back to the front, so an agent's highlights appear without reopening.
 */
export function useDocumentAnnotations(source: PdfSourceDescriptor | null): {
  readonly pdf: AnnotatedPdf | null;
  readonly annotations: ReadonlyArray<ScientPdfAnnotation>;
} {
  const target = documentTarget(source);
  const environmentId = target?.environmentId ?? null;
  const root = target?.root ?? null;
  const relativePath = target?.relativePath ?? null;
  const targetKey = target ? `${environmentId}\0${root}\0${relativePath}` : null;
  const [loaded, setLoaded] = useState<{ readonly key: string; readonly pdf: AnnotatedPdf } | null>(
    null,
  );

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reads the document's annotations from the server and again when the window returns to the front
  useEffect(() => {
    if (environmentId === null || root === null || relativePath === null || targetKey === null) {
      return;
    }
    let current = true;
    const load = () => {
      void readDocumentAnnotations(environmentId, { root, relativePath }).then(
        (result) => {
          if (!current || result.status !== "available") return;
          const pdf: AnnotatedPdf = {
            environmentId,
            root,
            relativePath,
            material: result.material,
          };
          storePdfAnnotations(annotatedPdfKey(pdf), result.annotations);
          setLoaded((previous) =>
            previous?.key === targetKey &&
            previous.pdf.material.sha256 === pdf.material.sha256 &&
            previous.pdf.material.byteLength === pdf.material.byteLength
              ? previous
              : { key: targetKey, pdf },
          );
        },
        () => undefined,
      );
    };
    load();
    const reload = () => {
      if (document.visibilityState === "visible") load();
    };
    window.addEventListener("focus", reload);
    document.addEventListener("visibilitychange", reload);
    return () => {
      current = false;
      window.removeEventListener("focus", reload);
      document.removeEventListener("visibilitychange", reload);
    };
  }, [environmentId, root, relativePath, targetKey]);

  const pdf = loaded?.key === targetKey ? loaded.pdf : null;
  return { pdf, annotations: usePdfAnnotations(pdf) };
}
