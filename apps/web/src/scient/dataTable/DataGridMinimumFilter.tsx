import type { DataTableColumn, DataTableMinimum } from "@t3tools/contracts";
import { useGT } from "gt-react";
import { use, useState } from "react";

import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "~/components/ui/dialog";
import { MenuItem } from "~/components/ui/menu";
import { GridActionMenuContext } from "./gridActionMenu";
import { Input } from "~/components/ui/input";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";

import { isNumericType } from "./dataGridModel";

export function DataGridMinimumFilter(props: {
  readonly columns: ReadonlyArray<DataTableColumn>;
  readonly minimum: DataTableMinimum | null;
  readonly onChange: (value: DataTableMinimum | null) => void;
}) {
  const gt = useGT();
  const menu = use(GridActionMenuContext);
  const [open, setOpen] = useState(false);
  const numericColumns = props.columns
    .map((value, column) => ({ value, column }))
    .filter(({ value }) => isNumericType(value.type));
  const [column, setColumn] = useState<number | null>(null);
  const [text, setText] = useState("");
  const onOpenChange = (next: boolean) => {
    if (next) {
      setColumn(props.minimum?.column ?? numericColumns[0]?.column ?? null);
      setText(props.minimum === null ? "" : String(props.minimum.value));
    }
    setOpen(next);
  };

  if (menu === null) return null;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <MenuItem focus="edge" onClick={() => menu.launch(() => onOpenChange(true))}>
        {gt("Filter rows…")}
      </MenuItem>
      <DialogPopup finalFocus={menu.finalFocus}>
        <DialogHeader>
          <DialogTitle>{gt("Filter rows by a minimum value")}</DialogTitle>
        </DialogHeader>
        <form
          className="flex min-h-0 flex-col"
          onSubmit={(event) => {
            event.preventDefault();
            const value = Number(text);
            if (column === null || !Number.isFinite(value) || !text.trim()) return;
            props.onChange({ column, value });
            setOpen(false);
          }}
        >
          <DialogPanel>
            <label className="flex flex-col gap-1 text-sm">
              {gt("Numeric column")}
              <Select value={column} onValueChange={setColumn}>
                <SelectTrigger aria-label={gt("Numeric column")}>
                  <SelectValue>
                    {column === null ? undefined : props.columns[column]?.name}
                  </SelectValue>
                </SelectTrigger>
                <SelectPopup>
                  {numericColumns.map(({ value, column }) => (
                    <SelectItem key={column} value={column}>
                      {value.name}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            </label>
            <label className="flex flex-col gap-1 text-sm">
              {gt("Keep values at or above")}
              <Input
                type="number"
                step="any"
                value={text}
                onChange={(event) => setText(event.currentTarget.value)}
              />
            </label>
          </DialogPanel>
          <DialogFooter>
            {props.minimum !== null ? (
              <Button
                focus="edge"
                variant="outline"
                type="button"
                onClick={() => {
                  props.onChange(null);
                  setOpen(false);
                }}
              >
                {gt("Clear filter")}
              </Button>
            ) : null}
            <Button
              focus="edge"
              type="submit"
              disabled={column === null || !text.trim() || !Number.isFinite(Number(text))}
            >
              {gt("Apply filter")}
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}
