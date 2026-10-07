import { useContext, useId, useMemo, useState } from "react";
import { latexColorCss, latexDocumentColors } from "./latexColorBoxes";
import { LatexAuthoringContext } from "./latexObjectAuthoring";
import { ScientTooltip } from "~/scient/presentation/ScientTooltip";
import { latexPackageInventory } from "./latexPackages";

/** Document names and xcolor mixtures use one picker across text and objects. */
export function LatexColorControl(props: {
  label: string;
  value?: string;
  disabled?: boolean;
  onApply: (color: string) => void;
}) {
  const { source } = useContext(LatexAuthoringContext);
  const preamble = source.slice(0, latexPackageInventory(source).end);
  const colors = useMemo(() => latexDocumentColors(preamble), [preamble]);
  const [value, setValue] = useState(props.value ?? "");
  const id = useId();
  const valid = !value || latexColorCss(value, colors) !== null;
  return (
    <div className="scient-latex-property-field">
      <label htmlFor={id}>{props.label}</label>
      <div className="scient-latex-property-row">
        <input
          id={id}
          list={`${id}-colors`}
          value={value}
          placeholder="Inherited"
          disabled={props.disabled}
          aria-invalid={!valid}
          onChange={(event) => setValue(event.target.value)}
        />
        <datalist id={`${id}-colors`}>
          {Object.keys(colors).map((name) => (
            <option key={name} value={name} />
          ))}
        </datalist>
        <button
          type="button"
          disabled={props.disabled || !valid}
          onClick={() => props.onApply(value)}
        >
          Apply
        </button>
      </div>
      <div className="scient-latex-color-swatches" aria-label={`${props.label} palette`}>
        {Object.entries(colors).map(([name, css]) => (
          <ScientTooltip key={name} content={name}>
            <button
              type="button"
              aria-label={`${props.label}: ${name}`}
              disabled={props.disabled}
              style={{ background: css }}
              onClick={() => {
                setValue(name);
                props.onApply(name);
              }}
            />
          </ScientTooltip>
        ))}
      </div>
    </div>
  );
}
