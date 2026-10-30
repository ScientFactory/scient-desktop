import {
  DatabaseIcon,
  ExternalLinkIcon,
  RefreshCwIcon,
  SigmaIcon,
  type LucideIcon,
} from "lucide-react";
import { useState, type ReactNode } from "react";
import * as Schema from "effect/Schema";
import type {
  ComputeLanguageRuntimeInventory,
  EnvironmentId,
  ScientificComputingLanguageSettings,
} from "@t3tools/contracts";
import {
  ComputeLanguageDescriptor,
  ComputeLanguageId,
  resolveScientificComputingExecutable,
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
import octaveLogo from "~/assets/compute/octave.svg";
import rustLogo from "~/assets/compute/rust.svg";
import spssLogo from "~/assets/compute/spss.svg";
import wolframLogo from "~/assets/compute/wolfram.svg";
import { Button } from "~/components/ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import {
  SettingsPageContainer,
  SettingsRow,
  SettingsSection,
} from "~/components/settings/settingsLayout";
import { useOptionalSettingsScope } from "~/components/settings/SettingsScopeContext";
import {
  SettingsSourcePanel,
  SettingsSourceGroup,
  SettingsSourceStrip,
  SettingsSourceStripItem,
} from "~/components/settings/SettingsSourceStrip";
import {
  useComputeManagedRuntime,
  type ComputeManagedRuntimeController,
} from "./ComputeManagedRuntimeControls";
import { ComputeLanguagePanel } from "./ComputeLanguagePanel";
import {
  computeCurrentRuntimeSummary,
  computeLanguageAbsent,
  computeLanguageListDetail,
  computeScientPart,
} from "./computeInstallationSettingsModel";

const SELECTED_LANGUAGE_STORAGE_KEY = "scient:scientific-computing:selected-language:v1";
const LANGUAGE_LOGOS: Readonly<Record<string, string>> = {
  python: pythonLogo,
  matlab: matlabLogo,
  julia: juliaLogo,
  r: rLogo,
  octave: octaveLogo,
  rust: rustLogo,
  spss: spssLogo,
  "wolfram-language": wolframLogo,
};
const LANGUAGE_SYMBOLS: Readonly<Record<string, LucideIcon>> = {
  sql: DatabaseIcon,
};
const LANGUAGE_DOWNLOADS: Readonly<Record<string, string>> = {
  matlab: "https://www.mathworks.com/products/matlab.html",
  r: "https://cloud.r-project.org/",
  julia: "https://julialang.org/install/",
};

import { PythonToolkitSettings, type ToolkitChange } from "./PythonToolkitSettings";

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

function LanguageMark({ languageId, className }: { languageId: string; className: string }) {
  const logo = LANGUAGE_LOGOS[languageId];
  if (logo) {
    return (
      <img
        src={logo}
        alt=""
        aria-hidden="true"
        width={24}
        height={24}
        className={cn(className, "shrink-0 object-contain")}
      />
    );
  }
  const Symbol = LANGUAGE_SYMBOLS[languageId] ?? SigmaIcon;
  return (
    <Symbol
      aria-hidden="true"
      data-language-icon={languageId}
      className={cn(className, "shrink-0")}
    />
  );
}

/** Languages not on this computer, each with what it takes to run it here. */
function MoreLanguages({
  languages,
}: {
  languages: ReadonlyArray<ComputeLanguageRuntimeInventory>;
}) {
  return (
    <SettingsSection
      id="scientific-computing-more"
      title="More languages"
      variant="plain"
      className="-mx-3 mt-8 sm:-mx-4"
    >
      <div className="px-3 sm:px-4">
        <SettingsSourcePanel>
          {languages.map((language) => {
            const languageId = language.descriptor.languageId;
            const name = language.descriptor.displayName;
            const url = language.descriptor.setup?.url ?? LANGUAGE_DOWNLOADS[languageId];
            return (
              <SettingsRow
                key={languageId}
                id={`${languageId}-installation-missing`}
                title={
                  <span className="flex items-center gap-2">
                    <LanguageMark languageId={languageId} className="size-4" />
                    {name}
                  </span>
                }
                description={language.descriptor.setup?.needs ?? "Not found on this computer"}
                control={
                  url ? (
                    <Button
                      size="xs"
                      variant="outline"
                      render={<a href={url} target="_blank" rel="noreferrer" />}
                    >
                      Get {name} <ExternalLinkIcon />
                    </Button>
                  ) : undefined
                }
              />
            );
          })}
        </SettingsSourcePanel>
      </div>
    </SettingsSection>
  );
}

