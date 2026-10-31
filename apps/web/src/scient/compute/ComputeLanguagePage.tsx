import { Link } from "@tanstack/react-router";
import { ChevronLeftIcon, ExternalLinkIcon } from "lucide-react";
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
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import { useEnvironment, usePrimaryEnvironmentId } from "~/state/environments";
import { ComputeLanguageMark } from "./ComputeLanguageMark";
import {
  AddLocationRow,
  ComputeLanguagePanel,
  ComputeScientPartSection,
  foundCountLabel,
  FoundList,
  FoundRow,
  FoundToolRow,
  RefreshRuntimesButton,
} from "./ComputeLanguagePanel";
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
  return <RefreshRuntimesButton busy={inventory.busy} onRefresh={inventory.refresh} />;
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
  children,
}: {
  environmentId: EnvironmentId;
  language: ComputeLanguageRuntimeInventory;
  children: (runtime: ComputeManagedRuntimeController) => ReactNode;
}) {
  const runtime = useComputeManagedRuntime({
    environmentId,
    languageId: language.descriptor.languageId,
    initialStatus: language.managedRuntime,
  });
  return children(runtime);
}

/** Toolkits are what Scient-managed Python holds, so they sit inside its section. */
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
  if (language.toolkits.length === 0 || !runtime.status?.installed) return null;
  return (
    <SettingsSourcePanel id="scientific-computing-toolkits">
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
  );
}

function LanguageHeader({
  languageId,
  name,
  checking,
  comingSoon = false,
}: {
  languageId: string;
  name: string;
  checking: boolean;
  comingSoon?: boolean;
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
        {checking ? <p className="text-sm text-muted-foreground">Checking…</p> : null}
      </div>
    </header>
  );
}

const AUTOMATIC_TOOL = "scient-tool:automatic";

