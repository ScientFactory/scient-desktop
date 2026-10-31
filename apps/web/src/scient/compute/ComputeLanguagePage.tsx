import { Link } from "@tanstack/react-router";
import { ChevronLeftIcon, ExternalLinkIcon, RefreshCwIcon } from "lucide-react";
import { useState, type ReactNode } from "react";
import {
  COMPUTE_ADDED_LOCATION,
  type ComputeLanguageRuntimeInventory,
  type EnvironmentId,
  type ScientificComputingLanguageSettings,
} from "@t3tools/contracts";

import {
  SettingsPageContainer,
  SettingsRow,
  SettingsSection,
} from "~/components/settings/settingsLayout";
import { useOptionalSettingsScope } from "~/components/settings/SettingsScopeContext";
import { SettingsSourcePanel } from "~/components/settings/SettingsSourceStrip";
import { Button } from "~/components/ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { cn } from "~/lib/utils";
import { useEnvironment, usePrimaryEnvironmentId } from "~/state/environments";
import { ComputeLanguageMark } from "./ComputeLanguageMark";
import { AddLocationRow, ComputeLanguagePanel } from "./ComputeLanguagePanel";
import {
  useComputeManagedRuntime,
  type ComputeManagedRuntimeController,
} from "./ComputeManagedRuntimeControls";
import { computeLanguageAbsent, computeLanguageStatus } from "./computeInstallationSettingsModel";
import { computeSourceLanguageForId } from "./computeSourceLanguage";
import { PythonToolkitSettings, type ToolkitChange } from "./PythonToolkitSettings";
import { useComputeLanguages, type ComputeLanguages } from "./useComputeLanguages";

/** The server this page manages: the one asked for, the scope's, or this computer. */
export function useComputeSettingsEnvironment(requested: EnvironmentId | undefined) {
  const primaryId = usePrimaryEnvironmentId();
  const scope = useOptionalSettingsScope();
  const environmentId =
    requested ?? (scope === null ? primaryId : (scope.environment?.environmentId ?? null));
  const environment = useEnvironment(environmentId);
  return environment === null ? null : environmentId;
}

export function ComputeSettingsUnavailable() {
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

export function FindRuntimesButton({ inventory }: { inventory: ComputeLanguages }) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            size="icon-xs"
            variant="ghost-muted"
            disabled={inventory.busy}
            aria-label="Refresh scientific runtimes"
            onClick={() => void inventory.refresh()}
          >
            <RefreshCwIcon className={cn(inventory.busy ? "animate-spin" : undefined)} />
          </Button>
        }
      />
      <TooltipPopup side="top">Find runtimes again</TooltipPopup>
    </Tooltip>
  );
}

export function ComputeInventoryFailure({ inventory }: { inventory: ComputeLanguages }) {
  return inventory.failure ? (
    <p className="text-xs text-destructive" role="alert">
      {inventory.failure}
    </p>
  ) : null;
}

