import { LatexSelect } from "./LatexSelect";
import { DocumentGridSizeMenu } from "../writing/DocumentTableSizeMenu";
import { insertMatrix, type MatrixEnvironment } from "../math/input/matrix";

export function LatexMatrixBrackets({
  value,
  onChange,
  compact = false,
}: {
  value: MatrixEnvironment;
  onChange: (value: MatrixEnvironment) => void;
  compact?: boolean;
}) {
  return (
    <label className={compact ? "grid justify-items-start" : "grid gap-1"}>
      {!compact && "Brackets"}
      <LatexSelect
        aria-label="Matrix brackets"
        size={compact ? "compact" : "default"}
        value={value}
        onValueChange={(value) => onChange(value as MatrixEnvironment)}
        options={[
          { value: "bmatrix", label: "[ ] Square" },
          { value: "pmatrix", label: "( ) Round" },
          { value: "Bmatrix", label: "{ } Braces" },
          { value: "vmatrix", label: "| | Single bars" },
          { value: "Vmatrix", label: "\u2016 \u2016 Double bars" },
          { value: "matrix", label: "None" },
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
}: {
  environment: MatrixEnvironment;
  onEnvironmentChange: (value: MatrixEnvironment) => void;
  onInsert: (tex: string) => void;
  disabled: boolean;
}) {
  return (
    <DocumentGridSizeMenu
      label="Matrix"
      commandScope="latex"
      disabled={disabled}
      options={
        <div
          className="px-2 py-2 text-xs"
          onKeyDown={(event) => {
            // Keep picker keys from navigating the enclosing size menu.
            if (event.key !== "Escape" && event.key !== "Tab") event.stopPropagation();
          }}
        >
          <LatexMatrixBrackets compact value={environment} onChange={onEnvironmentChange} />
        </div>
      }
      onInsert={({ rows, columns }) => {
        const matrix = insertMatrix({ from: 0, to: 0 }, environment, rows, columns);
        if (matrix) onInsert(matrix.insert);
      }}
    />
  );
}
