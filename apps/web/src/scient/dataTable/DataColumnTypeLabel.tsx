import type { DataTableColumn } from "@t3tools/contracts";
import { useMessages } from "gt-react";

import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";

import { dataColumnTypeName } from "./dataGridModel";

export function DataColumnTypeLabel(props: {
  readonly column: DataTableColumn;
  readonly className?: string;
}) {
  const messages = useMessages();
  return (
    <Tooltip>
      <TooltipTrigger render={<span className={props.className} />}>
        {dataColumnTypeName(props.column.type, messages)}
      </TooltipTrigger>
      <TooltipPopup role="tooltip">{props.column.label}</TooltipPopup>
    </Tooltip>
  );
}
