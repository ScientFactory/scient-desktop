import type {
  ConversationImportId,
  EnvironmentId,
  ScientConversationImportConfirmRequest,
  ScientConversationImportPreview,
  ScientConversationImportResult,
} from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { FileUpIcon, ImportIcon } from "lucide-react";
import { useEffect, useEffectEvent, useId, useMemo, useRef, useState, type DragEvent } from "react";

import { Button } from "../../components/ui/button";
import { Checkbox } from "../../components/ui/checkbox";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../../components/ui/dialog";
import { Label } from "../../components/ui/label";
import {
  Select,
  SelectGroup,
  SelectGroupLabel,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "../../components/ui/select";
import { toastManager } from "../../components/ui/toast";
import { cn, randomUUID } from "../../lib/utils";
import { useProjects, useServerConfigs } from "../../state/entities";
import { useEnvironments, usePrimaryEnvironmentId } from "../../state/environments";
import { buildThreadRouteParams } from "../../threadRoutes";
import {
  cancelConversationImport,
  confirmConversationImport,
  createConversationImportUpload,
  previewConversationImport,
  uploadConversationFile,
} from "./client";
import { ConversationImportPreviewDetails } from "./ConversationImportPreviewDetails";
import { installConversationImportDropTarget, type ConversationFileDrag } from "./drop";
import {
  ConversationImportNotice,
  IMPORT_RUNTIME_MODE,
  defaultImportModelKey,
  unavailableDefaultModelHint,
  desktopUploadOutcome,
  importEnvironmentOptions,
  importFailureMessage,
  importFileProblem,
  importModelGroups,
  importRuntimeModeNote,
  isAbort,
  isMarkdownFileName,
  isRecordLimitRefusal,
  isConversationImportError,
  modelDisplayName,
  selectedModelName,
} from "./importDialog.logic";
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
      /** A Markdown transcript too long to import can still start a conversation as a document. */
      readonly wholeFile?: true;
    };

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
  readonly isDocument: boolean;
  /** `unknown`: the answer never arrived; the server may still have committed it. */
  readonly phase: "sending" | "unknown";
  /** The destination's connection dropped since the confirm was sent. */
  readonly interrupted: boolean;
  /** How many times the confirm has been re-sent to learn its outcome. */
  readonly checks: number;
}

