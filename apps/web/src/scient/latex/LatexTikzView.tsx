import type { EnvironmentId } from "@t3tools/contracts";
import { renderEnvironmentLatexArtwork } from "@t3tools/client-runtime/state/scient-latex";
import { useEffect, useEffectEvent, useLayoutEffect, useRef, useState } from "react";
import { Button } from "~/components/ui/button";
import { runtime } from "~/lib/runtime";
import { readPreparedConnection } from "~/state/session";
import { observeLatexWidth } from "./observeLatexWidth";

interface ArtworkHandles {
  loading?: ReturnType<typeof import("../pdf/pdfRuntime").startPdfDocumentLoad> | undefined;
  rendering?: { cancel: () => void } | undefined;
  url?: string | undefined;
}

// Once painted, the canvas owns its pixels. Keeping a PDF document and its
// worker alive for every drawing wastes memory on long theses.
function releaseArtworkHandles(handles: ArtworkHandles) {
  const loading = handles.loading;
  handles.loading = undefined;
  if (loading) void loading.destroy().catch(() => {});
  if (handles.url) {
    URL.revokeObjectURL(handles.url);
    handles.url = undefined;
  }
}

/** Renders one admitted drawing; outside the component, whose compiler cannot follow it. */
async function paintLatexArtwork(input: {
  readonly environmentId: EnvironmentId | null;
  readonly cwd: string | null;
  readonly relativePath: string | null;
  readonly preamble: string;
  readonly source: string;
  readonly algorithmNumber: number | undefined;
  readonly widthInches: number;
  readonly rasterPixelRatio: number;
  readonly canvas: { readonly current: HTMLCanvasElement | null };
  readonly signal: AbortSignal;
  readonly handles: ArtworkHandles;
  readonly setStatus: (message: string | null) => void;
}) {
  const { signal, handles } = input;
  try {
    const prepared = input.environmentId && readPreparedConnection(input.environmentId);
    if (!prepared || !input.cwd || !input.relativePath) {
      input.setStatus("Connect to the document’s environment to show this drawing.");
      return;
    }
    const request = {
      authorization: "execute-host-tex" as const,
      workspaceRoot: input.cwd,
      relativePath: input.relativePath,
      preamble: input.preamble,
      source: input.source,
      widthInches: input.widthInches,
      rasterPixelRatio: input.rasterPixelRatio,
      ...(input.algorithmNumber === undefined ? {} : { algorithmNumber: input.algorithmNumber }),
    };
    const result = await runtime.runPromise(renderEnvironmentLatexArtwork({ prepared, request }), {
      signal,
    });
    if (signal.aborted) return;
    if (result._tag === "unavailable") {
      input.setStatus(result.message);
      return;
    }
    if (result.raster && typeof createImageBitmap === "function") {
      try {
        const size = result.raster;
        const width = (size.widthPoints * 96) / 72;
        const height = (size.heightPoints * 96) / 72;
        if (
          !Number.isFinite(width * height) ||
          width <= 0 ||
          height <= 0 ||
          Math.ceil(width * input.rasterPixelRatio) * Math.ceil(height * input.rasterPixelRatio) >
            16_777_216
        )
          throw new Error("The drawing preview is too large.");
        // Native decoding avoids loading fonts and executing PDF drawing
        // operators in the UI renderer. The PDF remains the fallback.
        const response = await fetch(`data:image/png;base64,${size.pngBase64}`, {
          signal,
        });
        const bitmap = await createImageBitmap(await response.blob());
        try {
          const element = input.canvas.current;
          if (signal.aborted || !element) return;
          if (!bitmap.width || !bitmap.height || bitmap.width * bitmap.height > 16_777_216)
            throw new Error("The drawing preview is too large.");
          const context = element.getContext("2d");
          if (!context) throw new Error("The drawing canvas is unavailable.");
          element.width = bitmap.width;
          element.height = bitmap.height;
          element.style.width = `${width}px`;
          element.style.height = `${height}px`;
          context.drawImage(bitmap, 0, 0);
          input.setStatus(null);
          return;
        } finally {
          bitmap.close();
        }
      } catch {
        if (signal.aborted) return;
      }
    }
    const { startPdfDocumentLoad } = await import("../pdf/pdfRuntime");
    if (signal.aborted) return;
    const bytes = Uint8Array.from(atob(result.pdfBase64), (character) => character.charCodeAt(0));
    handles.url = URL.createObjectURL(new Blob([bytes], { type: "application/pdf" }));
    handles.loading = startPdfDocumentLoad(handles.url, {
      onPassword: ({ submit }) => submit(""),
      onProgress: () => {},
    });
    const document = await handles.loading.promise;
    if (signal.aborted) return;
    const page = await document.getPage(1);
    const element = input.canvas.current;
    if (signal.aborted || !element) return;
    const scale = 96 / 72;
    const size = page.getViewport({ scale });
    const ratio = Math.min(3, Math.max(2, window.devicePixelRatio || 1));
    const viewport = page.getViewport({ scale: scale * ratio });
    if (viewport.width * viewport.height > 16_777_216)
      throw new Error("The drawing preview is too large.");
    element.width = Math.ceil(viewport.width);
    element.height = Math.ceil(viewport.height);
    element.style.width = `${size.width}px`;
    element.style.height = `${size.height}px`;
    const task = page.render({ canvas: element, viewport });
    handles.rendering = task;
    await task.promise;
    if (!signal.aborted) input.setStatus(null);
  } catch (error) {
    if (!signal.aborted)
      input.setStatus(error instanceof Error ? error.message : "Drawing preview unavailable.");
  } finally {
    releaseArtworkHandles(handles);
  }
}

