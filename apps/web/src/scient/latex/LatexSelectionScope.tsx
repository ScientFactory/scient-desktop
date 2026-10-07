import { useEffect, useState, type RefObject } from "react";

/** Scope feedback belongs to the status bar, never the command menus. */
export function LatexSelectionScope({ workspace }: { workspace: RefObject<HTMLElement | null> }) {
  const [path, setPath] = useState<readonly string[]>([]);
  useEffect(() => {
    const root = workspace.current;
    if (!root) return;
    const update = (event: Event) => {
      if (event instanceof CustomEvent && Array.isArray(event.detail)) setPath(event.detail);
    };
    root.addEventListener("scient-latex-selection-scope", update);
    return () => root.removeEventListener("scient-latex-selection-scope", update);
  }, [workspace]);
  return (
    <span
      className="scient-latex-selection-scope"
      dir="ltr"
      role="status"
      aria-label={path.join(" \u203a ")}
    >
      {path.join(" \u203a ")}
    </span>
  );
}