/** For a language that runs from its file: which program runs it, and everything found. */
function FoundPrograms({
  language,
  url,
  unknown,
  preference,
  busy,
  onChange,
  onRefresh,
}: {
  language: ComputeLanguageRuntimeInventory;
  url: string | undefined;
  /** Some places could not be read, so finding nothing proves nothing. */
  unknown: boolean;
  preference: ScientificComputingLanguageSettings;
  busy: boolean;
  onChange: (next: ScientificComputingLanguageSettings) => Promise<boolean>;
  onRefresh: () => Promise<void>;
}) {
  const languageId = language.descriptor.languageId;
  const name = language.descriptor.displayName;
  const setup = language.descriptor.setup;
  const tools = language.tools ?? [];
  const [path, setPath] = useState("");
  const [open, setOpen] = useState(false);
  const chosen = preference.executable.trim();
  const label = (tool: (typeof tools)[number]) =>
    [tool.name, tool.version, tool.origin ?? "System"].filter(Boolean).join(" · ");
  const chosenTool = tools.find((tool) => tool.executable === chosen);
  const onlyTool = tools.length === 1 ? tools[0] : undefined;
  return (
    <SettingsSourcePanel id={`scientific-computing-${languageId}`}>
      {tools.length === 0 ? null : (
        <SettingsRow
          id={`${languageId}-runs-with`}
          title="Runs with"
          control={
            onlyTool ? (
              <span className="text-xs text-muted-foreground">{label(onlyTool)}</span>
            ) : (
              <Select
                value={chosenTool === undefined ? AUTOMATIC_TOOL : chosen}
                disabled={busy}
                onValueChange={(next) => {
                  if (next === null) return;
                  void onChange({
                    ...preference,
                    executable: next === AUTOMATIC_TOOL ? "" : next,
                  });
                }}
              >
                <SelectTrigger size="sm" className="w-auto max-w-64" aria-label={`${name} program`}>
                  <SelectValue>
                    {chosenTool === undefined
                      ? `Automatic · ${tools[0]?.name ?? name}`
                      : label(chosenTool)}
                  </SelectValue>
                </SelectTrigger>
                <SelectPopup
                  align="end"
                  alignItemWithTrigger={false}
                  matchTriggerWidth={false}
                  className="max-w-[calc(100vw-1rem)]"
                >
                  <SelectItem hideIndicator value={AUTOMATIC_TOOL}>
                    {`Automatic · ${tools[0]?.name ?? name}`}
                  </SelectItem>
                  <SelectSeparator />
                  {tools.map((tool) => (
                    <SelectItem key={tool.executable} hideIndicator value={tool.executable}>
                      <span className="block max-w-[calc(100vw-3rem)] truncate sm:max-w-80">
                        {label(tool)}
                      </span>
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            )
          }
        />
      )}
      <FoundRow
        languageId={languageId}
        label={unknown ? "Couldn't check" : foundCountLabel(tools.length)}
        open={open}
        onToggle={() => setOpen((current) => !current)}
        refresh={<RefreshRuntimesButton busy={busy} onRefresh={onRefresh} />}
      />
      {open ? (
        <FoundList languageId={languageId}>
          {tools.map((tool) => (
            <FoundToolRow
              key={tool.executable}
              languageId={languageId}
              tool={tool}
              control={
                tool.origin === COMPUTE_ADDED_LOCATION ? (
                  <Button
                    size="xs"
                    variant="ghost-muted"
                    disabled={busy}
                    onClick={() => void onChange({ ...preference, executable: "" })}
                  >
                    Remove
                  </Button>
                ) : undefined
              }
            />
          ))}
          <AddLocationRow
            languageId={languageId}
            name={name}
            action="Add"
            path={path}
            onPathChange={setPath}
            disabled={busy}
            onAdd={(executable) => onChange({ ...preference, executable })}
          />
        </FoundList>
      ) : null}
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
    </SettingsSourcePanel>
  );
}

/** The sections one language adds to the shared page. New language settings go here. */
function LanguageSpecifics({
  language,
  preference,
  runtime,
  environmentId,
  inventory,
  toolkitChange,
  onToolkitChange,
}: {
  language: ComputeLanguageRuntimeInventory;
  preference: ScientificComputingLanguageSettings;
  runtime: ComputeManagedRuntimeController;
  environmentId: EnvironmentId;
  inventory: ComputeLanguages;
  toolkitChange: ToolkitChange | null;
  onToolkitChange: (change: ToolkitChange | null) => void;
}) {
  return (
    <ComputeScientPartSection
      language={language}
      preference={preference}
      runtime={runtime}
      environmentId={environmentId}
      refreshing={inventory.refreshing}
    >
      {language.descriptor.languageId === "python" ? (
        <PythonToolkits
          language={language}
          runtime={runtime}
          busy={inventory.pending || inventory.refreshing}
          change={toolkitChange}
          onChange={onToolkitChange}
        />
      ) : null}
    </ComputeScientPartSection>
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
            checking={inventory.pending}
            comingSoon={!inventory.pending && (status?.comingSoon ?? true)}
          />
          {inventory.pending || language === undefined ? null : (
            <FoundPrograms
              language={language}
              url={status?.getUrl}
              unknown={status?.unknown ?? false}
              preference={inventory.preferenceFor(language)}
              busy={inventory.busy}
              onChange={(next) => inventory.updateLanguage(language.descriptor.languageId, next)}
              onRefresh={inventory.refresh}
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
      <LanguageRuntime key={languageId} environmentId={environmentId} language={language}>
        {(runtime) => (
          <div className="grid gap-6">
            {back}
            <LanguageHeader languageId={languageId} name={name} checking={inventory.pending} />
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
            <LanguageSpecifics
              language={language}
              preference={preference}
              runtime={runtime}
              environmentId={environmentId}
              inventory={inventory}
              toolkitChange={toolkitChange}
              onToolkitChange={setToolkitChange}
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
