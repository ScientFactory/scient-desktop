import type { ComputeSessionRecord, EnvironmentId } from "@t3tools/contracts";
import {
  classifyMatlabSource,
  ComputeExecutionId,
  ComputeSessionId,
  resolveScientificComputingLanguageSettings,
  TERMINAL_COMPUTE_SESSION_STATUSES,
} from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { ChevronDown, LoaderCircle, Play } from "lucide-react";
import { Link } from "@tanstack/react-router";
import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type ReactNode,
} from "react";

import { Button } from "~/components/ui/button";
import { ContextualConfirmation } from "~/components/ui/contextual-confirmation";
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
import { useStableCallback } from "~/hooks/useStableCallback";
import { stackedThreadToast, toastManager } from "~/components/ui/toast";
import { randomUUID } from "~/lib/utils";
import { useEnvironmentSettings } from "~/hooks/useSettings";
import { computeEnvironment } from "~/state/compute";
import { serverEnvironment } from "~/state/server";
import { useAtomCommand } from "~/state/use-atom-command";
import { useAtomQueryRunner } from "~/state/use-atom-query-runner";
import { useEnvironmentQuery } from "~/state/query";
import { ScientTooltip } from "~/scient/presentation/ScientTooltip";

import {
  computeCell,
  computeFile,
  computeLineSelection,
  resolveComputeRunTarget,
  type ComputeCodeSlice,
  type ComputeTextRange,
} from "./computeSourceSlices";
import {
  stopComputeContext,
  mergeComputeSessionRecords,
  replaceComputeContextSession,
} from "./computeContextCoordinator";
import {
  computeRuntimeDisplayLabel,
  defaultComputeRuntime,
  isComputeCapacityReachedError,
  isExactTerminalComputeSession,
  resolveComputePreRunRuntimeChoice,
  resolveComputeRuntimeToolbarState,
  computeRuntimeBlocker,
  SCIENTIFIC_PYTHON_TOOLKIT_ID,
  computeRuntimeSetupActionLabel,
} from "./computeFileSurfaceModel";
import {
  managedRuntimeOperationLabel,
  ManagedRuntimeNotice,
  useComputeManagedRuntime,
} from "./ComputeManagedRuntimeControls";
import {
  computeSessionOwnerLabel,
  ensureComputeContext,
  getComputeContext,
  INITIAL_COMPUTE_CONTEXT_GENERATION,
  ownsLiveComputeSession,
  useComputeContextStore,
  createComputeContextId,
  type ComputeContextId,
} from "./computeContextStore";

import { computeScientPart } from "./computeInstallationSettingsModel";
import type { ComputeSourceLanguage } from "./computeSourceLanguage";

type ComputeRunKind = "selection" | "cell" | "file";
type PendingComputeRun = {
  readonly kind: ComputeRunKind;
  readonly slice: ComputeCodeSlice;
  readonly currentExecutable: string;
  readonly managedExecutable: string;
};

export interface ComputeFileActionsHandle {
  readonly runFile: () => void;
  readonly runPrimary: (selection?: ComputeTextRange | null) => void;
  readonly runCellAtLine: (line: number) => void;
  /** Queues notebook cells in order, each recorded against its cell. */
  readonly runCells: (cells: ReadonlyArray<ComputeNotebookCell>) => Promise<void>;
}

export interface ComputeNotebookCell {
  readonly id: string;
  readonly code: string;
}

interface ComputeRunSlice extends ComputeCodeSlice {
  readonly cells?: ReadonlyArray<ComputeNotebookCell>;
}

