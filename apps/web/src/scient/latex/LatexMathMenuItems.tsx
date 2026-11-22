import { DockCommandItem, DockCommandRadioItem } from "../writing/dockChrome";
import { MenuRadioGroup, MenuRadioItemIndicator, MenuSeparator } from "~/components/ui/menu";
import { LatexMatrixSizeMenu } from "./LatexMatrixSizeMenu";
import { LatexBracketsMenu } from "./LatexBracketsMenu";
import type { MatrixEnvironment } from "../math/input/matrix";
import { T, useGT } from "gt-react";

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
  const gt = useGT();
  return (
    <>
      <MenuRadioGroup value={placement}>
        {(
          [
            ["inline-math", gt("Inline math")],
            ["equation", gt("Display math")],
          ] as const
        ).map(([value, label]) => (
          <DockCommandRadioItem
            key={value}
            value={value}
            disabled={disabled || protectedSource || (value === "equation" && !displayAvailable)}
            title={
              value === "equation" && !displayAvailable
                ? gt("This container supports inline math.")
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
        title={!displayAvailable ? gt("This container supports inline math.") : undefined}
      >
        <T>Aligned equations</T>
      </DockCommandItem>
      <MenuSeparator />
      <LatexBracketsMenu disabled={disabled} onInsert={onBrackets} />
      <LatexMatrixSizeMenu
        display={placement !== "inline-math" && displayAvailable}
        environment={matrixEnvironment}
        onEnvironmentChange={onMatrixEnvironment}
        disabled={disabled}
        onInsert={onInsert}
      />
      <DockCommandItem disabled={disabled} onClick={() => onInsert(LATEX_CASES_TEMPLATE)}>
        <T context="LaTeX cases environment">Cases</T>
      </DockCommandItem>
      <DockCommandItem disabled={disabled} onClick={onSymbols}>
        <T>Symbols</T>
      </DockCommandItem>
    </>
  );
}
