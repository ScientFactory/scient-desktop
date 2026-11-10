import { useStableCallback } from "~/hooks/useStableCallback";
import type { OfficePreviewKind } from "@t3tools/shared/filePreview";
import { lazy, Suspense, use, useEffect, useRef, useState } from "react";
import { FileSurfaceLoading, FileSurfaceNotice } from "./fileSurfaceChrome";
import { OFFICE_PREVIEW_MAX_BYTES, type OfficeWorkerResult } from "./officePreviewProtocol";
// SCIENT-FORK:START
import { DocumentIdentityContext } from "~/scient/documentCache/documentIdentity";
import { useShelfPlace } from "~/scient/documentShelf/ScientDocumentShelf";
import { acquireOfficeDocument, type OfficeDocument } from "~/scient/office/officeDocuments";
// SCIENT-FORK:END
const WordDocument = lazy(() => import("./office/WordDocument"));
const Spreadsheet = lazy(() => import("./office/Spreadsheet"));
const Presentation = lazy(() => import("./office/Presentation"));
async function readOfficeFile(src: string, signal: AbortSignal) {
  const response = await fetch(src, { signal });
  if (!response.ok) throw new Error("The file could not be loaded. Close it and try again.");
  if (Number(response.headers.get("content-length")) > OFFICE_PREVIEW_MAX_BYTES)
    throw new Error("Preview limited to files under 50 MB.");
  const reader = response.body?.getReader();
  if (!reader) throw new Error("The file is unavailable.");
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > OFFICE_PREVIEW_MAX_BYTES) throw new Error("Preview limited to files under 50 MB.");
      chunks.push(value);
    }
  } finally {
    await reader.cancel();
  }
  return new Blob(chunks).arrayBuffer();
}

// SCIENT-FORK:START — preparation resolves to the bounded bytes, so a kept document can skip it.
function prepareOfficeFile(
  src: string,
  kind: Extract<OfficePreviewKind, "docx" | "xlsx" | "pptx">,
  signal: AbortSignal,
) {
  return new Promise<Extract<OfficeWorkerResult, { bytes: ArrayBuffer }>>((resolve, reject) => {
    const controller = new AbortController();
    const worker = new Worker(new URL("./officePreview.worker.ts", import.meta.url), {
      type: "module",
    });
    const finish = () => {
      clearTimeout(timer);
      controller.abort();
      worker.terminate();
    };
    const failure = (cause: unknown) => {
      if (controller.signal.aborted) return;
      finish();
      reject(cause);
    };
    const timer = setTimeout(
      () => failure(new Error("This document took too long to preview. Open it in another app.")),
      30000,
    );
    signal.addEventListener("abort", () => failure(new DOMException("Aborted", "AbortError")), {
      once: true,
    });
    worker.addEventListener("error", () => failure(new Error("Could not load the Office viewer.")));
    worker.addEventListener("messageerror", () =>
      failure(new Error("Could not read the Office viewer response.")),
    );
    worker.addEventListener("message", (event: MessageEvent<OfficeWorkerResult>) => {
      if (controller.signal.aborted) return;
      if (event.data.type === "error") failure(new Error(event.data.message));
      else if ("bytes" in event.data) {
        finish();
        resolve(event.data);
      }
    });
    void readOfficeFile(src, controller.signal)
      .then((bytes) => {
        if (!controller.signal.aborted) worker.postMessage({ type: "open", kind, bytes }, [bytes]);
      })
      .catch(failure);
  });
}
// SCIENT-FORK:END