interface ComputeFileActionsProps {
  readonly language: ComputeSourceLanguage;
  readonly environmentId: EnvironmentId;
  readonly cwd: string;
  readonly relativePath: string;
  readonly contents: string;
  readonly sourceRevision: string;
  readonly sourcePending: boolean;
  readonly selection: { readonly start: number; readonly end: number } | null;
  readonly editorSelection: ComputeTextRange | null;
  readonly contextId?: ComputeContextId;
  readonly onRunRequested: () => void;
  readonly onShowMatlabOneShot: () => void;
  readonly batchCanStart?: boolean;
  readonly onExecutionSubmitted: (
    sessionId: ComputeSessionId,
    executionId: ComputeExecutionId,
  ) => void;
  /** Notebooks run cell by cell: the primary action runs every cell. */
  readonly runAll?: () => void;
  /** The notebook's own entries for the Run menu. */
  readonly runMenu?: ReactNode;
  /** Controls placed just before the Run button. */
  readonly leadingActions?: ReactNode;
  /** Runs submitted for notebook cells, by cell. */
  readonly onCellsSubmitted?: (
    runs: ReadonlyArray<{ readonly cellId: string; readonly execution: string }>,
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

export const ComputeFileActions = forwardRef<ComputeFileActionsHandle, ComputeFileActionsProps>(
  function ComputeFileActions(props, ref) {
    const onRunRequested = props.onRunRequested;
    const [operation, setOperation] = useState<ComputeRunKind | "fresh" | null>(null);
    const [refreshing, setRefreshing] = useState(false);
    const [switching, setSwitching] = useState(false);
    const [stoppingUnusedSession, setStoppingUnusedSession] = useState<ComputeSessionId | null>(
      null,
    );
    const [capacityBlocked, setCapacityBlocked] = useState(false);
    const [freshCapacityBlocked, setFreshCapacityBlocked] = useState(false);
    const [freshStopTarget, setFreshStopTarget] = useState<{
      readonly contextId: ComputeContextId;
      readonly session: ComputeSessionRecord;
    } | null>(null);
    const capacityAnchor = useRef<HTMLButtonElement | null>(null);
    const primaryRunAnchor = useRef<HTMLButtonElement | null>(null);
    const [pendingRuntimeChoice, setPendingRuntimeChoice] = useState<PendingComputeRun | null>(
      null,
    );
    const stoppingForFresh = useRef(false);
    const [startRetryAvailable, setStartRetryAvailable] = useState(false);
    const [runBlocked, setRunBlocked] = useState(false);
    const [switchTarget, setSwitchTarget] = useState<{
      readonly environmentId: EnvironmentId;
      readonly contextId: ComputeContextId;
      readonly executable: string;
      readonly label: string;
      readonly session: ComputeSessionRecord;
    } | null>(null);
    const contextBinding = useComputeContextStore((state) =>
      props.contextId === undefined ? null : (state.bindings[props.contextId] ?? null),
    );
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
        input: { cwd: props.cwd, refresh: false, languageIds: [props.language.languageId] },
      }),
    );
    const exactSessionQuery =
      props.contextId !== undefined &&
      contextBinding?.sessionId !== null &&
      contextBinding?.sessionId !== undefined &&
      typeof computeEnvironment.session === "function"
        ? computeEnvironment.session({
            environmentId: props.environmentId,
            input: { cwd: props.cwd, sessionId: contextBinding.sessionId },
          })
        : null;
    const exactSession = useEnvironmentQuery(exactSessionQuery);
    const refreshSessions = sessions.refresh;
    const refreshEvents = events.refresh;
    const refreshRuntimeInspection = runtimes.refresh;
    const startSession = useAtomCommand(computeEnvironment.startSession, { reportFailure: false });
    const submitExecution = useAtomCommand(computeEnvironment.submitExecution, {
      reportFailure: false,
    });
    const submitCells = useAtomCommand(computeEnvironment.submitCells, { reportFailure: false });
    const refreshRuntimes = useAtomCommand(computeEnvironment.refreshRuntimes, {
      reportFailure: false,
    });
    const stopSession = useAtomCommand(computeEnvironment.stopSession, { reportFailure: false });
    const manageRuntime = useAtomCommand(computeEnvironment.manageRuntime, {
      reportFailure: false,
    });
    const updateSettings = useAtomCommand(serverEnvironment.updateSettings, {
      reportFailure: false,
    });
    const scientificComputing = useEnvironmentSettings(
      props.environmentId,
      (settings) => settings.scientificComputing,
    );
    const languageInspection =
      runtimes.data?.languages.find(
        (language) => language.descriptor.languageId === props.language.languageId,
      ) ?? null;
    const languageName = languageInspection?.descriptor.displayName ?? props.language.displayName;
    const languagePreference = resolveScientificComputingLanguageSettings(
      scientificComputing,
      props.language.languageId,
    );
    const managedRuntime = useComputeManagedRuntime({
      environmentId: props.environmentId,
      languageId: props.language.languageId,
      initialStatus: languageInspection?.managedRuntime ?? null,
      ensureEnabled: async () => {
        if (languagePreference.enabled) return true;
        const result = await updateSettings({
          environmentId: props.environmentId,
          input: {
            patch: {
              scientificComputing: {
                schemaVersion: 1,
                languages: {
                  [props.language.languageId]: { ...languagePreference, enabled: true },
                },
              },
            },
          },
        });
        return result._tag === "Success";
      },
    });
    const getSession = useAtomQueryRunner(computeEnvironment.session, {
      reportFailure: false,
      refresh: true,
    });
    const confirmFailedStart = async (
      sessionId: ComputeSessionId,
      generation: ComputeSessionRecord["generation"],
    ) => {
      if (props.contextId === undefined || typeof computeEnvironment.session !== "function") return;
      try {
        const observed = await getSession({
          environmentId: props.environmentId,
          input: { cwd: props.cwd, sessionId },
        });
        if (
          observed._tag !== "Success" ||
          observed.value === null ||
          !isExactTerminalComputeSession(observed.value, { sessionId, generation })
        ) {
          return;
        }
        useComputeContextStore.getState().markSessionTerminal({
          contextId: props.contextId,
          sessionId,
          generation,
        });
      } catch {
        // A rejected read is not proof that the independent server startup stopped.
      }
    };

