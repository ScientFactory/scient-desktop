// SCIENT-OWNED: the interface text weight picker beside the interface font size.
import { InterfaceFontWeight } from "@t3tools/contracts/settings";
import * as Schema from "effect/Schema";
import { msg, useGT, useMessages } from "gt-react";

import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "../../components/ui/select";

const isInterfaceFontWeight = Schema.is(InterfaceFontWeight);
const INTERFACE_FONT_WEIGHT_LABELS: Record<InterfaceFontWeight, string> = {
  300: msg("Light", { $context: "font weight" }),
  400: msg("Regular", { $context: "font weight" }),
  500: msg("Medium", { $context: "font weight" }),
};

export function InterfaceFontWeightSelect({
  weight,
}: {
  readonly weight: {
    value: InterfaceFontWeight;
    onChange: (value: InterfaceFontWeight) => void;
  };
}) {
  const gt = useGT();
  const m = useMessages();
  return (
    <Select
      value={String(weight.value)}
      onValueChange={(next) => {
        const parsed = typeof next === "string" ? Number(next) : null;
        if (isInterfaceFontWeight(parsed)) weight.onChange(parsed);
      }}
    >
      <SelectTrigger
        size="sm"
        className="w-24 min-w-0 shrink-0"
        aria-label={gt("Interface text weight")}
      >
        <SelectValue>{m(INTERFACE_FONT_WEIGHT_LABELS[weight.value])}</SelectValue>
      </SelectTrigger>
      <SelectPopup align="end" alignItemWithTrigger={false}>
        {InterfaceFontWeight.literals.map((value) => (
          <SelectItem hideIndicator key={value} value={String(value)}>
            {m(INTERFACE_FONT_WEIGHT_LABELS[value])}: {value}
          </SelectItem>
        ))}
      </SelectPopup>
    </Select>
  );
}
