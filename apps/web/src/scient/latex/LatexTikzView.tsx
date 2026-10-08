import type { EnvironmentId } from "@t3tools/contracts";
import { renderEnvironmentLatexArtwork } from "@t3tools/client-runtime/state/scient-latex";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { runtime } from "~/lib/runtime";
import { readPreparedConnection } from "~/state/session";
import { startPdfDocumentLoad } from "../pdf/pdfRuntime";

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
  const [widthInches, setWidthInches] = useState<number | null>(null);
  const requestKey = JSON.stringify([
    props.environmentId,
    props.cwd,
    props.relativePath,
    props.preamble,
    props.source,
    widthInches,
    props.algorithmNumber,
  ]);
  const [resultState, setResultState] = useState<{ key: string; message: string | null } | null>(
    null,
  );
  const status = resultState?.key === requestKey ? resultState.message : "Rendering drawing…";
  useLayoutEffect(() => {
    const panel = root.current?.closest<HTMLElement>(
      ".scient-latex-figure-panel, .scient-latex-compiled-algorithm",
    );
    if (!panel) return;
    const measure = () => {
      if (panel.clientWidth > 0)
        setWidthInches(Math.max(0.1, Math.min(30, Math.round(panel.clientWidth) / 96)));
    };
    const observer = new ResizeObserver(measure);
    observer.observe(panel);
    measure();
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (widthInches === null) return;
    const controller = new AbortController();
    let loading: ReturnType<typeof startPdfDocumentLoad> | undefined;
    let rendering: { cancel: () => void } | undefined;
    let url: string | undefined;
    const setStatus = (message: string | null) => setResultState({ key: requestKey, message });
    const timer = window.setTimeout(() => {
      void (async () => {
        try {
          const prepared = props.environmentId && readPreparedConnection(props.environmentId);
          if (!prepared || !props.cwd || !props.relativePath) {
            setStatus("Connect to the document’s environment to show this drawing.");
            return;
          }
          const request = {
            workspaceRoot: props.cwd,
            relativePath: props.relativePath,
            preamble: props.preamble,
            source: props.source,
            widthInches,
            ...(props.algorithmNumber === undefined
              ? {}
              : { algorithmNumber: props.algorithmNumber }),
          };
          const result = await runtime.runPromise(
            renderEnvironmentLatexArtwork({ prepared, request }),
            { signal: controller.signal },
          );
          if (controller.signal.aborted) return;
          if (result._tag === "unavailable") {
            setStatus(result.message);
            return;
          }
          const bytes = Uint8Array.from(atob(result.pdfBase64), (character) =>
            character.charCodeAt(0),
          );
          url = URL.createObjectURL(new Blob([bytes], { type: "application/pdf" }));
          loading = startPdfDocumentLoad(url, {
            onPassword: ({ submit }) => submit(""),
            onProgress: () => {},
          });
          const document = await loading.promise;
          const page = await document.getPage(1);
          const element = canvas.current;
          if (controller.signal.aborted || !element) return;
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
          rendering = task;
          await task.promise;
          if (!controller.signal.aborted) setStatus(null);
        } catch (error) {
          if (!controller.signal.aborted)
            setStatus(error instanceof Error ? error.message : "Drawing preview unavailable.");
        }
      })();
    }, 150);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
      rendering?.cancel();
      void loading?.destroy();
      if (url) URL.revokeObjectURL(url);
    };
  }, [
    props.environmentId,
    props.cwd,
    props.relativePath,
    props.preamble,
    props.source,
    widthInches,
    requestKey,
    props.algorithmNumber,
  ]);
  return (
    <div ref={root} className="scient-latex-tikz" contentEditable={false}>
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
