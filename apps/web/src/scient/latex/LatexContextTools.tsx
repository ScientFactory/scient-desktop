import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { ChevronUp } from "lucide-react";
import { dockButtonClass } from "../markdownEditor/ui/dockChrome";

/** A stable portal destination keeps object fields mounted as the footer resizes. */
export function LatexContextTools(props: { children: ReactNode }) {
  const root = useRef<HTMLDivElement>(null);
  const [compact, setCompact] = useState(false);
  const [open, setOpen] = useState(false);
  const [label, setLabel] = useState("Selection");
  useLayoutEffect(() => {
    const element = root.current;
    if (!element) return;
    const resize = new ResizeObserver(([entry]) => {
      if (!entry) return;
      const narrow = entry.contentRect.width < 320;
      if (
        narrow &&
        element.querySelector(".scient-latex-context-tools-slot")?.contains(document.activeElement)
      )
        setOpen(true);
      setCompact(narrow);
    });
    resize.observe(element);
    let selectedToolbar: Element | null = null;
    const selectionChanged = () => {
      const toolbar = element.querySelector('[role="toolbar"]');
      const name = toolbar?.getAttribute("aria-label") ?? "Selection";
      setLabel(name === "Math tools" ? "Equation" : name.replace(/ (options|tools)$/i, ""));
      if (toolbar !== selectedToolbar) {
        selectedToolbar = toolbar;
        setOpen(false);
      }
      // Keyboard commands can open formula tools while the compact menu is closed.
      if (
        element.querySelector(
          ".scient-latex-math-source-popover, .scient-latex-symbol-palette-panel",
        )
      ) {
        setOpen(true);
      }
    };
    const mutation = new MutationObserver(selectionChanged);
    const slot = element.querySelector(".scient-latex-context-tools-slot");
    if (slot) mutation.observe(slot, { childList: true, subtree: true });
    selectionChanged();
    const close = (event: PointerEvent) => {
      if (event.target instanceof Node && !element.contains(event.target)) setOpen(false);
    };
    document.addEventListener("pointerdown", close);
    return () => {
      resize.disconnect();
      mutation.disconnect();
      document.removeEventListener("pointerdown", close);
    };
  }, []);
  return (
    <div
      ref={root}
      className="scient-latex-context-tools"
      data-compact={compact || undefined}
      data-open={open || undefined}
      onKeyDown={(event) => {
        if (compact && open && event.key === "Escape" && !event.defaultPrevented) {
          event.preventDefault();
          event.stopPropagation();
          setOpen(false);
          root.current?.querySelector<HTMLButtonElement>(":scope > button")?.focus();
        }
      }}
    >
      <button
        type="button"
        className={dockButtonClass()}
        aria-label={`${label} options`}
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <span>{label}</span>
        <ChevronUp />
      </button>
      <div className="scient-latex-context-tools-slot">{props.children}</div>
    </div>
  );
}
