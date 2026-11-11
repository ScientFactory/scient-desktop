import type { DataTableQuery, EnvironmentId, ThreadId } from "@t3tools/contracts";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { useState } from "react";

import { useAssetUrlState } from "~/assets/assetUrls";
import { FileSurfaceLoading } from "~/components/files/fileSurfaceChrome";

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
  readonly threadId: ThreadId;
  /** Moves when the file may have changed: an agent's command or edit anywhere, the watcher. */
  readonly refreshToken: string;
  /** Moves when the reader asks to reload: the rows are read again. */
  readonly reloadKey: string;
}) {
  // Each move checks the file's revision; the table reads its rows again only for a new one.
  // An environment that reports no revision reads them on every move.
  const asset = useAssetUrlState(
    props.environmentId,
    {
      _tag: "media-file",
      threadId: props.threadId,
      path: props.absolutePath,
      disposition: "attachment",
    },
    props.refreshToken,
  );
  const checked =
    asset._tag === "Success"
      ? (asset.fileRevision ?? `unknown:${props.refreshToken}`)
      : asset._tag === "Failure"
        ? `unchecked:${props.refreshToken}`
        : null;
  const [revision, setRevision] = useState<string | null>(null);
  if (checked !== null && checked !== revision) setRevision(checked);
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
  if (revision === null) return <FileSurfaceLoading />;
  return (
    <DataGrid
      key={sheet}
      label={sheets[sheet] ?? props.name}
      revision={`${revision}#${props.reloadKey}`}
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
