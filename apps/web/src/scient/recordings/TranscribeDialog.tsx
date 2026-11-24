import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../../components/ui/collapsible";
import { Radio, RadioGroup } from "../../components/ui/radio-group";
import { Toggle, ToggleGroup } from "../../components/ui/toggle-group";
import type { ModelSelection } from "@t3tools/contracts";
import { CorrectionModelPicker } from "./CorrectionModelPicker";
import { downloadEnvironmentSpeechModel } from "@t3tools/client-runtime/voice-input";
import { readPreparedConnection } from "../../state/session";
import { readPrimaryEnvironmentId } from "../../state/environments";
import { runEnvironmentSpeech } from "../../speech/runEnvironmentSpeech";
import { Link } from "@tanstack/react-router";
import { formatBytes } from "../../lib/formatBytes";
import { recordingTime } from "./recordingPresentation";
import { Switch } from "../../components/ui/switch";
import { useGT, useLocale } from "gt-react";
import { useId, useRef, useState } from "react";

import { Button } from "../../components/ui/button";
import {
  Dialog,
  DialogAction,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../../components/ui/dialog";
import { consentToTranscriptionEngine, transcriptionCommand } from "../../rpc/transcription";
import { Badge } from "../../components/ui/badge";
import { languageLabel } from "../../lib/languageLabel";
import { RecordingSelect } from "./RecordingSelect";
import { useRecordingRead } from "./useRecordingRead";
import { andFinally } from "../../lib/compilerSafe";

const retiringOpenAiModels = new Set([
  "whisper-1",
  "gpt-4o-transcribe",
  "gpt-4o-mini-transcribe",
  "gpt-4o-mini-transcribe-2025-12-15",
  "gpt-4o-transcribe-diarize",
]);

export function TranscribeDialog({
  project,
  projectTitle,
  source,
  title,
  previousId,
  batchSources,
  onClose,
  onStart,
}: {
  project: string;
  projectTitle?: string;
  source: string;
  title: string;
  previousId?: string;
  batchSources?: readonly string[];
  onClose: () => void;
  onStart: () => void;
}) {
  const gt = useGT();
  const locale = useLocale();
  const formId = useId();
  const focusedPrimary = useRef(false);
  const focusPrimary = (button: HTMLButtonElement | null) => {
    if (button && !button.disabled && !focusedPrimary.current) {
      focusedPrimary.current = true;
      button.focus();
    }
  };
  const [language, setLanguage] = useState("auto");
  const [engineId, setEngineId] = useState("");
  const [correction, setCorrection] = useState<"off" | "quick" | "thorough">("quick");
  const [wordsEnabled, setWordsEnabled] = useState(true);
  const [correctionModel, setCorrectionModel] = useState<ModelSelection>();
  const [subtitleOverride, setSubtitleMode] = useState<"transcribe" | "subtitles" | "both">();
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);
  const [download, setDownload] = useState<string>();
  const [downloadError, setDownloadError] = useState(false);
  const [inventoryRefresh, setInventoryRefresh] = useState(0);
  const sample = useRecordingRead(batchSources ? "" : source, (signal) =>
    transcriptionCommand("sample-language", project, { source }, signal),
  );
  const sampling = !batchSources && !sample.data && !sample.isError;
  const detected = sample.data?.detectedLanguage;
  const effectiveLanguage = language === "auto" && detected ? detected : language;
  const inventory = useRecordingRead(
    sampling && language === "auto" ? "" : effectiveLanguage,
    (signal) =>
      transcriptionCommand(
        "inventory",
        project,
        { language: effectiveLanguage, details: true },
        signal,
      ),
    download ? 1500 : undefined,
    inventoryRefresh,
  );
  const discovery = useRecordingRead(batchSources ? "" : source, (signal) =>
    transcriptionCommand("discover-subtitles", project, { source }, signal),
  );
  const track = discovery.data?.tracks.find((entry) => entry.supported);
  const sidecar = discovery.data?.sidecars[0];
  const subtitles = track ? { stream: track.stream } : sidecar ? { file: sidecar.file } : undefined;
  const recommended = inventory.data?.recommendations[effectiveLanguage];
  const engines = [
    ...(inventory.data?.local ?? [])
      .filter(({ installed }) => installed)
      .toSorted(
        (left, right) => Number(right.id === recommended?.id) - Number(left.id === recommended?.id),
      )
      .map((model) => ({
        id: model.id,
        model: model.id,
        engine: "local" as const,
        title: model.name,
        destination: gt("Runs on this computer"),
        speed: model.secondsPer30s.accelerated,
        grade: model.grade,
        size: model.size,
        accuracy: model.accuracy,
        timing: /parakeet/i.test(model.id)
          ? gt("Tap any word to seek")
          : gt("Tap a sentence to seek"),
      })),
    ...(inventory.data?.chatgpt.signedIn
      ? [
          {
            id: "chatgpt",
            model: "chatgpt",
            engine: "chatgpt" as const,
            title: gt("ChatGPT"),
            destination: gt("Uses your ChatGPT sign-in"),
          },
        ]
      : []),
    ...(inventory.data?.cloud ?? []).map(
      ({ id, provider, model, accountName, origin, audioHourUsd }) => ({
        id,
        model,
        engine: "cloud" as const,
        title: model,
        retiresInFebruary: retiringOpenAiModels.has(model.replace(/^openai\//, "")),
        audioHourUsd,
        retention:
          provider === "openrouter"
            ? gt("Scient requests zero data retention.")
            : gt("Retention follows your provider account."),
        destination: gt("Uses your {destination} key", {
          destination:
            provider === "compatible"
              ? origin && URL.canParse(origin)
                ? new URL(origin).host
                : accountName?.trim() || gt("your configured endpoint")
              : origin && URL.canParse(origin)
                ? new URL(origin).host
                : accountName?.trim() || provider,
        }),
      }),
    ),
  ];
  const engine =
    engines.find(({ id }) => id === engineId) ??
    engines.find(({ id }) => id === recommended?.id) ??
    engines[0];
  const sampleModel =
    inventory.data?.local.find(
      (model) =>
        model.installed && model.id === recommended?.id && (model.languages?.length ?? 2) > 1,
    )?.id ??
    inventory.data?.local.find((model) => model.installed && (model.languages?.length ?? 2) > 1)
      ?.id;
  const assessmentKey = subtitles && sampleModel ? JSON.stringify([subtitles, sampleModel]) : "";
  const assessment = useRecordingRead(assessmentKey, (signal) =>
    transcriptionCommand(
      "assess-subtitles",
      project,
      { source, model: sampleModel!, subtitles: subtitles! },
      signal,
    ),
  );
  const choice = assessment.data?.assessment.quality?.recommendation;
  const subtitleMode =
    subtitleOverride ??
    (choice === "use-subtitles"
      ? "subtitles"
      : choice === "both" && engine?.engine === "local"
        ? "both"
        : "transcribe");
  const checking = sampling || (!!assessmentKey && !assessment.data && !assessment.isError);
  const both = subtitleMode === "both" && engine?.engine === "local" && subtitles !== undefined;
  const mediaUnavailable = inventory.data?.mediaAvailable === false;
  const canStart =
    !mediaUnavailable &&
    (subtitleMode === "subtitles" ? subtitles !== undefined : engine !== undefined);
  const quality = assessment.data?.assessment.quality;
  const subtitleLanguage = quality?.audioLanguage;
  const timingOffset = assessment.data?.assessment.correction?.offset;
  const displayLanguage =
    language === "auto" ? (detected ?? subtitleLanguage ?? language) : language;
  const recommendedModel = inventory.data?.local.find(({ id }) => id === recommended?.id);
  const recommendedBenchmark = recommendedModel?.accuracy?.[displayLanguage];

  const estimate = useRecordingRead(
    correction === "thorough" && !batchSources && subtitleMode !== "subtitles"
      ? JSON.stringify([source, previousId, effectiveLanguage, wordsEnabled, correctionModel])
      : "",
    (signal) =>
      transcriptionCommand(
        "correction-estimate",
        project,
        {
          source,
          language: effectiveLanguage,
          mode: "thorough",
          useWords: wordsEnabled,
          ...(previousId ? { resume: previousId } : {}),
          ...(correctionModel ? { correctionModel } : {}),
        },
        signal,
      ),
  );
  const vocabulary = useRecordingRead(project, (signal) =>
    Promise.all([
      transcriptionCommand("words-list", project, { level: "global" }, signal),
      transcriptionCommand("words-list", project, { level: "project" }, signal),
      ...(previousId
        ? [
            transcriptionCommand(
              "words-list",
              project,
              { level: "recording", id: previousId },
              signal,
            ),
          ]
        : []),
    ]),
  );
  const needsEstimate = correction === "thorough" && subtitleMode !== "subtitles";
  const duration = discovery.data?.duration;
  const estimatedSeconds =
    engine?.engine === "local" && engine.speed != null && duration
      ? (engine.speed * duration) / 30
      : undefined;
  const usd = new Intl.NumberFormat(locale, { style: "currency", currency: "USD" });
  const unknownCost = gt("Cost unknown for this provider");
  const audioCost = (rate: number | undefined) => {
    if (rate === undefined) return unknownCost;
    const perHour = gt("{cost} per audio hour", { cost: usd.format(rate) });
    return duration && Number.isFinite(duration) && duration > 0
      ? `${perHour} · ${gt("About {cost} for this recording", { cost: usd.format((rate * duration) / 3600) })}`
      : perHour;
  };
  const selectedCost =
    engine?.engine === "local"
      ? gt("No provider charge")
      : engine?.engine === "cloud"
        ? audioCost(engine.audioHourUsd)
        : undefined;
  const downloadModel = async (id: string) => {
    const environmentId = readPrimaryEnvironmentId();
    const prepared = environmentId && readPreparedConnection(environmentId);
    setDownloadError(false);
    if (!prepared) {
      setDownloadError(true);
      return;
    }
    setDownload(id);
    await andFinally(
      async () => {
        try {
          await runEnvironmentSpeech(downloadEnvironmentSpeechModel(prepared, id));
          setInventoryRefresh((refresh) => refresh + 1);
        } catch {
          setDownloadError(true);
        }
      },
      () => {
        setDownload(undefined);
      },
    );
  };
  const start = async () => {
    if (!canStart || pending || checking || (needsEstimate && !estimate.data?.estimateId)) return;
    setPending(true);
    setFailed(false);
    await andFinally(
      async () => {
        try {
          if (subtitleMode === "subtitles" && subtitles) {
            await transcriptionCommand("use-subtitles", project, { source, subtitles });
          } else if (engine) {
            if (engine.engine === "cloud") await consentToTranscriptionEngine(engine.id);
            if (batchSources) {
              await transcriptionCommand("start-batch", project, {
                source,
                sources: batchSources,
                language: effectiveLanguage,
                engine: engine.engine,
                model: engine.model,
                ...(engine.engine === "cloud" ? { cloudEngineId: engine.id } : {}),
                ...(correction === "off" ? { mode: "off" } : {}),
                ...(wordsEnabled ? {} : { useWords: false }),
                ...(correction !== "off" && correctionModel ? { correctionModel } : {}),
              });
            } else {
              await transcriptionCommand("start", project, {
                source,
                ...(previousId ? { resume: previousId, revisionMode: "rerun" } : {}),
                language: effectiveLanguage,
                engine: engine.engine,
                model: engine.model,
                ...(engine.engine === "cloud" ? { cloudEngineId: engine.id } : {}),
                ...(correction === "quick" ? {} : { mode: correction }),
                ...(needsEstimate && estimate.data?.estimateId
                  ? { estimateId: estimate.data.estimateId }
                  : {}),
                ...(wordsEnabled ? {} : { useWords: false }),
                ...(correction !== "off" && correctionModel ? { correctionModel } : {}),
                ...(both ? { subtitles, subtitleMode: "both" } : {}),
              });
            }
          }
          onStart();
        } catch {
          setFailed(true);
        }
      },
      () => {
        setPending(false);
      },
    );
  };
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !pending) onClose();
      }}
    >
      <DialogPopup className="max-w-[630px]!">
        <DialogHeader>
          <DialogTitle>{gt("Transcribe {title}", { title })}</DialogTitle>
          <DialogDescription>
            {[
              projectTitle,
              duration && Number.isFinite(duration) ? recordingTime(duration) : undefined,
            ]
              .filter(Boolean)
              .join(" · ")}
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <form
            id={formId}
            className="space-y-2.5"
            onSubmit={(event) => {
              event.preventDefault();
              void start();
            }}
          >
            <div className="flex items-center justify-between gap-2 text-sm">
              <span>{gt("Language")}</span>
              <RecordingSelect
                label={gt("Language")}
                variant="outline"
                value={language}
                options={[
                  {
                    value: "auto",
                    label: detected
                      ? gt("{language} (detected)", { language: languageLabel(detected, locale) })
                      : gt("Detect automatically"),
                  },
                  ...["en", "he", "ar"].map((value) => ({
                    value,
                    label: languageLabel(value, locale),
                  })),
                ]}
                onChange={(value) => {
                  setLanguage(value);
                  setEngineId("");
                  setSubtitleMode(undefined);
                }}
              />
            </div>
            {recommended &&
              subtitleMode !== "subtitles" &&
              (!engineId || engineId === recommended.id) && (
                <div className="rounded-lg bg-muted px-3 py-2 text-xs">
                  <Collapsible>
                    <CollapsibleTrigger className="text-start font-medium">
                      {gt("Recommended for {language}: {model}", {
                        language:
                          displayLanguage === "auto"
                            ? gt("automatic language detection")
                            : languageLabel(displayLanguage, locale),
                        model: recommendedModel?.name ?? recommended.id,
                      })}{" "}
                      · {gt("Why?")}
                    </CollapsibleTrigger>
                    <CollapsiblePanel>
                      <p className="mt-2 text-muted-foreground">
                        {recommendedBenchmark
                          ? gt(
                              "Measured grade {grade} with {error}% word error in this language.",
                              {
                                grade: recommendedBenchmark.grade,
                                error: recommendedBenchmark.errorPercent,
                              },
                            )
                          : recommended.installed
                            ? gt(
                                "This model is installed and supports the selected language. See its measured speech benchmark on the engine card.",
                              )
                            : gt(
                                "Download this model to recognize this language on your computer.",
                              )}
                      </p>
                    </CollapsiblePanel>
                  </Collapsible>
                </div>
              )}
            {subtitles && (
              <div className="rounded-lg border p-2.5">
                <div className="flex items-center justify-between gap-2 text-sm">
                  <span>
                    {quality?.subtitleLanguage
                      ? gt("Subtitles · {language}", {
                          language: languageLabel(quality.subtitleLanguage, locale),
                        })
                      : gt("Subtitles")}
                  </span>
                </div>
                <RadioGroup
                  className="mt-1"
                  aria-label={gt("Subtitle source")}
                  value={subtitleMode}
                  onValueChange={(value) => setSubtitleMode(value as typeof subtitleMode)}
                >
                  {(
                    [
                      [
                        "transcribe",
                        gt("Transcribe only"),
                        gt("Turn the audio into a new transcript."),
                      ],
                      [
                        "subtitles",
                        gt("Use subtitles"),
                        gt("Read the existing text with its timings."),
                      ],
                      [
                        "both",
                        gt("Transcribe with subtitle hints"),
                        gt("Transcribe the audio with names and terms from subtitles."),
                      ],
                    ] as const
                  ).map(([value, label, description]) => (
                    <label
                      key={value}
                      className="flex items-start gap-2 rounded-md px-2 py-1 has-data-checked:bg-muted"
                    >
                      <Radio
                        value={value}
                        aria-label={label}
                        disabled={value === "both" && engine?.engine !== "local"}
                      />
                      <span className="text-sm">
                        {label}
                        <span className="block text-xs text-muted-foreground">{description}</span>
                      </span>
                    </label>
                  ))}
                </RadioGroup>
                {quality?.coverage != null && (
                  <p className="mt-2 text-xs text-muted-foreground">
                    {gt("Speech coverage {percent}%", {
                      percent: Math.round(100 * quality.coverage),
                    })}
                    {quality.wordErrorRate != null &&
                      ` · ${gt("Spot-check word error {percent}%", { percent: Math.round(100 * quality.wordErrorRate) })}`}
                  </p>
                )}
                {timingOffset !== undefined && timingOffset !== 0 && (
                  <p className="mt-2 text-xs text-muted-foreground">
                    {gt("Timing offset {seconds} s", {
                      seconds: Math.round(timingOffset * 10) / 10,
                    })}
                  </p>
                )}
                <p className="mt-2 text-xs text-muted-foreground">
                  {checking
                    ? gt("Checking subtitles against the audio…")
                    : choice === "use-subtitles"
                      ? gt("The sampled subtitles closely match the audio.")
                      : choice === "both"
                        ? gt("The subtitles can help with names and terms.")
                        : choice === "transcribe-only"
                          ? gt("The quality check favors transcribing from the audio.")
                          : gt("Subtitle quality could not be checked.")}
                </p>
              </div>
            )}
            {subtitleMode !== "subtitles" && (
              <section className="space-y-1.5">
                <h3 id={`${formId}-engines`} className="text-sm font-medium">
                  {gt("Engine")}
                </h3>
                {!inventory.data && !inventory.isError && (
                  <p role="status" className="text-xs text-muted-foreground">
                    {gt("Checking available engines…")}
                  </p>
                )}
                <RadioGroup
                  aria-labelledby={`${formId}-engines`}
                  value={engine?.id ?? ""}
                  onValueChange={(value) => {
                    const next = engines.find(({ id }) => id === value);
                    if (!next) return;
                    setEngineId(next.id);
                    if (next.engine !== "local" && subtitleMode === "both")
                      setSubtitleMode("transcribe");
                  }}
                >
                  {(() => {
                    const sorted = engines.toSorted(
                      (left, right) =>
                        Number(right.id === recommended?.id) - Number(left.id === recommended?.id),
                    );
                    const visible = [
                      sorted[0],
                      engine,
                      sorted.find((option) => option.engine === "cloud"),
                      ...sorted,
                    ]
                      .filter((option): option is (typeof engines)[number] => option !== undefined)
                      .filter(
                        (option, index, all) =>
                          all.findIndex(({ id }) => id === option.id) === index,
                      )
                      .slice(0, 3);
                    const hidden = sorted.filter(
                      (option) => !visible.some(({ id }) => id === option.id),
                    );
                    const card = (option: (typeof engines)[number]) => {
                      const measured =
                        option.engine === "local" ? option.accuracy?.[displayLanguage] : undefined;
                      return (
                        <label
                          key={option.id}
                          className="flex cursor-pointer items-start gap-3 rounded-lg border bg-card px-3 py-2 has-data-checked:border-primary has-data-checked:bg-accent/40"
                        >
                          <Radio value={option.id} aria-label={option.title} />
                          <span className="flex min-w-0 flex-col gap-1 text-sm">
                            <span className="flex flex-wrap items-center gap-2 font-medium">
                              {option.title}
                              {option.id === recommended?.id && (
                                <Badge size="sm" variant="outline">
                                  {gt("Recommended")}
                                </Badge>
                              )}
                              {inventory.data?.recommendations.enFast?.id === option.id && (
                                <Badge size="sm" variant="outline">
                                  {gt("Faster")}
                                </Badge>
                              )}
                              {option.engine === "local" && (measured?.grade ?? option.grade) && (
                                <Badge size="sm" variant="secondary">
                                  {gt("Grade {grade}", {
                                    grade: measured?.grade ?? option.grade ?? "",
                                  })}
                                  {measured &&
                                    ` · ${gt("{error}% word error", { error: measured.errorPercent })}`}
                                </Badge>
                              )}
                            </span>
                            <span className="text-xs text-muted-foreground">
                              {option.destination}
                            </span>
                            {option.engine === "local" && (
                              <span className="text-xs text-muted-foreground">
                                {option.timing}
                                {option.size !== undefined && ` · ${formatBytes(option.size)}`}
                                {option.speed != null &&
                                  (duration
                                    ? ` · ${gt("About {time} for this recording", { time: recordingTime((option.speed * duration) / 30) })}`
                                    : ` · ${gt("About {time} for 90 min", { time: recordingTime(option.speed * 180) })}`)}
                              </span>
                            )}
                            {option.engine === "chatgpt" ? (
                              <span className="text-xs text-muted-foreground">
                                {gt("Tap a sentence to seek")}
                              </span>
                            ) : option.engine === "cloud" ? (
                              <span className="text-xs text-muted-foreground">
                                {audioCost(option.audioHourUsd)} · {option.retention}
                                {option.retiresInFebruary && (
                                  <span className="block">{gt("Retiring Feb 2027")}</span>
                                )}
                              </span>
                            ) : null}
                          </span>
                        </label>
                      );
                    };
                    return (
                      <>
                        {visible.map(card)}
                        {inventory.data && (
                          <div className="rounded-lg border px-3 py-1.5">
                            <Collapsible>
                              <CollapsibleTrigger className="text-sm font-medium">
                                {gt("More engines")}
                              </CollapsibleTrigger>
                              <CollapsiblePanel>
                                <div className="space-y-2 pt-2">
                                  {hidden.map(card)}
                                  {inventory.data && !inventory.data.chatgpt.signedIn && (
                                    <div className="flex items-center justify-between rounded-lg border p-2.5 text-sm">
                                      <span>{gt("ChatGPT")}</span>
                                      <Link to="/settings/providers" className="text-primary">
                                        {gt("Sign in")}
                                      </Link>
                                    </div>
                                  )}
                                  <Link
                                    to="/settings/accounts"
                                    className="block text-sm text-primary"
                                  >
                                    {gt("Add an account for a cloud engine")}
                                  </Link>
                                  {inventory.data?.local.some(({ installed }) => !installed) && (
                                    <ul className="mt-2 space-y-1 text-muted-foreground">
                                      {inventory.data.local
                                        .filter(({ installed }) => !installed)
                                        .map((model) => (
                                          <li
                                            key={model.id}
                                            className="flex items-center justify-between gap-2"
                                          >
                                            <span>
                                              {model.name}
                                              {model.size !== undefined &&
                                                ` · ${formatBytes(model.size)}`}
                                            </span>
                                            <Button
                                              size="xs"
                                              variant="outline"
                                              type="button"
                                              disabled={!!download}
                                              onClick={() => void downloadModel(model.id)}
                                            >
                                              {download === model.id
                                                ? gt("Downloading…")
                                                : gt("Download")}
                                            </Button>
                                          </li>
                                        ))}
                                    </ul>
                                  )}
                                </div>
                              </CollapsiblePanel>
                            </Collapsible>
                          </div>
                        )}
                      </>
                    );
                  })()}
                </RadioGroup>
              </section>
            )}
            {subtitleMode !== "subtitles" && (
              <fieldset className="space-y-1 border-t pt-3">
                <div className="flex items-center justify-between gap-2">
                  <legend className="float-left text-sm font-medium">{gt("Correction")}</legend>
                  <ToggleGroup
                    variant="segmented"
                    value={[correction]}
                    onValueChange={(value) => {
                      if (value[0] === "off" || value[0] === "quick" || value[0] === "thorough")
                        setCorrection(value[0]);
                    }}
                  >
                    {(
                      [
                        ["off", gt("Off")],
                        ["quick", gt("Quick")],
                        ["thorough", gt("Thorough")],
                      ] as const
                    ).map(([value, label]) => (
                      <Toggle
                        key={value}
                        value={value}
                        disabled={value === "thorough" && !!batchSources}
                      >
                        {label}
                      </Toggle>
                    ))}
                  </ToggleGroup>
                </div>
                <p className="text-xs text-muted-foreground">
                  {correction === "off"
                    ? gt("Keep the transcript as recognized.")
                    : correction === "quick"
                      ? gt("Fixes spelling and unclear spots. Keeps the original wording.")
                      : gt("Also checks names, numbers and unclear audio.")}
                </p>
                {correction !== "off" && (
                  <CorrectionModelPicker
                    selection={correctionModel}
                    onChange={setCorrectionModel}
                  />
                )}
                {needsEstimate && (
                  <p role="status" className="text-xs text-muted-foreground">
                    {estimate.data?.estimate
                      ? gt("Correction estimate: up to {time}", {
                          time: recordingTime(estimate.data.estimate.wallSeconds),
                        })
                      : estimate.isError || estimate.data?.unavailable
                        ? gt("Could not estimate correction.")
                        : gt("Estimating correction…")}
                  </p>
                )}
              </fieldset>
            )}
            <div className="border-t pt-3 text-sm">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="font-medium">{gt("Use Words")}</p>
                  <p className="text-xs text-muted-foreground">
                    {vocabulary.data
                      ? gt("{count} saved words help with names and terms.", {
                          count: vocabulary.data
                            .slice(0, previousId ? 3 : 2)
                            .reduce((total, words) => total + words.length, 0),
                        })
                      : vocabulary.isError
                        ? gt("Could not load Words")
                        : gt("Loading Words…")}{" "}
                    <Link to="/settings/transcription" className="text-foreground underline">
                      {gt("Edit Words")}
                    </Link>
                  </p>
                </div>
                <Switch
                  aria-label={gt("Use Words")}
                  checked={wordsEnabled}
                  onCheckedChange={setWordsEnabled}
                />
              </div>
              {vocabulary.data?.some((words) => words.length) ? (
                <Collapsible>
                  <CollapsibleTrigger className="mt-1 text-xs text-muted-foreground hover:text-foreground">
                    {gt("Show saved words")}
                  </CollapsibleTrigger>
                  <CollapsiblePanel>
                    <dl className="mt-2 space-y-2 text-xs">
                      {([gt("Personal"), gt("Project"), gt("Recording")] as const)
                        .slice(0, previousId ? 3 : 2)
                        .map((scope, index) => (
                          <div key={scope}>
                            <dt className="font-medium">{scope}</dt>
                            <dd className="max-h-24 overflow-auto break-words text-muted-foreground">
                              {vocabulary.data?.[index]
                                ?.map((word) => word.preferred ?? word.term)
                                .join(", ") || gt("No saved words")}
                            </dd>
                          </div>
                        ))}
                    </dl>
                  </CollapsiblePanel>
                </Collapsible>
              ) : null}
            </div>
            {downloadError && (
              <p role="status" className="text-sm">
                {gt("Could not download the model.")}
              </p>
            )}
            {inventory.isError && <p role="status">{gt("Could not load available engines")}</p>}
            {mediaUnavailable && (
              <p role="status" className="text-sm">
                {gt(
                  "Install FFmpeg on the computer running the Scient server, then reopen this dialog.",
                )}
              </p>
            )}
            {failed && (
              <p role="status">
                {gt("Could not start transcription. Check the engine and try again.")}
              </p>
            )}
          </form>
        </DialogPanel>
        <DialogFooter className="flex-col!">
          <p aria-live="polite" className="w-full text-xs text-muted-foreground">
            {subtitleMode === "subtitles"
              ? gt("Use the existing subtitles")
              : engine &&
                [
                  engine.title,
                  estimatedSeconds === undefined
                    ? undefined
                    : gt("About {time}", { time: recordingTime(estimatedSeconds) }),
                  selectedCost,
                  engine.destination,
                ]
                  .filter(Boolean)
                  .join(" · ")}
          </p>
          <div className="flex w-full justify-end gap-2">
            <Button type="button" variant="outline" onClick={onClose} disabled={pending}>
              {gt("Cancel")}
            </Button>
            <DialogAction
              ref={
                canStart && !checking && (!needsEstimate || estimate.data?.estimateId)
                  ? focusPrimary
                  : undefined
              }
              type="submit"
              form={formId}
              disabled={
                !canStart || pending || checking || (needsEstimate && !estimate.data?.estimateId)
              }
            >
              {subtitleMode === "subtitles" ? gt("Use subtitles") : gt("Transcribe")}
            </DialogAction>
          </div>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
