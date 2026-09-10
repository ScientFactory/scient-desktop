import {
  CheckIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  DownloadIcon,
  Mic2Icon,
  RefreshCwIcon,
  Trash2Icon,
} from "lucide-react";
import { Link } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  VOICE_LANGUAGE_NAMES,
  type VoiceLanguagePreference,
  type VoiceModelId,
  type VoiceModelSummary,
  type VoiceModelsSnapshot,
} from "@t3tools/contracts";

import { describeVoiceError } from "../../scient/voice/voiceErrorPresentation";
import { getVoiceBridge } from "../../scient/voice/voiceClient";
import { Badge } from "../ui/badge";
import {
  Popover,
  PopoverDescription,
  PopoverPopup,
  PopoverTitle,
  PopoverTrigger,
} from "../ui/popover";
import { Button } from "../ui/button";
import { Switch } from "../ui/switch";
import { useClientSettings, useUpdateClientSettings } from "../../hooks/useSettings";
import { SettingsPageContainer, SettingsSection } from "./settingsLayout";

function formatBytes(bytes: number): string {
  const mib = bytes / 1024 / 1024;
  return `~${Math.round(mib)} MiB`;
}

const PRIMARY_VOICE_LANGUAGES = [
  "auto",
  "en",
  "he",
] as const satisfies ReadonlyArray<VoiceLanguagePreference>;
const MORE_VOICE_LANGUAGES = [
  "ar",
  "zh",
  "fr",
  "de",
  "it",
  "ja",
  "ko",
  "pt",
  "ru",
  "es",
] as const satisfies ReadonlyArray<VoiceLanguagePreference>;

function isPrimaryVoiceLanguage(language: VoiceLanguagePreference): boolean {
  return language === "auto" || language === "en" || language === "he";
}

function VoiceLanguagePicker({
  value,
  onChange,
}: {
  readonly value: VoiceLanguagePreference;
  readonly onChange: (language: VoiceLanguagePreference) => void;
}): ReactNode {
  const [pickerOpen, setPickerOpen] = useState(false);
  const [moreLanguagesOpen, setMoreLanguagesOpen] = useState(!isPrimaryVoiceLanguage(value));

  const selectLanguage = (language: VoiceLanguagePreference): void => {
    onChange(language);
    setPickerOpen(false);
    if (isPrimaryVoiceLanguage(language)) setMoreLanguagesOpen(false);
  };

  return (
    <div className="relative border-border/60 border-t pt-3 md:border-t-0 md:pl-8 md:pt-1 md:before:absolute md:before:top-1 md:before:left-0 md:before:h-10 md:before:w-px md:before:bg-border/60">
      <div className="flex items-center gap-1">
        <h3 className="font-medium text-sm">Language</h3>
        <Popover open={pickerOpen} onOpenChange={setPickerOpen}>
          <PopoverTrigger
            render={
              <Button
                aria-label="Choose voice language"
                className="relative top-0.5 h-6 gap-1 px-1.5"
                size="xs"
                variant="ghost-muted"
              />
            }
          >
            {VOICE_LANGUAGE_NAMES[value]}
            <ChevronDownIcon className="size-3.5 stroke-[2.5] opacity-70" />
          </PopoverTrigger>
          <PopoverPopup
            align="start"
            className="w-56 max-w-[calc(100vw-1rem)]"
            side="bottom"
            sideOffset={4}
            viewportClassName="p-1"
          >
            <div className="space-y-0.5">
              {PRIMARY_VOICE_LANGUAGES.map((language) => {
                const selected = value === language;
                return (
                  <Button
                    key={language}
                    aria-pressed={selected}
                    className={
                      selected
                        ? "h-auto w-full justify-start bg-accent/60 px-2 py-1.5 text-foreground hover:bg-accent"
                        : "h-auto w-full justify-start px-2 py-1.5 hover:bg-accent hover:text-foreground"
                    }
                    onClick={() => selectLanguage(language)}
                    variant="ghost-muted"
                  >
                    <span className="flex min-w-0 flex-1 items-center gap-2">
                      <span>{VOICE_LANGUAGE_NAMES[language]}</span>
                      {language === "auto" ? (
                        <Badge size="sm" variant="info">
                          Recommended
                        </Badge>
                      ) : null}
                    </span>
                    {selected ? <CheckIcon className="stroke-[2.5]" /> : null}
                  </Button>
                );
              })}
              <div className="mt-1 border-border/60 border-t pt-1">
                <Button
                  aria-expanded={moreLanguagesOpen}
                  className="w-full justify-start px-2 hover:bg-accent hover:text-foreground"
                  onClick={() => setMoreLanguagesOpen((open) => !open)}
                  size="xs"
                  variant="ghost-muted"
                >
                  <span className="flex-1 text-left">More languages</span>
                  <ChevronRightIcon
                    className={`size-3.5 stroke-[2.5] transition-transform ${moreLanguagesOpen ? "rotate-90" : ""}`}
                  />
                </Button>
                {moreLanguagesOpen ? (
                  <div className="mt-0.5 space-y-0.5">
                    {MORE_VOICE_LANGUAGES.map((language) => {
                      const selected = value === language;
                      return (
                        <Button
                          key={language}
                          aria-pressed={selected}
                          className={
                            selected
                              ? "w-full justify-start bg-accent/60 px-2 text-foreground hover:bg-accent"
                              : "w-full justify-start px-2 hover:bg-accent hover:text-foreground"
                          }
                          onClick={() => selectLanguage(language)}
                          size="xs"
                          variant="ghost-muted"
                        >
                          <span className="flex-1 text-left">{VOICE_LANGUAGE_NAMES[language]}</span>
                          {selected ? <CheckIcon className="stroke-[2.5]" /> : null}
                        </Button>
                      );
                    })}
                  </div>
                ) : null}
              </div>
            </div>
          </PopoverPopup>
        </Popover>
      </div>
    </div>
  );
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
  readonly removeOpen: boolean;
  readonly removeDescription: string;
  readonly onDownload: (modelId: VoiceModelId) => void;
  readonly onCancel: (modelId: VoiceModelId) => void;
  readonly onCancelQueued: () => void;
  readonly onSelect: (modelId: VoiceModelId) => void;
  readonly onRemoveOpenChange: (open: boolean) => void;
  readonly onConfirmRemove: () => void;
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
  removeOpen,
  removeDescription,
  onDownload,
  onCancel,
  onCancelQueued,
  onSelect,
  onRemoveOpenChange,
  onConfirmRemove,
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
          <Popover
            open={removeOpen}
            onOpenChange={(open) => {
              if (busy) return;
              onRemoveOpenChange(open);
            }}
          >
            <PopoverTrigger
              render={
                <Button
                  aria-label={`Remove ${model.displayName}`}
                  size="icon-xs"
                  variant="ghost"
                  disabled={busy || (state.state === "missing" && !state.partialBytes)}
                />
              }
            >
              <Trash2Icon />
            </PopoverTrigger>
            <PopoverPopup
              align="start"
              className="w-72 max-w-[calc(100vw-1rem)]"
              side="bottom"
              sideOffset={6}
              viewportClassName="p-0"
              role="alertdialog"
            >
              <div className="p-3">
                <PopoverTitle className="text-sm">Remove {model.displayName}?</PopoverTitle>
                <PopoverDescription className="mt-1 text-xs leading-5">
                  {removeDescription}
                </PopoverDescription>
                <div className="mt-3 flex justify-end gap-1.5">
                  <Button size="xs" variant="ghost" onClick={() => onRemoveOpenChange(false)}>
                    Cancel
                  </Button>
                  <Button size="xs" variant="destructive" onClick={onConfirmRemove}>
                    Remove model
                  </Button>
                </div>
              </div>
            </PopoverPopup>
          </Popover>
        ) : null}
      </div>
    </div>
  );
}

