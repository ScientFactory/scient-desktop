import { useState } from "react";
import type { Editor } from "@tiptap/core";
import { applyDocumentSourcePatches } from "@scientfactory/scient-document";
import {
  createLatexEditorSourceSnapshot,
  invertLatexSourcePatches,
  type LatexVisualEditOutcome,
  type LatexVisualEditRequest,
  type LatexEditorSourceSnapshot,
} from "./latexSourceEditPlan";

/** HappyDOM has no browser font pool; editor fixtures use a settled empty one. */
export function stubLatexReadingFonts() {
  const previous = Object.getOwnPropertyDescriptor(document, "fonts");
  Object.defineProperty(document, "fonts", {
    configurable: true,
    value: Object.assign(new EventTarget(), {
      ready: Promise.resolve(),
      status: "loaded",
      [Symbol.iterator]: function* () {},
    }),
  });
  return () => {
    if (previous) Object.defineProperty(document, "fonts", previous);
    else Reflect.deleteProperty(document, "fonts");
  };
}

export interface LatexVisualTestOwner {
  readonly snapshot: LatexEditorSourceSnapshot;
  observe(source: string): LatexEditorSourceSnapshot;
  edit(request: LatexVisualEditRequest, accept?: boolean): LatexVisualEditOutcome;
}
/** A real single-file patch owner for editor behavior fixtures. */
export function createLatexVisualTestOwner(
  source: string,
  rootSource?: string,
): LatexVisualTestOwner {
  let snapshot = createLatexEditorSourceSnapshot(source, rootSource);
  let observed = source;
  return {
    get snapshot() {
      return snapshot;
    },
    observe(source: string) {
      if (source !== observed && source !== snapshot.source)
        snapshot = createLatexEditorSourceSnapshot(source, snapshot.rootSource);
      observed = source;
      return snapshot;
    },
    edit(request: LatexVisualEditRequest, accept = true): LatexVisualEditOutcome {
      if (!accept || request.snapshot.id !== snapshot.id || request.edit.source !== snapshot.source)
        return { accepted: false, reason: "The native source owner changed." };
      if (request.edit.physical?.length)
        return { accepted: false, reason: "This fixture owns one native file." };
      const previous = snapshot;
      const next = applyDocumentSourcePatches(previous.source, request.edit.patches);
      const root = request.edit.root;
      if (root && root.source !== previous.rootSource)
        return { accepted: false, reason: "The native root owner changed." };
      const rootSource = root
        ? applyDocumentSourcePatches(root.source, root.patches)
        : previous.rootSource;
      snapshot = createLatexEditorSourceSnapshot(next, rootSource);
      return {
        accepted: true,
        snapshot,
        inverseEdit: {
          source: next,
          patches: invertLatexSourcePatches(previous.source, request.edit.patches),
          ...(root
            ? {
                root: {
                  source: rootSource!,
                  patches: invertLatexSourcePatches(root.source, root.patches),
                },
              }
            : {}),
        },
      };
    },
  };
}

export function useLatexVisualTestOwner(source: string) {
  const [owner] = useState(() => createLatexVisualTestOwner(source));
  owner.observe(source);
  return owner;
}

/** A Tiptap instance can exist before its view mounts, or outlive its detached view. */
export function readMountedLatexVisualTestEditor(container: HTMLElement): Editor | null {
  const element = container.querySelector<HTMLElement & { editor?: Editor }>(
    ".scient-latex-visual-document",
  );
  const editor = element?.editor;
  if (!element?.isConnected || !editor || editor.isDestroyed || !editor.isInitialized) return null;
  return editor.view.dom === element ? editor : null;
}

/** Native scroll delivery invalidates pagination before a fixture can await its new plan. */
export async function scrollLatexVisualTestEditor(editor: Editor, change: () => void) {
  const scroll = editor.view.dom.closest<HTMLElement>(".scient-latex-visual-scroll")!;
  let receive!: () => void;
  const delivered = new Promise<void>((resolve) => {
    receive = resolve;
  });
  scroll.addEventListener("scroll", receive, { once: true });
  try {
    const beforeTop = scroll.scrollTop;
    const beforeLeft = scroll.scrollLeft;
    change();
    // A clamped request that leaves both offsets unchanged emits no native event.
    if (scroll.scrollTop !== beforeTop || scroll.scrollLeft !== beforeLeft) await delivered;
  } finally {
    scroll.removeEventListener("scroll", receive);
  }
}
