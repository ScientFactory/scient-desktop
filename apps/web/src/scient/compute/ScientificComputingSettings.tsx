import {
  ChartNoAxesCombinedIcon,
  ChevronRightIcon,
  DatabaseIcon,
  ExternalLinkIcon,
  RefreshCwIcon,
  SigmaIcon,
  type LucideIcon,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import * as Schema from "effect/Schema";
import type {
  ComputeLanguageRuntimeInventory,
  ComputeManagedRuntimeAction,
  EnvironmentId,
  ScientificComputingLanguageSettings,
} from "@t3tools/contracts";
import {
  ComputeLanguageDescriptor,
  ComputeLanguageId,
  resolveScientificComputingLanguageSettings,
} from "@t3tools/contracts";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";

import { useEnvironmentSettings } from "~/hooks/useSettings";
import { useLocalStorage } from "~/hooks/useLocalStorage";
import { serverEnvironment } from "~/state/server";
import { useEnvironment, usePrimaryEnvironmentId } from "~/state/environments";
import { useEnvironmentQuery } from "~/state/query";
import { computeEnvironment } from "~/state/compute";
import { useAtomCommand } from "~/state/use-atom-command";
import { cn } from "~/lib/utils";
import pythonLogo from "~/assets/compute/python.svg";
import matlabLogo from "~/assets/compute/matlab.svg";
import juliaLogo from "~/assets/compute/julia.svg";
import rLogo from "~/assets/compute/r.svg";
import rustLogo from "~/assets/compute/rust.svg";
import spssLogo from "~/assets/compute/spss.svg";
import octaveLogo from "~/assets/compute/octave.svg";
import wolframLogo from "~/assets/compute/wolfram.svg";
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
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import {
  SettingsPageContainer,
  SettingsRow,
  SettingsSection,
} from "~/components/settings/settingsLayout";
import {
  SettingsSourcePanel,
  SettingsSourceGroup,
  SettingsSourceStrip,
  SettingsSourceStripItem,
} from "~/components/settings/SettingsSourceStrip";
import {
  useComputeManagedRuntime,
  ManagedRuntimeNotice,
  ManagedRuntimeMaintenanceMenu,
  type ComputeManagedRuntimeController,
} from "./ComputeManagedRuntimeControls";
import {
  automaticComputeRuntimeLabel,
  runtimeSourceLabel,
  computeCurrentRuntimeSummary,
  computeManagedPrimaryAction,
  computeRuntimePickerLabel,
  defaultComputeInstallation,
  type ComputeManagedPrimaryAction,
} from "./computeInstallationSettingsModel";

const AUTOMATIC_RUNTIME_OPTION = "scient-runtime:automatic";
const SELECTED_LANGUAGE_STORAGE_KEY = "scient:scientific-computing:selected-language:v1";
const LANGUAGE_LOGOS: Readonly<Record<string, string>> = {
  python: pythonLogo,
  matlab: matlabLogo,
  julia: juliaLogo,
  r: rLogo,
  rust: rustLogo,
  spss: spssLogo,
  octave: octaveLogo,
  wolfram: wolframLogo,
};
const LANGUAGE_SYMBOLS: Readonly<Record<string, LucideIcon>> = {
  sql: DatabaseIcon,
  stata: ChartNoAxesCombinedIcon,
};
// Presentation-only previews; these must not become runtime inventory entries.
const UPCOMING_LANGUAGES = [
  { id: "julia", label: "Julia" },
  { id: "r", label: "R" },
  { id: "rust", label: "Rust" },
  { id: "spss", label: "SPSS" },
  { id: "sql", label: "SQL" },
  { id: "octave", label: "GNU Octave" },
  { id: "wolfram", label: "Wolfram Language" },
  { id: "stata", label: "Stata" },
] as const;

import { PythonToolkitSettings, type ToolkitChange } from "./PythonToolkitSettings";
import { ComputeInstallationRow } from "./ComputeInstallationRow";
import { useComputeInstallationSelection } from "./useComputeInstallationSelection";

/** Owns the one runtime controller shared by the selected language's runtime and Toolkit cards. */
function SelectedLanguageRuntime({
  environmentId,
  language,
  preference,
  onChange,
  children,
}: {
  environmentId: EnvironmentId;
  language: ComputeLanguageRuntimeInventory;
  preference: ScientificComputingLanguageSettings;
  onChange: (next: ScientificComputingLanguageSettings) => Promise<boolean>;
  children: (runtime: ComputeManagedRuntimeController) => ReactNode;
}) {
  const runtime = useComputeManagedRuntime({
    environmentId,
    languageId: language.descriptor.languageId,
    initialStatus: language.managedRuntime,
    ensureEnabled: async () =>
      preference.enabled || (await onChange({ ...preference, enabled: true })),
  });
  return children(runtime);
}

function LanguageRuntimeSummary({
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
  const isPython = languageId === "python";
  const isMatlab = languageId === "matlab";
  const summary = computeCurrentRuntimeSummary({
    language,
    preference,
    managed: runtime.status,
  });
  const selectedInstallation = defaultComputeInstallation(language, preference, runtime.status);
  const connectionNeedsRetarget =
    languageId === "matlab" &&
    runtime.status?.installed === true &&
    runtime.status.installationExecutable !== undefined &&
    selectedInstallation !== undefined &&
    runtime.status.installationExecutable !== selectedInstallation.executable;
  const helperNeedsRetarget = connectionNeedsRetarget && runtime.status?.selection === "managed";
  const connectionFailure =
    languageId === "matlab" &&
    runtime.failure?.retryAction != null &&
    runtime.failure.retryAction !== "remove"
      ? runtime.failure
      : null;
  const connectionNeedsRepair = summary.kind === "repair-connection" || connectionFailure !== null;
  const connectionRepairAction: ComputeManagedPrimaryAction =
    connectionFailure?.retryAction === "install" ? "install" : "repair";
  const requiredToolkitIds = language.toolkits
    .filter((toolkit) => toolkit.required)
    .map((toolkit) => toolkit.toolkitId);
  const disabled = Boolean(loading || refreshing || runtime.busy || !environmentId);
  const selection = useComputeInstallationSelection({
    language,
    preference,
    runtime,
    onChange,
    onRefresh,
    unavailable: loading || refreshing || !environmentId,
  });
  const runtimeFingerprint = JSON.stringify([
    refreshVersion,
    preference.enabled,
    selectedInstallation?.executable,
    selectedInstallation?.version,
    selectedInstallation?.problem,
    runtime.status?.generationId,
    runtime.status?.selection,
    runtime.status?.operation?.operationId,
    runtime.status?.installed,
    runtime.status?.installationExecutable,
    runtime.status?.failureMessage,
    language.installations.map(({ executable, version, problem }) => [
      executable,
      version,
      problem,
    ]),
  ]);
  // A Test may reveal a version that lightweight discovery deliberately did not probe.
  // Share that observation with this view's picker, never across environments or refreshes.
  const [observedVersions, setObservedVersions] = useState<{
    fingerprint: string;
    versions: Record<string, string>;
  } | null>(null);
  const displayLanguage =
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
  const setup = () => {
    const action = computeManagedPrimaryAction(runtime.status);
    void runtime.act(action, {
      ...(isPython
        ? {
            toolkitIds: [
              ...new Set([...(runtime.status?.toolkitIds ?? []), ...requiredToolkitIds]),
            ],
          }
        : {}),
      ...(isPython &&
      action === "install" &&
      selectedInstallation !== undefined &&
      selectedInstallation.source !== "managed"
        ? { selectionAfterInstall: "existing" as const }
        : {}),
    });
  };
  const operationId = runtime.status?.operation?.operationId ?? null;
  const previousOperationId = useRef<string | null>(null);
  useEffect(() => {
    if (previousOperationId.current !== null && operationId === null) void onRefresh();
    previousOperationId.current = operationId;
  }, [onRefresh, operationId]);
  const showManagedNotice = runtime.status?.operation != null || Boolean(runtime.failure);
  const toolkitOwnsNotice =
    isPython &&
    (runtime.status?.toolkitChanges?.some((entry) => entry.state === "running") ||
      language.toolkits.some((toolkit) => toolkit.toolkitId === toolkitChange?.toolkitId));
  const inlineManagedProgress = runtime.status?.operation != null && !toolkitOwnsNotice;
  const story = loading
    ? "Checking…"
    : helperNeedsRetarget
      ? `${selectedInstallation.version ?? "MATLAB"} · Connection needs update`
      : summary.kind === "disabled"
        ? "Off"
        : summary.kind === "ready"
          ? "For new sessions"
          : summary.kind === "update-managed" ||
              summary.kind === "repair-managed" ||
              summary.kind === "unavailable"
            ? `${summary.title} · ${summary.detail}`
            : summary.title;
  const pythonManagedAction = isPython ? computeManagedPrimaryAction(runtime.status) : null;
  const primaryManagedAction: ComputeManagedRuntimeAction | null = helperNeedsRetarget
    ? "repair"
    : pythonManagedAction === "repair"
      ? "repair"
      : summary.kind === "repair-managed"
        ? "repair"
        : connectionNeedsRepair
          ? connectionRepairAction
          : null;
  const managedAction = (() => {
    if (inlineManagedProgress)
      return <ManagedRuntimeNotice runtime={runtime} variant="toolbar" showFailure={false} />;
    if (loading || runtime.busy) return null;
    if (helperNeedsRetarget)
      return (
        <Button
          size="xs"
          variant="outline"
          disabled={disabled}
          onClick={() => void runtime.act("repair")}
        >
          Set up connection
        </Button>
      );
    if (connectionNeedsRepair)
      return (
        <Button
          size="xs"
          variant="outline"
          disabled={disabled}
          onClick={() => void runtime.act(connectionRepairAction)}
        >
          Repair connection
        </Button>
      );
    if (isMatlab && summary.kind === "connect")
      return (
        <Button size="xs" variant="outline" disabled={disabled} onClick={setup}>
          Connect MATLAB
        </Button>
      );
    if (isPython && !runtime.status?.installed)
      return (
        <Button size="xs" variant="outline" disabled={disabled} onClick={setup}>
          Set up
        </Button>
      );
    if (pythonManagedAction === "repair")
      return (
        <Button
          size="xs"
          variant="outline"
          disabled={disabled}
          onClick={() => void runtime.act("repair")}
        >
          Repair
        </Button>
      );
    if (summary.kind === "repair-managed")
      return (
        <Button
          size="xs"
          variant="outline"
          disabled={disabled}
          onClick={() => void runtime.act("repair")}
        >
          Repair
        </Button>
      );
    // Maintenance belongs to the installed capability, not the selected runtime.
    // For MATLAB this updates Scient's helper, never the user's MATLAB installation.
    if (runtime.status?.installed && runtime.status.updateAvailable)
      return (
        <Button
          size="xs"
          variant="outline"
          className="text-primary"
          disabled={disabled || (isMatlab && !selectedInstallation)}
          onClick={() => void runtime.act("update")}
        >
          Update
        </Button>
      );
    return null;
  })();
  const managedDescription = isPython
    ? runtime.status?.installed
      ? (runtime.status.runtimeVersion ?? "Version not checked")
      : "Not installed"
    : runtime.status?.installed
      ? "Connection helper installed"
      : "Connect Scient to the selected MATLAB installation.";
  return (
    <>
      <SettingsRow
        id={`${languageId}-enabled`}
        title={`Enable ${language.descriptor.displayName}`}
        control={
          <Switch
            checked={preference.enabled}
            disabled={loading || refreshing || !environmentId}
            onCheckedChange={(enabled) => {
              void onChange({ ...preference, enabled }).then((saved) => {
                if (saved) void onRefresh();
              });
            }}
            aria-label={`Enable ${language.descriptor.displayName}`}
          />
        }
      />
      <LanguageRuntimeRecovery
        language={displayLanguage}
        preference={preference}
        selection={selection}
        loading={loading}
        runtime={runtime}
        story={story}
      />
      {displayLanguage.installations
        .filter((installation) => installation.source !== "managed")
        .map((installation, index) => (
          <ComputeInstallationRow
            key={`${installation.executable}:${runtimeFingerprint}`}
            id={`${languageId}-installation-${index}`}
            title={
              displayLanguage.installations.filter(
                (other) =>
                  runtimeSourceLabel(other.source) === runtimeSourceLabel(installation.source),
              ).length > 1
                ? computeRuntimePickerLabel(
                    installation,
                    language.descriptor.displayName,
                    displayLanguage.installations,
                  )
                : runtimeSourceLabel(installation.source)
            }
            installation={installation}
            environmentId={environmentId}
            languageId={languageId}
            isDefault={installation.executable === selectedInstallation?.executable}
            disabled={
              loading ||
              refreshing ||
              !environmentId ||
              !preference.enabled ||
              (isMatlab && runtime.busy)
            }
            forgetDisabled={selection.disabled}
            onVersion={(version) => rememberVersion(installation.executable, version)}
            onForget={
              installation.source === "configured" &&
              (installation.configured ||
                installation.executable === preference.executable.trim()) &&
              preference.executable.trim()
                ? () => void selection.select(null)
                : undefined
            }
          />
        ))}
      {isMatlab && !loading && language.installations.length === 0 ? (
        <SettingsRow
          id="matlab-installation-missing"
          title="MATLAB installation"
          description="Not found"
          control={
            <Button
              size="xs"
              variant="outline"
              render={
                <a
                  href="https://www.mathworks.com/products/matlab.html"
                  target="_blank"
                  rel="noreferrer"
                />
              }
            >
              Get MATLAB <ExternalLinkIcon />
            </Button>
          }
        />
      ) : null}
      <ComputeInstallationRow
        key={`managed:${runtimeFingerprint}`}
        installation={
          isPython
            ? language.installations.find((installation) => installation.source === "managed")
            : undefined
        }
        environmentId={environmentId}
        languageId={languageId}
        isDefault={isPython && selectedInstallation?.source === "managed"}
        disabled={disabled || !preference.enabled}
        id={`${languageId}-managed-runtime`}
        title={isPython ? "Scient-managed Python" : "MATLAB connection"}
        description={
          connectionNeedsRepair
            ? null
            : runtime.status?.updateCheck === "unavailable"
              ? `${managedDescription} · Update check unavailable`
              : managedDescription
        }
        status={
          showManagedNotice && !toolkitOwnsNotice && (!inlineManagedProgress || runtime.failure) ? (
            <ManagedRuntimeNotice runtime={runtime} showProgress={!inlineManagedProgress} />
          ) : undefined
        }
        action={managedAction}
        renderMenu={(installationActions) => (
          <ManagedRuntimeMaintenanceMenu
            installationActions={installationActions}
            runtime={runtime}
            connection={isMatlab}
            omitAction={primaryManagedAction}
            canProvision={selectedInstallation !== undefined}
            disabled={refreshing || !environmentId}
            connectionNeedsRetarget={connectionNeedsRetarget}
          />
        )}
      />
    </>
  );
}

function PythonToolkitsSection({
  language,
  runtime,
  loading,
  refreshing,
  hidden,
  toolkitChange,
  onToolkitChange,
}: {
  language: ComputeLanguageRuntimeInventory;
  runtime: ComputeManagedRuntimeController;
  loading: boolean;
  refreshing: boolean;
  hidden: boolean;
  toolkitChange: ToolkitChange | null;
  onToolkitChange: (change: ToolkitChange | null) => void;
}) {
  if (language.descriptor.languageId !== "python" || language.toolkits.length === 0) return null;
  return (
    <SettingsSection
      id="scientific-computing-toolkits"
      title="Toolkits"
      headerAction={<span className="text-xs text-muted-foreground">Scient-managed Python</span>}
      variant="plain"
      className="-mx-3 mt-8 sm:-mx-4"
      hidden={hidden}
    >
      <div className="px-3 sm:px-4">
        <SettingsSourcePanel>
          <PythonToolkitSettings
            toolkits={language.toolkits}
            runtime={runtime}
            disabled={
              runtime.status?.toolkitChanges === undefined
                ? Boolean(loading || refreshing || runtime.busy)
                : Boolean(loading || refreshing || runtime.status.operation?.action === "remove")
            }
            change={toolkitChange}
            onChange={onToolkitChange}
          />
        </SettingsSourcePanel>
      </div>
    </SettingsSection>
  );
}

function LanguageRuntimeRecovery({
  language,
  preference,
  selection,
  loading,
  runtime,
  story,
}: {
  language: ComputeLanguageRuntimeInventory;
  preference: ScientificComputingLanguageSettings;
  selection: ReturnType<typeof useComputeInstallationSelection>;
  loading: boolean;
  runtime: ComputeManagedRuntimeController;
  story: string;
}) {
  const languageId = language.descriptor.languageId;
  const isPython = languageId === "python";
  const [pathOpen, setPathOpen] = useState(false);
  const [pathDraft, setPathDraft] = useState("");
  const { selecting, error: selectionFailure, disabled } = selection;
  const selectedInstallation = defaultComputeInstallation(language, preference, runtime.status);
  const hasExplicitSelection =
    Boolean(preference.executable.trim()) || (isPython && runtime.status?.selection === "managed");
  const runtimePickerValue = hasExplicitSelection
    ? (selectedInstallation?.executable ?? null)
    : AUTOMATIC_RUNTIME_OPTION;

  const select = async (executable: string | null) => {
    if (await selection.select(executable)) {
      setPathOpen(false);
      setPathDraft("");
    }
  };

  return (
    <SettingsRow
      id={`${languageId}-runtime`}
      title="Default runtime"
      description={<span data-compute-summary={languageId}>{story}</span>}
      control={
        loading ? (
          <p className="text-xs text-muted-foreground" role="status">
            Checking…
          </p>
        ) : (
          <div className="flex flex-wrap items-center gap-1.5">
            <div className="flex min-w-0 items-center">
              <Select
                value={runtimePickerValue}
                onValueChange={(value) => {
                  if (!value || value === runtimePickerValue) return;
                  if (value === AUTOMATIC_RUNTIME_OPTION) {
                    void select(null);
                    return;
                  }
                  void select(value);
                }}
                disabled={disabled || !preference.enabled}
              >
                <SelectTrigger
                  size="sm"
                  className="w-auto max-w-52"
                  aria-label={`Choose ${language.descriptor.displayName} runtime`}
                  data-compute-runtime={selectedInstallation?.executable ?? ""}
                >
                  <SelectValue>
                    {!hasExplicitSelection
                      ? automaticComputeRuntimeLabel(selectedInstallation)
                      : selectedInstallation
                        ? computeRuntimePickerLabel(
                            selectedInstallation,
                            language.descriptor.displayName,
                            language.installations,
                          )
                        : "Choose a runtime"}
                  </SelectValue>
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
                    {hasExplicitSelection
                      ? "Automatic"
                      : automaticComputeRuntimeLabel(selectedInstallation)}
                  </SelectItem>
                  {language.installations.length > 0 ? <SelectSeparator /> : null}
                  {language.installations.map((installation) => (
                    <SelectItem
                      key={installation.executable}
                      hideIndicator
                      value={installation.executable}
                      data-compute-runtime={installation.executable}
                    >
                      <span className="block max-w-[calc(100vw-3rem)] truncate sm:max-w-80">
                        {computeRuntimePickerLabel(
                          installation,
                          language.descriptor.displayName,
                          language.installations,
                        )}
                      </span>
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            </div>
          </div>
        )
      }
    >
      <div className="mt-2 mb-2 space-y-2" data-compute-recovery={languageId}>
        <Button
          size="xs"
          variant="ghost-muted"
          className="-ml-1.5"
          aria-expanded={pathOpen}
          aria-controls={`${languageId}-custom-executable`}
          disabled={disabled || !preference.enabled}
          onClick={() => setPathOpen((open) => !open)}
        >
          <ChevronRightIcon className={pathOpen ? "rotate-90" : undefined} /> Custom executable
        </Button>
        {pathOpen ? (
          <form
            id={`${languageId}-custom-executable`}
            className="flex min-w-0 items-center gap-1.5"
            onSubmit={(event) => {
              event.preventDefault();
              if (pathDraft.trim()) void select(pathDraft.trim());
            }}
          >
            <Input
              nativeInput
              size="compact"
              className="min-w-0 flex-1"
              value={pathDraft}
              disabled={disabled}
              placeholder="Executable path"
              aria-label={`${language.descriptor.displayName} executable path`}
              onChange={(event) => setPathDraft(event.currentTarget.value)}
            />
            <Button
              size="xs"
              variant="outline"
              type="submit"
              disabled={disabled || !pathDraft.trim()}
            >
              Use path
            </Button>
            <Button
              size="xs"
              variant="ghost-muted"
              disabled={selecting}
              onClick={() => setPathOpen(false)}
            >
              Cancel
            </Button>
          </form>
        ) : null}
        {selectionFailure ? (
          <p className="text-xs text-destructive" role="alert">
            {selectionFailure}
          </p>
        ) : null}
        {language.failureMessage ? (
          <p className="text-xs text-destructive" role="alert">
            {language.failureMessage}
          </p>
        ) : null}
      </div>
    </SettingsRow>
  );
}

const PENDING_RUNTIME_DESCRIPTORS: ReadonlyArray<ComputeLanguageDescriptor> = [
  ComputeLanguageDescriptor.make({
    languageId: ComputeLanguageId.make("python"),
    displayName: "Python",
    sourceExtensions: [".py"],
    capabilities: ["execute", "interrupt", "restart", "shutdown"],
  }),
  ComputeLanguageDescriptor.make({
    languageId: ComputeLanguageId.make("matlab"),
    displayName: "MATLAB",
    sourceExtensions: [".m"],
    capabilities: ["execute", "interrupt", "restart", "shutdown"],
  }),
];

function pendingRuntimeInventory(
  preferences: Readonly<Record<string, ScientificComputingLanguageSettings>>,
): ReadonlyArray<ComputeLanguageRuntimeInventory> {
  return PENDING_RUNTIME_DESCRIPTORS.map((descriptor) => {
    const preference = resolveScientificComputingLanguageSettings(
      { languages: preferences },
      descriptor.languageId,
    );
    return {
      descriptor,
      enabled: preference.enabled,
      configuredExecutable: preference.executable || null,
      managedRuntime: null,
      toolkits: [],
      installations: [],
      failureMessage: null,
    };
  });
}

export function ScientificComputingSettings(
  props: { environmentId?: EnvironmentId | undefined } = {},
) {
  const primaryId = usePrimaryEnvironmentId();
  const environmentId = props.environmentId ?? primaryId;
  const environment = useEnvironment(environmentId);
  if (environmentId === null || environment === null) {
    return (
      <SettingsPageContainer>
        <SettingsSection title="Scientific Computing">
          <p className="text-sm text-muted-foreground">
            This server is unavailable. Reconnect it to manage scientific runtimes.
          </p>
        </SettingsSection>
      </SettingsPageContainer>
    );
  }
  return (
    <EnvironmentScientificComputingSettings
      key={environmentId}
      environmentId={environmentId}
      label={environment.label}
    />
  );
}

function EnvironmentScientificComputingSettings({
  environmentId,
  label,
}: {
  environmentId: EnvironmentId;
  label: string;
}) {
  const preferences = useEnvironmentSettings(
    environmentId,
    (settings) => settings.scientificComputing,
  );
  const updateSettings = useAtomCommand(serverEnvironment.updateSettings, { reportFailure: false });
  const refreshRuntimes = useAtomCommand(computeEnvironment.refreshRuntimeInventory, {
    reportFailure: false,
  });
  const [refreshing, setRefreshing] = useState(false);
  const [refreshVersion, setRefreshVersion] = useState(0);
  const [refreshFailure, setRefreshFailure] = useState<string | null>(null);
  const runtimesAtom = environmentId
    ? computeEnvironment.runtimeInventory({
        environmentId,
        input: {},
      })
    : null;
  const runtimes = useEnvironmentQuery(runtimesAtom);
  const inventoryPending = runtimes.data === null && runtimes.error === null;
  const displayedLanguages =
    runtimes.data?.languages ?? pendingRuntimeInventory(preferences.languages);
  const [storedLanguageId, setStoredLanguageId] = useLocalStorage(
    SELECTED_LANGUAGE_STORAGE_KEY,
    "python",
    Schema.String,
  );
  const upcomingLanguages = UPCOMING_LANGUAGES.filter(
    (preview) =>
      !displayedLanguages.some((language) => language.descriptor.languageId === preview.id),
  );
  const selectedPreview = upcomingLanguages.find((preview) => preview.id === storedLanguageId);
  const selectedLanguage = selectedPreview
    ? undefined
    : (displayedLanguages.find((language) => language.descriptor.languageId === storedLanguageId) ??
      displayedLanguages[0]);
  const selectedId = selectedPreview?.id ?? selectedLanguage?.descriptor.languageId;
  const languageItems = [
    ...displayedLanguages.map((language) => ({
      id: language.descriptor.languageId,
      label: language.descriptor.displayName,
      detail: resolveScientificComputingLanguageSettings(
        preferences,
        language.descriptor.languageId,
      ).enabled
        ? "On"
        : "Off",
    })),
    ...upcomingLanguages.map((preview) => ({
      ...preview,
      detail: "Coming soon",
    })),
  ];
  const [collapsed, setCollapsed] = useState(false);
  // Keep the pending action when moving between language disclosures.
  const [toolkitChange, setToolkitChange] = useState<ToolkitChange | null>(null);

  const updateLanguage = async (
    languageId: ComputeLanguageRuntimeInventory["descriptor"]["languageId"],
    next: ScientificComputingLanguageSettings,
  ) => {
    const result = await updateSettings({
      environmentId,
      input: {
        patch: {
          scientificComputing: {
            schemaVersion: 1,
            languages: { [languageId]: next },
          },
        },
      },
    });
    if (result._tag === "Failure") {
      const failure = squashAtomCommandFailure(result);
      setRefreshFailure(
        failure instanceof Error ? failure.message : "The setting could not be saved.",
      );
      return false;
    }
    setRefreshFailure(null);
    setRefreshVersion((current) => current + 1);
    return true;
  };

  const handleRefresh = useCallback(async () => {
    if (environmentId === null) return;
    // Refresh is a new observation, not proof that an earlier Test still holds.
    setRefreshVersion((current) => current + 1);
    setRefreshFailure(null);
    setRefreshing(true);
    const result = await refreshRuntimes({
      environmentId,
      input: {},
    });
    setRefreshing(false);
    if (result._tag === "Failure") {
      const failure = squashAtomCommandFailure(result);
      setRefreshFailure(
        failure instanceof Error
          ? failure.message
          : "Scient could not refresh scientific runtimes.",
      );
      return;
    }
    setRefreshFailure(null);
  }, [environmentId, refreshRuntimes]);

  const selectedPreference = selectedLanguage
    ? {
        ...resolveScientificComputingLanguageSettings(
          preferences,
          selectedLanguage.descriptor.languageId,
        ),
        executable:
          preferences.languages[selectedLanguage.descriptor.languageId]?.executable ??
          selectedLanguage.configuredExecutable ??
          "",
      }
    : null;
  return (
    <SettingsPageContainer>
      <SettingsSection
        id="scientific-computing"
        title="Scientific Computing"
        icon={<SigmaIcon className="size-4 text-muted-foreground" />}
        variant="plain"
        headerAction={
          <div className="flex items-center gap-1.5">
            <span className="hidden text-xs text-muted-foreground sm:inline">{label}</span>
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    size="icon-xs"
                    variant="ghost-muted"
                    disabled={runtimes.isPending || refreshing}
                    aria-label="Refresh scientific runtimes"
                    onClick={() => void handleRefresh()}
                  >
                    <RefreshCwIcon
                      className={cn(runtimes.isPending || refreshing ? "animate-spin" : undefined)}
                    />
                  </Button>
                }
              />
              <TooltipPopup side="top">Find runtimes again</TooltipPopup>
            </Tooltip>
          </div>
        }
      >
        <div className="px-3 sm:px-4">
          <SettingsSourceGroup
            activePanelId={!collapsed && selectedId ? `scientific-computing-${selectedId}` : null}
          >
            <SettingsSourceStrip label="Scientific computing languages">
              {languageItems.map((language, index) => {
                const languageId = language.id;
                const LanguageSymbol = LANGUAGE_SYMBOLS[languageId] ?? SigmaIcon;
                return (
                  <SettingsSourceStripItem
                    key={languageId}
                    id={`scientific-computing-${languageId}-trigger`}
                    controls={`scientific-computing-${languageId}`}
                    expanded={!collapsed && languageId === selectedId}
                    separated={index > 0}
                    label={language.label}
                    detail={language.detail}
                    icon={
                      LANGUAGE_LOGOS[languageId] ? (
                        <img
                          src={LANGUAGE_LOGOS[languageId]}
                          alt=""
                          aria-hidden="true"
                          width={24}
                          height={24}
                          className={cn(
                            "size-6 shrink-0 object-contain",
                            languageId === "rust" && "dark:invert",
                          )}
                        />
                      ) : (
                        <LanguageSymbol
                          aria-hidden="true"
                          data-language-icon={languageId}
                          className="size-6 shrink-0"
                        />
                      )
                    }
                    onToggle={() => {
                      if (languageId === selectedId) {
                        setCollapsed((current) => !current);
                      } else {
                        setStoredLanguageId(languageId);
                        setCollapsed(false);
                      }
                    }}
                  />
                );
              })}
            </SettingsSourceStrip>
            {selectedPreview ? (
              <SettingsSourcePanel
                id={`scientific-computing-${selectedPreview.id}`}
                aria-labelledby={`scientific-computing-${selectedPreview.id}-trigger`}
                hidden={collapsed}
              >
                <p className="px-3 py-3 text-sm text-muted-foreground sm:px-4">Coming soon</p>
              </SettingsSourcePanel>
            ) : null}
            {selectedLanguage && selectedPreference ? (
              <SelectedLanguageRuntime
                key={selectedLanguage.descriptor.languageId}
                environmentId={environmentId}
                language={selectedLanguage}
                preference={selectedPreference}
                onChange={(next) => updateLanguage(selectedLanguage.descriptor.languageId, next)}
              >
                {(runtime) => (
                  <>
                    <SettingsSourcePanel
                      id={`scientific-computing-${selectedLanguage.descriptor.languageId}`}
                      data-compute-settings=""
                      aria-labelledby={`scientific-computing-${selectedLanguage.descriptor.languageId}-trigger`}
                      hidden={collapsed}
                    >
                      <LanguageRuntimeSummary
                        language={selectedLanguage}
                        preference={selectedPreference}
                        runtime={runtime}
                        onChange={(next) =>
                          updateLanguage(selectedLanguage.descriptor.languageId, next)
                        }
                        environmentId={environmentId}
                        loading={inventoryPending}
                        refreshing={refreshing}
                        onRefresh={handleRefresh}
                        refreshVersion={refreshVersion}
                        toolkitChange={
                          selectedLanguage.descriptor.languageId === "python" ? toolkitChange : null
                        }
                      />
                    </SettingsSourcePanel>
                    <PythonToolkitsSection
                      language={selectedLanguage}
                      runtime={runtime}
                      loading={inventoryPending}
                      refreshing={refreshing}
                      hidden={collapsed}
                      toolkitChange={toolkitChange}
                      onToolkitChange={setToolkitChange}
                    />
                  </>
                )}
              </SelectedLanguageRuntime>
            ) : null}
          </SettingsSourceGroup>
        </div>
        {(refreshFailure ?? runtimes.error) ? (
          <p className="px-4 py-3 text-xs text-destructive" role="alert">
            {refreshFailure ?? runtimes.error}
          </p>
        ) : null}
      </SettingsSection>
    </SettingsPageContainer>
  );
}
