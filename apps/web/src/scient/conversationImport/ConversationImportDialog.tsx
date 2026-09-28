import type {
  ConversationImportId,
  EnvironmentId,
  ScientConversationImportPreview,
} from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { FileUpIcon, ImportIcon } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState, type DragEvent } from "react";

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
import { cn } from "../../lib/utils";
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
  desktopUploadOutcome,
  importEnvironmentOptions,
  importFailureMessage,
  importFileProblem,
  importModelGroups,
  importRuntimeModeNote,
  isAbort,
  modelDisplayName,
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
  | { readonly _tag: "failed"; readonly message: string };

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
        primaryEnvironmentId,
      }),
    [configs, environments, primaryEnvironmentId],
  );
  // The destination is fixed once a file is sent there, or once the person
  // picks one. Until then the first option (this device) is used. A fixed
  // destination that disappears stops the import; the file is never sent
  // to a destination nobody chose.
  const [destination, setDestination] = useState<EnvironmentId | null>(null);
  const destinationAvailable = environmentOptions.some(
    (option) => option.environmentId === destination,
  );
  const destinationLost = destination !== null && !destinationAvailable;
  const environmentId =
    destination === null
      ? (environmentOptions[0]?.environmentId ?? null)
      : destinationAvailable
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

  const file = sourceFile(source);
  const fileProblem = file === null ? null : importFileProblem(file.name, file.sizeBytes);
  // "Start with the whole file" re-stages this same Markdown file as a document.
  const [documentModeFor, setDocumentModeFor] = useState<ConversationImportSource | null>(null);
  const markdownMode: "document" | undefined = documentModeFor === source ? "document" : undefined;
  const [retries, setRetries] = useState(0);
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
  const [importing, setImporting] = useState(false);
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
    const staged: StagedAttempt = { environmentId, importId: null };
    stagedRef.current = staged;
    const stopped = () => controller.signal.aborted;
    const setStage = (stage: Stage) => setProgress({ attempt, stage });
    // Set while the desktop streams this attempt's file; a cancel stops it first.
    let desktopToken: string | null = null;
    const release = () => {
      const importId = staged.importId;
      staged.importId = null;
      if (importId === null) return;
      const token = desktopToken;
      desktopToken = null;
      const stopDesktop =
        token === null
          ? Promise.resolve()
          : Promise.resolve(window.desktopBridge?.cancelOpenedConversationFileUpload?.({ token }));
      void stopDesktop
        .catch(() => undefined)
        .then(() => cancelConversationImport(staged.environmentId, importId))
        .catch(() => undefined);
    };
    const { name, sizeBytes } = sourceFile(source)!;
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
            desktopToken = source.file.token;
            return window.desktopBridge?.uploadOpenedConversationFile?.({
              token: source.file.token,
              url: upload.url,
            });
          });
          desktopUploadRef.current = sending.catch(() => undefined);
          const result = await sending;
          desktopToken = null;
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
        const preview = await previewConversationImport(environmentId, upload.importId);
        if (!stopped()) setStage({ _tag: "ready", preview });
      } catch (cause) {
        if (stopped() || isAbort(cause)) return;
        release();
        setStage({
          _tag: "failed",
          message: importFailureMessage(cause, "This file couldn't be checked. Try again."),
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

  const close = () => {
    if (importing) return;
    dismissConversationImportRequest();
  };

  const runImport = async () => {
    const staged = stagedRef.current;
    if (!canImport || staged?.importId == null) return;
    setImporting(true);
    setConversationImportReplaceable(false);
    setImportError(null);
    let result: Awaited<ReturnType<typeof confirmConversationImport>>;
    try {
      result = await confirmConversationImport(staged.environmentId, {
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
      });
    } catch (cause) {
      setImportError({
        attempt,
        message: importFailureMessage(cause, "The conversation couldn't be imported. Try again."),
      });
      setImporting(false);
      setConversationImportReplaceable(true);
      return;
    }
    staged.importId = null;
    dismissConversationImportRequest();
    toastManager.add({
      type: "success",
      title: isDocument ? "Conversation started" : "Conversation imported",
      description: `Your next message continues it with ${selectedModel.name}.`,
    });
    await navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams({
        environmentId: staged.environmentId,
        threadId: result.threadId,
      }),
    });
  };

  const status = fileProblem === null ? stageStatus(stage) : null;
  const failure =
    fileProblem ??
    (destinationLost
      ? "That destination is no longer available. Choose another."
      : stage._tag === "failed"
        ? stage.message
        : null);
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
            {environmentOptions.length > 1 || destinationLost ? (
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
                    if (!option || option.environmentId === environmentId) return;
                    setDestination(option.environmentId);
                    setProjectId(null);
                    setModelKey(null);
                  }}
                >
                  <SelectTrigger aria-labelledby={`${id}-environment`} className="min-w-0">
                    <SelectValue placeholder="Choose a destination" />
                  </SelectTrigger>
                  <SelectPopup>
                    {environmentOptions.map((option) => (
                      <SelectItem key={option.environmentId} value={option.environmentId}>
                        {option.label}
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
                {fileProblem === null && !destinationLost ? (
                  <Button
                    type="button"
                    size="xs"
                    variant="outline"
                    onClick={() => setRetries((count) => count + 1)}
                  >
                    Try again
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
            {importError?.attempt === attempt ? (
              <p role="alert" className="text-destructive text-sm">
                {importError.message}
              </p>
            ) : null}
          </div>
        </DialogPanel>
        <DialogFooter>
          <Button type="button" variant="outline" disabled={importing} onClick={close}>
            Cancel
          </Button>
          <Button type="button" disabled={!canImport} onClick={() => void runImport()}>
            {importing
              ? isDocument
                ? "Starting…"
                : "Importing…"
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