function PythonToolkitsSection({
  language,
  runtime,
  loading,
  refreshing,
  toolkitChange,
  onToolkitChange,
}: {
  language: ComputeLanguageRuntimeInventory;
  runtime: ComputeManagedRuntimeController;
  loading: boolean;
  refreshing: boolean;
  toolkitChange: ToolkitChange | null;
  onToolkitChange: (change: ToolkitChange | null) => void;
}) {
  if (
    language.descriptor.languageId !== "python" ||
    language.toolkits.length === 0 ||
    !runtime.status?.installed
  )
    return null;
  return (
    <SettingsSection
      id="scientific-computing-toolkits"
      title="Toolkits"
      headerAction={<span className="text-xs text-muted-foreground">Scient-managed Python</span>}
      variant="plain"
      className="-mx-3 mt-8 sm:-mx-4"
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

const PENDING_RUNTIME_DESCRIPTORS: ReadonlyArray<ComputeLanguageDescriptor> = (
  [
    ["python", "Python", ".py"],
    ["r", "R", ".r"],
    ["julia", "Julia", ".jl"],
    ["sql", "SQL", ".sql"],
    ["matlab", "MATLAB", ".m"],
  ] as const
).map(([languageId, displayName, extension]) =>
  ComputeLanguageDescriptor.make({
    languageId: ComputeLanguageId.make(languageId),
    displayName,
    sourceExtensions: [extension],
    capabilities: ["execute", "interrupt", "restart", "shutdown"],
  }),
);

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
  const scope = useOptionalSettingsScope();
  const environmentId =
    props.environmentId ??
    (scope === null ? primaryId : (scope.environment?.environmentId ?? null));
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
    <EnvironmentScientificComputingSettings key={environmentId} environmentId={environmentId} />
  );
}

function EnvironmentScientificComputingSettings({
  environmentId,
}: {
  environmentId: EnvironmentId;
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
  // The list is instant; versions run each Python, so they arrive a moment later.
  const listed = useEnvironmentQuery(
    computeEnvironment.runtimeInventory({ environmentId, input: {} }),
  );
  const withVersions = useEnvironmentQuery(
    computeEnvironment.runtimeInventory({ environmentId, input: { versions: true } }),
  );
  const runtimes = withVersions.data ? withVersions : listed;
  const inventoryPending = runtimes.data === null && runtimes.error === null;
  const displayedLanguages =
    runtimes.data?.languages ?? pendingRuntimeInventory(preferences.languages);
  const [storedLanguageId, setStoredLanguageId] = useLocalStorage(
    SELECTED_LANGUAGE_STORAGE_KEY,
    "python",
    Schema.String,
  );
  const hostKey = runtimes.data?.hostKey ?? null;
  const preferenceFor = (language: ComputeLanguageRuntimeInventory) => {
    const languageId = language.descriptor.languageId;
    return {
      ...resolveScientificComputingLanguageSettings(preferences, languageId),
      executable:
        hostKey === null
          ? (preferences.languages[languageId]?.executable ?? language.configuredExecutable ?? "")
          : resolveScientificComputingExecutable(preferences.languages[languageId], hostKey),
    };
  };
  // Languages Scient has a part in lead; the ones that bring their own kernel follow.
  const hereLanguages = displayedLanguages
    .filter((language) => inventoryPending || !computeLanguageAbsent(language))
    .toSorted(
      (a, b) =>
        Number(computeScientPart(a.descriptor.languageId) === null) -
        Number(computeScientPart(b.descriptor.languageId) === null),
    );
  const moreLanguages = inventoryPending ? [] : displayedLanguages.filter(computeLanguageAbsent);
  const selectedLanguage =
    hereLanguages.find((language) => language.descriptor.languageId === storedLanguageId) ??
    hereLanguages[0];
  const selectedId = selectedLanguage?.descriptor.languageId;
  const languageItems = hereLanguages.map((language) => ({
    id: language.descriptor.languageId,
    label: language.descriptor.displayName,
    detail: inventoryPending
      ? "Checking…"
      : computeLanguageListDetail(
          language,
          computeCurrentRuntimeSummary({
            language,
            preference: preferenceFor(language),
            managed: language.managedRuntime,
          }),
        ),
  }));
  // Keep the pending action when moving between language disclosures.
  const [toolkitChange, setToolkitChange] = useState<ToolkitChange | null>(null);

  // Choices are saved for this machine, so a copied or synced profile does not carry them.
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
            languages: {
              [languageId]:
                hostKey === null
                  ? next
                  : {
                      enabled: next.enabled,
                      executable: "",
                      selections: { [hostKey]: next.executable },
                    },
            },
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

  const handleRefresh = async () => {
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
  };

  const selectedPreference = selectedLanguage ? preferenceFor(selectedLanguage) : null;
  return (
    <SettingsPageContainer>
      <SettingsSection
        id="scientific-computing"
        title="Scientific Computing"
        icon={<SigmaIcon className="size-4 text-muted-foreground" />}
        variant="plain"
        headerAction={
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
        }
      >
        <div className="px-3 sm:px-4">
          <SettingsSourceGroup
            activePanelId={selectedId ? `scientific-computing-${selectedId}` : null}
          >
            <SettingsSourceStrip label="Scientific computing languages" wrap>
              {languageItems.map((language) => {
                const languageId = language.id;
                return (
                  <SettingsSourceStripItem
                    key={languageId}
                    id={`scientific-computing-${languageId}-trigger`}
                    controls={`scientific-computing-${languageId}`}
                    expanded={languageId === selectedId}
                    separated={false}
                    chevron={false}
                    label={language.label}
                    detail={language.detail}
                    icon={<LanguageMark languageId={languageId} className="size-6" />}
                    onToggle={() => setStoredLanguageId(languageId)}
                  />
                );
              })}
            </SettingsSourceStrip>
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
                    >
                      <ComputeLanguagePanel
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
                      toolkitChange={toolkitChange}
                      onToolkitChange={setToolkitChange}
                    />
                  </>
                )}
              </SelectedLanguageRuntime>
            ) : null}
          </SettingsSourceGroup>
          {moreLanguages.length > 0 ? <MoreLanguages languages={moreLanguages} /> : null}
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
