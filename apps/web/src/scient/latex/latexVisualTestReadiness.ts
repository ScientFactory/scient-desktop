import type { Editor } from "@tiptap/core";
import { vi, type TestContext } from "vite-plus/test";
import { latexPagedKey, pagedLayoutSettled } from "./latexPagedGeometry";
import { mathReadingPreviewReady } from "./mathReadingPreview";
import { readMountedLatexVisualTestEditor } from "./latexVisualTestOwner";

/** Poll the owners: an unchanged pagination pass can settle without a DOM or layout event. */
export async function waitForLatexVisualTestReadiness(
  container: HTMLElement,
  context: TestContext,
  label: string,
): Promise<Editor> {
  const { signal } = context;
  signal.throwIfAborted();
  // Vitest's retry helpers advance fake timers. Opening must finish before a scenario freezes them.
  if (vi.isFakeTimers()) throw new Error(`${label}: visual readiness requires native timers`);
  let fonts: { editor: Editor; promise: Promise<FontFaceSet>; ready: boolean } | undefined;
  try {
    const editor = await vi.waitUntil(
      () => {
        // A truthy abort result lets waitUntil clear its own interval and timeout.
        if (signal.aborted) return true;
        const current = readMountedLatexVisualTestEditor(container);
        if (!current || current.view.dom.dataset.latexLoading === "true") return false;
        const promise = document.fonts.ready;
        if (fonts?.editor !== current || fonts.promise !== promise) {
          const pending = { editor: current, promise, ready: false };
          fonts = pending;
          void promise.then(() => {
            if (!signal.aborted) pending.ready = true;
          });
        }
        if (!fonts.ready || document.fonts.status === "loading") return false;
        if (
          ![...current.view.dom.querySelectorAll(".scient-latex-math-preview")].every(
            mathReadingPreviewReady,
          )
        )
          return false;
        if (!latexPagedKey.getState(current.state)?.plan || !pagedLayoutSettled(current.view))
          return false;
        return current;
      },
      { timeout: context.task.timeout },
    );
    signal.throwIfAborted();
    // Only the abort sentinel is boolean, and throwIfAborted above prevents it escaping.
    if (editor === true) throw new Error(`${label}: visual readiness aborted`);
    return editor;
  } catch (error) {
    signal.throwIfAborted();
    throw new Error(`${label}: visual readiness did not complete`, { cause: error });
  }
}
