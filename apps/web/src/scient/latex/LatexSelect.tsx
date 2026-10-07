import { useId, type ReactNode } from "react";
import { ScientTooltip } from "~/scient/presentation/ScientTooltip";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";

/** Theme-aware choices that keep a portaled popup attached to its editor context. */
export function LatexSelect(props: {
  value: string | number;
  onValueChange: (value: string) => void;
  onClosed?: () => void;
  options: readonly { value: string; label: ReactNode; disabled?: boolean }[];
  "aria-label": string;
  disabled?: boolean;
  title?: string | undefined;
  size?: "default" | "compact" | "sm";
  width?: "default" | "options";
}) {
  const ownerId = useId();
  const trigger = (
    <SelectTrigger
      aria-label={props["aria-label"]}
      aria-description={props.title}
      size={props.size ?? "default"}
      variant={props.size === "compact" ? "ghost" : "default"}
      width={props.width === "options" ? "content" : "default"}
    >
      {props.width === "options" ? (
        <span className="grid min-w-0 flex-1 text-left">
          <span className="col-start-1 row-start-1">
            <SelectValue />
          </span>
          {/* Reserve the widest option without measurement effects or resize on selection. */}
          <span
            aria-hidden="true"
            className="invisible pointer-events-none col-start-1 row-start-1 grid"
          >
            {props.options.map((option) => (
              <span key={option.value} className="col-start-1 row-start-1 whitespace-nowrap">
                {option.label}
              </span>
            ))}
          </span>
        </span>
      ) : (
        <SelectValue />
      )}
    </SelectTrigger>
  );
  return (
    <span
      id={ownerId}
      className="scient-latex-select"
      data-compact={props.size === "compact" || undefined}
    >
      <Select
        value={String(props.value)}
        items={props.options}
        disabled={props.disabled}
        onValueChange={(value) => {
          if (value !== null) {
            document
              .getElementById(ownerId)
              ?.dispatchEvent(
                new CustomEvent("scient-writing-restore-selection", { bubbles: true }),
              );
            props.onValueChange(value);
          }
        }}
        onOpenChangeComplete={(open) => {
          if (!open) props.onClosed?.();
        }}
      >
        {props.title ? (
          <ScientTooltip content={props.title}>
            <span>{trigger}</span>
          </ScientTooltip>
        ) : (
          trigger
        )}
        <SelectPopup
          alignItemWithTrigger={false}
          data-dock-command-scope="latex"
          data-latex-select-owner={ownerId}
        >
          {props.options.map((option) => (
            <SelectItem key={option.value} value={option.value} disabled={option.disabled}>
              {option.label}
            </SelectItem>
          ))}
        </SelectPopup>
      </Select>
    </span>
  );
}
