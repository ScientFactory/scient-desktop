import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { useLayoutEffect } from "react";
import { useContentDirection } from "./ContentDirectionScope";

function applyComposerDirection(
  rootElement: HTMLElement | null,
  direction: "auto" | "rtl" | "ltr",
): void {
  if (!rootElement) return;

  const surface = rootElement.closest<HTMLElement>(".composer-editor-surface");
  if (surface) {
    if (direction === "auto") {
      surface.removeAttribute("data-scient-content-direction");
    } else {
      surface.dataset.scientContentDirection = direction;
    }
  }

  if (direction === "auto") {
    rootElement.removeAttribute("dir");
    for (const paragraph of rootElement.querySelectorAll<HTMLElement>(":scope > p")) {
      paragraph.dir = "auto";
    }
    return;
  }

  rootElement.dir = direction;
  for (const paragraph of rootElement.querySelectorAll<HTMLElement>(":scope > p")) {
    paragraph.dir = direction;
  }
}

/** Applies only the explicit mode; Automatic remains Lexical's native mode. */
export function ComposerContentDirectionPlugin() {
  const [editor] = useLexicalComposerContext();
  const direction = useContentDirection();

  useLayoutEffect(() => {
    const apply = () => applyComposerDirection(editor.getRootElement(), direction);
    apply();
    const unregisterUpdate = editor.registerUpdateListener(apply);
    const unregisterRoot = editor.registerRootListener(() => apply());
    return () => {
      unregisterUpdate();
      unregisterRoot();
    };
  }, [direction, editor]);

  return null;
}
