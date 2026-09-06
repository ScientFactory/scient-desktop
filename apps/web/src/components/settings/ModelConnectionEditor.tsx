import { useState, type ReactNode } from "react";
import {
  validateCustomModelConnection,
  customModelImageInput,
  type CustomModel,
  type CustomModelConnection,
  type CustomModelProtocol,
  type CustomModelSaveInput,
  type CustomModelsSettings,
  type ModelReasoningMetadata,
  type ProviderDriverKind,
  type ProviderInstanceId,
} from "@t3tools/contracts";
import * as Redacted from "effect/Redacted";
import { ChevronDownIcon, ChevronRightIcon } from "lucide-react";
import { cn, randomUUID } from "~/lib/utils";
import { PROVIDER_ICON_BY_PROVIDER } from "../chat/providerIconUtils";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Checkbox } from "../ui/checkbox";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";
import { Switch } from "../ui/switch";
import {
  Dialog,
  DialogPopup,
  DialogTitle,
  DialogDescription,
  DialogHeader,
  DialogPanel,
} from "../ui/dialog";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
  selectTriggerVariants,
} from "../ui/select";
import { CUSTOM_MODEL_PRESETS, CUSTOM_MODEL_PROTOCOLS, customModelPresetId } from "./customModels";

const DEFAULT_CUSTOM_MODEL_PRESET = CUSTOM_MODEL_PRESETS[0]!;
const REASONING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
type ReasoningLevel = (typeof REASONING_LEVELS)[number];
const PENDING_DETECTION = "Detected from the provider after saving.";
const NOT_DETECTED = "Not detected yet.";

/**
 * Labelled control. With `action` the label row also hosts a small text
 * button, so the wrapper becomes a div and the child must carry its own
 * `aria-label`.
 */
