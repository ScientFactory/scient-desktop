import { useId, type ReactNode } from "react";
import { ScientTooltip } from "~/scient/presentation/ScientTooltip";

/** Availability and its explanation travel with the action, not just its button. */
export function LatexContextAction(props: {
  children: ReactNode;
  onAction: () => void;
  disabled?: boolean;
  disabledReason?: string | null | undefined;
  destructive?: boolean;
}) {
  const button = (
    <button
      type="button"
      className="scient-latex-context-action"
      disabled={props.disabled || Boolean(props.disabledReason)}
      aria-description={props.disabledReason ?? undefined}
      data-destructive={props.destructive || undefined}
      onClick={() => {
        if (!props.disabled && !props.disabledReason) props.onAction();
      }}
    >
      {props.children}
    </button>
  );
  return props.disabledReason ? (
    <ScientTooltip content={props.disabledReason}>
      <span>{button}</span>
    </ScientTooltip>
  ) : (
    button
  );
}

export function LatexContextSection(props: { title: string; children: ReactNode }) {
  const id = useId();
  return (
    <details className="scient-latex-context-menu">
      <summary aria-controls={id}>
        {props.title}
        <span aria-hidden="true">⌄</span>
      </summary>
      <div id={id} className="scient-latex-context-menu-panel">
        {props.children}
      </div>
    </details>
  );
}