export function VoiceSettingsPanel(): ReactNode {
  const client = useMemo(() => getVoiceBridge(), []);
  const correctionEnabled = useClientSettings(
    (settings) => settings.voiceTranscriptCorrectionEnabled,
  );
  const languagePreference = useClientSettings((settings) => settings.voiceLanguagePreference);
  const updateClientSettings = useUpdateClientSettings();
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
      <SettingsSection
        title="Voice"
        icon={<Mic2Icon className="size-4 text-muted-foreground" />}
        variant="plain"
      >
        <div className="space-y-3 px-3 sm:px-4">
          <div className="grid items-start gap-y-3 md:grid-cols-[minmax(0,3fr)_minmax(0,2fr)] md:gap-y-0">
            <div className="flex items-start justify-between gap-4 py-1 md:pr-8">
              <div className="min-w-0">
                <h3 className="font-medium text-sm">Correct transcripts with an LLM</h3>
                <p className="text-xs text-muted-foreground">
                  Fix spelling and punctuation. Significantly slower.
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <Button
                  className="h-6 px-1.5"
                  render={<Link hash="text-generation-model" to="/settings/general" />}
                  size="sm"
                  variant="ghost-muted"
                >
                  Manage
                </Button>
                <Switch
                  aria-label="Correct voice transcripts with an LLM"
                  checked={correctionEnabled}
                  onCheckedChange={(checked) =>
                    updateClientSettings({ voiceTranscriptCorrectionEnabled: Boolean(checked) })
                  }
                />
              </div>
            </div>
            <VoiceLanguagePicker
              value={languagePreference}
              onChange={(language) => updateClientSettings({ voiceLanguagePreference: language })}
            />
          </div>
          <div className="border-border/60 border-t pt-3">
            <h3 className="font-medium text-sm">Voice model</h3>
            <p className="text-muted-foreground text-xs">
              Choose the balance of speed and accuracy for this computer.
            </p>
          </div>
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
                removeOpen={removeTarget?.id === model.id}
                removeDescription={
                  removeTarget?.id === model.id && replacementModel
                    ? `${replacementModel.displayName} will be used instead.`
                    : "You can download this model again here at any time."
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
                onRemoveOpenChange={(open) =>
                  setRemoveTarget((current) =>
                    open ? model : current?.id === model.id ? null : current,
                  )
                }
                onConfirmRemove={() => void confirmRemove()}
              />
            ))}
          </div>
        </div>
      </SettingsSection>
    </SettingsPageContainer>
  );
}
