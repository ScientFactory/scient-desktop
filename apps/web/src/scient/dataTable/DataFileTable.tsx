import type { DataTableQuery, EnvironmentId } from "@t3tools/contracts";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { useState } from "react";

import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import { useAtomQueryRunner } from "~/state/use-atom-query-runner";

import { DataGrid } from "./DataGrid";
import { dataFileTablePage } from "./dataTableState";

/** A data file read in place on its environment, a page at a time. */
export function DataFileTable(props: {
  readonly environmentId: EnvironmentId;
  readonly absolutePath: string;
  readonly name: string;
  /** Changes when the file changes on disk. */
  readonly revision: string;
}) {
  const readPage = useAtomQueryRunner(dataFileTablePage, { reportFailure: false, refresh: true });
  const [sheet, setSheet] = useState(0);
  const [sheets, setSheets] = useState<ReadonlyArray<string>>([]);
  const loadPage = async (query: DataTableQuery) => {
    const result = await readPage({
      environmentId: props.environmentId,
      input: { path: props.absolutePath, sheet, query },
    });
    if (result._tag !== "Success") throw squashAtomCommandFailure(result);
    setSheets(result.value.sheets);
    return result.value;
  };
  return (
    <DataGrid
      key={sheet}
      label={sheets[sheet] ?? props.name}
      revision={props.revision}
      loadPage={loadPage}
      toolbarStart={
        sheets.length > 1 ? (
          <Select value={sheet} onValueChange={(value) => setSheet(value ?? 0)}>
            <SelectTrigger size="xs" className="w-fit max-w-40 shrink-0" aria-label="Sheet">
              <SelectValue>{sheets[sheet]}</SelectValue>
            </SelectTrigger>
            <SelectPopup alignItemWithTrigger={false}>
              {sheets.map((name, index) => (
                <SelectItem key={name} value={index}>
                  {name}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        ) : null
      }
    />
  );
}
