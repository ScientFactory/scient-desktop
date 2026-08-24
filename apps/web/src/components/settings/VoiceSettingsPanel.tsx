import { CheckIcon, DownloadIcon, Mic2Icon, RefreshCwIcon, Trash2Icon } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { VoiceModelId, VoiceModelSummary, VoiceModelsSnapshot } from "@t3tools/contracts";

import { describeVoiceError } from "../../scient/voice/voiceErrorPresentation";
import { getVoiceBridge } from "../../scient/voice/voiceClient";
import { Badge } from "../ui/badge";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Button } from "../ui/button";
import { SettingsPageContainer, SettingsSection } from "./settingsLayout";

function formatBytes(bytes: number): string {
  const mib = bytes / 1024 / 1024;
  return `~${Math.round(mib)} MiB`;
}

export function voiceModelProgressPercent(model: VoiceModelSummary): number {
  if (model.state.state !== "downloading" || model.state.totalBytes <= 0) return 0;
  return Math.min(100, Math.round((model.state.downloadedBytes / model.state.totalBytes) * 100));
}

export function findVoiceReplacementModel(
  models: readonly VoiceModelSummary[],
  removedModelId: VoiceModelId,
): VoiceModelSummary | null {
  return (
    models.find((model) => model.id !== removedModelId && model.state.state === "ready") ?? null
  );
}

export function shouldSelectVoiceModelAfterDownload(
  selectedModelId: VoiceModelId | null,
  downloadedModelId: VoiceModelId,
): boolean {
  return selectedModelId === null || selectedModelId === downloadedModelId;
}

interface VoiceModelCardProps {
  readonly model: VoiceModelSummary;
  readonly runtimeAvailable: boolean;
  readonly selected: boolean;
  readonly recommended: boolean;
  readonly busy: boolean;
  readonly activeDownload: boolean;
  readonly queuedDownload: boolean;
  readonly downloadBlocked: boolean;
  readonly onDownload: (modelId: VoiceModelId) => void;
  readonly onCancel: (modelId: VoiceModelId) => void;
  readonly onCancelQueued: () => void;
  readonly onSelect: (modelId: VoiceModelId) => void;
  readonly onRemove: (model: VoiceModelSummary) => void;
}

function VoiceModelCard({
  model,
  runtimeAvailable,
  selected,
  recommended,
  busy,
  activeDownload,
  queuedDownload,
  downloadBlocked,
  onDownload,
  onCancel,
  onCancelQueued,
  onSelect,
  onRemove,
}: VoiceModelCardProps): ReactNode {
  const state = model.state;
  const progress = voiceModelProgressPercent(model);
  const downloading = state.state === "downloading" || activeDownload;
  return (
    <div className="rounded-xl border border-border/70 bg-card/50 p-4">
      <div className="min-w-0 space-y-1">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="font-medium text-sm">{model.displayName}</h3>
          {recommended ? (
            <Badge variant="info" size="sm">
              Best for this computer
            </Badge>
          ) : null}
          {selected ? (
            <Badge variant="success" size="sm">
              <CheckIcon /> In use
            </Badge>
          ) : null}
        </div>
        <p className="text-muted-foreground text-xs">{model.description}</p>
        <p className="text-muted-foreground/70 text-xs">
          Multilingual · {formatBytes(model.byteSize)}
        </p>
      </div>

      {downloading ? (
        <div className="mt-4 space-y-2">
          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <span>{state.state === "downloading" ? "Downloading…" : "Starting download…"}</span>
            <span>{progress}%</span>
          </div>
          <div
            aria-label={`Downloading ${model.displayName}`}
            aria-valuemax={100}
            aria-valuemin={0}
            aria-valuenow={progress}
            className="h-1.5 overflow-hidden rounded-full bg-muted"
            role="progressbar"
          >
            <div
              className="h-full rounded-full bg-primary transition-[width]"
              style={{ width: `${progress}%` }}
            />
          </div>
        </div>
      ) : null}

      {state.state === "missing" && state.partialBytes ? (
        <p className="mt-3 text-muted-foreground text-xs">
          Paused at {formatBytes(state.partialBytes)}.
        </p>
      ) : null}
      {state.state === "error" ? (
        <p className="mt-3 text-destructive text-xs">{state.message}</p>
      ) : null}

      <div className="mt-3 flex flex-wrap items-center gap-2">
        {queuedDownload ? (
          <>
            <span className="text-muted-foreground text-xs">Queued</span>
            <Button size="xs" variant="ghost-muted" onClick={onCancelQueued}>
              Cancel
            </Button>
          </>
        ) : downloading ? (
          <Button
            size="xs"
            variant="outline"
            disabled={!runtimeAvailable}
            onClick={() => onCancel(model.id)}
          >
            Cancel
          </Button>
        ) : state.state === "ready" ? (
          <Button
            size="xs"
            variant={selected ? "outline" : "default"}
            disabled={selected || busy || !runtimeAvailable}
            onClick={() => onSelect(model.id)}
          >
            {selected ? "In use" : "Use this model"}
          </Button>
        ) : (
          <Button
            size="xs"
            disabled={downloadBlocked || !runtimeAvailable}
            onClick={() => onDownload(model.id)}
          >
            {state.state === "error" ? <RefreshCwIcon /> : <DownloadIcon />}
            {state.state === "error"
              ? "Retry"
              : state.state === "missing" && Boolean(state.partialBytes)
                ? "Resume"
                : "Download"}
          </Button>
        )}
        {!downloading && !queuedDownload ? (
          <Button
            aria-label={`Remove ${model.displayName}`}
            size="icon-xs"
            variant="ghost"
            disabled={busy || (state.state === "missing" && !state.partialBytes)}
            onClick={() => onRemove(model)}
          >
            <Trash2Icon />
          </Button>
        ) : null}
      </div>
    </div>
  );
}

