// SCIENT-OWNED: the interface text weight picker beside the interface font size.
import { InterfaceFontWeight } from "@t3tools/contracts/settings";
import * as Schema from "effect/Schema";

import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "../../components/ui/select";

const isInterfaceFontWeight = Schema.is(InterfaceFontWeight);
const INTERFACE_FONT_WEIGHT_LABELS: Record<InterfaceFontWeight, string> = {
  300: "Light",
  400: "Regular",
  500: "Medium",
};

export function InterfaceFontWeightSelect({
  weight,
}: {
  readonly weight: {
    value: InterfaceFontWeight;
    onChange: (value: InterfaceFontWeight) => void;
  };
}) {
  return (
    <Select
      value={String(weight.value)}
      onValueChange={(next) => {
        const parsed = typeof next === "string" ? Number(next) : null;
        if (isInterfaceFontWeight(parsed)) weight.onChange(parsed);
      }}
    >
      <SelectTrigger size="sm" className="w-24 min-w-0 shrink-0" aria-label="Interface text weight">
        <SelectValue>{INTERFACE_FONT_WEIGHT_LABELS[weight.value]}</SelectValue>
      </SelectTrigger>
      <SelectPopup align="end" alignItemWithTrigger={false}>
        {InterfaceFontWeight.literals.map((value) => (
          <SelectItem hideIndicator key={value} value={String(value)}>
            {INTERFACE_FONT_WEIGHT_LABELS[value]} — {value}
          </SelectItem>
        ))}
      </SelectPopup>
    </Select>
  );
}
