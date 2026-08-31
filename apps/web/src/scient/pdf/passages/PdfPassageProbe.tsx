import { useEffect, useRef, useState } from "react";
import type { ScientPdfRuntime } from "../pdfRuntime";
import {
  captureSelectedPdfPassage,
  readPdfPassageSelection,
  showCapturedPdfPassage,
  verifyCapturedPdfPassage,
  type PdfPassageSelectionResult,
} from "./pdfPassageCapture";
import { PASSAGE_REFUSAL_COPY, type PdfPassageCapture } from "./pdfPassageModel";

// Loaded only by the development build. No file, browser-storage, or server writes.
export function PdfPassageProbe(props: {
  readonly runtime: ScientPdfRuntime | null;
  readonly reopen: () => void;
}) {
  const [capture, setCapture] = useState<PdfPassageCapture | null>(null);
  const captureRef = useRef(capture);
  captureRef.current = capture;
  const [selection, setSelection] = useState<PdfPassageSelectionResult>({ _tag: "Empty" });
  const [message, setMessage] = useState("Select a short passage, then capture it.");
  const [busy, setBusy] = useState(false);
  const generation = useRef(0);
  const currentRuntime = useRef(props.runtime);
  currentRuntime.current = props.runtime;
  const clearMarks = useRef<(() => void) | null>(null);

  useEffect(() => {
    generation.current += 1;
    setSelection({ _tag: "Empty" });
    setBusy(false);
    clearMarks.current?.();
    clearMarks.current = null;
    if (captureRef.current)
      setMessage(
        "The capture is preserved in memory. Return to verify it against the reopened PDF.",
      );
    const runtime = props.runtime;
    if (!runtime) return;
    const changed = () => {
      try {
        setSelection(readPdfPassageSelection(runtime, window.getSelection()));
      } catch {
        setSelection({ _tag: "Refused", reason: "invalid-selection" });
      }
    };
    document.addEventListener("selectionchange", changed);
    changed();
    return () => {
      generation.current += 1;
      document.removeEventListener("selectionchange", changed);
      clearMarks.current?.();
      clearMarks.current = null;
    };
  }, [props.runtime]);

  async function run(action: "capture" | "return") {
    const runtime = props.runtime;
    if (!runtime || busy) return;
    if (action === "capture" && selection._tag !== "Ready") return;
    const job = ++generation.current;
    const isCurrent = () => generation.current === job && currentRuntime.current === runtime;
    setBusy(true);
    setMessage(
      action === "capture"
        ? "Checking the selected text against the PDF…"
        : "Verifying the original PDF and passage…",
    );
    clearMarks.current?.();
    clearMarks.current = null;
    try {
      if (action === "capture" && selection._tag === "Ready") {
        const result = await captureSelectedPdfPassage(runtime, selection.pages);
        if (!isCurrent()) return;
        if (result._tag === "Captured") {
          setCapture(result.capture);
          setMessage(
            "Captured for this review session. Reopen the PDF, then return to the passage.",
          );
        } else setMessage(PASSAGE_REFUSAL_COPY[result.reason]);
      } else if (capture) {
        const result = await verifyCapturedPdfPassage(runtime, capture);
        if (!isCurrent()) return;
        if (result._tag === "Exact") {
          clearMarks.current = showCapturedPdfPassage(runtime, capture);
          setMessage(
            "Same PDF and text location verified. Extracted text accuracy has not been checked.",
          );
        } else setMessage(PASSAGE_REFUSAL_COPY[result.reason]);
      }
    } catch (error) {
      if (isCurrent())
        setMessage(
          error instanceof Error
            ? error.message
            : "The passage could not be verified. The original capture is preserved.",
        );
    } finally {
      if (isCurrent()) setBusy(false);
    }
  }

  const buttonClass =
    "rounded px-2 py-1 text-xs text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-40";
  return (
    <section
      className="shrink-0 border-t border-border bg-background p-3 text-sm"
      aria-label="PDF passage capture proof"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="font-medium">Passage capture proof</span>
        <span className="text-xs text-muted-foreground">
          Development only · not saved to the project
        </span>
      </div>
      <div className="mt-2 flex flex-wrap gap-1">
        <button
          type="button"
          className={buttonClass}
          disabled={!props.runtime || busy || selection._tag !== "Ready"}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => void run("capture")}
        >
          Capture selection
        </button>
        <button
          type="button"
          className={buttonClass}
          disabled={!props.runtime || busy || !capture}
          onClick={() => void run("return")}
        >
          Return to passage
        </button>
        <button
          type="button"
          className={buttonClass}
          disabled={!props.runtime || busy || !capture}
          onClick={() => {
            setMessage("Reopening PDF. The capture stays in memory; return to verify it again.");
            props.reopen();
          }}
        >
          Reopen PDF
        </button>
        <button
          type="button"
          className={buttonClass}
          disabled={!capture && !busy}
          onClick={() => {
            generation.current += 1;
            clearMarks.current?.();
            clearMarks.current = null;
            setCapture(null);
            setBusy(false);
            setMessage("Capture cleared. Nothing was saved to the project.");
          }}
        >
          Clear
        </button>
      </div>
      <p className="mt-2 text-xs text-muted-foreground" role="status">
        {!busy && selection._tag === "Refused" ? PASSAGE_REFUSAL_COPY[selection.reason] : message}
      </p>
      {capture ? (
        <div className="mt-2 text-xs">
          <p className="text-muted-foreground">
            Captured passage · page {capture.pages.map((page) => page.page).join(", ")}
          </p>
          <blockquote
            dir="auto"
            className="my-2 max-h-24 overflow-auto whitespace-pre-wrap border-s-2 border-border ps-3"
          >
            {capture.pages.map((page) => page.quote).join("\n\n")}
          </blockquote>
          <p className="text-muted-foreground">
            Compare this extracted text with the visible page, especially in scanned PDFs. A
            matching location does not verify the wording or its scientific meaning.
          </p>
          <details className="mt-2">
            <summary className="cursor-pointer text-muted-foreground hover:text-foreground">
              Capture diagnostics
            </summary>
            <p className="break-all text-muted-foreground">
              PDF SHA-256: {capture.material.sha256}
            </p>
            <p className="text-muted-foreground">
              PDF.js {capture.extractorVersion} ·{" "}
              {capture.pages.reduce((sum, page) => sum + page.rectangles.length, 0)} character-range
              rectangles
            </p>
          </details>
        </div>
      ) : null}
    </section>
  );
}
