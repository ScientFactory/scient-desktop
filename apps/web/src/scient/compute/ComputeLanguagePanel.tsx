import { useEffect, useRef, useState } from "react";
import { ChevronDownIcon } from "lucide-react";
import type {
  ComputeLanguageRuntimeInventory,
  ComputeManagedRuntimeAction,
  EnvironmentId,
  ScientificComputingLanguageSettings,
} from "@t3tools/contracts";
import { SettingsRow } from "~/components/settings/settingsLayout";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import { Switch } from "~/components/ui/switch";
import { cn } from "~/lib/utils";
import {
  ManagedRuntimeMaintenanceMenu,
  ManagedRuntimeNotice,
  type ComputeManagedRuntimeController,
} from "./ComputeManagedRuntimeControls";
import { ComputeInstallationRow } from "./ComputeInstallationRow";
import { ComputeRuntimeTest } from "./ComputeRuntimeTest";
import {
  automaticComputeRuntimeLabel,
  computeConnectionNeedsRetarget,
  computeCurrentRuntimeSummary,
  computeLanguagePrimaryAction,
  computeManagedPrimaryAction,
  computeRuntimePickerLabel,
  computeScientPart,
  defaultComputeInstallation,
} from "./computeInstallationSettingsModel";
import type { ToolkitChange } from "./PythonToolkitSettings";
import { useComputeInstallationSelection } from "./useComputeInstallationSelection";

const AUTOMATIC_RUNTIME_OPTION = "scient-runtime:automatic";

type InstallationSelection = ReturnType<typeof useComputeInstallationSelection>;

