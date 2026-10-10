import { useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { ChevronUp, X } from "lucide-react";
import { dockButtonClass } from "../writing/dockChrome";
import { isLatexContextEvent } from "./latexContextEvents";
import "./latexContextTools.css";

/** One object inspector. Its portal destination and unfinished fields stay mounted. */
export function LatexContextTools(props: {
  children: ReactNode;
  onPositionChange?: (position: string | null) => void;
}) {
  const { onPositionChange } = props;
  const root = useRef<HTMLDivElement>(null);
  const slot = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const panelId = useId();
  const [open, setOpen] = useState(false);
  const [label, setLabel] = useState<string | null>(null);
  const [inline, setInline] = useState(false);
  useLayoutEffect(() => {
    const element = root.current;
    const destination = slot.current;
    if (!element || !destination) return;
    let selectedToolbar: Element | null = null;
    const selectionChanged = () => {
      const object = destination.querySelector('[role="toolbar"]:not([data-context-fallback])');
      const fallbacks = Array.from(
        destination.querySelectorAll<HTMLElement>("[data-context-fallback]"),
      );
      const fallback = fallbacks[0];
      fallbacks.forEach((element, index) => {
        element.hidden = object !== null || index > 0;
      });
      const toolbar = object ?? fallback ?? null;
      onPositionChange?.(toolbar?.getAttribute("data-context-position") ?? null);
      setInline(toolbar?.getAttribute("data-context-presentation") === "inline");
      const name =
        toolbar?.getAttribute("data-context-name") ?? toolbar?.getAttribute("aria-label");
      setLabel(name ? name.replace(/ (options|tools)$/i, "") : null);
      if (toolbar !== selectedToolbar) {
        selectedToolbar = toolbar;
        setOpen(false);
      }
      if (
        toolbar?.getAttribute("data-context-presentation") !== "inline" &&
        toolbar?.querySelector(
          ".scient-latex-math-source-popover, .scient-latex-symbol-palette-panel",
        )
      )
        setOpen(true);
    };
    const mutation = new MutationObserver(selectionChanged);
    mutation.observe(destination, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: [
        "aria-label",
        "data-context-name",
        "data-context-presentation",
        "data-context-position",
      ],
    });
    selectionChanged();
    const outside = (event: Event) => {
      if (!isLatexContextEvent(event, element)) setOpen(false);
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("focusin", outside);
    return () => {
      mutation.disconnect();
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("focusin", outside);
    };
  }, [onPositionChange]);
  const close = () => {
    trigger.current?.focus({ preventScroll: true });
    setOpen(false);
  };
  return (
    <div
      ref={root}
      className="scient-latex-context-tools"
      data-inspector=""
      data-inline={inline || undefined}
      data-open={(open && label !== null) || undefined}
      onKeyDown={(event) => {
        if (open && event.key === "Escape" && !event.defaultPrevented) {
          event.preventDefault();
          event.stopPropagation();
          close();
        }
      }}
    >
      <button
        ref={trigger}
        type="button"
        className={dockButtonClass(open)}
        hidden={label === null || inline}
        aria-label={`${label ?? "Object"} options`}
        aria-expanded={open && label !== null}
        aria-controls={panelId}
        aria-haspopup="dialog"
        onClick={() => setOpen(!open)}
        onKeyDown={(event) => {
          if (event.key === "ArrowUp" || event.key === "ArrowDown") {
            event.preventDefault();
            setOpen(true);
            requestAnimationFrame(() => {
              const fields = slot.current?.querySelectorAll<HTMLElement>(
                "button:not(:disabled), input:not(:disabled), textarea:not(:disabled), summary",
              );
              Array.from(fields ?? [])
                .find((field) => field.getClientRects().length > 0)
                ?.focus();
            });
          }
        }}
      >
        <span>{label}</span>
        <ChevronUp aria-hidden="true" />
      </button>
      <div
        id={panelId}
        className="scient-latex-context-inspector"
        role={!inline && open && label !== null ? "dialog" : undefined}
        aria-label={`${label ?? "Object"} options`}
        inert={(!inline && !open) || label === null}
      >
        <div className="scient-latex-context-inspector-heading">
          <strong>{label}</strong>
          <button
            type="button"
            className={dockButtonClass()}
            aria-label="Close object options"
            onClick={close}
          >
            <X aria-hidden="true" />
          </button>
        </div>
        <div ref={slot} className="scient-latex-context-tools-slot">
          {props.children}
        </div>
      </div>
    </div>
  );
}
