import { useRef } from "react";
import { applyDocumentSourcePatches } from "@scientfactory/scient-document";
import {
  createLatexEditorSourceSnapshot,
  invertLatexSourcePatches,
  type LatexVisualEditOutcome,
  type LatexVisualEditRequest,
  type LatexEditorSourceSnapshot,
} from "./latexSourceEditPlan";

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
  const owner = useRef<LatexVisualTestOwner | null>(null);
  if (!owner.current) owner.current = createLatexVisualTestOwner(source);
  owner.current.observe(source);
  return owner.current;
}