/** What a language runs on, what Scient adds to it, and everything else found on this computer. */
export function ComputeLanguagePanel({
  language,
  preference,
  runtime,
  onChange,
  environmentId,
  loading,
  refreshing,
  onRefresh,
  refreshVersion,
  toolkitChange,
}: {
  language: ComputeLanguageRuntimeInventory;
  preference: ScientificComputingLanguageSettings;
  runtime: ComputeManagedRuntimeController;
  onChange: (next: ScientificComputingLanguageSettings) => Promise<boolean>;
  environmentId: EnvironmentId | null;
  loading: boolean;
  refreshing: boolean;
  onRefresh: () => Promise<void>;
  refreshVersion: number;
  toolkitChange: ToolkitChange | null;
}) {
  const languageId = language.descriptor.languageId;
  const name = language.descriptor.displayName;
  const part = computeScientPart(languageId);
  const summary = computeCurrentRuntimeSummary({ language, preference, managed: runtime.status });
  const selected = defaultComputeInstallation(language, preference, runtime.status);
  const primary = computeLanguagePrimaryAction({
    language,
    summary,
    managed: runtime.status,
    selected,
    failureRetry: runtime.failure?.retryAction,
  });
  const unavailable = loading || refreshing || !environmentId;
  const disabled = unavailable || runtime.busy;
  const selection = useComputeInstallationSelection({
    language,
    preference,
    runtime,
    onChange,
    onRefresh,
    unavailable,
  });
  const runtimeFingerprint = JSON.stringify([
    refreshVersion,
    preference.enabled,
    selected?.executable,
    runtime.status?.generationId,
    runtime.status?.selection,
    runtime.status?.operation?.operationId,
    runtime.status?.installed,
    language.installations.map(({ executable, version, problem }) => [
      executable,
      version,
      problem,
    ]),
  ]);
  // A Test may reveal a version discovery did not reach. Share it with this view's labels, never
  // across environments or refreshes.
  const [observedVersions, setObservedVersions] = useState<{
    fingerprint: string;
    versions: Record<string, string>;
  } | null>(null);
  const shown =
    observedVersions?.fingerprint === runtimeFingerprint
      ? {
          ...language,
          installations: language.installations.map((installation) => ({
            ...installation,
            version: observedVersions.versions[installation.executable] ?? installation.version,
          })),
        }
      : language;
  const rememberVersion = (executable: string, version: string) => {
    setObservedVersions((previous) => ({
      fingerprint: runtimeFingerprint,
      versions: {
        ...(previous?.fingerprint === runtimeFingerprint ? previous.versions : {}),
        [executable]: version,
      },
    }));
  };
  const setUp = () => {
    const action = computeManagedPrimaryAction(runtime.status);
    void runtime.act(action, {
      ...(languageId === "python"
        ? {
            toolkitIds: [
              ...new Set([
                ...(runtime.status?.toolkitIds ?? []),
                ...language.toolkits
                  .filter((toolkit) => toolkit.required)
                  .map((toolkit) => toolkit.toolkitId),
              ]),
            ],
          }
        : {}),
      ...(part === "managed-python" &&
      action === "install" &&
      selected !== undefined &&
      selected.source !== "managed"
        ? { selectionAfterInstall: "existing" as const }
        : {}),
    });
  };
  const operationId = runtime.status?.operation?.operationId ?? null;
  const previousOperationId = useRef<string | null>(null);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- re-reads runtime state over the environment connection when a managed operation ends
  useEffect(() => {
    if (previousOperationId.current !== null && operationId === null) void onRefresh();
    previousOperationId.current = operationId;
  }, [onRefresh, operationId]);
  const toolkitOwnsNotice =
    languageId === "python" &&
    (runtime.status?.toolkitChanges?.some((entry) => entry.state === "running") ||
      language.toolkits.some((toolkit) => toolkit.toolkitId === toolkitChange?.toolkitId));
  const inlineProgress = runtime.status?.operation != null && !toolkitOwnsNotice;
  const showNotice =
    !toolkitOwnsNotice &&
    (Boolean(runtime.failure) || (runtime.status?.operation != null && !inlineProgress));
  const needs =
    loading || summary.kind === "ready" || summary.kind === "update-managed" ? null : summary.title;
  const keptAction: ComputeManagedRuntimeAction | null =
    primary?.run === "repair" || primary?.run === "install" ? primary.run : null;

  return (
    <>
      <SettingsRow
        id={`${languageId}-runtime`}
        title="Runtime"
        {...(needs === null
          ? {}
          : { description: <span data-compute-summary={languageId}>{needs}</span> })}
        status={
          showNotice ? <ManagedRuntimeNotice runtime={runtime} showProgress={false} /> : undefined
        }
        control={
          loading ? (
            <p className="text-xs text-muted-foreground" role="status">
              Checking…
            </p>
          ) : (
            <div className="flex flex-wrap items-center justify-end gap-1.5">
              {inlineProgress ? (
                <ManagedRuntimeNotice runtime={runtime} variant="toolbar" showFailure={false} />
              ) : primary && !runtime.busy ? (
                <Button
                  size="xs"
                  variant={primary.emphasis ? "primary-outline" : "outline"}
                  disabled={
                    disabled ||
                    (primary.run === "update" && part === "connection" && selected === undefined)
                  }
                  onClick={() => {
                    if (primary.run === "setup") setUp();
                    else void runtime.act(primary.run);
                  }}
                >
                  {primary.label}
                </Button>
              ) : null}
              {selected && needs === null ? (
                <ComputeRuntimeTest
                  key={runtimeFingerprint}
                  executable={selected.executable}
                  environmentId={environmentId}
                  languageId={languageId}
                  label={name}
                  disabled={disabled}
                  onVersion={(version) => rememberVersion(selected.executable, version)}
                />
              ) : null}
              <RuntimePicker
                language={shown}
                preference={preference}
                selection={selection}
                runtime={runtime}
              />
            </div>
          )
        }
      >
        {selection.error || language.failureMessage ? (
          <p className="mt-1 text-xs text-destructive" role="alert">
            {selection.error ?? language.failureMessage}
          </p>
        ) : null}
      </SettingsRow>
      {part !== null && runtime.status?.installed ? (
        <ComputeInstallationRow
          key={`scient:${runtimeFingerprint}`}
          id={`${languageId}-managed-runtime`}
          title={
            part === "connection"
              ? "MATLAB connection"
              : part === "kernel"
                ? (runtime.status.displayName ?? name)
                : "Scient-managed Python"
          }
          description={
            part === "connection"
              ? "Connects Scient to MATLAB"
              : languageId === "sql"
                ? "Includes DuckDB"
                : (runtime.status.runtimeVersion ?? "Private to Scient")
          }
          installation={
            part === "managed-python"
              ? language.installations.find((installation) => installation.source === "managed")
              : undefined
          }
          testable={false}
          environmentId={environmentId}
          languageId={languageId}
          disabled={disabled || !preference.enabled}
          renderMenu={(installationActions) => (
            <ManagedRuntimeMaintenanceMenu
              installationActions={installationActions}
              runtime={runtime}
              connection={part === "connection"}
              {...(part === "kernel" ? { kernel: runtime.status?.displayName ?? name } : {})}
              omitAction={keptAction}
              canProvision={selected !== undefined}
              disabled={refreshing || !environmentId}
              connectionNeedsRetarget={
                part === "connection" && computeConnectionNeedsRetarget(runtime.status, selected)
              }
            />
          )}
        />
      ) : null}
      <FoundInstallations
        language={shown}
        preference={preference}
        selectedExecutable={selected?.executable}
        selection={selection}
        environmentId={environmentId}
        disabled={unavailable || !preference.enabled}
        fingerprint={runtimeFingerprint}
        onVersion={rememberVersion}
      />
      <SettingsRow
        id={`${languageId}-enabled`}
        title={`Use ${name} in Scient`}
        control={
          <Switch
            checked={preference.enabled}
            disabled={unavailable}
            onCheckedChange={(enabled) => {
              void onChange({ ...preference, enabled }).then((saved) => {
                if (saved) void onRefresh();
              });
            }}
            aria-label={`Use ${name} in Scient`}
          />
        }
      />
    </>
  );
}

