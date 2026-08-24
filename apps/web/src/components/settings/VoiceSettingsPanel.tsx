import { CheckIcon, DownloadIcon, Mic2Icon, RefreshCwIcon, Trash2Icon } from "lucide-react";
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import type { VoiceModelId, VoiceModelSummary, VoiceModelsSnapshot } from "@t3tools/contracts";

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

function progressPercent(model: VoiceModelSummary): number {
  if (model.state.state !== "downloading" || model.state.totalBytes <= 0) return 0;
  return Math.min(100, Math.round((model.state.downloadedBytes / model.state.totalBytes) * 100));
}

interface VoiceModelCardProps {
  readonly model: VoiceModelSummary;
  readonly runtimeAvailable: boolean;
  readonly selected: boolean;
  readonly recommended: boolean;
  readonly busy: boolean;
  readonly onDownload: (modelId: VoiceModelId, selectOnSuccess: boolean) => void;
  readonly onCancel: (modelId: VoiceModelId) => void;
  readonly onSelect: (modelId: VoiceModelId) => void;
  readonly onRemove: (model: VoiceModelSummary) => void;
}

function VoiceModelCard({
  model,
  runtimeAvailable,
  selected,
  recommended,
  busy,
  onDownload,
  onCancel,
  onSelect,
  onRemove,
}: VoiceModelCardProps): ReactNode {
  const state = model.state;
  const progress = progressPercent(model);
  return (
    <div className="rounded-xl border border-border/70 bg-card/50 p-4">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="font-medium text-sm">{model.displayName}</h3>
            {recommended ? (
              <Badge variant="info" size="sm">
                Recommended
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
        {state.state === "ready" ? <CheckIcon className="size-4 shrink-0 text-success" /> : null}
      </div>

      {state.state === "downloading" ? (
        <div className="mt-4 space-y-2">
          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <span>Downloading…</span>
            <span>{progress}%</span>
          </div>
          <div className="h-1.5 overflow-hidden rounded-full bg-muted">
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

      <div className="mt-4 flex flex-wrap items-center gap-2">
        {state.state === "downloading" ? (
          <Button size="xs" variant="outline" disabled={busy} onClick={() => onCancel(model.id)}>
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
            disabled={busy || !runtimeAvailable}
            onClick={() => onDownload(model.id, selected || recommended)}
          >
            {state.state === "error" ? <RefreshCwIcon /> : <DownloadIcon />}
            {state.state === "error"
              ? "Retry"
              : state.state === "missing" && Boolean(state.partialBytes)
                ? "Resume"
                : "Download"}
          </Button>
        )}
        {state.state !== "downloading" ? (
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
  const [removeTarget, setRemoveTarget] = useState<VoiceModelSummary | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!client) return;
    try {
      setSnapshot(await client.getModelsState());
      setErrorMessage(null);
    } catch {
      setErrorMessage("Voice settings could not be loaded.");
    }
  }, [client]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (!snapshot?.activeDownloadModelId) return;
    const interval = window.setInterval(() => void refresh(), 500);
    return () => window.clearInterval(interval);
  }, [refresh, snapshot?.activeDownloadModelId]);

  const run = useCallback(
    async (modelId: VoiceModelId, operation: () => Promise<VoiceModelsSnapshot>) => {
      setBusyModelId(modelId);
      setErrorMessage(null);
      try {
        setSnapshot(await operation());
      } catch (error) {
        setErrorMessage(error instanceof Error ? error.message : "Voice model operation failed.");
      } finally {
        setBusyModelId(null);
      }
    },
    [],
  );

  const handleDownload = useCallback(
    (modelId: VoiceModelId, selectOnSuccess: boolean) => {
      if (!client) return;
      void run(modelId, () => client.downloadModel({ modelId, selectOnSuccess }));
    },
    [client, run],
  );

  const handleCancel = useCallback(
    async (modelId: VoiceModelId) => {
      if (!client) return;
      setBusyModelId(modelId);
      try {
        await client.cancelModelDownload({ modelId });
        await refresh();
      } finally {
        setBusyModelId(null);
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
    return (
      snapshot.models.find(
        (model) => model.id !== removeTarget.id && model.state.state === "ready",
      ) ?? null
    );
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
          <p className="max-w-2xl text-sm text-muted-foreground">
            Voice transcription runs locally on this computer. Choose the model that best fits your
            balance of speed and accuracy.
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
          <div className="grid gap-3 sm:grid-cols-2">
            {snapshot?.models.map((model) => (
              <VoiceModelCard
                key={model.id}
                model={model}
                runtimeAvailable={snapshot.runtimeAvailable}
                selected={snapshot.selectedModelId === model.id}
                recommended={snapshot.recommendation?.modelId === model.id}
                busy={busyModelId === model.id || busyModelId !== null}
                onDownload={handleDownload}
                onCancel={handleCancel}
                onSelect={handleSelect}
                onRemove={setRemoveTarget}
              />
            ))}
          </div>
          {snapshot ? (
            <p className="text-xs text-muted-foreground/70">
              The recommendation is based on local device capabilities and can always be changed
              here.
            </p>
          ) : null}
        </div>
      </SettingsSection>

      <AlertDialog
        open={removeTarget !== null}
        onOpenChange={(open) => !open && setRemoveTarget(null)}
      >
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove {removeTarget?.displayName}?</AlertDialogTitle>
            <AlertDialogDescription>
              {replacementModel
                ? `${replacementModel.displayName} will become the active voice model.`
                : "Voice setup will be required before dictation can be used again."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" />}>Cancel</AlertDialogClose>
            <Button variant="destructive" onClick={() => void confirmRemove()}>
              Remove model
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </SettingsPageContainer>
  );
}
