import type { PdfMaterial } from "@scientfactory/document-artifacts";
import {
  liveScientAnnotations,
  type EnvironmentId,
  type ScientAnnotationCommand,
  type ScientAnnotationMutationResult,
  type ScientPdfAnnotation,
  type ScientPdfAnnotationAnchor,
} from "@t3tools/contracts";

import { toastManager } from "~/components/ui/toast";
import { randomUUID } from "~/lib/utils";

import { isLibraryMovingError, LIBRARY_MOVING_MESSAGE } from "../sources/errorMessage";
import { mutateAnnotation } from "./client";

/** Where a PDF's annotations live: its project and its bytes. */
export interface AnnotatedPdf {
  readonly environmentId: EnvironmentId;
  readonly root: string;
  readonly material: PdfMaterial;
  /** The project path the reader shows; needed to create. */
  readonly relativePath?: string;
}

type Listener = () => void;
const annotationsByPdf = new Map<string, ReadonlyArray<ScientPdfAnnotation>>();
const listeners = new Map<string, Set<Listener>>();
const EMPTY: ReadonlyArray<ScientPdfAnnotation> = [];

export function annotatedPdfKey(pdf: Pick<AnnotatedPdf, "environmentId" | "root" | "material">) {
  return `${pdf.environmentId}\0${pdf.root}\0${pdf.material.sha256}`;
}

export function readPdfAnnotations(key: string): ReadonlyArray<ScientPdfAnnotation> {
  return annotationsByPdf.get(key) ?? EMPTY;
}

export function subscribePdfAnnotations(key: string, listener: Listener): () => void {
  const set = listeners.get(key) ?? new Set<Listener>();
  set.add(listener);
  listeners.set(key, set);
  return () => {
    set.delete(listener);
    if (set.size === 0) listeners.delete(key);
  };
}

/** Replaces what is known about one PDF's live annotations. */
export function storePdfAnnotations(
  key: string,
  annotations: ReadonlyArray<ScientPdfAnnotation>,
): void {
  annotationsByPdf.set(key, liveScientAnnotations(annotations));
  for (const listener of listeners.get(key) ?? []) listener();
}

function storeOne(key: string, annotation: ScientPdfAnnotation): void {
  const others = readPdfAnnotations(key).filter(
    (existing) => existing.annotationId !== annotation.annotationId,
  );
  storePdfAnnotations(key, [...others, annotation]);
}

function newAnnotationId(): string {
  return `ann_${randomUUID().replaceAll("-", "")}`;
}

async function send(
  pdf: AnnotatedPdf,
  command: ScientAnnotationCommand,
): Promise<ScientAnnotationMutationResult | null> {
  try {
    const result = await mutateAnnotation(pdf.environmentId, {
      root: pdf.root,
      material: pdf.material,
      ...(pdf.relativePath === undefined ? {} : { relativePath: pdf.relativePath }),
      command,
    });
    const key = annotatedPdfKey(pdf);
    if (result.annotation) storeOne(key, result.annotation);
    if (result.outcome === "stale") {
      toastManager.add({
        type: "info",
        title: "This annotation changed elsewhere",
        description: "Showing its latest version.",
      });
    } else if (result.outcome === "material-changed") {
      toastManager.add({
        type: "warning",
        title: "This PDF changed on disk",
        description: "Reopen it and select the text again.",
      });
    } else if (result.outcome === "limit-reached") {
      toastManager.add({ type: "warning", title: "This PDF has too many annotations" });
    }
    return result;
  } catch (cause) {
    toastManager.add({
      type: "error",
      title: "Couldn't save the annotation",
      ...(isLibraryMovingError(cause) ? { description: LIBRARY_MOVING_MESSAGE } : {}),
    });
    return null;
  }
}

export async function createAnnotation(
  pdf: AnnotatedPdf,
  input: {
    readonly anchor: ScientPdfAnnotationAnchor;
    readonly highlighted: boolean;
    readonly note: string;
  },
): Promise<ScientPdfAnnotation | null> {
  const result = await send(pdf, { action: "create", annotationId: newAnnotationId(), ...input });
  return result?.outcome === "created" ? result.annotation : null;
}

export async function updateAnnotation(
  pdf: AnnotatedPdf,
  annotation: ScientPdfAnnotation,
  change: { readonly note?: string; readonly highlighted?: boolean },
): Promise<ScientPdfAnnotation | null> {
  const result = await send(pdf, {
    action: "update",
    annotationId: annotation.annotationId,
    expectedRevision: annotation.revision,
    ...change,
  });
  return result?.annotation ?? null;
}

/** Removes with an Undo that brings the annotation back as it was. */
export async function removeAnnotation(
  pdf: AnnotatedPdf,
  annotation: ScientPdfAnnotation,
): Promise<void> {
  const result = await send(pdf, {
    action: "remove",
    annotationId: annotation.annotationId,
    expectedRevision: annotation.revision,
  });
  const removed = result?.outcome === "removed" ? result.annotation : null;
  if (!removed) return;
  toastManager.add({
    type: "success",
    title: removed.highlighted ? "Highlight removed" : "Note removed",
    actionProps: {
      children: "Undo",
      onClick: () => {
        void send(pdf, {
          action: "restore",
          annotationId: removed.annotationId,
          expectedRevision: removed.revision,
        });
      },
    },
  });
}