/** A choice only exists with more than one runtime, or to leave a chosen one. */
function RuntimePicker({
  language,
  preference,
  selection,
  runtime,
}: {
  language: ComputeLanguageRuntimeInventory;
  preference: ScientificComputingLanguageSettings;
  selection: InstallationSelection;
  runtime: ComputeManagedRuntimeController;
}) {
  const languageId = language.descriptor.languageId;
  const name = language.descriptor.displayName;
  const selected = defaultComputeInstallation(language, preference, runtime.status);
  const explicit =
    Boolean(preference.executable.trim()) ||
    (languageId === "python" && runtime.status?.selection === "managed");
  const value = explicit ? (selected?.executable ?? null) : AUTOMATIC_RUNTIME_OPTION;
  const current = !explicit
    ? automaticComputeRuntimeLabel(selected)
    : selected
      ? computeRuntimePickerLabel(selected, name, language.installations)
      : "Choose a runtime";
  if (language.installations.length < 2 && !preference.executable.trim()) {
    return selected ? (
      <span className="text-xs text-muted-foreground">
        {computeRuntimePickerLabel(selected, name, language.installations)}
      </span>
    ) : null;
  }
  return (
    <Select
      value={value}
      onValueChange={(next) => {
        if (!next || next === value) return;
        void selection.select(next === AUTOMATIC_RUNTIME_OPTION ? null : next);
      }}
      disabled={selection.disabled || !preference.enabled}
    >
      <SelectTrigger
        size="sm"
        className="w-auto max-w-64"
        aria-label={`Choose ${name} runtime`}
        data-compute-runtime={selected?.executable ?? ""}
      >
        <SelectValue>{current}</SelectValue>
      </SelectTrigger>
      <SelectPopup
        align="end"
        alignItemWithTrigger={false}
        matchTriggerWidth={false}
        className="max-w-[calc(100vw-1rem)]"
      >
        <SelectItem
          hideIndicator
          value={AUTOMATIC_RUNTIME_OPTION}
          data-compute-runtime={AUTOMATIC_RUNTIME_OPTION}
        >
          {explicit ? "Automatic" : current}
        </SelectItem>
        <SelectSeparator />
        {language.installations.map((installation) => (
          <SelectItem
            key={installation.executable}
            hideIndicator
            value={installation.executable}
            data-compute-runtime={installation.executable}
          >
            <span className="block max-w-[calc(100vw-3rem)] truncate sm:max-w-80">
              {computeRuntimePickerLabel(installation, name, language.installations)}
            </span>
          </SelectItem>
        ))}
      </SelectPopup>
    </Select>
  );
}