export function VoiceSettingsPanel(): ReactNode {
  const client = useMemo(() => getVoiceBridge(), []);
  const [snapshot, setSnapshot] = useState<VoiceModelsSnapshot | null>(null);
  const [busyModelId, setBusyModelId] = useState<VoiceModelId | null>(null);
  const [localDownloadModelId, setLocalDownloadModelId] = useState<VoiceModelId | null>(null);
  const [queuedDownload, setQueuedDownload] = useState<{
    readonly modelId: VoiceModelId;
    readonly selectOnSuccess: boolean;
  } | null>(null);
  const [removeTarget, setRemoveTarget] = useState<VoiceModelSummary | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const cancelledDownloadRef = useRef<VoiceModelId | null>(null);
  const localDownloadModelIdRef = useRef<VoiceModelId | null>(null);

  const refresh = useCallback(
    async (clearError = false) => {
      if (!client) return;
      try {
        setSnapshot(await client.getModelsState());
        if (clearError) setErrorMessage(null);
      } catch {
        setErrorMessage("Voice settings could not be loaded.");
      }
    },
    [client],
  );

  useEffect(() => {
    void refresh(true);
  }, [refresh]);

  useEffect(() => {
    if (!busyModelId && !snapshot?.activeDownloadModelId) return;
    const interval = window.setInterval(() => void refresh(), 500);
    return () => window.clearInterval(interval);
  }, [busyModelId, refresh, snapshot?.activeDownloadModelId]);

  const run = useCallback(
    async (modelId: VoiceModelId, operation: () => Promise<VoiceModelsSnapshot>) => {
      setBusyModelId(modelId);
      setErrorMessage(null);
      try {
        setSnapshot(await operation());
      } catch (error) {
        if (cancelledDownloadRef.current !== modelId) {
          setErrorMessage(describeVoiceError(error));
        }
      } finally {
        if (cancelledDownloadRef.current === modelId) cancelledDownloadRef.current = null;
        setBusyModelId(null);
      }
    },
    [],
  );

  const startDownload = useCallback(
    (modelId: VoiceModelId, selectOnSuccess: boolean) => {
      if (!client) return;
      cancelledDownloadRef.current = null;
      localDownloadModelIdRef.current = modelId;
      setLocalDownloadModelId(modelId);
      void run(modelId, () => client.downloadModel({ modelId, selectOnSuccess })).finally(() => {
        if (localDownloadModelIdRef.current !== modelId) return;
        localDownloadModelIdRef.current = null;
        setLocalDownloadModelId(null);
      });
    },
    [client, run],
  );

  const observedActiveDownloadModelId =
    localDownloadModelId ?? snapshot?.activeDownloadModelId ?? null;

  const handleDownload = useCallback(
    (modelId: VoiceModelId, selectOnSuccess: boolean) => {
      const activeModelId =
        localDownloadModelIdRef.current ?? snapshot?.activeDownloadModelId ?? null;
      if (activeModelId !== null && activeModelId !== modelId) {
        setQueuedDownload({ modelId, selectOnSuccess });
        return;
      }
      startDownload(modelId, selectOnSuccess);
    },
    [snapshot?.activeDownloadModelId, startDownload],
  );

  useEffect(() => {
    if (queuedDownload === null || observedActiveDownloadModelId !== null || busyModelId !== null) {
      return;
    }
    const next = queuedDownload;
    setQueuedDownload(null);
    startDownload(next.modelId, next.selectOnSuccess);
  }, [busyModelId, observedActiveDownloadModelId, queuedDownload, startDownload]);

  const handleCancel = useCallback(
    async (modelId: VoiceModelId) => {
      if (!client) return;
      cancelledDownloadRef.current = modelId;
      try {
        await client.cancelModelDownload({ modelId });
        await refresh();
      } catch (error) {
        if (cancelledDownloadRef.current === modelId) cancelledDownloadRef.current = null;
        setErrorMessage(describeVoiceError(error));
      }
    },
    [client, refresh],
  );

  const handleSelect = useCallback(
    (modelId: VoiceModelId) => {
      if (!client) return;
      void run(modelId, () => client.selectModel({ modelId }));
    },
    [client, run],
  );

  const replacementModel = useMemo(() => {
    if (!removeTarget || !snapshot || snapshot.selectedModelId !== removeTarget.id) return null;
    return findVoiceReplacementModel(snapshot.models, removeTarget.id);
  }, [removeTarget, snapshot]);

  const confirmRemove = useCallback(async () => {
    if (!client || !removeTarget) return;
    const target = removeTarget;
    setRemoveTarget(null);
    await run(target.id, async () => {
      const next = await client.removeModel({
        modelId: target.id,
        ...(replacementModel ? { replacementModelId: replacementModel.id } : {}),
      });
      return next;
    });
  }, [client, removeTarget, replacementModel, run]);

  if (!client) return null;

  return (
    <SettingsPageContainer>
      <SettingsSection title="Voice" icon={<Mic2Icon className="size-4 text-muted-foreground" />}>
        <div className="space-y-3 px-3 sm:px-4">
          <p className="text-sm text-muted-foreground">
            Voice transcription runs locally on this computer. Larger models can improve accuracy,
            but use more memory, storage, and processing power. Scient marks the best fit for this
            computer.
          </p>
          {!snapshot ? (
            <p className="text-sm text-muted-foreground">Loading voice models…</p>
          ) : null}
          {snapshot && !snapshot.runtimeAvailable ? (
            <p className="rounded-lg border border-warning/30 bg-warning/8 p-3 text-sm text-warning-foreground">
              {snapshot.runtimeMessage}
            </p>
          ) : null}
          {errorMessage ? (
            <p className="text-sm text-destructive" role="alert">
              {errorMessage}
            </p>
          ) : null}
          <div className="grid gap-x-8 gap-y-3 md:grid-cols-2">
            {snapshot?.models.map((model) => (
              <VoiceModelCard
                key={model.id}
                model={model}
                runtimeAvailable={snapshot.runtimeAvailable}
                selected={snapshot.selectedModelId === model.id}
                recommended={snapshot.recommendation?.modelId === model.id}
                busy={busyModelId !== null}
                activeDownload={observedActiveDownloadModelId === model.id}
                queuedDownload={queuedDownload?.modelId === model.id}
                downloadBlocked={
                  (busyModelId !== null && observedActiveDownloadModelId === null) ||
                  (queuedDownload !== null && queuedDownload.modelId !== model.id)
                }
                onDownload={(modelId) =>
                  handleDownload(
                    modelId,
                    shouldSelectVoiceModelAfterDownload(snapshot.selectedModelId, modelId),
                  )
                }
                onCancel={handleCancel}
                onCancelQueued={() => setQueuedDownload(null)}
                onSelect={handleSelect}
                onRemove={setRemoveTarget}
              />
            ))}
          </div>
        </div>
      </SettingsSection>

      <AlertDialog
        open={removeTarget !== null}
        onOpenChange={(open) => !open && setRemoveTarget(null)}
      >
        <AlertDialogPopup className="max-w-sm">
          <AlertDialogHeader className="gap-1.5 p-4 pb-3">
            <AlertDialogTitle className="text-base">
              Remove {removeTarget?.displayName}?
            </AlertDialogTitle>
            <AlertDialogDescription className="text-xs leading-5">
              {replacementModel
                ? `${replacementModel.displayName} will be used instead.`
                : "You can download this model again here at any time."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter className="gap-1 px-4 pb-4" variant="bare">
            <AlertDialogClose render={<Button size="sm" variant="ghost-muted" />}>
              Cancel
            </AlertDialogClose>
            <Button size="sm" variant="destructive" onClick={() => void confirmRemove()}>
              Remove model
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </SettingsPageContainer>
  );
}
