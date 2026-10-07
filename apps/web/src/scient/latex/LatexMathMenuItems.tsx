import { DockCommandItem, DockCommandRadioItem } from "../writing/dockChrome";
import { MenuRadioGroup, MenuRadioItemIndicator, MenuSeparator } from "~/components/ui/menu";
import { LatexMatrixSizeMenu } from "./LatexMatrixSizeMenu";
import { LatexBracketsMenu } from "./LatexBracketsMenu";
import type { MatrixEnvironment } from "../math/input/matrix";

export const LATEX_CASES_TEMPLATE = "\\begin{cases}{} & {}\\\\{} & {}\\end{cases}";

/** The same placement and insertion actions in the writing menu and math footer. */
export function LatexMathMenuItems({
  placement,
  disabled = false,
  protectedSource = false,
  displayAvailable = true,
  onPlacement,
  onAligned,
  matrixEnvironment,
  onMatrixEnvironment,
  onInsert,
  onBrackets,
  onSymbols,
}: {
  placement: "inline-math" | "equation" | "";
  disabled?: boolean;
  protectedSource?: boolean;
  displayAvailable?: boolean;
  onPlacement: (display: boolean) => void;
  onAligned: () => void;
  matrixEnvironment: MatrixEnvironment;
  onMatrixEnvironment: (value: MatrixEnvironment) => void;
  onInsert: (tex: string) => void;
  onBrackets: (tex: string) => void;
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
            disabled={disabled || protectedSource || (value === "equation" && !displayAvailable)}
            title={
              value === "equation" && !displayAvailable
                ? "This container supports inline math."
                : undefined
            }
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
      <DockCommandItem
        disabled={disabled || protectedSource || !displayAvailable}
        onClick={onAligned}
        title={!displayAvailable ? "This container supports inline math." : undefined}
      >
        Aligned equations
      </DockCommandItem>
      <MenuSeparator />
      <LatexBracketsMenu disabled={disabled} onInsert={onBrackets} />
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
        Symbols
      </DockCommandItem>
    </>
  );
}
