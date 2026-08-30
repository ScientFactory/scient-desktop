import type { ComputeSessionRecord, EnvironmentId } from "@t3tools/contracts";
import {
  ComputeExecutionId,
  ComputeSessionId,
  TERMINAL_COMPUTE_SESSION_STATUSES,
} from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { ChevronDown, LoaderCircle, Play, RefreshCwIcon } from "lucide-react";
import { Link } from "@tanstack/react-router";
import { forwardRef, useCallback, useImperativeHandle, useMemo, useState } from "react";

import { Button } from "~/components/ui/button";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "~/components/ui/alert-dialog";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "~/components/ui/menu";
import { stackedThreadToast, toastManager } from "~/components/ui/toast";
import { randomUUID } from "~/lib/utils";
import { computeEnvironment } from "~/state/compute";
import { useAtomCommand } from "~/state/use-atom-command";
import { useEnvironmentQuery } from "~/state/query";

import {
  pythonCell,
  pythonFile,
  pythonSelection,
  resolvePythonRunTarget,
  type PythonCodeSlice,
  type PythonTextRange,
} from "./pythonCells";
import { resolvePythonRuntimeToolbarState } from "./pythonComputeSurfaceModel";

type PythonRunKind = "selection" | "cell" | "file";

export interface PythonFileComputeActionsHandle {
  readonly runPrimary: (selection?: PythonTextRange | null) => void;
  readonly runCellAtLine: (line: number) => void;
}

interface PythonFileComputeActionsProps {
  readonly environmentId: EnvironmentId;
  readonly cwd: string;
  readonly relativePath: string;
  readonly contents: string;
  readonly sourceRevision: string;
  readonly sourcePending: boolean;
  readonly selection: { readonly start: number; readonly end: number } | null;
  readonly editorSelection: PythonTextRange | null;
  readonly onExecutionSubmitted: (
    sessionId: ComputeSessionId,
    executionId: ComputeExecutionId,
  ) => void;
}

function reportFailure(
  title: string,
  result: { readonly cause: Parameters<typeof squashAtomCommandFailure>[0]["cause"] },
) {
  const error = squashAtomCommandFailure(result);
  toastManager.add(
    stackedThreadToast({
      type: "error",
      title,
      description: error instanceof Error ? error.message : "The compute operation failed.",
    }),
  );
}

export const PythonFileComputeActions = forwardRef<
  PythonFileComputeActionsHandle,
  PythonFileComputeActionsProps