function Field({
  label,
  action,
  children,
}: {
  label: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  if (action)
    return (
      <div className="flex min-w-0 flex-col gap-1.5">
        <span className="flex items-center justify-between gap-2 text-sm/4 font-medium text-foreground">
          {label}
          {action}
        </span>
        {children}
      </div>
    );
  return (
    <label className="flex min-w-0 flex-col gap-1.5">
      <span className="text-sm/4 font-medium text-foreground">{label}</span>
      {children}
    </label>
  );
}

function FieldAction({ children, onClick }: { children: ReactNode; onClick: () => void }) {
  return (
    <button
      type="button"
      className="rounded-sm text-xs font-normal text-muted-foreground underline-offset-2 outline-none hover:text-foreground hover:underline focus-visible:ring-1 focus-visible:ring-ring"
      onClick={onClick}
    >
      {children}
    </button>
  );
}

/** Settings-style row: label and detected values on the left, a compact selector on the right. */
function Row({
  label,
  description,
  control,
  children,
}: {
  label: string;
  description?: string | undefined;
  control: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0 space-y-1">
          <span className="block text-sm/4 font-medium text-foreground">{label}</span>
          {description ? <p className="text-xs text-muted-foreground">{description}</p> : null}
        </div>
        {control}
      </div>
      {children}
    </div>
  );
}

function reuseOptionLabel(connection: CustomModelConnection, presetId: string): string {
  const head = connection.credentialId
    ? `Use saved key •••${connection.apiKeySuffix ?? ""}`
    : "Use existing connection";
  const tail = presetId === "custom" ? ` · ${connection.baseUrl}` : "";
  return `${head} · ${connection.name}${tail}`;
}

function reasoningLevelLabel(level: string): string {
  return level === "xhigh" ? "Extra-high" : level.charAt(0).toUpperCase() + level.slice(1);
}

function formatTokens(count: number): string {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  if (count >= 1000) return `${Math.round(count / 1000)}k`;
  return String(count);
}

function limitsSummary(detected: ModelReasoningMetadata | undefined, editing: boolean): string {
  if (detected?.contextWindow === undefined) return editing ? NOT_DETECTED : PENDING_DETECTION;
  return (
    "Detected: " +
    [
      `${formatTokens(detected.contextWindow)} context`,
      ...(detected.maxOutputTokens !== undefined
        ? [`${formatTokens(detected.maxOutputTokens)} output`]
        : []),
    ].join(" · ")
  );
}

function reasoningSummary(detected: ModelReasoningMetadata | undefined, editing: boolean): string {
  if (detected?.status !== "known") return editing ? NOT_DETECTED : PENDING_DETECTION;
  if (!detected.supported) return "Detected: not supported";
  const levels = detected.levels.filter((level) => level !== "off");
  return "Detected: " + (levels.length ? levels.map(reasoningLevelLabel).join(" · ") : "supported");
}

/** A connection saved without a name is labelled by its host. */
function hostLabel(baseUrl: string): string {
  try {
    return new URL(baseUrl).host || "Custom endpoint";
  } catch {
    return "Custom endpoint";
  }
}
/** Native select styled like the shared select trigger, so it matches the inputs beside it. */
export function Choice({
  value,
  onChange,
  children,
  label,
  disabled = false,
}: {
  value: string;
  onChange: (value: string) => void;
  children: ReactNode;
  label: string;
  disabled?: boolean;
}) {
  return (
    <span className="relative inline-flex w-full">
      <select
        aria-label={label}
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
        className={cn(
          selectTriggerVariants({ variant: "default", size: "default" }),
          "appearance-none pr-9 disabled:pointer-events-none disabled:opacity-64",
        )}
      >
        {children}
      </select>
      <ChevronDownIcon className="pointer-events-none absolute top-1/2 right-3 size-4 -translate-y-1/2 text-icon-muted opacity-80" />
    </span>
  );
}

export type EditorTarget = { connection?: CustomModelConnection; model?: CustomModel };

/** Form draft stays local; only the dedicated redacted RPC receives an entered key. */
export function ModelConnectionEditor({
  settings,
  target,
  agents,
  defaultInstanceId,
  onSave,
  onClose,
}: {
  settings: CustomModelsSettings;
  target: EditorTarget;
  agents: ReadonlyArray<{ id: ProviderInstanceId; name: string; driver?: ProviderDriverKind }>;
  defaultInstanceId?: ProviderInstanceId | undefined;
  onSave: (input: CustomModelSaveInput) => Promise<void>;
  onClose: () => void;
}) {
  // A provider that already has a connection reuses it by default; the key
  // field offers "Enter a new API key" to start a second one.
  const initialConnection =
    target.connection ??
    settings.connections.find((c) => customModelPresetId(c) === DEFAULT_CUSTOM_MODEL_PRESET.id);
  const [connectionId, setConnectionId] = useState(initialConnection?.id ?? "");
  const [presetId, setPresetId] = useState(
    initialConnection ? customModelPresetId(initialConnection) : DEFAULT_CUSTOM_MODEL_PRESET.id,
  );
  const [connectionName, setConnectionName] = useState(
    initialConnection?.name ?? DEFAULT_CUSTOM_MODEL_PRESET.name,
  );
  const [baseUrl, setBaseUrl] = useState(
    initialConnection?.baseUrl ?? DEFAULT_CUSTOM_MODEL_PRESET.baseUrl,
  );
  const [protocol, setProtocol] = useState<CustomModelProtocol>(
    initialConnection?.protocol ?? DEFAULT_CUSTOM_MODEL_PRESET.protocol,
  );
  const [apiKey, setApiKey] = useState("");
  const [modelId, setModelId] = useState(target.model?.modelId ?? "");
  const [name, setName] = useState(target.model?.name ?? "");
  const [configurationMode, setConfigurationMode] = useState<"automatic" | "manual">(
    target.model
      ? (target.model.configurationMode ?? "manual")
      : initialConnection && customModelPresetId(initialConnection) === "custom"
        ? "manual"
        : "automatic",
  );
  const [contextWindow, setContextWindow] = useState<number | undefined>(
    target.model?.contextWindow,
  );
  const [maxOutputTokens, setMaxOutputTokens] = useState<number | undefined>(
    target.model?.maxOutputTokens,
  );
  const [imageInput, setImageInput] = useState<"automatic" | "enabled" | "disabled">(
    target.model ? customModelImageInput(target.model) : "automatic",
  );
  const [defaultReasoningLevel, setDefaultReasoningLevel] = useState<
    CustomModel["defaultReasoningLevel"]
  >(target.model?.defaultReasoningLevel);
  const [reasoningOverride, setReasoningOverride] = useState<CustomModel["reasoningOverride"]>(
    target.model?.reasoningOverride,
  );
  const [instanceIds, setInstanceIds] = useState<ReadonlyArray<ProviderInstanceId>>(
    target.model?.instanceIds ?? (defaultInstanceId ? [defaultInstanceId] : []),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const editing = target.model !== undefined;
  // Saved detection only describes the saved identity; any edit to it is a new model.
  const detected =
    target.model?.modelId === modelId.trim() &&
    target.connection?.baseUrl === baseUrl &&
    target.connection.protocol === protocol
      ? target.model.reasoningMetadata
      : undefined;
  const preferenceLevels = (
    reasoningOverride
      ? reasoningOverride.supported
        ? reasoningOverride.levels
        : []
      : detected?.status === "known" && detected.supported
        ? detected.levels
        : []
  ).filter((level) => level !== "off");
  const existing = settings.connections.find((c) => c.id === connectionId);
  const reusing = Boolean(existing && !target.model);
  const newCustomConnection = !existing && presetId === "custom";
  const matchingConnections = settings.connections.filter(
    (c) => customModelPresetId(c) === presetId,
  );
  const applyConnection = (
    preset: (typeof CUSTOM_MODEL_PRESETS)[number],
    connection: CustomModelConnection | undefined,
  ) => {
    setConnectionId(connection?.id ?? "");
    setApiKey("");
    setError(null);
    setConnectionName(connection?.name ?? (preset.id === "custom" ? "" : preset.name));
    setBaseUrl(connection?.baseUrl ?? preset.baseUrl);
    setProtocol(connection?.protocol ?? preset.protocol);
    setReasoningOverride(undefined);
    setConfigurationMode(preset.id === "custom" ? "manual" : "automatic");
  };
  const chooseConnection = (id: string) => {
    const connection = matchingConnections.find((c) => c.id === id);
    if (id && !connection) return;
    applyConnection(
      CUSTOM_MODEL_PRESETS.find((p) => p.id === presetId)!,
      connection,
    );
  };
  const choosePreset = (id: string) => {
    const preset = CUSTOM_MODEL_PRESETS.find((p) => p.id === id)!;
    setPresetId(id);
    applyConnection(
      preset,
      settings.connections.find((c) => customModelPresetId(c) === id),
    );
  };
  // Switching to manual starts from the detected values so the user edits, not re-enters.
  const chooseLimitsMode = (value: "automatic" | "manual" | null) => {
    if (value === null) return;
    if (value !== "manual") {
      setConfigurationMode("automatic");
      return;
    }
    setConfigurationMode("manual");
    if (contextWindow === undefined && detected?.contextWindow !== undefined)
      setContextWindow(detected.contextWindow);
    if (maxOutputTokens === undefined && detected?.maxOutputTokens !== undefined)
      setMaxOutputTokens(detected.maxOutputTokens);
  };
  const reasoningDetected = detected?.status === "known" && detected.supported === true;
  // One selector carries the default level; "manual" unfolds the capability override.
  const reasoningValue = defaultReasoningLevel ?? (reasoningOverride ? "manual" : "");
  const reasoningValueLabel = (value: string) =>
    value === "" ? "Automatic" : value === "manual" ? "Set manually" : reasoningLevelLabel(value);
  const chooseReasoning = (value: string | null) => {
    if (value === null) return;
    if (value === "manual") {
      setReasoningOverride({ supported: true, levels: [] });
      setDefaultReasoningLevel(undefined);
    } else if (value === "") {
      setReasoningOverride(undefined);
      setDefaultReasoningLevel(undefined);
    } else if (REASONING_LEVELS.includes(value as ReasoningLevel) && value !== "off") {
      setDefaultReasoningLevel(value as Exclude<ReasoningLevel, "off">);
    }
  };
  const submit = async () => {
    const model: CustomModel = {
      id: target.model?.id ?? randomUUID(),
      modelId: modelId.trim(),
      name: name.trim() || modelId.trim(),
      configurationMode,
      ...(configurationMode === "manual"
        ? {
            ...(contextWindow !== undefined ? { contextWindow } : {}),
            ...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
          }
        : {}),
      imageInput,
      images: imageInput === "enabled",
      // Retain legacy intent without promoting the old boolean to verified capabilities.
      reasoning: target.model?.reasoning ?? false,
      ...(reasoningOverride ? { reasoningOverride } : {}),
      ...(defaultReasoningLevel ? { defaultReasoningLevel } : {}),
      instanceIds,
    };
    const connection = {
      id: existing?.id ?? randomUUID(),
      name: reusing ? existing!.name : connectionName.trim() || hostLabel(baseUrl.trim()),
      baseUrl: reusing ? existing!.baseUrl : baseUrl.trim(),
      protocol: reusing ? existing!.protocol : protocol,
      models: target.model
        ? (existing?.models ?? []).map((m) => (m.id === target.model!.id ? model : m))
        : [...(existing?.models ?? []), model],
    };
    const invalid = validateCustomModelConnection(connection);
    if (invalid) {
      setError(invalid);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await onSave({
        revision: settings.revision,
        connection,
        ...(!reusing && apiKey ? { apiKey: Redacted.make(apiKey) } : {}),
      });
      setApiKey("");
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not save this model.");
    } finally {
      setBusy(false);
    }
  };
  const baseUrlField = (placeholder?: string) => (
    <Field label="Base URL">
      <Input
        required
        type="url"
        maxLength={2048}
        value={baseUrl}
        onChange={(e) => {
          setBaseUrl(e.target.value);
          setReasoningOverride(undefined);
        }}
        placeholder={placeholder}
      />
    </Field>
  );
  const apiFormatField = (
    <Field label="API format">
      <Choice
        label="API format"
        value={protocol}
        onChange={(id) => {
          setProtocol(CUSTOM_MODEL_PROTOCOLS.find((p) => p.id === id)!.id);
          setReasoningOverride(undefined);
        }}
      >
        {CUSTOM_MODEL_PROTOCOLS.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
          </option>
        ))}
      </Choice>
    </Field>
  );
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <DialogPopup className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{editing ? "Edit model" : "Add custom model"}</DialogTitle>
          <DialogDescription className="sr-only">
            Set up a model and choose which agents can use it.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <form
            className="space-y-4"
            onSubmit={(event) => {
              event.preventDefault();
              void submit();
            }}
          >
            <fieldset disabled={busy} className="space-y-4">
              {!editing ? (
                <Field label="Model provider">
                  <Choice label="Model provider" value={presetId} onChange={choosePreset}>
                    {CUSTOM_MODEL_PRESETS.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                  </Choice>
                </Field>
              ) : (
                <p className="text-sm text-muted-foreground">Connection · {existing?.name}</p>
              )}
              {newCustomConnection ? (
                <>
                  {baseUrlField("http://localhost:8080/v1")}
                  {apiFormatField}
                </>
              ) : null}
              <Field label="Model ID">
                <Input
                  required
                  autoFocus
                  maxLength={256}
                  value={modelId}
                  onChange={(e) => {
                    setModelId(e.target.value);
                    setReasoningOverride(undefined);
                  }}
                  placeholder="Model identifier"
                />
              </Field>
              {reusing ? (
                <Field label="API key">
                  <Choice label="API key" value={connectionId} onChange={chooseConnection}>
                    {matchingConnections.map((c) => (
                      <option key={c.id} value={c.id}>
                        {reuseOptionLabel(c, presetId)}
                      </option>
                    ))}
                    <option value="">
                      {presetId === "custom" ? "New connection" : "Enter a new API key"}
                    </option>
                  </Choice>
                </Field>
              ) : (
                <Field
                  label={
                    existing?.credentialId
                      ? "API key · saved"
                      : !existing && presetId !== "custom"
                        ? "API key"
                        : "API key (optional)"
                  }
                  action={
                    !editing && matchingConnections.length > 0 ? (
                      <FieldAction onClick={() => chooseConnection(matchingConnections[0]!.id)}>
                        {presetId === "custom" ? "Use existing connection" : "Use existing key"}
                      </FieldAction>
                    ) : undefined
                  }
                >
                  <Input
                    type="password"
                    aria-label="API key"
                    required={!existing && presetId !== "custom"}
                    autoComplete="off"
                    spellCheck={false}
                    maxLength={16384}
                    value={apiKey}
                    onChange={(e) => setApiKey(e.target.value)}
                    placeholder={existing?.credentialId ? "Leave blank to keep" : "API key"}
                  />
                </Field>
              )}
              <fieldset>
                <legend className="mb-1.5 text-sm/4 font-medium text-foreground">Use with</legend>
                <div className="divide-y divide-border overflow-hidden rounded-[var(--control-radius)] border border-input bg-background">
                  {agents.map((agent) => {
                    const AgentIcon = agent.driver
                      ? PROVIDER_ICON_BY_PROVIDER[agent.driver]
                      : undefined;
                    return (
                      <label
                        key={agent.id}
                        className="flex cursor-pointer items-center gap-3 px-3 py-2 text-sm transition-colors hover:bg-accent/40"
                      >
                        {AgentIcon ? (
                          <AgentIcon className="size-4 shrink-0 text-icon-muted" />
                        ) : (
                          <span aria-hidden className="size-4 shrink-0" />
                        )}
                        <span className="min-w-0 flex-1 truncate">{agent.name}</span>
                        <Switch
                          size="sm"
                          checked={instanceIds.includes(agent.id)}
                          onCheckedChange={(checked) =>
                            setInstanceIds((ids) =>
                              checked ? [...ids, agent.id] : ids.filter((id) => id !== agent.id),
                            )
                          }
                        />
                      </label>
                    );
                  })}
                </div>
              </fieldset>
              <Collapsible>
                <CollapsibleTrigger className="group inline-flex items-center gap-1 rounded-md py-1 pr-2 text-sm/4 font-medium text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring">
                  <ChevronRightIcon className="size-4 text-icon-muted transition-transform duration-200 group-data-panel-open:rotate-90" />
                  Advanced
                </CollapsibleTrigger>
                <CollapsiblePanel keepMounted className="text-sm">
                  <div className="mt-4 space-y-4 border-l border-border pl-4">
                    <Field label="Display name">
                      <Input
                        maxLength={256}
                        value={name}
                        onChange={(e) => setName(e.target.value)}
                        placeholder={modelId.trim() || "Same as model ID"}
                      />
                    </Field>
                    {!reusing ? (
                      <Field label="Connection name">
                        <Input
                          maxLength={256}
                          value={connectionName}
                          onChange={(e) => setConnectionName(e.target.value)}
                          placeholder={newCustomConnection ? hostLabel(baseUrl.trim()) : undefined}
                        />
                      </Field>
                    ) : null}
                    {!reusing && !newCustomConnection ? (
                      <>
                        {baseUrlField()}
                        {apiFormatField}
                      </>
                    ) : null}
                    <Row
                      label="Limits"
                      description={limitsSummary(detected, editing)}
                      control={
                        <Select value={configurationMode} onValueChange={chooseLimitsMode}>
                          <SelectTrigger size="sm" className="w-36 shrink-0" aria-label="Limits">
                            <SelectValue>
                              {configurationMode === "manual" ? "Set manually" : "Automatic"}
                            </SelectValue>
                          </SelectTrigger>
                          <SelectPopup align="end" alignItemWithTrigger={false}>
                            <SelectItem hideIndicator value="automatic">
                              Automatic
                            </SelectItem>
                            <SelectItem hideIndicator value="manual">
                              Set manually
                            </SelectItem>
                          </SelectPopup>
                        </Select>
                      }
                    >
                      {configurationMode === "manual" ? (
                        <div className="space-y-3">
                          <div className="grid grid-cols-2 gap-3">
                            <Field label="Context window">
                              <Input
                                required
                                type="number"
                                min={1024}
                                max={10000000}
                                value={contextWindow ?? ""}
                                onChange={(e) =>
                                  setContextWindow(
                                    e.target.value ? e.target.valueAsNumber : undefined,
                                  )
                                }
                              />
                            </Field>
                            <Field label="Max output tokens">
                              <Input
                                required
                                type="number"
                                min={1}
                                max={1000000}
                                value={maxOutputTokens ?? ""}
                                onChange={(e) =>
                                  setMaxOutputTokens(
                                    e.target.value ? e.target.valueAsNumber : undefined,
                                  )
                                }
                              />
                            </Field>
                          </div>
                        </div>
                      ) : null}
                    </Row>
                    <Row
                      label="Image input"
                      control={
                        <Select
                          value={imageInput}
                          onValueChange={(value) => {
                            if (value) setImageInput(value);
                          }}
                        >
                          <SelectTrigger
                            size="sm"
                            className="w-36 shrink-0"
                            aria-label="Image input"
                          >
                            <SelectValue>
                              {imageInput === "automatic"
                                ? "Automatic"
                                : imageInput === "enabled"
                                  ? "Enabled"
                                  : "Disabled"}
                            </SelectValue>
                          </SelectTrigger>
                          <SelectPopup align="end" alignItemWithTrigger={false}>
                            <SelectItem hideIndicator value="automatic">
                              Automatic
                            </SelectItem>
                            <SelectItem hideIndicator value="enabled">
                              Enabled
                            </SelectItem>
                            <SelectItem hideIndicator value="disabled">
                              Disabled
                            </SelectItem>
                          </SelectPopup>
                        </Select>
                      }
                    />
                    <Row
                      label="Reasoning"
                      description={reasoningSummary(detected, editing)}
                      control={
                        <Select value={reasoningValue} onValueChange={chooseReasoning}>
                          <SelectTrigger size="sm" className="w-36 shrink-0" aria-label="Reasoning">
                            <SelectValue>{reasoningValueLabel(reasoningValue)}</SelectValue>
                          </SelectTrigger>
                          <SelectPopup align="end" alignItemWithTrigger={false}>
                            <SelectItem hideIndicator value="">
                              Automatic
                            </SelectItem>
                            {defaultReasoningLevel &&
                            !preferenceLevels.includes(defaultReasoningLevel) ? (
                              <SelectItem hideIndicator disabled value={defaultReasoningLevel}>
                                {reasoningLevelLabel(defaultReasoningLevel)} (unavailable)
                              </SelectItem>
                            ) : null}
                            {preferenceLevels.map((level) => (
                              <SelectItem hideIndicator key={level} value={level}>
                                {reasoningLevelLabel(level)}
                              </SelectItem>
                            ))}
                            {reasoningOverride || !reasoningDetected ? (
                              <>
                                <SelectSeparator />
                                <SelectItem hideIndicator value="manual">
                                  Set manually
                                </SelectItem>
                              </>
                            ) : null}
                          </SelectPopup>
                        </Select>
                      }
                    >
                      {reasoningOverride ? (
                        <div className="space-y-2">
                          <label className="flex items-center gap-2">
                            <Checkbox
                              checked={reasoningOverride.supported}
                              onCheckedChange={(supported) => {
                                setReasoningOverride({ supported, levels: [] });
                                setDefaultReasoningLevel(undefined);
                              }}
                            />
                            Model supports reasoning
                          </label>
                          {reasoningOverride.supported ? (
                            <>
                              <p className="text-xs text-muted-foreground">
                                Select the levels supported by your endpoint.
                                {protocol === "anthropic-messages"
                                  ? " Requires adaptive thinking with effort support."
                                  : " Requires effort parameter support."}
                              </p>
                              <div className="flex flex-wrap gap-3">
                                {REASONING_LEVELS.map((level) => (
                                  <label key={level} className="flex items-center gap-1.5 text-xs">
                                    <Checkbox
                                      checked={reasoningOverride.levels.includes(level)}
                                      onCheckedChange={(checked) => {
                                        const levels = REASONING_LEVELS.filter((candidate) =>
                                          candidate === level
                                            ? checked
                                            : reasoningOverride.levels.includes(candidate),
                                        );
                                        setReasoningOverride({ supported: true, levels });
                                        if (
                                          defaultReasoningLevel &&
                                          !levels.includes(defaultReasoningLevel)
                                        )
                                          setDefaultReasoningLevel(undefined);
                                      }}
                                    />
                                    {reasoningLevelLabel(level)}
                                  </label>
                                ))}
                              </div>
                            </>
                          ) : null}
                        </div>
                      ) : null}
                    </Row>
                  </div>
                </CollapsiblePanel>
              </Collapsible>
            </fieldset>
            {error ? (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            ) : null}
            <div className="flex items-center justify-between gap-3 border-t border-border pt-4">
              <span className="text-xs text-muted-foreground">
                Saved on this execution environment.
              </span>
              <Button type="submit" disabled={busy}>
                {busy ? "Saving…" : "Save model"}
              </Button>
            </div>
          </form>
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}
