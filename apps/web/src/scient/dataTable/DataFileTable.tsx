import type { DataTableQuery, EnvironmentId, ThreadId } from "@t3tools/contracts";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { savedViewReferences, savedViewUnresolvedRelations } from "@t3tools/shared/savedDataView";
import { useGT } from "gt-react";
import { useState } from "react";

import { useAssetUrlState } from "~/assets/assetUrls";
import { Button } from "~/components/ui/button";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "~/components/ui/collapsible";
import { FileSurfaceLoading } from "~/components/files/fileSurfaceChrome";

import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import { useAtomQueryRunner } from "~/state/use-atom-query-runner";

import { DataProfileButton } from "./DataProfileButton";
import { DataGrid } from "./DataGrid";
import { canSaveDataView, isScientSavedViewFile } from "./dataFiles";
import { dataFileTablePage, dataViewPage, type ProfileTarget } from "./dataTableState";
import { DataViewActions, type DataWorkspaceFile } from "./DataViewActions";
import { UseDataInAnalysis } from "./UseDataInAnalysis";

/** A data file read in place on its environment, a page at a time. */
export function DataFileTable(props: {
  readonly environmentId: EnvironmentId;
  readonly absolutePath: string;
  readonly name: string;
  readonly workspace?: DataWorkspaceFile | undefined;
  readonly viewSql?: string | undefined;
  readonly onShowSql?: (() => void) | undefined;
  readonly threadId: ThreadId;
  /** Moves when the file may have changed: an agent's command or edit anywhere, the watcher. */
  readonly refreshToken: string;
  /** Moves when the reader asks to reload: the rows are read again. */
  readonly reloadKey: string;
}) {
  // Each move checks the file's revision; the table reads its rows again only for a new one.
  // An environment that reports no revision reads them on every move.
  const gt = useGT();
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
  const readView = useAtomQueryRunner(dataViewPage, { reportFailure: false, refresh: true });
  const workspace = props.workspace;
  const savedView =
    workspace && isScientSavedViewFile(workspace.path, props.viewSql) ? workspace : null;
  const [sheet, setSheet] = useState(0);
  const [sheets, setSheets] = useState<ReadonlyArray<string>>([]);
  const loadPage = async (query: DataTableQuery) => {
    if (savedView !== null) {
      const result = await readView({
        environmentId: props.environmentId,
        input: { cwd: savedView.cwd, path: savedView.path, query },
      });
      if (result._tag !== "Success") throw squashAtomCommandFailure(result);
      return result.value;
    }
    const result = await readPage({
      environmentId: props.environmentId,
      input: { path: props.absolutePath, sheet, query },
    });
    if (result._tag !== "Success") throw squashAtomCommandFailure(result);
    setSheets(result.value.sheets);
    return result.value;
  };
  if (revision === null) return <FileSurfaceLoading />;
  const gridRevision = `${revision}#${props.reloadKey}`;
  const target: ProfileTarget = savedView
    ? { kind: "view", input: { cwd: savedView.cwd, path: savedView.path } }
    : { kind: "file", input: { path: props.absolutePath, sheet } };
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {savedView ? <SavedViewBanner sql={props.viewSql ?? ""} onShowSql={props.onShowSql} /> : null}
      <DataGrid
        key={sheet}
        label={sheets[sheet] ?? props.name}
        revision={gridRevision}
        loadPage={loadPage}
        enableMinimumFilter={
          workspace !== undefined && (savedView !== null || canSaveDataView(workspace.path))
        }
        toolbarEnd={
          <DataProfileButton
            key={gridRevision}
            environmentId={props.environmentId}
            sourceLabel={workspace?.path ?? props.name}
            target={target}
          />
        }
        {...(workspace
          ? {
              renderMenuActions: (view) => (
                <>
                  {savedView || canSaveDataView(workspace.path) ? (
                    <DataViewActions
                      kind={savedView ? "export" : "save"}
                      file={workspace}
                      view={view}
                      environmentId={props.environmentId}
                    />
                  ) : null}
                  <UseDataInAnalysis
                    environmentId={props.environmentId}
                    threadId={props.threadId}
                    file={workspace}
                    sheet={sheet}
                  />
                </>
              ),
            }
          : {})}
        toolbarStart={
          sheets.length > 1 ? (
            <Select value={sheet} onValueChange={(value) => setSheet(value ?? 0)}>
              <SelectTrigger
                size="xs"
                className="w-fit max-w-40 shrink-0"
                aria-label={gt("Sheet", { $context: "spreadsheet worksheet picker" })}
              >
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
    </div>
  );
}

function SavedViewBanner(props: {
  readonly sql: string;
  readonly onShowSql?: (() => void) | undefined;
}) {
  const gt = useGT();
  const { files, globs, dropped } = savedViewReferences(props.sql);
  const paths = [...files, ...globs];
  const more = paths.slice(2);
  const untraced = [...dropped, ...savedViewUnresolvedRelations(props.sql)];
  const list = (entries: readonly string[]) => (
    <ul className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
      {entries.map((entry) => (
        <li key={entry} className="max-w-full wrap-anywhere">
          <bdi>{entry}</bdi>
        </li>
      ))}
    </ul>
  );
  return (
    <section
      aria-label={gt("Saved view")}
      className="mx-3 mt-2 shrink-0 space-y-1 rounded-lg bg-muted/50 px-3 py-2"
    >
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm font-medium">{gt("Saved view")}</p>
        {props.onShowSql ? (
          <Button focus="edge" variant="ghost" size="xs" onClick={props.onShowSql}>
            {gt("Show SQL")}
          </Button>
        ) : null}
      </div>
      {paths.length > 0 ? (
        <div className="space-y-1">
          <p className="text-xs text-muted-foreground">{gt("Reads")}</p>
          {list(paths.slice(0, 2))}
        </div>
      ) : null}
      {more.length || untraced.length ? (
        <Collapsible>
          <CollapsibleTrigger
            render={(trigger, { open }) => (
              <Button {...trigger} focus="edge" variant={open ? "selected" : "ghost"} size="xs" />
            )}
          >
            {untraced.length
              ? gt("Source coverage is incomplete")
              : gt("{count} more sources", { count: more.length })}
          </CollapsibleTrigger>
          <CollapsiblePanel>
            <div className="space-y-1">
              {more.length ? list(more) : null}
              {untraced.length ? (
                <>
                  <p className="text-xs text-muted-foreground">{gt("Untraced references")}</p>
                  {list(untraced)}
                </>
              ) : null}
            </div>
          </CollapsiblePanel>
        </Collapsible>
      ) : null}
      {untraced.length === 0 && paths.length === 0 ? (
        <p className="text-xs text-muted-foreground">{gt("Scient found no file references.")}</p>
      ) : null}
    </section>
  );
}