>(function PythonFileComputeActions(props, ref) {
  const [operation, setOperation] = useState<PythonRunKind | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [switching, setSwitching] = useState(false);
  const [switchTarget, setSwitchTarget] = useState<{
    readonly environmentId: EnvironmentId;
    readonly session: ComputeSessionRecord;
  } | null>(null);
  const sessions = useEnvironmentQuery(
    computeEnvironment.sessions({
      environmentId: props.environmentId,
      input: { cwd: props.cwd },
    }),
  );
  const events = useEnvironmentQuery(
    computeEnvironment.events({
      environmentId: props.environmentId,
      input: { cwd: props.cwd },
    }),
  );
  const runtimes = useEnvironmentQuery(
    computeEnvironment.runtimes({
      environmentId: props.environmentId,
      input: { cwd: props.cwd, refresh: false },
    }),
  );
  const refreshSessions = sessions.refresh;
  const refreshEvents = events.refresh;
  const refreshRuntimeInspection = runtimes.refresh;
  const startSession = useAtomCommand(computeEnvironment.startSession, { reportFailure: false });
  const submitExecution = useAtomCommand(computeEnvironment.submitExecution, {
    reportFailure: false,
  });
  const refreshRuntimes = useAtomCommand(computeEnvironment.refreshRuntimes, {
    reportFailure: false,
  });
  const stopSession = useAtomCommand(computeEnvironment.stopSession, { reportFailure: false });

  const liveSession = useMemo(() => {
    const byId = new Map<string, ComputeSessionRecord>();
    for (const session of sessions.data ?? []) byId.set(session.sessionId, session);
    for (const session of events.data?.sessions.values() ?? []) {
      byId.set(session.sessionId, session);
    }
    return (
      [...byId.values()].find(
        (session) => !TERMINAL_COMPUTE_SESSION_STATUSES.has(session.status),
      ) ?? null
    );
  }, [events.data?.sessions, sessions.data]);
  const readyPython = useMemo(
    () =>
      runtimes.data?.languages
        .find((language) => language.descriptor.languageId === "python" && language.enabled)
        ?.runtimes.find((candidate) => candidate.verification.readiness === "ready") ?? null,
    [runtimes.data],
  );
  const activePython =
    liveSession === null || liveSession.runtime === null
      ? readyPython
      : (runtimes.data?.languages
          .find((language) => language.descriptor.languageId === "python")
          ?.runtimes.find(
            (candidate) => candidate.profile.executable === liveSession.runtime?.executable,
          ) ?? null);
  const scientificToolkit = activePython?.toolkits.find(
    (toolkit) => toolkit.toolkitId === "python-data-and-figures",
  );
  const missingScientificPackages =
    scientificToolkit?.readiness === "missing-requirement"
      ? scientificToolkit.missingRequirements
      : [];
  const runtimeToolbar = resolvePythonRuntimeToolbarState({
    liveSession,
    runtimeInspectionPending: runtimes.isPending || refreshing,
    readyPythonAvailable: readyPython !== null,
    preferredPythonExecutable: readyPython?.profile.executable ?? null,
    scientificPackagesMissing: missingScientificPackages.length > 0,
  });
  const requestPythonSwitch = () => {
    if (liveSession !== null) {
      setSwitchTarget({ environmentId: props.environmentId, session: liveSession });
    }
  };

  const refreshPython = useCallback(async () => {
    if (refreshing) return;
    setRefreshing(true);
    const result = await refreshRuntimes({
      environmentId: props.environmentId,
      input: { cwd: props.cwd, refresh: true },
    });
    setRefreshing(false);
    if (result._tag !== "Success") {
      if (!isAtomCommandInterrupted(result)) reportFailure("Unable to refresh Python", result);
      return;
    }
    refreshRuntimeInspection();
    refreshSessions();
  }, [
    props.cwd,
    props.environmentId,
    refreshRuntimes,
    refreshing,
    refreshRuntimeInspection,
    refreshSessions,
  ]);

  const switchPython = useCallback(async () => {
    if (switchTarget === null || switching) return;
    setSwitching(true);
    const result = await stopSession({
      environmentId: switchTarget.environmentId,
      input: {
        cwd: switchTarget.session.workingDirectory,
        sessionId: switchTarget.session.sessionId,
        expectedGeneration: switchTarget.session.generation,
      },
    });
    setSwitching(false);
    if (result._tag !== "Success") {
      if (!isAtomCommandInterrupted(result)) reportFailure("Unable to switch Python", result);
      return;
    }
    setSwitchTarget(null);
    refreshSessions();
    refreshEvents();
    refreshRuntimeInspection();
  }, [
    refreshEvents,
    refreshRuntimeInspection,
    refreshSessions,
    stopSession,
    switchTarget,
    switching,
  ]);

  const run = useCallback(
    async (kind: PythonRunKind, slice: PythonCodeSlice | null) => {
      if (slice === null || operation !== null || refreshing || switching) return;
      setOperation(kind);

      let session = liveSession;
      if (session !== null && session.languageId !== "python") {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Another language is active",
            description: "Stop the live compute session before running this Python file.",
          }),
        );
        setOperation(null);
        return;
      }
      if (session === null) {
        if (readyPython === null) {
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Python is not ready",
              description: "Enable and configure Python in Scientific Computing settings.",
            }),
          );
          setOperation(null);
          return;
        }
        const started = await startSession({
          environmentId: props.environmentId,
          input: {
            cwd: props.cwd,
            sessionId: ComputeSessionId.make(randomUUID()),
            languageId: readyPython.profile.languageId,
            executable: readyPython.profile.executable,
          },
        });
        if (started._tag !== "Success") {
          setOperation(null);
          if (!isAtomCommandInterrupted(started)) reportFailure("Unable to start Python", started);
          refreshSessions();
          refreshRuntimeInspection();
          return;
        }
        session = started.value;
        refreshSessions();
      }

      const executionId = ComputeExecutionId.make(randomUUID());
      const submitted = await submitExecution({
        environmentId: props.environmentId,
        input: {
          cwd: props.cwd,
          sessionId: session.sessionId,
          executionId,
          expectedGeneration: session.generation,
          code: slice.code,
          source: {
            _tag: "document",
            origin: kind,
            path: props.relativePath,
            bufferState: props.sourcePending ? "dirty" : "saved",
            revision: props.sourceRevision,
            range: slice.range,
          },
        },
      });
      setOperation(null);
      if (submitted._tag === "Success") {
        props.onExecutionSubmitted(session.sessionId, executionId);
      } else if (!isAtomCommandInterrupted(submitted)) {
        reportFailure("Unable to run Python", submitted);
        refreshSessions();
      }
    },
    [
      liveSession,
      operation,
      props.cwd,
      props.environmentId,
      props.onExecutionSubmitted,
      props.relativePath,
      props.sourcePending,
      props.sourceRevision,
      readyPython,
      refreshing,
      refreshRuntimeInspection,
      refreshSessions,
      startSession,
      submitExecution,
      switching,
    ],
  );

  const lineSelectionSlice =
    props.selection === null ? null : pythonSelection(props.contents, props.selection);
  const primary = resolvePythonRunTarget(props.contents, props.selection, props.editorSelection);
  const selectionSlice = primary.kind === "selection" ? primary.slice : lineSelectionSlice;
  const caretLine = props.editorSelection?.end.line;
  const cellSlice = caretLine === undefined ? null : pythonCell(props.contents, caretLine + 1);
  const fileSlice = pythonFile(props.contents);
  const busy = operation !== null || refreshing || switching;

  useImperativeHandle(
    ref,
    () => ({
      runPrimary: (selection) => {
        const target = resolvePythonRunTarget(
          props.contents,
          props.selection,
          selection === undefined ? props.editorSelection : selection,
        );
        void run(target.kind, target.slice);
      },
      runCellAtLine: (line) => void run("cell", pythonCell(props.contents, line)),
    }),
    [props.contents, props.editorSelection, props.selection, run],
  );

  return (
    <>
      <div className="@container/python-file-actions flex min-w-0 items-center justify-end gap-1.5">
        <div className="hidden min-w-0 flex-1 @[9rem]/python-file-actions:block">
          {runtimeToolbar.kind === "switch" ? (
            <Button
              size="xs"
              variant="ghost-muted"
              className="-ms-1 h-6 min-w-0 max-w-full px-1 text-[11px] font-normal"
              title="Stop the current session and use the selected Python"
              disabled={switching}
              onClick={requestPythonSwitch}
            >
              <span className="truncate">{runtimeToolbar.label}</span>
            </Button>
          ) : (
            <Button
              size="xs"
              variant="ghost-muted"
              className="-ms-1 h-6 min-w-0 max-w-full px-1 text-[11px] font-normal"
              title={
                missingScientificPackages.length === 0
                  ? "Open Scientific Computing settings"
                  : `Missing scientific packages: ${missingScientificPackages.join(", ")}. Open Scientific Computing settings.`
              }
              render={<Link to="/settings/scientific-computing" />}
            >
              <span className="truncate">{runtimeToolbar.label}</span>
            </Button>
          )}
        </div>
        <Button
          size="icon-xs"
          variant="ghost-muted"
          className="shrink-0"
          aria-label="Refresh Python detection"
          title="Check Python again"
          disabled={refreshing || switching}
          onClick={() => void refreshPython()}
        >
          {refreshing ? <LoaderCircle className="animate-spin" /> : <RefreshCwIcon />}
        </Button>
        <div className="flex shrink-0 items-center">
          <Button
            size="xs"
            variant="outline"
            className="rounded-r-none px-1.5 @[15rem]/python-file-actions:px-[calc(--spacing(2)-1px)]"
            aria-label={primary.label}
            disabled={busy || !runtimeToolbar.canRun || primary.slice === null}
            onClick={() => void run(primary.kind, primary.slice)}
          >
            {operation === primary.kind ? <LoaderCircle className="animate-spin" /> : <Play />}
            <span className="hidden @[15rem]/python-file-actions:inline">{primary.label}</span>
          </Button>
          <Menu>
            <MenuTrigger
              render={
                <Button
                  size="icon-xs"
                  variant="outline"
                  className="rounded-l-none border-l-0"
                  disabled={busy || !runtimeToolbar.canRun}
                  aria-label="Choose Python code to run"
                />
              }
            >
              <ChevronDown />
            </MenuTrigger>
            <MenuPopup align="end" side="bottom">
              <MenuItem
                disabled={selectionSlice === null}
                onClick={() => void run("selection", selectionSlice)}
              >
                Run selection
              </MenuItem>
              <MenuItem disabled={cellSlice === null} onClick={() => void run("cell", cellSlice)}>
                Run cell
              </MenuItem>
              <MenuItem disabled={fileSlice === null} onClick={() => void run("file", fileSlice)}>
                Run file
              </MenuItem>
              {runtimeToolbar.kind === "switch" ? (
                <>
                  <MenuSeparator />
                  <MenuItem onClick={requestPythonSwitch}>Switch Python environment…</MenuItem>
                </>
              ) : null}
            </MenuPopup>
          </Menu>
        </div>
      </div>
      <AlertDialog
        open={switchTarget !== null}
        onOpenChange={(open) => {
          if (!open) setSwitchTarget(null);
        }}
      >
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Switch Python environment?</AlertDialogTitle>
            <AlertDialogDescription>
              This stops the current Python session and clears its in-memory variables. Run history
              remains available, and the next run uses the Python selected in Scientific Computing.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" disabled={switching} />}>
              Cancel
            </AlertDialogClose>
            <Button disabled={switching} onClick={() => void switchPython()}>
              {switching ? <LoaderCircle className="animate-spin" /> : null}
              Switch
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </>
  );
});