/** Owns the one runtime controller shared by a language's runtime rows and Toolkits. */
function LanguageRuntime({
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

function PythonToolkits({
  language,
  runtime,
  busy,
  change,
  onChange,
}: {
  language: ComputeLanguageRuntimeInventory;
  runtime: ComputeManagedRuntimeController;
  busy: boolean;
  change: ToolkitChange | null;
  onChange: (change: ToolkitChange | null) => void;
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
      className="-mx-3 sm:-mx-4"
    >
      <div className="px-3 sm:px-4">
        <SettingsSourcePanel>
          <PythonToolkitSettings
            toolkits={language.toolkits}
            runtime={runtime}
            disabled={
              runtime.status?.toolkitChanges === undefined
                ? Boolean(busy || runtime.busy)
                : Boolean(busy || runtime.status.operation?.action === "remove")
            }
            change={change}
            onChange={onChange}
          />
        </SettingsSourcePanel>
      </div>
    </SettingsSection>
  );
}

function LanguageHeader({
  languageId,
  name,
  state,
  comingSoon = false,
  inventory,
}: {
  languageId: string;
  name: string;
  state: string | null;
  comingSoon?: boolean;
  inventory: ComputeLanguages;
}) {
  return (
    <header className="flex items-center gap-4">
      <ComputeLanguageMark languageId={languageId} large />
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 flex-wrap items-baseline gap-x-2">
          <h1 className="truncate text-2xl font-medium tracking-[-0.02em] text-foreground">
            {name}
          </h1>
          {comingSoon ? (
            <span className="shrink-0 text-sm text-muted-foreground">Coming soon</span>
          ) : null}
        </div>
        {state ? <p className="text-sm text-muted-foreground">{state}</p> : null}
      </div>
      <FindRuntimesButton inventory={inventory} />
    </header>
  );
}

/** What is here for a language Scient has no runtime for: each file, and room to add another. */
function FoundElsewhere({
  language,
  url,
  preference,
  disabled,
  onChange,
}: {
  language: ComputeLanguageRuntimeInventory;
  url: string | undefined;
  preference: ScientificComputingLanguageSettings;
  disabled: boolean;
  onChange: (next: ScientificComputingLanguageSettings) => Promise<boolean>;
}) {
  const languageId = language.descriptor.languageId;
  const name = language.descriptor.displayName;
  const setup = language.descriptor.setup;
  const [path, setPath] = useState("");
  return (
    <SettingsSourcePanel id={`scientific-computing-${languageId}`}>
      {(language.tools ?? []).map((tool) => (
        <SettingsRow
          key={tool.executable}
          id={`${languageId}-found-${tool.executable}`}
          title={tool.name}
          description={tool.problem ?? tool.executable}
          control={
            tool.origin === COMPUTE_ADDED_LOCATION ? (
              <Button
                size="xs"
                variant="ghost-muted"
                disabled={disabled}
                onClick={() => void onChange({ ...preference, executable: "" })}
              >
                Remove
              </Button>
            ) : (
              <span className="text-xs text-muted-foreground">
                {[tool.version, tool.origin ?? "System"].filter(Boolean).join(" · ")}
              </span>
            )
          }
        />
      ))}
      {setup === undefined && url === undefined ? null : (
        <SettingsRow
          id={`${languageId}-installation-missing`}
          title="Needs"
          description={setup?.needs ?? name}
          control={
            url ? (
              <Button
                size="xs"
                variant="outline"
                render={<a href={url} target="_blank" rel="noreferrer" />}
              >
                Get <ExternalLinkIcon />
              </Button>
            ) : undefined
          }
        />
      )}
      <AddLocationRow
        languageId={languageId}
        name={name}
        action="Add"
        path={path}
        onPathChange={setPath}
        disabled={disabled}
        onAdd={(executable) => onChange({ ...preference, executable })}
      />
    </SettingsSourcePanel>
  );
}

function LanguageDetail({
  environmentId,
  languageId,
}: {
  environmentId: EnvironmentId;
  languageId: string;
}) {
  const inventory = useComputeLanguages(environmentId);
  const [toolkitChange, setToolkitChange] = useState<ToolkitChange | null>(null);
  const language = inventory.languages.find(
    (candidate) => candidate.descriptor.languageId === languageId,
  );
  const name =
    language?.descriptor.displayName ?? computeSourceLanguageForId(languageId).displayName;
  const back = (
    <div>
      <Button
        size="sm"
        variant="ghost-muted"
        className="-ms-2.5"
        render={<Link to="/settings/scientific-computing" search={{ environmentId }} />}
      >
        <ChevronLeftIcon aria-hidden />
        Scientific Computing
      </Button>
    </div>
  );
  if (language === undefined || computeLanguageAbsent(language)) {
    const status =
      language === undefined
        ? null
        : computeLanguageStatus({
            language,
            preference: inventory.preferenceFor(language),
            incomplete: inventory.incomplete,
          });
    return (
      <SettingsPageContainer>
        <div className="grid gap-6">
          {back}
          <LanguageHeader
            languageId={languageId}
            name={name}
            state={inventory.pending ? "Checking…" : (status?.detail ?? "")}
            comingSoon={!inventory.pending && (status?.comingSoon ?? true)}
            inventory={inventory}
          />
          {inventory.pending || language === undefined ? null : (
            <FoundElsewhere
              language={language}
              url={status?.getUrl}
              preference={inventory.preferenceFor(language)}
              disabled={inventory.busy}
              onChange={(next) => inventory.updateLanguage(language.descriptor.languageId, next)}
            />
          )}
          <ComputeInventoryFailure inventory={inventory} />
        </div>
      </SettingsPageContainer>
    );
  }
  const preference = inventory.preferenceFor(language);
  const onChange = (next: ScientificComputingLanguageSettings) =>
    inventory.updateLanguage(language.descriptor.languageId, next);
  return (
    <SettingsPageContainer>
      <LanguageRuntime
        key={languageId}
        environmentId={environmentId}
        language={language}
        preference={preference}
        onChange={onChange}
      >
        {(runtime) => (
          <div className="grid gap-6">
            {back}
            <LanguageHeader
              languageId={languageId}
              name={name}
              state={inventory.pending ? "Checking…" : null}
              inventory={inventory}
            />
            <SettingsSourcePanel id={`scientific-computing-${languageId}`} data-compute-settings="">
              <ComputeLanguagePanel
                language={language}
                preference={preference}
                runtime={runtime}
                onChange={onChange}
                environmentId={environmentId}
                loading={inventory.pending}
                refreshing={inventory.refreshing}
                onRefresh={inventory.refresh}
                refreshVersion={inventory.refreshVersion}
                toolkitChange={languageId === "python" ? toolkitChange : null}
              />
            </SettingsSourcePanel>
            <PythonToolkits
              language={language}
              runtime={runtime}
              busy={inventory.pending || inventory.refreshing}
              change={toolkitChange}
              onChange={setToolkitChange}
            />
            <ComputeInventoryFailure inventory={inventory} />
          </div>
        )}
      </LanguageRuntime>
    </SettingsPageContainer>
  );
}

/** One language's own page: what it runs on, what Scient adds, and everything found for it. */
export function ComputeLanguagePage({
  languageId,
  environmentId: requested,
}: {
  languageId: string;
  environmentId?: EnvironmentId | undefined;
}) {
  const environmentId = useComputeSettingsEnvironment(requested);
  if (environmentId === null) return <ComputeSettingsUnavailable />;
  return (
    <LanguageDetail key={environmentId} environmentId={environmentId} languageId={languageId} />
  );
}
