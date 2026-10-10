import { Check } from "lucide-react";
import { Button } from "~/components/ui/button";
import { ScientTooltip } from "../presentation/ScientTooltip";

function LatexNumberedLabel({ checked }: { checked: boolean }) {
  return (
    <>
      Numbered
      <span aria-hidden="true" className="flex size-3 shrink-0 items-center justify-center">
        {checked ? <Check /> : null}
      </span>
    </>
  );
}

export function LatexHeadingNumberButton({
  checked,
  disabled,
  onCheckedChange,
}: {
  checked: boolean;
  disabled?: boolean;
  onCheckedChange: (checked: boolean) => void;
}) {
  return (
    <div className="flex h-6 shrink-0 items-center gap-1">
      <ScientTooltip
        content={
          checked
            ? "Numbering is on. Click to turn it off."
            : "Numbering is off. Click to turn it on."
        }
      >
        <Button
          size="xs"
          variant={checked ? "selected-strong" : "outline"}
          aria-pressed={checked}
          data-latex-number-toggle=""
          disabled={disabled}
          onClick={() => onCheckedChange(!checked)}
        >
          <LatexNumberedLabel checked={checked} />
        </Button>
      </ScientTooltip>
    </div>
  );
}