function ConversationImportDialog({ source }: { readonly source: ConversationImportSource }) {
  const id = useId();
  const navigate = useNavigate();
  const projects = useProjects();
  const configs = useServerConfigs();
  const { environments } = useEnvironments();
  const primaryEnvironmentId = usePrimaryEnvironmentId();

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
  const [retries, setRetries] = useState(0);
  // The destination is fixed once a file is sent there, or once the person
  // picks one. Until then the first connected option (this device) is used.
  // The file is never sent to a destination nobody chose: one that
  // disappears stops the import, and so does losing its connection, which
  // only "Try again" resumes, even after it reconnects.
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
        ? (environmentOptions.find((option) => option.connected)?.environmentId ?? null)
        : destinationOption?.connected === true && !connectionLost
          ? destination
          : null;
  const config = environmentId === null ? undefined : configs.get(environmentId);
  const availableProjects = projects.filter((project) => project.environmentId === environmentId);
  const [chosenProjectId, setProjectId] = useState<string | null>(null);
  const project =
    availableProjects.find((candidate) => candidate.id === chosenProjectId) ??
    availableProjects[0] ??
    null;
  const modelGroups = useMemo(() => importModelGroups(config), [config]);
  const [chosenModelKey, setModelKey] = useState<string | null>(null);
  const modelKey = chosenModelKey ?? defaultImportModelKey(config, project, modelGroups);
  const selectedModel =
    modelGroups.flatMap((group) => group.models).find((model) => model.key === modelKey) ?? null;
  const runtimeModeNote = importRuntimeModeNote(config, project);
  const defaultModelHint =
    chosenModelKey === null ? unavailableDefaultModelHint(config, project, modelGroups) : null;

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
  const [acknowledgedFor, setAcknowledgedFor] = useState<typeof attempt | null>(null);
  const acknowledged = acknowledgedFor === attempt;
  const importing = confirmation !== null;
  const [importError, setImportError] = useState<{
    readonly attempt: typeof attempt;
    readonly message: string;
  } | null>(null);
  const stagedRef = useRef<StagedAttempt | null>(null);
  // The desktop streams one opened file at a time; a new attempt waits for the last.
  const desktopUploadRef = useRef<Promise<unknown>>(Promise.resolve());
  const detailsRef = useRef<HTMLDivElement>(null);

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
        setStage({
          _tag: "failed",
          message: importFailureMessage(cause, "This file couldn't be checked. Try again."),
          // The check refused a transcript for its length; the same file as a
          // document is one message. A file refused for its size is not offered.
          ...(checking &&
          source._tag === "browser-file" &&
          markdownMode === undefined &&
          isMarkdownFileName(name) &&
          isRecordLimitRefusal(cause)
            ? { wholeFile: true as const }
            : {}),
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

  // A finished check moves focus to what it found when focus is still where
  // the file came in (the dialog itself or the file zone), never away from a
  // choice the person is making.
  useEffect(() => {
    if (preview === null) return;
    const active = document.activeElement;
    const atEntry =
      active === null ||
      active === document.body ||
      active.getAttribute("role") === "dialog" ||
      active.closest("[data-conversation-file-zone]") !== null;
    if (atEntry) detailsRef.current?.focus();
  }, [preview]);

  const isDocument = preview?.kind === "document";
  const needsAcknowledgement =
    preview?.kind === "markdown" && preview.markdownIssues.length > 0 && !acknowledged;
  const canImport =
    preview !== null &&
    !importing &&
    project !== null &&
    selectedModel !== null &&
    !needsAcknowledgement;

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
    // The committed destination is the server's, which can differ from this
    // confirm's; name its model only when the environment lists it.
    const modelName = selectedModelName(
      configs.get(next.staged.environmentId),
      result.destination.modelSelection,
    );
    toastManager.add({
      type: "success",
      title: next.isDocument ? "Conversation started" : "Conversation imported",
      description:
        modelName === null
          ? "Your next message continues it."
          : `Your next message continues it with ${modelName}.`,
    });
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
        ...(preview.kind === "markdown" && preview.markdownIssues.length > 0
          ? { acknowledgeMarkdownIssues: acknowledged }
          : {}),
        destination: {
          projectId: project.id,
          modelSelection: selectedModel.selection,
          runtimeMode: IMPORT_RUNTIME_MODE,
          interactionMode: "default",
        },
      },
      isDocument,
      phase: "sending",
      interrupted: false,
      checks: 0,
    };
    setConfirmation(next);
    void askServer(next);
  };

  const status = fileProblem === null ? stageStatus(stage) : null;
  const failure =
    fileProblem ??
    (confirmation !== null
      ? null
      : destinationGone
        ? "That destination is no longer available. Choose another."
        : connectionLost
          ? "Lost the connection to that destination. Choose another or try again."
          : file !== null && environmentId === null && destination === null
            ? "No destination is connected. Reconnect one to import this file."
            : stage._tag === "failed"
              ? stage.message
              : null);
  const offersWholeFile =
    stage._tag === "failed" && stage.wholeFile === true && failure === stage.message;
  // "Try again" resends to the same destination, only once it is connected.
  // A transcript too long to import would be refused again; it gets the
  // document choice instead.
  const canRetry =
    fileProblem === null &&
    !destinationGone &&
    !offersWholeFile &&
    (connectionLost ? destinationOption?.connected === true : stage._tag === "failed");
  const environmentLabel = environmentOptions.find(
    (option) => option.environmentId === environmentId,
  )?.label;

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) close();
      }}
    >
      <DialogPopup className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {isDocument ? "Start a conversation from this document" : "Import conversation"}
          </DialogTitle>
          <DialogDescription>
            Check what's in this file. Nothing is added until you choose{" "}
            {isDocument ? "Start conversation" : "Import"}.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="flex flex-col gap-4">
            <ConversationFileZone file={file} disabled={importing} />
            {confirmation === null &&
            (environmentOptions.length > 1 || destinationGone || connectionLost) ? (
              <div className="flex flex-col gap-2">
                <span id={`${id}-environment`} className="text-sm font-medium">
                  Destination
                </span>
                <Select
                  value={environmentId ?? ""}
                  items={Object.fromEntries(
                    environmentOptions.map((option) => [option.environmentId, option.label]),
                  )}
                  disabled={importing}
                  onValueChange={(value) => {
                    const option = environmentOptions.find(
                      (candidate) => candidate.environmentId === value,
                    );
                    if (!option?.connected || option.environmentId === environmentId) return;
                    setDestination(option.environmentId);
                    setDisconnectedAt(null);
                    setProjectId(null);
                    setModelKey(null);
                  }}
                >
                  <SelectTrigger aria-labelledby={`${id}-environment`} className="min-w-0">
                    <SelectValue placeholder="Choose a destination" />
                  </SelectTrigger>
                  <SelectPopup>
                    {environmentOptions.map((option) => (
                      <SelectItem
                        key={option.environmentId}
                        value={option.environmentId}
                        disabled={!option.connected}
                      >
                        {option.connected ? option.label : `${option.label} (not connected)`}
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
              </div>
            ) : null}
            {status !== null ? (
              <p className="text-muted-foreground text-sm" role="status">
                {status}
              </p>
            ) : null}
            {failure !== null ? (
              <div className="flex flex-wrap items-center gap-2">
                <p role="alert" className="text-destructive text-sm">
                  {failure}
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
                {offersWholeFile ? (
                  <Button
                    type="button"
                    size="xs"
                    variant="outline"
                    onClick={() => setDocumentModeFor(source)}
                  >
                    Start with the whole file instead
                  </Button>
                ) : null}
              </div>
            ) : null}
            {preview !== null ? (
              <>
                <div
                  ref={detailsRef}
                  tabIndex={-1}
                  aria-label="What's in this file"
                  className="rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <ConversationImportPreviewDetails
                    preview={preview}
                    sourceModelName={
                      preview.conversation.model === null
                        ? null
                        : modelDisplayName(
                            config,
                            preview.conversation.provider,
                            preview.conversation.model,
                          )
                    }
                  />
                </div>
                {preview.markdownIssues.length > 0 ? (
                  <MarkdownIssues
                    preview={preview}
                    acknowledged={acknowledged}
                    disabled={importing}
                    onAcknowledgedChange={(checked) => setAcknowledgedFor(checked ? attempt : null)}
                    {...(source._tag === "browser-file"
                      ? { onUseWholeFile: () => setDocumentModeFor(source) }
                      : {})}
                  />
                ) : null}
                <div className="flex flex-col gap-2">
                  <span id={`${id}-project`} className="text-sm font-medium">
                    Project
                  </span>
                  <Select
                    value={project?.id ?? ""}
                    items={Object.fromEntries(
                      availableProjects.map((candidate) => [candidate.id, candidate.title]),
                    )}
                    disabled={importing || availableProjects.length === 0}
                    onValueChange={(value) => {
                      setProjectId(typeof value === "string" ? value : null);
                      setModelKey(null);
                    }}
                  >
                    <SelectTrigger aria-labelledby={`${id}-project`} className="min-w-0">
                      <SelectValue placeholder="No projects here" />
                    </SelectTrigger>
                    <SelectPopup>
                      {availableProjects.map((candidate) => (
                        <SelectItem key={candidate.id} value={candidate.id}>
                          {candidate.title}
                        </SelectItem>
                      ))}
                    </SelectPopup>
                  </Select>
                </div>
                <div className="flex flex-col gap-2">
                  <span id={`${id}-model`} className="text-sm font-medium">
                    Model for your next message
                  </span>
                  <Select
                    value={modelKey ?? ""}
                    items={Object.fromEntries(
                      modelGroups.flatMap((group) =>
                        group.models.map((model) => [model.key, `${group.label} · ${model.name}`]),
                      ),
                    )}
                    disabled={importing || modelGroups.length === 0}
                    onValueChange={(value) => setModelKey(typeof value === "string" ? value : null)}
                  >
                    <SelectTrigger aria-labelledby={`${id}-model`} className="min-w-0">
                      <SelectValue placeholder="Choose a model" />
                    </SelectTrigger>
                    <SelectPopup>
                      {modelGroups.map((group) => (
                        <SelectGroup key={group.label}>
                          <SelectGroupLabel>{group.label}</SelectGroupLabel>
                          {group.models.map((model) => (
                            <SelectItem key={model.key} value={model.key}>
                              {model.name}
                            </SelectItem>
                          ))}
                        </SelectGroup>
                      ))}
                    </SelectPopup>
                  </Select>
                  {defaultModelHint !== null ? (
                    <p className="text-muted-foreground text-xs">{defaultModelHint}</p>
                  ) : null}
                  {runtimeModeNote !== null ? (
                    <p className="text-muted-foreground text-xs">{runtimeModeNote}</p>
                  ) : null}
                </div>
                {availableProjects.length === 0 || modelGroups.length === 0 ? (
                  <p role="alert" className="text-sm">
                    {availableProjects.length === 0
                      ? `Add a project${environmentLabel ? ` on ${environmentLabel}` : ""} before importing.`
                      : `Set up a model provider${environmentLabel ? ` on ${environmentLabel}` : ""} before importing.`}
                  </p>
                ) : null}
              </>
            ) : null}
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
          <Button type="button" disabled={!canImport} onClick={runImport}>
            {importing
              ? isDocument
                ? "Starting…"
                : "Importing…"
              : importError?.attempt === attempt
                ? "Try again"
                : isDocument
                  ? "Start conversation"
                  : "Import"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

/** The chosen file, and where to drop or choose another. */
function ConversationFileZone({
  file,
  disabled,
}: {
  readonly file: { readonly name: string } | null;
  readonly disabled: boolean;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dropTarget, setDropTarget] = useState(false);
  const accept = (event: DragEvent<HTMLDivElement>) => {
    if (disabled || !event.dataTransfer.types.includes("Files")) return false;
    event.preventDefault();
    return true;
  };
  return (
    <div
      data-conversation-file-zone
      className={cn(
        "flex flex-wrap items-center justify-between gap-3 rounded-xl border border-dashed px-3 py-3 transition-colors",
        dropTarget ? "border-ring bg-accent/20" : "border-border/80 bg-muted/20",
      )}
      onDragEnter={(event) => setDropTarget(accept(event))}
      onDragOver={(event) => setDropTarget(accept(event))}
      onDragLeave={(event) => {
        if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
        setDropTarget(false);
      }}
      onDrop={(event) => {
        setDropTarget(false);
        if (!accept(event)) return;
        const dropped = event.dataTransfer.files;
        if (dropped.length === 1 && dropped[0]) {
          replaceConversationImportSource({ _tag: "browser-file", file: dropped[0] });
        }
      }}
    >
      <div className="min-w-0">
        <p className="text-sm font-medium">Conversation file</p>
        <p className="truncate text-muted-foreground text-xs">
          {file?.name ?? "Drop a Scient conversation (.scic) or Markdown (.md) file here"}
        </p>
      </div>
      <Button
        type="button"
        size="sm"
        variant="outline"
        disabled={disabled}
        onClick={() => inputRef.current?.click()}
      >
        <FileUpIcon />
        {file === null ? "Choose file" : "Choose another file"}
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

function MarkdownIssues(props: {
  readonly preview: ScientConversationImportPreview;
  readonly acknowledged: boolean;
  readonly disabled: boolean;
  readonly onAcknowledgedChange: (acknowledged: boolean) => void;
  readonly onUseWholeFile?: () => void;
}) {
  const { preview } = props;
  const hidden = preview.markdownIssues.length - 10;
  return (
    <section
      aria-label="Some messages couldn't be read"
      className="flex flex-col gap-2 rounded-md border p-3 text-sm"
      role="alert"
    >
      <p className="font-medium">Some messages couldn't be read</p>
      <p>
        Import the messages Scient could read, or start a conversation with the whole file instead.
      </p>
      <ul className="list-inside list-disc text-muted-foreground text-xs">
        {preview.markdownIssues.slice(0, 10).map((issue) => (
          <li key={`${issue.kind}-${issue.startLine}-${issue.endLine}-${issue.detail}`}>
            {issue.startLine === issue.endLine
              ? `Line ${issue.startLine}`
              : `Lines ${issue.startLine}–${issue.endLine}`}
            : {issue.detail}
          </li>
        ))}
        {hidden > 0 ? <li>{hidden === 1 ? "1 more place" : `${hidden} more places`}</li> : null}
      </ul>
      {preview.kind === "markdown" ? (
        <Label>
          <Checkbox
            checked={props.acknowledged}
            disabled={props.disabled}
            onCheckedChange={(checked) => props.onAcknowledgedChange(checked === true)}
          />
          Import only the messages Scient could read
        </Label>
      ) : null}
      {props.onUseWholeFile ? (
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={props.disabled}
          onClick={props.onUseWholeFile}
        >
          Start with the whole file instead
        </Button>
      ) : null}
    </section>
  );
}
