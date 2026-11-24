import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "../../components/ui/select";

export function RecordingSelect({
  label,
  value,
  options,
  onChange,
  variant = "ghost",
  portalContainer,
  display,
}: {
  label: string;
  /** A shorter trigger text than the selected option's label. */
  display?: string | undefined;
  variant?: "ghost" | "outline";
  portalContainer?: React.RefObject<HTMLElement | null> | undefined;
  value: string;
  options: readonly { value: string; label: string }[];
  onChange: (value: string) => void;
}) {
  return (
    <Select
      value={value}
      onValueChange={(next) => {
        if (next !== null) onChange(next);
      }}
    >
      <SelectTrigger
        size="sm"
        variant={variant === "outline" ? "default" : "ghost"}
        width="content"
        aria-label={label}
      >
        <SelectValue>
          {display ?? options.find((option) => option.value === value)?.label ?? label}
        </SelectValue>
      </SelectTrigger>
      <SelectPopup alignItemWithTrigger={false} portalContainer={portalContainer}>
        {options.map((option) => (
          <SelectItem key={option.value} value={option.value}>
            {option.label}
          </SelectItem>
        ))}
      </SelectPopup>
    </Select>
  );
}
