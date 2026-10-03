import { DockCommandItem, DockCommandRadioItem } from "../writing/dockChrome";
import { MenuRadioGroup, MenuRadioItemIndicator, MenuSeparator } from "~/components/ui/menu";
import { LatexMatrixSizeMenu } from "./LatexMatrixSizeMenu";
import type { MatrixEnvironment } from "../math/input/matrix";

export const LATEX_CASES_TEMPLATE = "\\begin{cases}{} & {}\\\\{} & {}\\end{cases}";

/** The same placement and insertion actions in the writing menu and math footer. */
export function LatexMathMenuItems({
  placement,
  disabled = false,
  protectedSource = false,
  onPlacement,
  onAligned,
  matrixEnvironment,
  onMatrixEnvironment,
  onInsert,
  onSymbols,
}: {
  placement: "inline-math" | "equation" | "";
  disabled?: boolean;
  protectedSource?: boolean;
  onPlacement: (display: boolean) => void;
  onAligned: () => void;
  matrixEnvironment: MatrixEnvironment;
  onMatrixEnvironment: (value: MatrixEnvironment) => void;
  onInsert: (tex: string) => void;
  onSymbols: () => void;
}) {
  return (
    <>
      <MenuRadioGroup value={placement}>
        {(
          [
            ["inline-math", "Inline math"],
            ["equation", "Display math"],
          ] as const
        ).map(([value, label]) => (
          <DockCommandRadioItem
            key={value}
            value={value}
            disabled={disabled || protectedSource}
            onClick={() => {
              if (placement !== value) onPlacement(value === "equation");
            }}
          >
            <span className="flex items-center justify-between gap-2">
              {label}
              <MenuRadioItemIndicator />
            </span>
          </DockCommandRadioItem>
        ))}
      </MenuRadioGroup>
      <DockCommandItem disabled={disabled || protectedSource} onClick={onAligned}>
        Aligned equations
      </DockCommandItem>
      <MenuSeparator />
      <LatexMatrixSizeMenu
        environment={matrixEnvironment}
        onEnvironmentChange={onMatrixEnvironment}
        disabled={disabled}
        onInsert={onInsert}
      />
      <DockCommandItem disabled={disabled} onClick={() => onInsert(LATEX_CASES_TEMPLATE)}>
        Cases
      </DockCommandItem>
      <DockCommandItem disabled={disabled} onClick={onSymbols}>
        Symbols &amp; structures…
      </DockCommandItem>
    </>
  );
}
