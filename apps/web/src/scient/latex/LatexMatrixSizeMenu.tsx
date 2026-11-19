import { LatexSelect } from "./LatexSelect";
import { DocumentGridSizeMenu } from "../writing/DocumentTableSizeMenu";
import { insertMatrix, type MatrixEnvironment } from "../math/input/matrix";
import { useGT } from "gt-react";

export function LatexMatrixBrackets({
  value,
  onChange,
  compact = false,
}: {
  value: MatrixEnvironment;
  onChange: (value: MatrixEnvironment) => void;
  compact?: boolean;
}) {
  const gt = useGT();
  return (
    <label className={compact ? "grid justify-items-start" : "grid gap-1"}>
      {!compact && gt("Brackets")}
      <LatexSelect
        aria-label={gt("Matrix brackets")}
        size={compact ? "compact" : "default"}
        value={value}
        onValueChange={(value) => onChange(value as MatrixEnvironment)}
        options={[
          { value: "bmatrix", label: gt("{brackets} Square", { brackets: "[ ]" }) },
          { value: "pmatrix", label: gt("{brackets} Round", { brackets: "( )" }) },
          { value: "Bmatrix", label: gt("{brackets} Braces", { brackets: "{ }" }) },
          { value: "vmatrix", label: gt("{brackets} Single bars", { brackets: "| |" }) },
          {
            value: "Vmatrix",
            label: gt("{brackets} Double bars", { brackets: "\u2016 \u2016" }),
          },
          { value: "matrix", label: gt("None", { $context: "no matrix brackets" }) },
        ]}
      />
    </label>
  );
}

export function LatexMatrixSizeMenu({
  environment,
  onEnvironmentChange,
  onInsert,
  disabled,
  display,
}: {
  environment: MatrixEnvironment;
  onEnvironmentChange: (value: MatrixEnvironment) => void;
  onInsert: (tex: string) => void;
  disabled: boolean;
  display: boolean;
}) {
  const gt = useGT();
  return (
    <DocumentGridSizeMenu
      label={gt("Matrix")}
      kind="matrix"
      commandScope="latex"
      disabled={disabled}
      options={
        <div
          // Close to the grid below it: the choice belongs to the grid.
          className="scient-latex-matrix-options px-1.5 pt-0.5 pb-0 text-xs"
          onKeyDown={(event) => {
            // Keep picker keys from navigating the enclosing size menu.
            if (event.key !== "Escape" && event.key !== "Tab") event.stopPropagation();
          }}
        >
          <LatexMatrixBrackets compact value={environment} onChange={onEnvironmentChange} />
        </div>
      }
      onInsert={({ rows, columns }) => {
        const matrix = insertMatrix({ from: 0, to: 0 }, environment, rows, columns, display);
        if (matrix) onInsert(matrix.insert);
      }}
    />
  );
}
