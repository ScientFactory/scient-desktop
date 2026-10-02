import { useState } from "react";
import { Input } from "~/components/ui/input";
import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogPopup,
  DialogTitle,
  DialogDescription,
  DialogHeader,
  DialogPanel,
} from "~/components/ui/dialog";
import { insertMatrix, type MatrixEnvironment } from "../math/input/matrix";
import { LatexMatrixBrackets } from "./LatexMatrixSizeMenu";

export function LatexMatrixDialog({
  open,
  environment,
  onEnvironmentChange,
  onOpenChange,
  onOpenChangeComplete,
  onInsert,
}: {
  open: boolean;
  environment: MatrixEnvironment;
  onEnvironmentChange: (value: MatrixEnvironment) => void;
  onOpenChange: (open: boolean) => void;
  onOpenChangeComplete: (open: boolean) => void;
  onInsert: (tex: string) => void;
}) {
  const [rows, setRows] = useState(2);
  const [columns, setColumns] = useState(2);
  const matrix = insertMatrix({ from: 0, to: 0 }, environment, rows, columns);
  return (
    <Dialog open={open} onOpenChange={onOpenChange} onOpenChangeComplete={onOpenChangeComplete}>
      <DialogPopup data-dock-command-scope="latex" finalFocus={false}>
        <DialogHeader>
          <DialogTitle>Matrix</DialogTitle>
          <DialogDescription>
            Choose its size and brackets, then fill in the cells.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <form
            className="scient-writing-dialog"
            onSubmit={(event) => {
              event.preventDefault();
              if (matrix) onInsert(matrix.insert);
            }}
          >
            <div className="grid grid-cols-2 gap-3">
              <label>
                Rows{" "}
                <Input
                  aria-label="Matrix rows"
                  type="number"
                  min={1}
                  max={20}
                  value={Number.isFinite(rows) ? rows : ""}
                  onChange={(event) => setRows(event.currentTarget.valueAsNumber)}
                />
              </label>
              <label>
                Columns{" "}
                <Input
                  aria-label="Matrix columns"
                  type="number"
                  min={1}
                  max={20}
                  value={Number.isFinite(columns) ? columns : ""}
                  onChange={(event) => setColumns(event.currentTarget.valueAsNumber)}
                />
              </label>
              <div className="col-span-2">
                <LatexMatrixBrackets value={environment} onChange={onEnvironmentChange} />
              </div>
            </div>
            <div className="mt-4 flex justify-end gap-2">
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={!matrix}>
                Insert matrix
              </Button>
            </div>
          </form>
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}