export default function OfficeViewer(props: {
  readonly src: string;
  readonly name: string;
  readonly kind: Extract<OfficePreviewKind, "docx" | "xlsx" | "pptx">;
  readonly sizeBytes?: number;
}) {
  const [error, setError] = useState<string | null>(null);
  // SCIENT-FORK:START — the prepared document, with its engine session, comes from the window's
  // document cache when this file was open recently (scient/office/officeDocuments.ts).
  const [opened, setOpened] = useState<OfficeDocument>();
  const identity = use(DocumentIdentityContext);
  const cacheKey = identity === null ? null : JSON.stringify(["office", props.kind, identity]);
  const failed = useRef(false);
  const lease = useRef<{ release: (options?: { discard?: boolean }) => void } | null>(null);
  const shelfPlace = useShelfPlace();
  // SCIENT-FORK:END
  const [details, setDetails] = useState("");
  // SCIENT-FORK: the viewer left out pages past its limit.
  const [limited, setLimited] = useState(false);
  const showLimited = useStableCallback(() => setLimited(true));
  const fail = useStableCallback((cause: unknown) => {
    // SCIENT-FORK: a failed document goes at once, its engine with it, and is not kept.
    failed.current = true;
    lease.current?.release({ discard: true });
    setError(cause instanceof Error ? cause.message : "Could not render this Office document.");
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Own the Open XML fetch, preparation worker, and timeout for this source and release them on cleanup.
  useEffect(() => {
    if ((props.sizeBytes ?? 0) > OFFICE_PREVIEW_MAX_BYTES) {
      // Metadata bounds are checked before fetching or starting an engine.
      // oxlint-disable-next-line react/set-state-in-effect
      setError("Preview limited to files under 50 MB.");
      return;
    }
    // SCIENT-FORK:START
    let current = true;
    failed.current = false;
    const acquired = acquireOfficeDocument(cacheKey, (signal) =>
      prepareOfficeFile(props.src, props.kind, signal),
    );
    lease.current = acquired;
    let unkeep: (() => void) | null = null;
    acquired.value.then(
      (document) => {
        if (!current) return;
        setOpened(document);
        // Hidden but kept (documentShelf), unless it failed: its drawn pages count as kept.
        unkeep =
          shelfPlace?.keep({
            hide: (evict, viewBytes) => !failed.current && acquired.park(evict, viewBytes),
            show: acquired.unpark,
          }) ?? null;
      },
      (cause: unknown) => {
        if (current) fail(cause);
      },
    );
    return () => {
      current = false;
      unkeep?.();
      acquired.release({ discard: failed.current });
      if (lease.current === acquired) lease.current = null;
    };
    // SCIENT-FORK:END
  }, [props.src, props.kind, props.sizeBytes, cacheKey, fail, shelfPlace]);
  if (error)
    return (
      <div
        role="alert"
        className="flex min-h-0 flex-1 flex-col items-center justify-center gap-1 px-6 text-center"
      >
        <p className="text-sm font-medium">No preview for this file</p>
        <p className="max-w-sm text-xs leading-relaxed text-muted-foreground">
          {error} Save it or open it in another app.
        </p>
      </div>
    );
  if (!opened) return <FileSurfaceLoading />;
  const prepared = opened.prepared; // SCIENT-FORK
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* SCIENT-FORK:START — no details row; the page count stays announced for assistive tech. */}
      {details ? (
        <span className="sr-only" aria-live="polite">
          {details}
        </span>
      ) : null}
      {/* SCIENT-FORK:END */}
      {prepared.truncated || limited ? (
        <FileSurfaceNotice>
          Preview limited. Save it or open it in another app to read the full document.
        </FileSurfaceNotice>
      ) : null}
      <Suspense fallback={<FileSurfaceLoading />}>
        {/* SCIENT-FORK:START — Word and PowerPoint keep their engine session with the document. */}
        {props.kind === "xlsx" ? (
          <Spreadsheet bytes={prepared.bytes} onDetails={setDetails} onError={fail} />
        ) : props.kind === "docx" ? (
          <WordDocument
            bytes={prepared.bytes}
            session={opened.session}
            onDetails={setDetails}
            onError={fail}
            // A stable callback, as the viewer's effect depends on it.
            onLimited={showLimited}
          />
        ) : (
          <Presentation
            bytes={prepared.bytes}
            session={opened.session}
            onDetails={setDetails}
            onError={fail}
          />
        )}
        {/* SCIENT-FORK:END */}
      </Suspense>
    </div>
  );
}