function FoundInstallations({
  language,
  preference,
  selectedExecutable,
  selection,
  environmentId,
  disabled,
  fingerprint,
  onVersion,
}: {
  language: ComputeLanguageRuntimeInventory;
  preference: ScientificComputingLanguageSettings;
  selectedExecutable: string | undefined;
  selection: InstallationSelection;
  environmentId: EnvironmentId | null;
  disabled: boolean;
  fingerprint: string;
  onVersion: (executable: string, version: string) => void;
}) {
  const languageId = language.descriptor.languageId;
  const name = language.descriptor.displayName;
  const [open, setOpen] = useState(false);
  const [path, setPath] = useState("");
  const found = language.installations.filter((installation) => installation.source !== "managed");
  const chosen = preference.executable.trim();
  const applyPath = async () => {
    if (await selection.select(path.trim())) setPath("");
  };
  return (
    <>
      <SettingsRow
        id={`${languageId}-found`}
        title="Found on this computer"
        control={
          <Button
            size="xs"
            variant="ghost-muted"
            aria-expanded={open}
            aria-controls={`${languageId}-found-list`}
            aria-label={`${found.length} found on this computer`}
            onClick={() => setOpen((current) => !current)}
          >
            {found.length}
            <ChevronDownIcon className={cn("transition-transform", open && "rotate-180")} />
          </Button>
        }
      />
      {open ? (
        <div id={`${languageId}-found-list`} className="[&>:not(:first-child)]:border-t">
          {found.map((installation, index) => (
            <ComputeInstallationRow
              key={`${installation.executable}:${fingerprint}`}
              id={`${languageId}-installation-${index}`}
              title={computeRuntimePickerLabel(installation, name, language.installations)}
              installation={installation}
              environmentId={environmentId}
              languageId={languageId}
              inUse={installation.executable === selectedExecutable}
              disabled={disabled}
              forgetDisabled={selection.disabled}
              onVersion={(version) => onVersion(installation.executable, version)}
              onForget={
                installation.source === "configured" &&
                (installation.configured || installation.executable === chosen) &&
                chosen
                  ? () => void selection.select(null)
                  : undefined
              }
            />
          ))}
          <SettingsRow
            id={`${languageId}-custom-executable`}
            title="Custom path"
            control={
              <form
                className="flex min-w-0 items-center gap-1.5"
                onSubmit={(event) => {
                  event.preventDefault();
                  if (path.trim()) void applyPath();
                }}
              >
                <Input
                  nativeInput
                  size="compact"
                  className="w-64 min-w-0"
                  value={path}
                  disabled={disabled || selection.disabled}
                  placeholder="Executable path"
                  aria-label={`${name} executable path`}
                  onChange={(event) => setPath(event.currentTarget.value)}
                />
                <Button
                  size="xs"
                  variant="outline"
                  type="submit"
                  disabled={disabled || selection.disabled || !path.trim()}
                >
                  Use
                </Button>
              </form>
            }
          />
        </div>
      ) : null}
    </>
  );
}
