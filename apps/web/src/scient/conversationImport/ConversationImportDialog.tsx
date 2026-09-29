import type {
  ConversationImportId,
  EnvironmentId,
  ScientConversationImportConfirmRequest,
  ScientConversationImportPreview,
  ScientConversationImportResult,
} from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { FileUpIcon, ImportIcon } from "lucide-react";
import { useEffect, useEffectEvent, useId, useMemo, useRef, useState } from "react";

import { Button } from "../../components/ui/button";
import {
  Dialog,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../../components/ui/dialog";
import {
  Select,
  SelectGroup,
  SelectGroupLabel,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "../../components/ui/select";
import { Spinner } from "../../components/ui/spinner";
import { toastManager } from "../../components/ui/toast";
import { useHandleNewThread } from "../../hooks/useHandleNewThread";
import { mergeEnvironmentSettings, useClientSettings } from "../../hooks/useSettings";
import { resolveThreadActionProjectRef } from "../../lib/chatThreadActions";
import { randomUUID } from "../../lib/utils";
import { useProjects, useServerConfigs, useThreadShells } from "../../state/entities";
import { useEnvironments, usePrimaryEnvironmentId } from "../../state/environments";
import { buildThreadRouteParams } from "../../threadRoutes";
import {
  cancelConversationImport,
  confirmConversationImport,
  createConversationImportUpload,
  previewConversationImport,
  uploadConversationFile,
} from "./client";
import { installConversationImportDropTarget, type ConversationFileDrag } from "./drop";
import {
  ConversationImportNotice,
  IMPORT_RUNTIME_MODE,
  desktopUploadOutcome,
  importEnvironmentOptions,
  importFailureMessage,
  importFileProblem,
  isAbort,
  isConversationImportError,
  isMarkdownFileName,
  isRecordLimitRefusal,
} from "./importDialog.logic";
import { defaultImportProject, newChatModelSelection } from "./importDestination.logic";
import {
  dismissConversationImportRequest,
  replaceConversationImportSource,
  requestConversationImport,
  setConversationImportReplaceable,
  useConversationImportRequests,
  type ConversationImportSource,
} from "./requests";

/**
 * The File menu, drag and drop, and OS file-open events enter the same
 * check-and-confirm flow. While `suspended` (first-run setup), requests are
 * kept and the dialog opens once setup is finished.
 */
export function ConversationImportDialogHost({
  suspended = false,
}: {
  readonly suspended?: boolean;
}) {
  const request = useConversationImportRequests((state) => state.queue[0] ?? null);
  const queued = useConversationImportRequests((state) => state.queue.length);
  const [drag, setDrag] = useState<ConversationFileDrag | null>(null);
  useEffect(() => installConversationImportDropTarget(window, setDrag), []);
  useEffect(() => {
    const bridge = window.desktopBridge;
    const collect = () => {
      void bridge?.takeOpenedConversationFiles?.().then(
        (files) =>
          files.forEach((file) => requestConversationImport({ _tag: "desktop-file", file })),
        () =>
          toastManager.add({
            type: "error",
            title: "Couldn't open the conversation file",
            description: "Open it again from Scient's File menu.",
          }),
      );
    };
    collect();
    const stopFiles = bridge?.onConversationFilesOpened?.(collect);
    const stopMenu = bridge?.onMenuAction?.((action) => {
      if (action === "import-conversation") requestConversationImport();
    });
    return () => {
      stopFiles?.();
      stopMenu?.();
    };
  }, []);
  const announced = useRef(queued);
  useEffect(() => {
    if (suspended && queued > announced.current) {
      toastManager.add({
        type: "info",
        title: "Conversation file received",
        description: "It opens for import when setup is finished.",
      });
    }
    announced.current = queued;
  }, [queued, suspended]);
  return (
    <>
      {drag !== null ? <ConversationImportDropOverlay drag={drag} /> : null}
      {!suspended && request !== null ? (
        <ConversationImportDialog key={request.id} source={request.source} />
      ) : null}
    </>
  );
}

function ConversationImportDropOverlay({ drag }: { readonly drag: ConversationFileDrag }) {
  return (
    <div
      className="pointer-events-none fixed inset-2 z-[70] flex items-center justify-center rounded-2xl border-2 border-dashed border-primary/60 bg-primary/[0.035]"
      data-conversation-import-drop-overlay={drag}
    >
      <div
        role="status"
        className="flex flex-col items-center gap-0.5 rounded-2xl border border-primary/25 bg-background/95 px-4 py-2.5 text-sm font-medium text-foreground shadow-lg"
      >
        <span className="flex items-center gap-2">
          <ImportIcon className="size-4 text-primary" aria-hidden="true" />
          Drop to import conversation
        </span>
        {drag === "possible-conversation" ? (
          <span className="text-muted-foreground text-xs font-normal">
            Other files attach as usual.
          </span>
        ) : null}
      </div>
    </div>
  );
}

function sourceFile(source: ConversationImportSource) {
  switch (source._tag) {
    case "choose":
      return null;
    case "browser-file":
      return { name: source.file.name, sizeBytes: source.file.size };
    case "desktop-file":
      return { name: source.file.fileName, sizeBytes: source.file.sizeBytes };
  }
}

function formatMegabytes(bytes: number): string {
  return `${Math.max(1, Math.round(bytes / (1024 * 1024)))} MB`;
}

type Stage =
  | { readonly _tag: "waiting" }
  | { readonly _tag: "sending"; readonly sentBytes: number | null; readonly totalBytes: number }
  | { readonly _tag: "checking" }
  | { readonly _tag: "ready"; readonly preview: ScientConversationImportPreview }
  | {
      readonly _tag: "failed";
      readonly message: string;
      /** A transient failure; the same file can be sent again. */
      readonly retryable: boolean;
      /** A Markdown transcript too long to import can still start a conversation as a document. */
      readonly wholeFile?: true;
    };

/** Announced to assistive technology while the Import button spins. */
function stageStatus(stage: Stage): string | null {
  switch (stage._tag) {
    case "sending":
      return stage.sentBytes === null || stage.totalBytes < 2 * 1024 * 1024
        ? "Sending the file…"
        : `Sending the file… ${formatMegabytes(stage.sentBytes)} of ${formatMegabytes(stage.totalBytes)}`;
    case "checking":
      return "Checking the file…";
    default:
      return null;
  }
}

/** Refusals that sending the same file again would repeat. */
function isUnreadableRefusal(cause: unknown): boolean {
  return (
    isConversationImportError(cause) &&
    (cause.reason === "package-rejected" || cause.reason === "package-too-large")
  );
}

/** One staged import: where it lives, and its ID while the server holds it. */
interface StagedAttempt {
  readonly environmentId: EnvironmentId;
  importId: ConversationImportId | null;
  /**
   * Set once a confirm is sent. From then the server may commit the import
   * whatever happens to the connection, so the staged import is kept, and
   * never cancelled, until the outcome is known.
   */
  confirming: boolean;
  /** A confirm was sent at some point; a later cancel may find it committed after all. */
  confirmed: boolean;
}

/** A confirm that was sent, and what is known about its outcome. */
interface Confirmation {
  readonly staged: StagedAttempt;
  readonly request: ScientConversationImportConfirmRequest;
  /** `unknown`: the answer never arrived; the server may still have committed it. */
  readonly phase: "sending" | "unknown";
  /** The destination's connection dropped since the confirm was sent. */
  readonly interrupted: boolean;
  /** How many times the confirm has been re-sent to learn its outcome. */
  readonly checks: number;
}

function projectKey(project: { readonly environmentId: EnvironmentId; readonly id: string }) {
  return `${project.environmentId}/${project.id}`;
}

/**
 * A file, a project, and Import. The file is sent and checked in the
 * background; the conversation opens on the model a new chat in that project
 * would use, in approval-required mode. What the file leaves out is shown
 * after import, on the thread.
 */
function ConversationImportDialog({ source }: { readonly source: ConversationImportSource }) {
  const id = useId();
  const navigate = useNavigate();
  const projects = useProjects();
  const threads = useThreadShells();
  const configs = useServerConfigs();
  const clientSettings = useClientSettings();
  const { environments } = useEnvironments();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const { activeDraftThread, activeThread, handleNewThread } = useHandleNewThread();

  const environmentOptions = useMemo(
    () =>
      importEnvironmentOptions({
        environmentIds: configs.keys(),
        labels: new Map(
          environments.map((environment) => [environment.environmentId, environment.label]),
        ),
        connected: new Set(
          environments
            .filter((environment) => environment.connection.phase === "connected")
            .map((environment) => environment.environmentId),
        ),
        primaryEnvironmentId,
      }),
    [configs, environments, primaryEnvironmentId],
  );
  const environmentLabel = (environmentId: EnvironmentId | null) =>
    environmentOptions.find((option) => option.environmentId === environmentId)?.label ?? null;
  // Projects the file can go to: those of connected environments.
  const connectedProjects = projects.filter((project) =>
    environmentOptions.some(
      (option) => option.environmentId === project.environmentId && option.connected,
    ),
  );
  const currentProjectRef = resolveThreadActionProjectRef({
    activeDraftThread,
    activeThread: activeThread ?? undefined,
    defaultProjectRef: null,
    handleNewThread,
  });
  const defaultProject = defaultImportProject({
    available: connectedProjects,
    current: currentProjectRef,
    threads,
  });

  const [retries, setRetries] = useState(0);
  // The destination environment is the chosen project's. It is fixed once a
  // file is sent there, or once the person picks a project. Until then the
  // default project's environment is used. The file is never sent to a
  // destination nobody chose: one that disappears stops the import, and so
  // does losing its connection, which only "Try again" resumes.
  const [destination, setDestination] = useState<EnvironmentId | null>(null);
  const destinationOption = environmentOptions.find(
    (option) => option.environmentId === destination,
  );
  const destinationGone = destination !== null && destinationOption === undefined;
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const [disconnectedAt, setDisconnectedAt] = useState<number | null>(null);
  // A sent confirm holds its destination: losing the connection then does
  // not abandon the attempt, it waits to learn whether the import finished.
  if (
    confirmation === null &&
    destinationOption?.connected === false &&
    disconnectedAt !== retries
  ) {
    setDisconnectedAt(retries);
  }
  const confirmingConnected =
    confirmation !== null &&
    environmentOptions.some(
      (option) => option.environmentId === confirmation.staged.environmentId && option.connected,
    );
  if (confirmation !== null && !confirmingConnected && !confirmation.interrupted) {
    setConfirmation({ ...confirmation, interrupted: true });
  }
  // Once the destination is back, ask it what became of the lost confirm.
  if (confirmation?.interrupted === true && confirmingConnected) {
    setConfirmation({
      ...confirmation,
      interrupted: false,
      phase: "sending",
      checks: confirmation.checks + 1,
    });
  }
  const connectionLost =
    confirmation === null && !destinationGone && destination !== null && disconnectedAt === retries;
  const environmentId =
    confirmation !== null
      ? confirmation.staged.environmentId
      : destination === null
        ? (defaultProject?.environmentId ??
          environmentOptions.find((option) => option.connected)?.environmentId ??
          null)
        : destinationOption?.connected === true && !connectionLost
          ? destination
          : null;
  const config = environmentId === null ? undefined : configs.get(environmentId);
  const [chosenProjectId, setProjectId] = useState<string | null>(null);
  const environmentProjects = projects.filter((project) => project.environmentId === environmentId);
  const project =
    environmentProjects.find((candidate) => candidate.id === chosenProjectId) ??
    (defaultProject?.environmentId === environmentId ? defaultProject : undefined) ??
    environmentProjects[0] ??
    null;
  const settings = useMemo(
    () => (config === undefined ? null : mergeEnvironmentSettings(config.settings, clientSettings)),
    [clientSettings, config],
  );
  const modelSelection =
    settings === null ? null : newChatModelSelection({ config, settings, project });

  const file = sourceFile(source);
  const fileProblem = file === null ? null : importFileProblem(file.name, file.sizeBytes);
  // "Start with the whole file" re-stages this same Markdown file as a document.
  const [documentModeFor, setDocumentModeFor] = useState<ConversationImportSource | null>(null);
  const markdownMode: "document" | undefined = documentModeFor === source ? "document" : undefined;
  // One attempt per file, destination, and mode; "Try again" starts another.
  // What an attempt shows is kept with it, so a new attempt starts clean.
  const attempt = useMemo(
    () => ({ source, environmentId, markdownMode, retries }),
    [source, environmentId, markdownMode, retries],
  );
  const [progress, setProgress] = useState<{
    readonly attempt: typeof attempt;
    readonly stage: Stage;
  } | null>(null);
  const stage: Stage =
    progress?.attempt === attempt
      ? progress.stage
      : file === null || environmentId === null
        ? { _tag: "waiting" }
        : { _tag: "sending", sentBytes: null, totalBytes: file.sizeBytes };
  const importing = confirmation !== null;
  const [importError, setImportError] = useState<{
    readonly attempt: typeof attempt;
    readonly message: string;
  } | null>(null);
  const stagedRef = useRef<StagedAttempt | null>(null);
  // The desktop streams one opened file at a time; a new attempt waits for the last.
  const desktopUploadRef = useRef<Promise<unknown>>(Promise.resolve());
  const primaryRef = useRef<HTMLButtonElement>(null);
  // Opening focuses the dialog itself; Import takes focus once the check is done.
  const popupRef = useRef<HTMLDivElement>(null);

  // Every file and destination is sent and checked as soon as it is chosen.
  // Changing either, closing, or cancelling stops the transfer and releases
  // what the server staged.
  useEffect(() => {
    const { source, environmentId, markdownMode } = attempt;
    if (source._tag === "choose" || environmentId === null || fileProblem !== null) return;
    const controller = new AbortController();
    const staged: StagedAttempt = {
      environmentId,
      importId: null,
      confirming: false,
      confirmed: false,
    };
    stagedRef.current = staged;
    const stopped = () => controller.signal.aborted;
    const setStage = (stage: Stage) => setProgress({ attempt, stage });
    // Set while the desktop streams this attempt's file; a cancel stops that
    // attempt first, and a later attempt can still send the same file.
    let desktopAttempt: { readonly token: string; readonly attemptId: string } | null = null;
    const release = () => {
      if (staged.confirming) return;
      const importId = staged.importId;
      staged.importId = null;
      if (importId === null) return;
      const sending = desktopAttempt;
      desktopAttempt = null;
      const stopDesktop =
        sending === null
          ? Promise.resolve()
          : Promise.resolve(window.desktopBridge?.cancelOpenedConversationFileUpload?.(sending));
      void stopDesktop
        .catch(() => undefined)
        .then(() => cancelConversationImport(staged.environmentId, importId))
        .then((answer) => {
          // A confirm that answered "not imported" can still have finished
          // (for example one that was interrupted and resumed on the server).
          if (staged.confirmed && answer._tag === "already-imported") {
            toastManager.add({
              type: "success",
              title: "Conversation imported",
              description: "The import finished after all. It's in your conversations.",
            });
          }
        })
        .catch(() => undefined);
    };
    const { name, sizeBytes } = sourceFile(source)!;
    let checking = false;
    void (async () => {
      setDestination((current) => current ?? environmentId);
      try {
        const upload = await createConversationImportUpload(
          environmentId,
          name,
          sizeBytes,
          markdownMode,
        );
        staged.importId = upload.importId;
        if (stopped()) return release();
        if (source._tag === "browser-file") {
          await uploadConversationFile(upload.url, source.file, {
            signal: controller.signal,
            onProgress: (sentBytes, totalBytes) => {
              if (!stopped()) setStage({ _tag: "sending", sentBytes, totalBytes });
            },
          });
        } else {
          // A cancelled attempt never starts its queued upload.
          const sending = desktopUploadRef.current.then(() => {
            if (stopped()) return null;
            desktopAttempt = { token: source.file.token, attemptId: randomUUID() };
            return window.desktopBridge?.uploadOpenedConversationFile?.({
              ...desktopAttempt,
              url: upload.url,
            });
          });
          desktopUploadRef.current = sending.catch(() => undefined);
          const result = await sending;
          desktopAttempt = null;
          if (stopped() || result === null) return;
          const outcome = desktopUploadOutcome(result);
          if (outcome instanceof ConversationImportNotice) throw outcome;
          if (outcome._tag === "stopped") {
            release();
            dismissConversationImportRequest();
            return;
          }
        }
        if (stopped()) return;
        setStage({ _tag: "checking" });
        checking = true;
        const preview = await previewConversationImport(environmentId, upload.importId);
        if (!stopped()) setStage({ _tag: "ready", preview });
      } catch (cause) {
        if (stopped() || isAbort(cause)) return;
        release();
        // The check refused a transcript for its length; the same file as a
        // document is one message. A file refused for its size is not offered.
        const wholeFile =
          checking &&
          source._tag === "browser-file" &&
          markdownMode === undefined &&
          isMarkdownFileName(name) &&
          isRecordLimitRefusal(cause);
        setStage({
          _tag: "failed",
          message: importFailureMessage(cause, "This file couldn't be read."),
          retryable: !wholeFile && !isUnreadableRefusal(cause),
          ...(wholeFile ? { wholeFile: true as const } : {}),
        });
      }
    })();
    return () => {
      controller.abort();
      release();
    };
  }, [attempt, fileProblem]);

  // While this dialog is on screen, a dropped file replaces its file.
  useEffect(() => {
    setConversationImportReplaceable(true);
    return () => setConversationImportReplaceable(false);
  }, []);

  const preview = stage._tag === "ready" ? stage.preview : null;
  const isDocument = preview?.kind === "document";
  const damagedMarkers = preview?.kind === "markdown" && preview.markdownIssues.length > 0;
  const canImport = preview !== null && !importing && project !== null && modelSelection !== null;

  // A finished check puts focus on Import when focus is still where the file
  // came in (the dialog itself), never away from a choice being made.
  useEffect(() => {
    if (preview === null) return;
    const active = document.activeElement;
    const atEntry =
      active === null ||
      active === document.body ||
      active.getAttribute("role") === "dialog" ||
      active.closest("[data-conversation-file-choice]") !== null;
    if (atEntry) primaryRef.current?.focus();
  }, [preview]);

  // Closing while a confirm's answer is pending or lost keeps the staged
  // import; the thread appears if the server committed it.
  const closable =
    confirmation === null || confirmation.phase === "unknown" || confirmation.interrupted;
  const closedRef = useRef(false);
  const close = () => {
    if (!closable) return;
    closedRef.current = true;
    dismissConversationImportRequest();
  };

  const finished = (next: Confirmation, result: ScientConversationImportResult) => {
    if (closedRef.current) return;
    closedRef.current = true;
    next.staged.importId = null;
    next.staged.confirming = false;
    dismissConversationImportRequest();
    toastManager.add({ type: "success", title: "Conversation imported" });
    void navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams({
        environmentId: next.staged.environmentId,
        threadId: result.threadId,
      }),
    });
  };

  // Sends (or re-sends) one confirm. The server answers a repeated identical
  // confirm with the import it committed, joins the attempt still running,
  // or reports that nothing was imported; so re-sending never imports twice.
  const confirmSequence = useRef(0);
  const notImported = (next: Confirmation) => {
    next.staged.confirming = false;
    next.staged.importId = null;
    setConfirmation(null);
    setConversationImportReplaceable(true);
    setProgress({
      attempt,
      stage: {
        _tag: "failed",
        message: "The import didn't finish. Send the file again to import it.",
        retryable: true,
      },
    });
  };
  // "Already imported" for this import's own ID means it committed, but with
  // a destination other than this confirm's; cancel answers a committed
  // import with its result, so the dialog finishes with that thread and
  // never sends the file again.
  const collectCommitted = (next: Confirmation, sequence: number) => {
    void cancelConversationImport(next.staged.environmentId, next.request.importId).then(
      (answer) => {
        if (closedRef.current || sequence !== confirmSequence.current) return;
        if (answer._tag === "already-imported") finished(next, answer.result);
        else notImported(next);
      },
      () => {
        if (closedRef.current || sequence !== confirmSequence.current) return;
        setConfirmation((current) => (current === null ? null : { ...current, phase: "unknown" }));
      },
    );
  };
  const onServerFailure = (next: Confirmation, sequence: number, cause: unknown) => {
    if (closedRef.current || sequence !== confirmSequence.current) return;
    if (!isConversationImportError(cause)) {
      setConfirmation((current) => (current === null ? null : { ...current, phase: "unknown" }));
      return;
    }
    if (cause.reason === "already-imported") {
      collectCommitted(next, sequence);
      return;
    }
    // The server answered: nothing was imported.
    if (cause.reason === "import-not-found" || cause.reason === "cancelled") {
      notImported(next);
      return;
    }
    next.staged.confirming = false;
    setConfirmation(null);
    setConversationImportReplaceable(true);
    setImportError({
      attempt,
      message: importFailureMessage(cause, "The conversation couldn't be imported. Try again."),
    });
  };
  const askServer = (next: Confirmation) => {
    const sequence = ++confirmSequence.current;
    return confirmConversationImport(next.staged.environmentId, next.request).then(
      (result) => finished(next, result),
      (cause: unknown) => onServerFailure(next, sequence, cause),
    );
  };
  const recheck = useEffectEvent(() => {
    if (confirmation !== null) void askServer(confirmation);
  });
  const checks = confirmation?.checks ?? 0;
  useEffect(() => {
    if (checks > 0) recheck();
  }, [checks]);

  const runImport = () => {
    const staged = stagedRef.current;
    if (!canImport || staged?.importId == null) return;
    staged.confirming = true;
    staged.confirmed = true;
    setImportError(null);
    setConversationImportReplaceable(false);
    const next: Confirmation = {
      staged,
      request: {
        importId: staged.importId,
        packageSha256: preview.package.packageSha256,
        // Offered only as "Import readable messages" when markers are damaged.
        ...(damagedMarkers ? { acknowledgeMarkdownIssues: true } : {}),
        destination: {
          projectId: project.id,
          modelSelection,
          runtimeMode: IMPORT_RUNTIME_MODE,
          interactionMode: "default",
        },
      },
      phase: "sending",
      interrupted: false,
      checks: 0,
    };
    setConfirmation(next);
    void askServer(next);
  };

  const busy = stage._tag === "sending" || stage._tag === "checking" || importing;
  const status = fileProblem === null ? stageStatus(stage) : null;
  const unreadable =
    fileProblem ??
    (confirmation === null && stage._tag === "failed" && !stage.retryable && !stage.wholeFile
      ? stage.message
      : null);
  const notice =
    unreadable !== null || confirmation !== null
      ? null
      : destinationGone
        ? "That project's environment is no longer available. Choose another project."
        : connectionLost
          ? `Lost the connection to ${environmentLabel(destination) ?? "that environment"}. Choose another project or try again.`
          : file !== null && environmentId === null && destination === null
            ? "Nothing to import into is connected. Reconnect to import this file."
            : stage._tag === "failed"
              ? stage.message
              : preview !== null && environmentProjects.length === 0
                ? "Add a project to import this conversation."
                : preview !== null && project !== null && modelSelection === null
                  ? "No model is available. Connect a provider to import."
                  : null;
  const offersWholeFile = stage._tag === "failed" && stage.wholeFile === true;
  // "Try again" resends to the same destination, only once it is connected.
  const canRetry =
    unreadable === null &&
    !destinationGone &&
    !offersWholeFile &&
    (connectionLost
      ? destinationOption?.connected === true
      : stage._tag === "failed" && stage.retryable);
  const canWholeFile = source._tag === "browser-file";
  // Projects to choose from, grouped by environment only when several have some.
  const projectGroups = environmentOptions
    .filter((option) => option.connected || option.environmentId === environmentId)
    .map((option) => ({
      label: option.label,
      projects: projects.filter((candidate) => candidate.environmentId === option.environmentId),
    }))
    .filter((group) => group.projects.length > 0);
  const title =
    preview === null
      ? file === null
        ? "Import conversation"
        : `Import “${file.name}”`
      : isDocument
        ? `Start a conversation from ${file?.name ?? preview.fileName}`
        : `Import “${preview.conversation.title}”`;

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) close();
      }}
    >
      <DialogPopup
        ref={popupRef}
        initialFocus={popupRef}
        className="sm:max-w-md"
        showCloseButton={false}
      >
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        <DialogPanel>
          <div className="flex flex-col gap-3">
            {status !== null ? (
              <p className="sr-only" role="status">
                {status}
              </p>
            ) : null}
            {file === null ? (
              <ConversationFileChoice />
            ) : unreadable !== null ? (
              <p role="alert" className="text-sm">
                {unreadable}
              </p>
            ) : (
              <>
                {projectGroups.length > 0 ? (
                  <div className="flex items-center gap-3">
                    <span id={`${id}-project`} className="shrink-0 text-sm font-medium">
                      Project
                    </span>
                    <Select
                      value={project === null ? "" : projectKey(project)}
                      items={Object.fromEntries(
                        projectGroups.flatMap((group) =>
                          group.projects.map((candidate) => [
                            projectKey(candidate),
                            projectGroups.length > 1
                              ? `${candidate.title} · ${group.label}`
                              : candidate.title,
                          ]),
                        ),
                      )}
                      disabled={importing}
                      onValueChange={(value) => {
                        const chosen = projects.find(
                          (candidate) => projectKey(candidate) === value,
                        );
                        if (!chosen) return;
                        setProjectId(chosen.id);
                        if (chosen.environmentId !== environmentId) {
                          setDestination(chosen.environmentId);
                          setDisconnectedAt(null);
                        }
                      }}
                    >
                      <SelectTrigger aria-labelledby={`${id}-project`} className="min-w-0 flex-1">
                        <SelectValue placeholder="Choose a project" />
                      </SelectTrigger>
                      <SelectPopup>
                        {projectGroups.map((group) =>
                          projectGroups.length > 1 ? (
                            <SelectGroup key={group.label}>
                              <SelectGroupLabel>{group.label}</SelectGroupLabel>
                              {group.projects.map((candidate) => (
                                <SelectItem
                                  key={projectKey(candidate)}
                                  value={projectKey(candidate)}
                                >
                                  {candidate.title}
                                </SelectItem>
                              ))}
                            </SelectGroup>
                          ) : (
                            group.projects.map((candidate) => (
                              <SelectItem key={projectKey(candidate)} value={projectKey(candidate)}>
                                {candidate.title}
                              </SelectItem>
                            ))
                          ),
                        )}
                      </SelectPopup>
                    </Select>
                  </div>
                ) : null}
                {notice !== null ? (
                  <div className="flex flex-wrap items-center gap-2">
                    <p role="alert" className="text-sm">
                      {notice}
                    </p>
                    {canRetry ? (
                      <Button
                        type="button"
                        size="xs"
                        variant="outline"
                        onClick={() => setRetries((count) => count + 1)}
                      >
                        Try again
                      </Button>
                    ) : null}
                    {offersWholeFile && canWholeFile ? (
                      <Button
                        type="button"
                        size="xs"
                        variant="outline"
                        onClick={() => setDocumentModeFor(source)}
                      >
                        Start with the whole file
                      </Button>
                    ) : null}
                  </div>
                ) : null}
                {damagedMarkers && !importing ? (
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="text-sm">Some messages couldn't be read.</p>
                    <Button
                      type="button"
                      size="xs"
                      variant="outline"
                      disabled={!canImport}
                      onClick={runImport}
                    >
                      Import readable messages
                    </Button>
                    {canWholeFile ? (
                      <Button
                        type="button"
                        size="xs"
                        variant="outline"
                        onClick={() => setDocumentModeFor(source)}
                      >
                        Start with the whole file
                      </Button>
                    ) : null}
                  </div>
                ) : null}
              </>
            )}
            {confirmation !== null && (confirmation.interrupted || !confirmingConnected) ? (
              <p role="alert" className="text-sm">
                Lost the connection while importing. Scient will check whether the import finished
                when the connection returns.
              </p>
            ) : confirmation?.phase === "unknown" ? (
              <div className="flex flex-wrap items-center gap-2">
                <p role="alert" className="text-sm">
                  Scient couldn't tell whether the import finished.
                </p>
                <Button
                  type="button"
                  size="xs"
                  variant="outline"
                  onClick={() =>
                    setConfirmation({
                      ...confirmation,
                      phase: "sending",
                      checks: confirmation.checks + 1,
                    })
                  }
                >
                  Check again
                </Button>
              </div>
            ) : null}
            {importError?.attempt === attempt ? (
              <p role="alert" className="text-destructive text-sm">
                {importError.message}
              </p>
            ) : null}
          </div>
        </DialogPanel>
        <DialogFooter>
          <Button type="button" variant="outline" disabled={!closable} onClick={close}>
            {confirmation === null ? "Cancel" : "Close"}
          </Button>
          {file !== null && unreadable === null && (!damagedMarkers || importing) ? (
            <Button
              ref={primaryRef}
              type="button"
              disabled={!canImport}
              aria-busy={busy}
              onClick={runImport}
            >
              {busy ? <Spinner aria-hidden="true" /> : null}
              {importError?.attempt === attempt ? "Try again" : isDocument ? "Start" : "Import"}
            </Button>
          ) : null}
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

/** Where a file is chosen when the dialog opened without one. */
function ConversationFileChoice() {
  const inputRef = useRef<HTMLInputElement>(null);
  return (
    <div data-conversation-file-choice className="flex flex-col items-start gap-2">
      <p className="text-muted-foreground text-sm">
        Choose a Scient conversation (.scic) or Markdown (.md) file, or drop one here.
      </p>
      <Button type="button" size="sm" variant="outline" onClick={() => inputRef.current?.click()}>
        <FileUpIcon />
        Choose file…
      </Button>
      <input
        ref={inputRef}
        type="file"
        accept=".scic,.md"
        className="sr-only"
        tabIndex={-1}
        aria-hidden
        onChange={(event) => {
          const chosen = event.currentTarget.files?.[0];
          event.currentTarget.value = "";
          if (chosen) replaceConversationImportSource({ _tag: "browser-file", file: chosen });
        }}
      />
    </div>
  );
}
