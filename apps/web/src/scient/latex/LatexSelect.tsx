import { useId, type ReactNode } from "react";
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
}) {
  const ownerId = useId();
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
          if (value !== null) props.onValueChange(value);
        }}
        onOpenChangeComplete={(open) => {
          if (!open) props.onClosed?.();
        }}
      >
        <SelectTrigger
          aria-label={props["aria-label"]}
          title={props.title}
          size={props.size ?? "default"}
          variant={props.size === "compact" ? "ghost" : "default"}
        >
          <SelectValue />
        </SelectTrigger>
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
