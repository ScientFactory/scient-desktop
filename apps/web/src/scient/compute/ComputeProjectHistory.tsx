import {
  ComputeExecutionId,
  ComputeSessionId,
  type ComputeRunHistoryInput,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { T, useGT } from "gt-react";
import { useState } from "react";
import { ChevronDown, Package, Search, X } from "lucide-react";

import { Button } from "~/components/ui/button";
import { InputGroup, InputGroupAddon, InputGroupInput } from "~/components/ui/input-group";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "~/components/ui/menu";
import { Toggle, ToggleGroup } from "~/components/ui/toggle-group";
import { useDebouncedValue } from "~/state/queries";
import { useRightPanelStore } from "~/rightPanelStore";
import { ExportResultPackageButton } from "../results/handoff/ExportResultPackageButton";
import { useResultPackagePaletteItem } from "../results/handoff/resultPackagePalette";
import { scientComputeSurface } from "~/scient/rightPanel/surfaces";
import { analysisEnvironment } from "~/state/analysis";
import { computeEnvironment } from "~/state/compute";
import { useEnvironmentQuery } from "~/state/query";

import { useComputeHistoryFocus, type ComputeHistoryFocus } from "./computeHistoryFocus";
import { createComputeContextId } from "./computeContextStore";
import { usePendingComputeQuote } from "./computeQuoteReveal";
import type { ComputeFeedEntry } from "./computeFeedModel";
import { ComputePanel } from "./ComputePanel";
import { ComputeResultsFeed } from "./ComputeResultsFeed";
import { useComputeRunHistory } from "./useComputeRunHistory";

const PAGE_SIZE = 30;

interface ComputeProjectHistoryProps {
  readonly cwd: string;
  readonly threadRef: ScopedThreadRef;
}

export function ComputeProjectHistory(props: ComputeProjectHistoryProps) {
  const { cwd, threadRef } = props;
  const gt = useGT();
  const [showSessions, setShowSessions] = useState(false);
  const [fileSearch, setFileSearch] = useState("");
  const reveal = usePendingComputeQuote(threadRef, (citation) =>
    citation.place._tag === "run" ? citation : null,
  );
  const focusRun = useComputeHistoryFocus(threadRef, cwd);
  const [seenFocus, setSeenFocus] = useState(focusRun);
  if (focusRun !== seenFocus) {
    setSeenFocus(focusRun);
    if (focusRun) setShowSessions(false);
  }
  const [seenReveal, setSeenReveal] = useState(reveal);
  if (reveal !== seenReveal) {
    setSeenReveal(reveal);
    if (reveal !== null) setShowSessions(false);
  }
  const { environmentId } = threadRef;
  const verify = useResultPackagePaletteItem(environmentId, cwd);
  return (
    <div className="@container flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-2 px-3 py-2 @min-[480px]:flex-nowrap">
        <ToggleGroup
          aria-label={gt("Compute view")}
          size="segmented-compact"
          value={[showSessions ? "sessions" : "history"]}
          onValueChange={(value) => {
            if (value.length) setShowSessions(value[0] === "sessions");
          }}
        >
          <Toggle value="history">
            <T>History</T>
          </Toggle>
          <Toggle value="sessions">
            <T>Sessions</T>
          </Toggle>
        </ToggleGroup>
        {!showSessions ? (
          <div className="order-last w-full min-w-0 @min-[480px]:order-none @min-[480px]:w-auto @min-[480px]:flex-1">
            <InputGroup>
              <InputGroupAddon>
                <Search aria-hidden />
              </InputGroupAddon>
              <InputGroupInput
                nativeInput
                size="compact"
                type="search"
                aria-label={gt("Filter by file")}
                placeholder={gt("Filter by file")}
                value={fileSearch}
                maxLength={4096}
                onChange={(event) => setFileSearch(event.currentTarget.value)}
                onKeyDown={(event) => {
                  if (event.key === "Escape" && fileSearch !== "") {
                    event.preventDefault();
                    event.stopPropagation();
                    setFileSearch("");
                  }
                }}
              />
              {fileSearch ? (
                <InputGroupAddon align="inline-end">
                  <Button
                    variant="ghost-muted"
                    focus="edge"
                    size="icon-micro"
                    aria-label={gt("Clear file filter")}
                    onClick={(event) => {
                      event.currentTarget
                        .closest("[data-slot=input-group]")
                        ?.querySelector("input")
                        ?.focus();
                      setFileSearch("");
                    }}
                  >
                    <X aria-hidden />
                  </Button>
                </InputGroupAddon>
              ) : null}
            </InputGroup>
          </div>
        ) : null}
        <div className="ms-auto flex shrink-0 items-center gap-2">
          {!showSessions ? (
            <ExportResultPackageButton
              environmentId={environmentId}
              cwd={cwd}
              renderTrigger={(openExport) =>
                openExport || verify ? (
                  <Menu>
                    <MenuTrigger
                      render={
                        <Button
                          variant="ghost"
                          focus="edge"
                          size="xs"
                          aria-label={gt("Result packages")}
                        />
                      }
                    >
                      <Package aria-hidden className="size-3.5" />
                      <span className="hidden @min-[480px]:inline">
                        <T>Result packages</T>
                      </span>
                      <ChevronDown aria-hidden className="size-3" />
                    </MenuTrigger>
                    <MenuPopup align="end">
                      {openExport ? (
                        <MenuItem onClick={openExport}>
                          <T>Export for rerun…</T>
                        </MenuItem>
                      ) : null}
                      {verify ? (
                        <MenuItem onClick={() => void verify.run()}>
                          <T>Verify a result package…</T>
                        </MenuItem>
                      ) : null}
                    </MenuPopup>
                  </Menu>
                ) : null
              }
            />
          ) : null}
          <Button
            variant="outline"
            focus="edge"
            size="xs"
            onClick={() =>
              useRightPanelStore
                .getState()
                .openScient(
                  threadRef,
                  scientComputeSurface({ cwd, contextId: createComputeContextId() }),
                )
            }
          >
            <T>New console</T>
          </Button>
        </div>
      </div>
      <ProjectRunHistory
        {...props}
        fileSearch={fileSearch}
        hidden={showSessions}
        focusRun={focusRun}
      />
      {showSessions ? (
        <section className="flex min-h-0 flex-1 flex-col" aria-label={gt("Compute sessions")}>
          <ComputePanel {...props} environmentId={environmentId} />
        </section>
      ) : null}
    </div>
  );
}

function ProjectRunHistory(
  props: ComputeProjectHistoryProps & {
    readonly fileSearch: string;
    readonly hidden: boolean;
    readonly focusRun: ComputeHistoryFocus | null;
  },
) {
  const { cwd, threadRef, fileSearch } = props;
  const { environmentId } = threadRef;
  const gt = useGT();
  const debouncedFilter = useDebouncedValue(fileSearch.trim(), 150);
  const filter = fileSearch.trim() === "" ? "" : debouncedFilter;
  const [previousFilter, setPreviousFilter] = useState(filter);
  const [pages, setPages] = useState<ReadonlyArray<NonNullable<ComputeRunHistoryInput["before"]>>>(
    [],
  );
  const before = previousFilter === filter ? pages.at(-1) : undefined;
  const reveal = usePendingComputeQuote(threadRef, ({ place }) =>
    place._tag === "run" ? place : null,
  );
  const [lastReveal, setLastReveal] = useState<typeof reveal>(null);
  if (previousFilter !== filter) {
    setPreviousFilter(filter);
    setPages([]);
    setLastReveal(null);
  }
  const [previousFocus, setPreviousFocus] = useState(props.focusRun);
  if (previousFocus !== props.focusRun) {
    setPreviousFocus(props.focusRun);
    if (props.focusRun) setLastReveal(null);
  }
  if (reveal !== null && reveal !== lastReveal) setLastReveal(reveal);
  const focusRun = (reveal ?? lastReveal) ? null : props.focusRun;
  const target = reveal ?? lastReveal ?? (focusRun && "executionId" in focusRun ? focusRun : null);
  const history = useComputeRunHistory(environmentId, {
    cwd,
    limit: PAGE_SIZE,
    filter,
    ...(before === undefined ? {} : { before }),
  });
  const quoted = useEnvironmentQuery(
    target === null
      ? null
      : computeEnvironment.runHistory({
          environmentId,
          input: {
            cwd,
            limit: 1,
            sessionId: ComputeSessionId.make(target.sessionId),
            executionId: ComputeExecutionId.make(target.executionId),
          },
        }),
  );
  const runs = new Map(history.runs.map((row) => [row.execution.request.executionId, row]));
  const quotedRun = quoted.data?.runs[0];
  const quotedSource = quotedRun?.execution.request.source;
  const quotedBatchId =
    quotedSource?._tag === "document" ? quotedSource.notebookBatch?.id : undefined;
  if (quotedRun && (quotedBatchId === undefined || !runs.has(quotedBatchId))) {
    runs.set(quotedRun.execution.request.executionId, quotedRun);
  }
  const batchEvents = useEnvironmentQuery(
    analysisEnvironment.runEvents({ environmentId, input: { cwd } }),
  );
  const fileRuns = new Map(history.fileRuns.map((run) => [run.receipt.runId, run]));
  for (const run of batchEvents.data ?? []) {
    const { runId, startedAt } = run.receipt;
    if (
      !fileRuns.has(runId) &&
      (before !== undefined ||
        (history.next !== null &&
          (startedAt < history.next.submittedAt ||
            (startedAt === history.next.submittedAt && runId < history.next.executionId))))
    )
      continue;
    if (filter && !run.source.relativePath.toLowerCase().includes(filter.toLowerCase())) continue;
    fileRuns.set(run.receipt.runId, run);
  }
  const focusedFile = useEnvironmentQuery(
    focusRun && "fileRunId" in focusRun
      ? analysisEnvironment.run({ environmentId, input: { cwd, runId: focusRun.fileRunId } })
      : null,
  ).data;
  if (focusedFile && !fileRuns.has(focusedFile.receipt.runId)) {
    fileRuns.set(focusedFile.receipt.runId, focusedFile);
  }
  const entries = [
    ...[...runs.values()].map(
      (row) =>
        ({
          kind: "run",
          key: row.execution.request.executionId,
          ...row,
        }) satisfies ComputeFeedEntry,
    ),
    ...[...fileRuns.values()].map(
      (run) =>
        ({
          kind: "batch",
          key: run.receipt.runId,
          run,
        }) satisfies ComputeFeedEntry,
    ),
  ].toSorted(
    (left, right) =>
      (right.kind === "run"
        ? right.execution.request.submittedAt
        : right.run.receipt.startedAt
      ).localeCompare(
        left.kind === "run" ? left.execution.request.submittedAt : left.run.receipt.startedAt,
      ) || (right.key > left.key ? 1 : right.key < left.key ? -1 : 0),
  );
  return (
    <section
      className={props.hidden ? "hidden" : "flex min-h-0 flex-1 flex-col"}
      aria-label={gt("Compute history")}
    >
      <ComputeResultsFeed
        environmentId={environmentId}
        cwd={cwd}
        threadRef={threadRef}
        entries={entries}
        events={history.events}
        rehydrationToken={history.rehydrationToken}
        includeSourcePath
        projectHistory
        quotedRun={quotedRun}
        focusRun={focusRun}
        runtimeInspection={null}
        dependencyRecoveryFor={() => undefined}
        followRequest={null}
        empty={
          <p className="p-6 text-center text-xs text-muted-foreground" role="status">
            {history.error ? (
              <T>Couldn&apos;t load runs</T>
            ) : history.pending ? (
              <T>Loading runs…</T>
            ) : (
              <T>No matching runs</T>
            )}
          </p>
        }
      />
      {pages.length > 0 || history.next !== null ? (
        <div className="flex shrink-0 justify-end gap-2 border-t px-3 py-2">
          <Button
            size="xs"
            variant="ghost-muted"
            disabled={pages.length === 0}
            onClick={() => {
              setPages((current) => current.slice(0, -1));
              setLastReveal(null);
            }}
          >
            <T>Newer runs</T>
          </Button>
          <Button
            size="xs"
            variant="ghost-muted"
            disabled={history.next === null}
            onClick={() => {
              if (history.next !== null) setPages([...pages, history.next]);
              setLastReveal(null);
            }}
          >
            <T>Older runs</T>
          </Button>
        </div>
      ) : null}
    </section>
  );
}