/** The compiled drawing is read-only; captions retain the ordinary figure editor. */
export function LatexTikzArtwork(props: {
  readonly source: string;
  readonly preamble: string;
  readonly environmentId: EnvironmentId | null;
  readonly cwd: string | null;
  readonly relativePath: string | null;
  readonly algorithmNumber?: number | undefined;
  readonly label?: string | undefined;
}) {
  const root = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const requested = useRef(false);
  const [widthInches, setWidthInches] = useState<number | null>(null);
  const rasterPixelRatio = Math.min(3, Math.max(2, window.devicePixelRatio || 1));
  const sourceIdentity = JSON.stringify([
    props.environmentId,
    props.cwd,
    props.relativePath,
    props.preamble,
    props.source,
    props.algorithmNumber,
  ]);
  const [admittedSource, setAdmittedSource] = useState<string | null>(null);
  const [actionNumber, setActionNumber] = useState(0);
  const admitted = admittedSource === sourceIdentity;
  const requestKey = JSON.stringify([
    actionNumber,
    props.environmentId,
    props.cwd,
    props.relativePath,
    props.preamble,
    props.source,
    widthInches,
    props.algorithmNumber,
    rasterPixelRatio,
  ]);
  const [resultState, setResultState] = useState<{ key: string; message: string | null } | null>(
    null,
  );
  const status = !admitted
    ? "Drawing preview is off. You can continue editing in Source."
    : resultState?.key === requestKey
      ? resultState.message
      : "Rendering drawing…";
  useLayoutEffect(() => {
    const panel = root.current?.closest<HTMLElement>(
      ".scient-latex-figure-panel, .scient-latex-compiled-algorithm",
    );
    if (!panel) return;
    return observeLatexWidth(panel, (width) => {
      setWidthInches(Math.max(0.1, Math.min(30, width / 96)));
    });
  }, []);
  // A changed drawing waits to be admitted again.
  const [admissionSource, setAdmissionSource] = useState(sourceIdentity);
  if (admissionSource !== sourceIdentity) {
    setAdmissionSource(sourceIdentity);
    setAdmittedSource(null);
  }
  const resetRequested = useEffectEvent((..._changes: readonly unknown[]) => {
    requested.current = false;
  });
  useEffect(() => resetRequested(sourceIdentity), [sourceIdentity]);
  useEffect(() => {
    if (!admitted || widthInches === null) return;
    const delay = requested.current ? 150 : 0;
    const controller = new AbortController();
    const handles: ArtworkHandles = {};
    const setStatus = (message: string | null) => setResultState({ key: requestKey, message });
    const timer = window.setTimeout(() => {
      requested.current = true;
      void paintLatexArtwork({
        environmentId: props.environmentId,
        cwd: props.cwd,
        relativePath: props.relativePath,
        preamble: props.preamble,
        source: props.source,
        algorithmNumber: props.algorithmNumber,
        widthInches,
        rasterPixelRatio,
        canvas,
        signal: controller.signal,
        handles,
        setStatus,
      });
    }, delay);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
      handles.rendering?.cancel();
      releaseArtworkHandles(handles);
    };
  }, [
    admitted,
    props.environmentId,
    props.cwd,
    props.relativePath,
    props.preamble,
    props.source,
    widthInches,
    requestKey,
    props.algorithmNumber,
    rasterPixelRatio,
  ]);
  return (
    <div ref={root} className="scient-latex-tikz" contentEditable={false}>
      {!admitted && (
        <div className="scient-latex-tikz-admission">
          <p>
            Preview runs this drawing and its document preamble with host TeX/Lua. It has the
            environment’s filesystem authority; this is not a sandbox. Only run source you trust.
          </p>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => {
              setAdmittedSource(sourceIdentity);
              setActionNumber((action) => action + 1);
            }}
          >
            Run this drawing preview
          </Button>
        </div>
      )}
      {admitted && (
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => setActionNumber((action) => action + 1)}
        >
          Run drawing preview again
        </Button>
      )}
      <canvas
        ref={canvas}
        role="img"
        aria-label={props.label ?? "TikZ drawing"}
        hidden={status !== null}
      />
      {status !== null && (
        <div className="scient-latex-tikz-status" role="status">
          {status}
        </div>
      )}
    </div>
  );
}
