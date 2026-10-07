import { useEffect, useEffectEvent, useRef, useState } from "react";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import {
  Dialog,
  DialogPopup,
  DialogTitle,
  DialogDescription,
  DialogHeader,
  DialogPanel,
} from "~/components/ui/dialog";
import { MAX_SCIENT_MARKDOWN_TABLE_INSERT_DIMENSION } from "../markdownEditor/prosemirror/commands";

export function LatexTableInsertDialog(props: {
  open: boolean;
  onClose: () => void;
  onCancel: () => void;
  onInsert: (rows: number, columns: number) => void;
}) {
  const [rows, setRows] = useState(2);
  const [columns, setColumns] = useState(2);
  const pending = useRef<{ rows: number; columns: number } | null>(null);
  const previouslyOpen = useRef(props.open);
  const finish = useEffectEvent(() => {
    const size = pending.current;
    pending.current = null;
    if (size) props.onInsert(size.rows, size.columns);
    else props.onCancel();
  });
  useEffect(() => {
    const closing = previouslyOpen.current && !props.open;
    previouslyOpen.current = props.open;
    if (closing) finish();
  }, [props.open]);
  const max = MAX_SCIENT_MARKDOWN_TABLE_INSERT_DIMENSION;
  const valid = [rows, columns].every(
    (value) => Number.isInteger(value) && value >= 1 && value <= max,
  );
  return (
    <Dialog
      modal={false}
      open={props.open}
      onOpenChange={(open) => {
        if (!open) props.onClose();
      }}
    >
      <DialogPopup showBackdrop={false} finalFocus={false} data-dock-command-scope="latex">
        <DialogHeader>
          <DialogTitle>Insert table</DialogTitle>
          <DialogDescription>
            Choose the number of rows and columns, from 1 to {max}.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <form
            className="grid gap-3"
            onSubmit={(event) => {
              event.preventDefault();
              if (!valid) return;
              pending.current = { rows, columns };
              props.onClose();
            }}
          >
            <label>
              Rows
              <Input
                autoFocus
                type="number"
                min={1}
                max={max}
                value={Number.isNaN(rows) ? "" : rows}
                onChange={(event) => setRows(event.target.valueAsNumber)}
              />
            </label>
            <label>
              Columns
              <Input
                type="number"
                min={1}
                max={max}
                value={Number.isNaN(columns) ? "" : columns}
                onChange={(event) => setColumns(event.target.valueAsNumber)}
              />
            </label>
            <div className="flex justify-end gap-2">
              <Button type="button" variant="outline" onClick={props.onClose}>
                Cancel
              </Button>
              <Button type="submit" disabled={!valid}>
                Insert table
              </Button>
            </div>
          </form>
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}