    const allSessions = mergeComputeSessionRecords(
      sessions.data ?? [],
      exactSession.data === null ? [] : [exactSession.data],
      events.data?.sessions.values() ?? [],
    );
    const ownedSession = allSessions.find(
      (session) => session.sessionId === contextBinding?.sessionId,
    );
    // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- registers the owned session in the compute-context store registry when the session binding changes
    useEffect(() => {
      if (props.contextId !== undefined && ownedSession !== undefined) {
        useComputeContextStore.getState().observeSession(props.contextId, ownedSession);
      }
    }, [props.contextId, ownedSession]);
    const canRetryStart =
      startRetryAvailable || (contextBinding?.lifecycle === "starting" && operation === null);
    const capacitySessions = allSessions.filter(
      (session) =>
        !TERMINAL_COMPUTE_SESSION_STATUSES.has(session.status) &&
        session.sessionId !== contextBinding?.sessionId,
    );
    const contextSessionId = contextBinding?.sessionId;
    const liveSession = (() => {
      if (props.contextId !== undefined) {
        if (contextSessionId === null || contextSessionId === undefined) {
          return null;
        }
        return (
          allSessions.find(
            (session) =>
              session.sessionId === contextSessionId &&
              !TERMINAL_COMPUTE_SESSION_STATUSES.has(session.status),
          ) ?? null
        );
      }
      return (
        allSessions.find((session) => !TERMINAL_COMPUTE_SESSION_STATUSES.has(session.status)) ??
        null
      );
    })();
    const readyRuntime = defaultComputeRuntime(
      languageInspection === null ? [] : [languageInspection],
    );
    const preRunRuntimeChoice = resolveComputePreRunRuntimeChoice(languageInspection);
    const activeRuntime =
      liveSession === null || liveSession.runtime === null
        ? readyRuntime
        : (languageInspection?.runtimes.find(
            (candidate) => candidate.profile.executable === liveSession.runtime?.executable,
          ) ?? null);
    const scientificToolkit = activeRuntime?.toolkits.find(
      (toolkit) => toolkit.toolkitId === SCIENTIFIC_PYTHON_TOOLKIT_ID,
    );
    const missingScientificPackages =
      scientificToolkit?.readiness === "missing-requirement"
        ? scientificToolkit.missingRequirements
        : [];
    const setupProgress =
      managedRuntime.status === null
        ? null
        : managedRuntimeOperationLabel(managedRuntime.status, props.language.languageId);
    const runtimeToolbar = resolveComputeRuntimeToolbarState({
      languageId: props.language.languageId,
      languageName: languageName,
      runtimeVersion:
        liveSession?.runtime?.languageVersion ?? readyRuntime?.profile.languageVersion ?? null,
      liveSession,
      runtimeInspectionPending: runtimes.isPending || refreshing,
      readyRuntimeAvailable: readyRuntime !== null,
      preferredRuntimeExecutable: readyRuntime?.profile.executable ?? null,
      scientificPackagesMissing: missingScientificPackages.length > 0,
      runtimeCheckFailure: runtimes.isPending
        ? null
        : (runtimes.error ??
          (runtimes.data !== undefined &&
          languageInspection === null &&
          computeScientPart(props.language.languageId) !== null
            ? ""
            : (languageInspection?.failure ?? null))),
      runtimeBlocker: computeRuntimeBlocker(languageInspection),
      capacityRecoveryAvailable: capacityBlocked,
      startingRetryAvailable: canRetryStart,
      ...(contextBinding?.lifecycle === undefined
        ? {}
        : { contextLifecycle: contextBinding.lifecycle }),
    });
    const matlabFileCapability =
      props.language.languageId === "matlab"
        ? classifyMatlabSource({ path: props.relativePath, code: props.contents })
        : null;
    const requestRuntimeSwitch = () => {
      if (liveSession !== null && readyRuntime !== null && props.contextId !== undefined) {
        setSwitchTarget({
          environmentId: props.environmentId,
          contextId: props.contextId,
          executable: readyRuntime.profile.executable,
          label: computeRuntimeDisplayLabel(readyRuntime.profile, languageName),
          session: liveSession,
        });
      }
    };

    const stopUnusedSession = async (session: ComputeSessionRecord) => {
      if (stoppingUnusedSession !== null) return;
      setStoppingUnusedSession(session.sessionId);
      let result: Awaited<ReturnType<typeof stopSession>>;
      try {
        result = await stopSession({
          environmentId: props.environmentId,
          input: {
            cwd: props.cwd,
            sessionId: session.sessionId,
            expectedGeneration: session.generation,
          },
        });
      } catch (error) {
        setStoppingUnusedSession(null);
        toastManager.add({
          type: "error",
          title: `Unable to stop ${session.label}`,
          description: error instanceof Error ? error.message : "The stop request failed.",
        });
        return;
      }
      setStoppingUnusedSession(null);
      if (result._tag === "Success") {
        for (const binding of Object.values(useComputeContextStore.getState().bindings)) {
          if (
            binding.environmentId === props.environmentId &&
            binding.cwd === props.cwd &&
            binding.sessionId === session.sessionId &&
            binding.generation === session.generation
          ) {
            useComputeContextStore.getState().markSessionTerminal({
              contextId: binding.contextId,
              sessionId: result.value.sessionId,
              generation: result.value.generation,
            });
          }
        }
        refreshSessions();
        refreshEvents();
        refreshRuntimeInspection();
        return;
      }
      if (!isAtomCommandInterrupted(result)) {
        reportFailure(`Unable to stop ${session.label}`, result);
      }
    };

    const refreshRuntime = async () => {
      if (refreshing) return;
      setRefreshing(true);
      const result = await refreshRuntimes({
        environmentId: props.environmentId,
        input: { cwd: props.cwd, refresh: true, languageIds: [props.language.languageId] },
      });
      setRefreshing(false);
      if (result._tag !== "Success") {
        if (!isAtomCommandInterrupted(result))
          reportFailure(`Unable to refresh ${languageName}`, result);
        return;
      }
      refreshSessions();
    };

    const previousManagedOperation = useRef(false);
    // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- refreshes runtime status over the environment connection when a managed runtime operation ends
    useEffect(() => {
      const operating = managedRuntime.status?.operation != null;
      if (previousManagedOperation.current && !operating) {
        void refreshRuntime();
      }
      previousManagedOperation.current = operating;
    }, [managedRuntime.status?.operation, refreshRuntime]);

    const switchRuntime = async () => {
      if (switchTarget === null || switching) return;
      const target = switchTarget;
      setSwitching(true);
      return await (async () => {
        const result = await replaceComputeContextSession({
          contextId: target.contextId,
          expectedSession: target.session,
          replacementSessionId: ComputeSessionId.make(randomUUID()),
          getSession,
          stopSession,
          startSession,
          prepareRuntime: async () => {
            const refreshed = await refreshRuntimes({
              environmentId: target.environmentId,
              input: { cwd: target.session.workingDirectory, refresh: true },
            });
            const runtime =
              refreshed._tag === "Success"
                ? refreshed.value.languages
                    .find(
                      (language) =>
                        language.descriptor.languageId === target.session.languageId &&
                        language.enabled,
                    )
                    ?.runtimes.find(
                      (candidate) =>
                        candidate.profile.executable === target.executable &&
                        candidate.verification.readiness === "ready",
                    )
                : undefined;
            if (runtime === undefined)
              throw new Error(
                "The selected environment is no longer ready. Refresh environments and try again.",
              );
            return { languageId: runtime.profile.languageId, executable: target.executable };
          },
        });
        if (result.kind === "failed") {
          toastManager.add({
            type: "error",
            title: "Unable to switch environment",
            description: result.error,
          });
          return;
        }
        setSwitchTarget(null);
      })().finally(() => {
        setSwitching(false);
        refreshSessions();
        refreshEvents();
        refreshRuntimeInspection();
      });
    };

