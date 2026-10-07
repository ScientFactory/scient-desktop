import type { ReactNode } from "react";

/** Native fields keep typing and Tab navigation while inside a document menu. */
export function LatexContextMenuForm(props: { label: string; children: ReactNode }) {
  return (
    <div
      className="scient-latex-context-menu-form"
      role="group"
      aria-label={props.label}
      onKeyDown={(event) => {
        if (!(event.target instanceof Node) || !event.currentTarget.contains(event.target)) return;
        if (event.key === "Tab") {
          const fields = Array.from(
            event.currentTarget.querySelectorAll<HTMLElement>(
              'input:not(:disabled), button:not(:disabled), [role="menuitem"]:not([data-disabled])',
            ),
          ).filter((field) => field.getClientRects().length > 0);
          if (!fields.length) return;
          const at = fields.indexOf(document.activeElement as HTMLElement);
          const next =
            at < 0
              ? event.shiftKey
                ? fields.length - 1
                : 0
              : (at + (event.shiftKey ? -1 : 1) + fields.length) % fields.length;
          event.preventDefault();
          event.stopPropagation();
          fields[next]?.focus();
        } else if (event.key !== "Escape") event.stopPropagation();
      }}
    >
      {props.children}
    </div>
  );
}
