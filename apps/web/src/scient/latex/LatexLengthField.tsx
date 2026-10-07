import { LatexSelect } from "./LatexSelect";
import { Input } from "~/components/ui/input";

/** User-facing dimensions keep LaTeX units at the adapter boundary. */
export function LatexLengthField(props: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  relative?: boolean;
  relativeTo?: readonly ("linewidth" | "textwidth" | "columnwidth")[];
  automatic?: boolean;
  disabled?: boolean;
  size?: "sm";
  width?: "content";
}) {
  const match =
    /^(\d+(?:\.\d*)?|\.\d+)(mm|cm|in|pt|em|ex|\\(?:linewidth|textwidth|columnwidth))$/u.exec(
      props.value,
    );
  const unit = match?.[2] ?? "mm";
  const amount = match
    ? String(unit.startsWith("\\") ? Math.round(Number(match[1]) * 10000) / 100 : Number(match[1]))
    : "";
  const make = (value: string, nextUnit: string) =>
    value === "" ? "" : `${nextUnit.startsWith("\\") ? Number(value) / 100 : value}${nextUnit}`;
  const amountField =
    props.size === "sm" ? (
      <Input
        size="compact"
        type="number"
        aria-label={props.label}
        value={amount}
        min={0}
        step="any"
        placeholder={props.automatic ? "Automatic" : undefined}
        disabled={props.disabled}
        onChange={(event) => props.onChange(make(event.target.value, unit))}
      />
    ) : (
      <input
        type="number"
        aria-label={props.label}
        value={amount}
        min={0}
        step="any"
        placeholder={props.automatic ? "Automatic" : undefined}
        disabled={props.disabled}
        onChange={(event) => props.onChange(make(event.target.value, unit))}
      />
    );
  return (
    <label>
      {props.label}
      <span className="scient-latex-property-row" data-width={props.width}>
        {props.width === "content" ? (
          <span className="scient-latex-length-amount">{amountField}</span>
        ) : (
          amountField
        )}
        <LatexSelect
          size={props.size ?? "default"}
          aria-label={`${props.label} unit`}
          value={unit}
          disabled={props.disabled === true}
          width={props.width === "content" ? "options" : "default"}
          onValueChange={(value) => props.onChange(make(amount, value))}
          options={[
            ...["mm", "cm", "in", "pt", "em", ...(unit === "ex" ? ["ex"] : [])].map((value) => ({
              value,
              label: value,
            })),
            ...(props.relative
              ? (props.relativeTo ?? ["linewidth"]).map((basis) => ({
                  value: `\\${basis}`,
                  label:
                    basis === "textwidth"
                      ? "% of text"
                      : basis === "columnwidth"
                        ? "% of column"
                        : "% of line",
                }))
              : []),
          ]}
        />
      </span>
    </label>
  );
}