    const onExecutionSubmitted = props.onExecutionSubmitted;
    const run = async (
      kind: ComputeRunKind,
      slice: ComputeRunSlice | null,
      requestedExecutable?: string,
    ) => {
      if (slice === null || refreshing || switching) return;
      // Notebook cells wait in `waitingCells`; only one batch is ever in this path.
      if (operation !== null && slice.cells === undefined) return;
      // Keyboard shortcuts and the empty-results action use this same path;
      // a disabled toolbar must not be bypassed through an imperative handle.
      if (!runtimeToolbar.canRun) {
        setRunBlocked(true);
        toastManager.add({
          type: "info",
          title: ("note" in runtimeToolbar && runtimeToolbar.note) || runtimeToolbar.label,
        });
        return;
      }
      if (kind === "file" && matlabFileCapability?.runnableAsFile === false) {
        toastManager.add({
          type: "info",
          title: "This MATLAB file is a definition",
          description:
            matlabFileCapability.reason ??
            "Run a MATLAB script that calls this definition, or run a selection instead.",
        });
        return;
      }
      if (
        liveSession === null &&
        requestedExecutable === undefined &&
        preRunRuntimeChoice !== null
      ) {
        setPendingRuntimeChoice({
          kind,
          slice,
          currentExecutable: preRunRuntimeChoice.current.profile.executable,
          managedExecutable: preRunRuntimeChoice.managed.profile.executable,
        });
        return;
      }
      setPendingRuntimeChoice(null);
      setOperation(kind);

      let session = liveSession;
      const currentBinding =
        props.contextId === undefined
          ? null
          : (getComputeContext(props.contextId) ??
            ensureComputeContext({
              contextId: props.contextId,
              environmentId: props.environmentId,
              cwd: props.cwd,
              ownerKey: `${props.environmentId}:${props.cwd}:${props.relativePath}`,
              relativePath: props.relativePath,
            }));
      if (
        currentBinding?.lifecycle === "closing" ||
        currentBinding?.lifecycle === "close-failed" ||
        (currentBinding?.lifecycle === "starting" && !capacityBlocked && !canRetryStart)
      ) {
        toastManager.add({
          type: "info",
          title: capacityBlocked
            ? "Compute capacity reached"
            : currentBinding.lifecycle === "starting"
              ? "Compute is starting"
              : "Compute is closing",
          description: capacityBlocked
            ? "Stop an unused session above, then retry with this same tab-owned session."
            : currentBinding.lifecycle === "starting"
              ? startRetryAvailable
                ? "Retry with the same tab-owned session ID."
                : "This tab already owns a start in progress."
              : "Retry closing this tab before running it again.",
        });
        setOperation(null);
        return;
      }
      if (
        currentBinding?.sessionId !== null &&
        currentBinding?.sessionId !== undefined &&
        currentBinding.lifecycle === "live" &&
        session === null
      ) {
        toastManager.add({
          type: "info",
          title: "Refreshing this compute tab",
          description:
            "The owned session is not in the current snapshot yet. Try Run again shortly.",
        });
        setOperation(null);
        return;
      }
      if (session === null && readyRuntime === null) {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: `${languageName} is not ready`,
            description: `Use ${computeRuntimeSetupActionLabel(props.language.languageId, languageName)} on this file, or choose another runtime in Scientific Computing settings.`,
          }),
        );
        setOperation(null);
        return;
      }
      onRunRequested();
      if (session === null) {
        const runtime = readyRuntime;
        if (runtime === null) {
          setOperation(null);
          return;
        }
        const sessionId =
          currentBinding?.lifecycle === "terminal" || currentBinding?.sessionId === null
            ? ComputeSessionId.make(randomUUID())
            : (currentBinding?.sessionId ?? ComputeSessionId.make(randomUUID()));
        const requestedGeneration =
          currentBinding?.lifecycle === "terminal" || currentBinding?.sessionId === null
            ? INITIAL_COMPUTE_CONTEXT_GENERATION
            : (currentBinding?.generation ?? INITIAL_COMPUTE_CONTEXT_GENERATION);
        if (props.contextId !== undefined) {
          const reserved = useComputeContextStore.getState().reserveSession({
            contextId: props.contextId,
            sessionId,
            generation: requestedGeneration,
          });
          if (!reserved) {
            setOperation(null);
            return;
          }
        }
        setStartRetryAvailable(false);
        const started = await startSession({
          environmentId: props.environmentId,
          input: {
            cwd: props.cwd,
            sessionId,
            languageId: runtime.profile.languageId,
            // Null preserves server-side default resolution. A non-null value
            // is the runtime explicitly chosen immediately before this Run.
            executable: requestedExecutable ?? null,
            owner: { _tag: "file", path: props.relativePath },
          },
        });
        if (started._tag !== "Success") {
          setOperation(null);
          const capacityRejected = isComputeCapacityReachedError(squashAtomCommandFailure(started));
          setStartRetryAvailable(!capacityRejected);
          setCapacityBlocked(capacityRejected);
          setFreshCapacityBlocked(false);
          if (capacityRejected && props.contextId !== undefined) {
            useComputeContextStore.getState().releasePendingReservation({
              contextId: props.contextId,
              sessionId,
              generation: requestedGeneration,
            });
          } else {
            void confirmFailedStart(sessionId, requestedGeneration);
          }
          if (!isAtomCommandInterrupted(started))
            reportFailure(`Unable to start ${languageName}`, started);
          refreshSessions();
          refreshRuntimeInspection();
          return;
        }
        session = started.value;
        setStartRetryAvailable(false);
        setCapacityBlocked(false);
        if (
          props.contextId !== undefined &&
          !useComputeContextStore.getState().bindSession({
            contextId: props.contextId,
            sessionId: session.sessionId,
            generation: session.generation,
          })
        ) {
          setOperation(null);
          const current = getComputeContext(props.contextId);
          if (
            current?.sessionId === session.sessionId &&
            (current.lifecycle === "closing" || current.lifecycle === "close-failed")
          ) {
            void stopComputeContext({
              contextId: props.contextId,
              stopSession,
              getSession,
            });
          }
          return;
        }
        refreshSessions();
      }

      const currentOwner =
        props.contextId === undefined ? null : getComputeContext(props.contextId);
      if (props.contextId !== undefined && !ownsLiveComputeSession(currentOwner, session)) {
        setOperation(null);
        return;
      }

      const report = (failure: Parameters<typeof reportFailure>[1]) => {
        reportFailure(`Unable to run ${languageName}`, failure);
        refreshSessions();
      };
      if (slice.cells !== undefined) {
        const cells = slice.cells.map((cell) => ({
          cellId: cell.id,
          executionId: ComputeExecutionId.make(randomUUID()),
          code: cell.code,
        }));
        const submitted = await submitCells({
          environmentId: props.environmentId,
          input: {
            cwd: props.cwd,
            sessionId: session.sessionId,
            expectedGeneration: session.generation,
            path: props.relativePath,
            cells,
          },
        });
        setOperation(null);
        if (submitted._tag === "Success") {
          for (const cell of cells) onExecutionSubmitted(session.sessionId, cell.executionId);
          props.onCellsSubmitted?.(
            cells.map((cell) => ({ cellId: cell.cellId, execution: cell.executionId })),
          );
        } else if (!isAtomCommandInterrupted(submitted)) {
          report(submitted);
        }
        return;
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
        onExecutionSubmitted(session.sessionId, executionId);
      } else if (!isAtomCommandInterrupted(submitted)) {
        report(submitted);
      }
    };

    const stableRun = useStableCallback(run);
    const waitingCells = useRef<ComputeNotebookCell[]>([]);
    const cellRun = useRef<Promise<void> | null>(null);
    const runCells = (cells: ReadonlyArray<ComputeNotebookCell>): Promise<void> => {
      waitingCells.current.push(...cells);
      if (cellRun.current !== null) return cellRun.current;
      const drained = (async () => {
        while (waitingCells.current.length > 0) {
          const batch = waitingCells.current.splice(0);
          await stableRun("cell", {
            code: batch.map((cell) => cell.code).join("\n"),
            range: { startLine: 0, startColumn: 0, endLine: 0, endColumn: 0 },
            cells: batch,
          });
        }
      })().finally(() => {
        cellRun.current = null;
      });
      cellRun.current = drained;
      return drained;
    };

    const runWithChosenRuntime = (executable: string) => {
      const pending = pendingRuntimeChoice;
      setPendingRuntimeChoice(null);
      if (pending !== null) void run(pending.kind, pending.slice, executable);
    };

    const runtimeChoiceOpen =
      pendingRuntimeChoice !== null &&
      liveSession === null &&
      preRunRuntimeChoice !== null &&
      pendingRuntimeChoice.currentExecutable === preRunRuntimeChoice.current.profile.executable &&
      pendingRuntimeChoice.managedExecutable === preRunRuntimeChoice.managed.profile.executable;

    const lineSelectionSlice =
      props.selection === null ? null : computeLineSelection(props.contents, props.selection);
    const primary = resolveComputeRunTarget(
      props.contents,
      props.selection,
      props.editorSelection,
      props.language.cellMarker,
    );
    const selectionSlice = primary.kind === "selection" ? primary.slice : lineSelectionSlice;
    const caretLine = props.editorSelection?.end.line;
    const cellSlice =
      caretLine === undefined
        ? null
        : computeCell(props.contents, caretLine + 1, props.language.cellMarker);
    const fileSlice = computeFile(props.contents);
    const runFresh = async () => {
      if (
        props.contextId === undefined ||
        operation !== null ||
        fileSlice === null ||
        !languagePreference.enabled ||
        readyRuntime === null ||
        matlabFileCapability?.runnableAsFile === false
      )
        return;
      const parent =
        getComputeContext(props.contextId) ??
        ensureComputeContext({
          contextId: props.contextId,
          environmentId: props.environmentId,
          cwd: props.cwd,
          relativePath: props.relativePath,
          ownerKey: props.contextId,
        });
      if (parent.lifecycle === "closing" || parent.lifecycle === "close-failed") return;
      const childId = createComputeContextId();
      const sessionId = ComputeSessionId.make(randomUUID());
      const executionId = ComputeExecutionId.make(randomUUID());
      useComputeContextStore.getState().ensureContext({
        contextId: childId,
        parentContextId: props.contextId,
        environmentId: props.environmentId,
        cwd: props.cwd,
        relativePath: props.relativePath,
        ownerKey: props.contextId,
      });
      if (!useComputeContextStore.getState().reserveSession({ contextId: childId, sessionId }))
        return;
      setOperation("fresh");
      onRunRequested();
      return await (async () => {
        const started = await startSession({
          environmentId: props.environmentId,
          input: {
            cwd: props.cwd,
            sessionId,
            languageId: props.language.languageId,
            executable: null,
            owner: { _tag: "file", path: props.relativePath },
            runOnce: {
              executionId,
              code: fileSlice.code,
              source: {
                _tag: "document",
                origin: "file",
                path: props.relativePath,
                bufferState: props.sourcePending ? "dirty" : "saved",
                revision: props.sourceRevision,
                range: fileSlice.range,
              },
            },
          },
        });
        if (started._tag !== "Success") {
          const error = squashAtomCommandFailure(started);
          if (isComputeCapacityReachedError(error)) {
            useComputeContextStore.getState().releasePendingReservation({
              contextId: childId,
              sessionId,
              generation: INITIAL_COMPUTE_CONTEXT_GENERATION,
            });
            setCapacityBlocked(true);
            setFreshCapacityBlocked(true);
          }
          // These rejections happen before admission. Network/startup failures
          // retain the exact owner until Stop confirms cleanup.
          if (
            typeof error === "object" &&
            error !== null &&
            "reason" in error &&
            ["capacity-reached", "language-disabled", "source-invalid"].includes(
              String(error.reason),
            )
          ) {
            useComputeContextStore.getState().removeContext(childId);
          }
          if (!isAtomCommandInterrupted(started)) reportFailure("Unable to run fresh", started);
          return;
        }
        if (started.value.sessionId !== sessionId) {
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Unable to confirm fresh run",
              description:
                "The server returned a different session. The requested owner is retained.",
            }),
          );
          return;
        }
        if (
          !useComputeContextStore.getState().bindSession({
            contextId: childId,
            sessionId,
            generation: started.value.generation,
          })
        ) {
          await stopComputeContext({ contextId: childId, stopSession, getSession });
          return;
        }
        useComputeContextStore.getState().observeSession(childId, started.value);
        setCapacityBlocked(false);
        setFreshCapacityBlocked(false);
        onExecutionSubmitted(sessionId, executionId);
      })()
        .catch(async (error) => {
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Unable to confirm fresh run",
              description:
                error instanceof Error
                  ? error.message
                  : "The connection failed. Stop the owned run before closing this tab.",
            }),
          );
        })
        .finally(() => {
          setOperation(null);
          refreshSessions();
        });
    };
    const stopAndRunFresh = async () => {
      const target = freshStopTarget;
      if (
        target === null ||
        stoppingForFresh.current ||
        operation !== null ||
        !languagePreference.enabled ||
        readyRuntime === null ||
        fileSlice === null ||
        matlabFileCapability?.runnableAsFile === false
      )
        return;
      const binding = getComputeContext(target.contextId);
      // Approval concerns this exact session and generation, never a replacement.
      if (
        target.contextId !== props.contextId ||
        binding?.environmentId !== props.environmentId ||
        binding.cwd !== props.cwd ||
        binding.sessionId !== target.session.sessionId ||
        binding.generation !== target.session.generation ||
        binding.lifecycle === "closing" ||
        binding.lifecycle === "close-failed"
      )
        return;
      stoppingForFresh.current = true;
      setSwitching(true);
      return await (async () => {
        const result = await stopSession({
          environmentId: binding.environmentId,
          input: {
            cwd: binding.cwd,
            sessionId: target.session.sessionId,
            expectedGeneration: target.session.generation,
          },
        });
        if (result._tag !== "Success") {
          if (!isAtomCommandInterrupted(result))
            reportFailure("Unable to stop this session", result);
          return;
        }
        if (!isExactTerminalComputeSession(result.value, target.session))
          throw new Error("The session has not confirmed shutdown. Run fresh was not started.");
        const current = getComputeContext(target.contextId);
        if (
          current?.sessionId !== target.session.sessionId ||
          current.generation !== target.session.generation ||
          current.lifecycle === "closing" ||
          current.lifecycle === "close-failed"
        )
          return;
        useComputeContextStore.getState().markSessionTerminal({
          contextId: target.contextId,
          sessionId: target.session.sessionId,
          generation: target.session.generation,
        });
        await runFresh();
      })()
        .catch(async (error) => {
          toastManager.add({
            type: "error",
            title: "Unable to run fresh",
            description:
              error instanceof Error ? error.message : "Shutdown could not be confirmed.",
          });
        })
        .finally(() => {
          stoppingForFresh.current = false;
          setSwitching(false);
          refreshSessions();
          refreshEvents();
        });
    };
    const fileRunBlocked = matlabFileCapability?.runnableAsFile === false;
    const busy = operation !== null || refreshing || switching || stoppingUnusedSession !== null;
    // Setup receipts describe maintenance, not the health of this file's runtime.
    // A cached probe cannot disprove a failure of the managed runtime itself.
    // MATLAB's executable source does not identify its Engine host; its helper
    // selection determines whether a detected connection is independent.
    const hasIndependentRuntime =
      readyRuntime !== null &&
      (props.language.languageId === "python" || props.language.languageId === "sql"
        ? readyRuntime.profile.source !== "managed"
        : managedRuntime.status?.selection === "existing");
    // A live session takes precedence over discovery of a replacement runtime.
    const managedFailureUnrelated =
      liveSession !== null
        ? liveSession.languageId === props.language.languageId && liveSession.status === "ready"
        : hasIndependentRuntime;
    const showManagedFailure = Boolean(managedRuntime.failure) && !managedFailureUnrelated;
    const showManagedNotice = Boolean(setupProgress) || showManagedFailure;
    const pinRuntimeChrome =
      showManagedNotice ||
      runtimeToolbar.kind === "setup" ||
      runtimeToolbar.kind === "switch" ||
      runtimeToolbar.kind === "retry" ||
      runtimeToolbar.kind === "choose" ||
      // A blocked Run keeps its reason in view, however narrow the toolbar.
      (runBlocked && !runtimeToolbar.canRun) ||
      capacityBlocked;
    const primaryRunBlocked = primary.kind === "file" && fileRunBlocked;
    const liveRunDisabled = busy || !runtimeToolbar.canRun || primaryRunBlocked;
    const runMenuDisabled =
      busy ||
      (props.language.languageId !== "matlab" && !runtimeToolbar.canRun && readyRuntime === null);
    const runtimeNote =
      [
        liveSession?.runtime ? liveSession.runtime.executable : null,
        "note" in runtimeToolbar ? runtimeToolbar.note : null,
      ]
        .filter(Boolean)
        .join(" · ") || undefined;
    const primaryRunTooltip = primaryRunBlocked
      ? (matlabFileCapability?.reason ?? "This definition is called from a script.")
      : primary.slice === null
        ? "Nothing to run"
        : !runtimeToolbar.canRun
          ? runtimeToolbar.label
          : busy
            ? "Another compute action is finishing"
            : primary.label;

    useImperativeHandle(
      ref,
      () => ({
        runFile: () => void run("file", computeFile(props.contents)),
        runPrimary: (selection) => {
          const target = resolveComputeRunTarget(
            props.contents,
            props.selection,
            selection === undefined ? props.editorSelection : selection,
            props.language.cellMarker,
          );
          void run(target.kind, target.slice);
        },
        runCellAtLine: (line) =>
          void run("cell", computeCell(props.contents, line, props.language.cellMarker)),
        runCells,
      }),
      [props.contents, props.editorSelection, props.selection, props.language.cellMarker, run],
    );

    return (
      <>
        <div className="@container/python-file-actions flex min-w-0 items-center justify-end gap-1.5">
          <div
            className={
              pinRuntimeChrome
                ? "flex min-w-0 flex-1 items-center gap-1 overflow-hidden"
                : "hidden min-w-0 flex-1 overflow-hidden @[9rem]/python-file-actions:flex @[9rem]/python-file-actions:items-center @[9rem]/python-file-actions:gap-1"
            }
          >
            {showManagedNotice ? (
              <ManagedRuntimeNotice
                runtime={managedRuntime}
                variant="toolbar"
                showFailure={showManagedFailure}
              />
            ) : capacityBlocked ? (
              <Menu>
                <MenuTrigger
                  render={
                    <Button
                      size="toolbar"
                      variant="ghost-muted"
                      className="min-w-0 max-w-full"
                      disabled={stoppingUnusedSession !== null}
                      aria-label="Choose a compute session to stop"
                      ref={capacityAnchor}
                    />
                  }
                >
                  <span className="truncate">Stop a session…</span>
                </MenuTrigger>
                <MenuPopup align="start" side="bottom" className="min-w-64">
                  {freshCapacityBlocked && liveSession !== null && props.contextId !== undefined ? (
                    <MenuItem
                      disabled={switching || operation !== null}
                      onClick={() =>
                        setFreshStopTarget({ contextId: props.contextId!, session: liveSession })
                      }
                    >
                      Stop this session and run fresh…
                    </MenuItem>
                  ) : null}
                  {capacitySessions.length === 0 ? (
                    <MenuItem disabled>No other sessions</MenuItem>
                  ) : (
                    capacitySessions.map((session) => (
                      <MenuItem
                        key={`${session.sessionId}:${session.generation}`}
                        disabled={stoppingUnusedSession !== null}
                        onClick={() => void stopUnusedSession(session)}
                      >
                        Stop {computeSessionOwnerLabel(session, props.environmentId, props.cwd)}
                      </MenuItem>
                    ))
                  )}
                </MenuPopup>
              </Menu>
            ) : runtimeToolbar.kind === "retry" ? (
              <ScientTooltip content={runtimeNote ?? "Retry the check"}>
                <Button
                  size="xs"
                  variant="ghost-muted"
                  className="min-w-0 max-w-full"
                  aria-label={`${runtimeToolbar.label}. Retry the check`}
                  disabled={refreshing}
                  onClick={() => void refreshRuntime()}
                >
                  <span className="truncate font-normal">{runtimeToolbar.label} · Retry</span>
                </Button>
              </ScientTooltip>
            ) : runtimeToolbar.kind === "switch" ? (
              <Button
                size="xs"
                variant="ghost-muted"
                className="min-w-0 max-w-full"
                title={runtimeNote}
                aria-label={`Switch ${languageName} environment`}
                disabled={switching || props.contextId === undefined}
                onClick={requestRuntimeSwitch}
              >
                <span className="truncate font-normal">{runtimeToolbar.label}</span>
              </Button>
            ) : (
              <ScientTooltip content={runtimeNote ?? "Open Scientific Computing"}>
                <Button
                  size="xs"
                  variant="ghost-muted"
                  className="min-w-0 max-w-full shrink"
                  aria-label={`${runtimeToolbar.label}. Open Scientific Computing`}
                  render={
                    <Link
                      to="/settings/scientific-computing/$languageId"
                      params={{ languageId: props.language.languageId }}
                      search={{ environmentId: props.environmentId }}
                    />
                  }
                >
                  {runtimeToolbar.kind === "status" && runtimeToolbar.busy ? (
                    <LoaderCircle className="animate-spin" aria-hidden />
                  ) : null}
                  <span className="truncate font-normal">{runtimeToolbar.label}</span>
                </Button>
              </ScientTooltip>
            )}
          </div>
          {props.leadingActions}
          <div className="flex shrink-0 items-center">
            <ScientTooltip content={primaryRunTooltip}>
              <span className="inline-flex">
                <Button
                  ref={primaryRunAnchor}
                  size="xs"
                  variant="outline"
                  shape="group-start"
                  aria-label={
                    props.runAll
                      ? "Run all"
                      : primaryRunBlocked
                        ? "MATLAB definition file"
                        : primary.label
                  }
                  disabled={
                    props.runAll
                      ? !runtimeToolbar.canRun
                      : liveRunDisabled || primary.slice === null
                  }
                  onClick={() =>
                    props.runAll ? props.runAll() : void run(primary.kind, primary.slice)
                  }
                >
                  {operation === primary.kind && !props.runAll ? (
                    <LoaderCircle className="animate-spin" />
                  ) : (
                    <Play />
                  )}
                  <span className="hidden @[15rem]/python-file-actions:inline">
                    {props.runAll ? "Run all" : primaryRunBlocked ? "Definition" : primary.label}
                  </span>
                </Button>
              </span>
            </ScientTooltip>
            <Menu>
              <MenuTrigger
                render={
                  <Button
                    size="icon-xs"
                    variant="outline"
                    shape="group-end"
                    disabled={runMenuDisabled}
                    aria-label={`Choose ${languageName} code to run`}
                  />
                }
              >
                <ChevronDown />
              </MenuTrigger>
              <MenuPopup align="end" side="bottom">
                {props.runAll ? (
                  props.runMenu
                ) : (
                  <>
                    <MenuItem
                      disabled={busy || !runtimeToolbar.canRun || selectionSlice === null}
                      onClick={() => void run("selection", selectionSlice)}
                    >
                      Run selection
                    </MenuItem>
                    <MenuItem
                      disabled={busy || !runtimeToolbar.canRun || cellSlice === null}
                      onClick={() => void run("cell", cellSlice)}
                    >
                      Run cell
                    </MenuItem>
                    <MenuItem
                      disabled={
                        busy || !runtimeToolbar.canRun || fileRunBlocked || fileSlice === null
                      }
                      title={
                        fileRunBlocked ? (matlabFileCapability.reason ?? undefined) : undefined
                      }
                      onClick={() => void run("file", fileSlice)}
                    >
                      Run file
                    </MenuItem>
                    {props.contextId !== undefined ? (
                      <MenuItem
                        disabled={
                          busy ||
                          !languagePreference.enabled ||
                          readyRuntime === null ||
                          fileRunBlocked ||
                          fileSlice === null
                        }
                        onClick={() => void runFresh()}
                      >
                        Run fresh
                      </MenuItem>
                    ) : null}
                  </>
                )}
                {runtimeToolbar.kind === "switch" ? (
                  <>
                    <MenuSeparator />
                    <MenuItem onClick={requestRuntimeSwitch}>
                      Switch {languageName} environment…
                    </MenuItem>
                  </>
                ) : null}
                {props.language.languageId === "matlab" ? (
                  <>
                    <MenuSeparator />
                    <MenuItem
                      disabled={fileRunBlocked || props.batchCanStart === false}
                      title={
                        fileRunBlocked ? (matlabFileCapability.reason ?? undefined) : undefined
                      }
                      onClick={props.onShowMatlabOneShot}
                    >
                      Run MATLAB batch
                    </MenuItem>
                  </>
                ) : null}
              </MenuPopup>
            </Menu>
          </div>
        </div>
        {preRunRuntimeChoice === null ? null : (
          <ContextualConfirmation
            open={runtimeChoiceOpen}
            onOpenChange={(open) => {
              if (!open) setPendingRuntimeChoice(null);
            }}
            anchor={primaryRunAnchor}
            title="Use Scient-managed Python?"
            description={`${computeRuntimeDisplayLabel(preRunRuntimeChoice.current.profile, languageName)} is missing scientific packages.`}
            confirmLabel="Use managed"
            secondaryAction={{
              label: "Use current",
              onSelect: () => runWithChosenRuntime(preRunRuntimeChoice.current.profile.executable),
            }}
            onConfirm={() => {
              runWithChosenRuntime(preRunRuntimeChoice.managed.profile.executable);
              // The choice holds for new sessions, so the next file does not ask again.
              void manageRuntime({
                environmentId: props.environmentId,
                input: { languageId: props.language.languageId, action: "use-managed" },
              });
            }}
          />
        )}
        <ContextualConfirmation
          open={freshStopTarget !== null}
          onOpenChange={(open) => {
            if (!open) setFreshStopTarget(null);
          }}
          anchor={capacityAnchor}
          title="Stop this session and run fresh?"
          description="Current variables will be lost. Run history is kept."
          confirmLabel="Stop and run fresh"
          destructive
          busy={switching}
          onConfirm={() => void stopAndRunFresh()}
        />
        <AlertDialog
          open={switchTarget !== null}
          onOpenChange={(open) => {
            if (!open) setSwitchTarget(null);
          }}
        >
          <AlertDialogPopup>
            <AlertDialogHeader>
              <AlertDialogTitle>Switch {languageName} environment?</AlertDialogTitle>
              <AlertDialogDescription>
                Use {switchTarget?.label}? Current variables will be cleared. Run history is kept;
                no code is rerun.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogClose render={<Button variant="outline" disabled={switching} />}>
                Cancel
              </AlertDialogClose>
              <Button disabled={switching} onClick={() => void switchRuntime()}>
                {switching ? <LoaderCircle className="animate-spin" /> : null}
                Switch
              </Button>
            </AlertDialogFooter>
          </AlertDialogPopup>
        </AlertDialog>
      </>
    );
  },
);
