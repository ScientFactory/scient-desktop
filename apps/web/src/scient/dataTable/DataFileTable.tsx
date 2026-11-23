import {
  DataViewError,
  type DataTableQuery,
  type EnvironmentId,
  type ThreadId,
} from "@t3tools/contracts";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { savedViewReferences, savedViewUnresolvedRelations } from "@t3tools/shared/savedDataView";
import * as Schema from "effect/Schema";
import { useGT } from "gt-react";
import { useEffect, useState } from "react";

import { useAssetUrlState } from "~/assets/assetUrls";
import { Button } from "~/components/ui/button";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "~/components/ui/collapsible";
import { FileSurfaceFailure, FileSurfaceLoading } from "~/components/files/fileSurfaceChrome";

import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import { useStableCallback } from "~/hooks/useStableCallback";
import { useAtomQueryRunner } from "~/state/use-atom-query-runner";

import { DataProfileButton } from "./DataProfileButton";
import { DataGrid } from "./DataGrid";
import { canSaveDataView, isScientSavedViewFile } from "./dataFiles";
import {
  dataFileTablePage,
  dataViewPage,
  dataViewRevision,
  type ProfileTarget,
} from "./dataTableState";
import { DataViewActions, type DataWorkspaceFile } from "./DataViewActions";
import { UseDataInAnalysis } from "./UseDataInAnalysis";

const isDataViewError = Schema.is(DataViewError);

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
  const gt = useGT();
  const workspace = props.workspace;
  const savedView =
    workspace && isScientSavedViewFile(workspace.path, props.viewSql) ? workspace : null;
  const asset = useAssetUrlState(
    props.environmentId,
    savedView !== null
      ? null
      : {
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
  const readRevision = useStableCallback(
    useAtomQueryRunner(dataViewRevision, { reportFailure: false, refresh: true }),
  );
  const cwd = savedView?.cwd;
  const viewPath = savedView?.path;
  const viewKey = JSON.stringify([props.environmentId, cwd, viewPath]);
  const [viewState, setViewState] = useState<{
    key: string;
    revision: string | null;
    error: string | null;
  } | null>(null);
  const [viewAttempt, setViewAttempt] = useState(0);
  const viewRevision = viewState?.key === viewKey ? viewState.revision : null;
  const viewError = viewState?.key === viewKey ? viewState.error : null;
  const viewRefresh = JSON.stringify([props.refreshToken, props.reloadKey, viewAttempt]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- refresh the server's view identity when project files may have changed.
  useEffect(() => {
    if (cwd === undefined || viewPath === undefined) return;
    const controller = new AbortController();
    void readRevision(
      { environmentId: props.environmentId, input: { cwd, path: viewPath } },
      { signal: controller.signal },
    ).then((result) => {
      if (controller.signal.aborted) return;
      setViewState(
        result._tag === "Success"
          ? { key: viewKey, revision: result.value, error: null }
          : { key: viewKey, revision: null, error: String(squashAtomCommandFailure(result)) },
      );
    });
    return () => controller.abort();
  }, [
    props.environmentId,
    cwd,
    viewPath,
    readRevision,
    viewKey,
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- A file notification or reload requires a fresh server revision.
    viewRefresh,
  ]);

  const onViewFailure = (failure: unknown) => {
    if (!isDataViewError(failure) || failure.reason !== "view-changed") return;
    setViewState((state) =>
      state?.key === viewKey && state.revision === viewRevision ? null : state,
    );
    setViewAttempt((attempt) => attempt + 1);
  };
  const viewInput =
    savedView && viewRevision !== null
      ? { cwd: savedView.cwd, path: savedView.path, revision: viewRevision }
      : null;
  const validateCopy = async () => {
    if (viewInput === null) return;
    const result = await readRevision({
      environmentId: props.environmentId,
      input: { cwd: viewInput.cwd, path: viewInput.path },
    });
    if (result._tag === "Success" && result.value === viewInput.revision) return;
    const failure = new DataViewError({ reason: "view-changed" });
    onViewFailure(failure);
    throw failure;
  };
  const [sheet, setSheet] = useState(0);
  const [sheets, setSheets] = useState<ReadonlyArray<string>>([]);
  const loadPage = async (query: DataTableQuery) => {
    if (viewInput !== null) {
      const result = await readView({
        environmentId: props.environmentId,
        input: { ...viewInput, query },
      });
      if (result._tag !== "Success") {
        const failure = squashAtomCommandFailure(result);
        onViewFailure(failure);
        throw failure;
      }
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
  if (savedView !== null && viewError !== null)
    return (
      <FileSurfaceFailure
        title={gt("Couldn't read this table")}
        description={viewError}
        onRetry={() => {
          setViewState(null);
          setViewAttempt((attempt) => attempt + 1);
        }}
      />
    );
  const currentRevision = savedView === null ? revision : viewRevision;
  if (currentRevision === null) return <FileSurfaceLoading />;
  const gridRevision = `${currentRevision}#${props.reloadKey}`;
  const target: ProfileTarget = viewInput
    ? { kind: "view", input: viewInput }
    : { kind: "file", input: { path: props.absolutePath, sheet } };
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {savedView ? <SavedViewBanner sql={props.viewSql ?? ""} onShowSql={props.onShowSql} /> : null}
      <DataGrid
        key={savedView === null ? sheet : `${viewKey}#${gridRevision}`}
        {...(viewInput === null ? {} : { validateCopy })}
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
            {...(viewInput === null ? {} : { onFailure: onViewFailure })}
          />
        }
        {...(workspace
          ? {
              renderMenuActions: (view) => (
                <>
                  {savedView || canSaveDataView(workspace.path) ? (
                    <DataViewActions
                      {...(viewInput === null
                        ? { kind: "save" as const }
                        : {
                            kind: "export" as const,
                            revision: viewInput.revision,
                            onFailure: onViewFailure,
                          })}
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
