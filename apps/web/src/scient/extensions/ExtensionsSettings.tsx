import { useAtomValue } from "@effect/atom-react";
import {
  AuthSettingsWriteScope,
  type DiscoverEntry,
  type EnvironmentId,
  type ProviderInstanceId,
} from "@t3tools/contracts";
import { PlusIcon, PuzzleIcon } from "lucide-react";
import { useState } from "react";

import {
  SettingsPageContainer,
  SettingsRow,
  SettingsSection,
  useSettingsSearchTargetId,
} from "../../components/settings/settingsLayout";
import { useOptionalSettingsScope } from "../../components/settings/SettingsScopeContext";
import { searchableSetting } from "../../components/settings/settingsSearch";
import { Button } from "../../components/ui/button";
import { NativeSelect } from "../../components/ui/select";
import { Toggle, ToggleGroup } from "../../components/ui/toggle-group";
import { useProjects } from "../../state/entities";
import { useEnvironmentHttpBaseUrl, usePrimaryEnvironmentId } from "../../state/environments";
import { useEnvironmentQuery } from "../../state/query";
import { providersIgnoringCheckedAtAtom } from "../../state/server";
import { useEnvironmentScope } from "../../state/session";
import { AddConnectorDialog } from "./AddConnectorDialog";
import { ConnectorRow } from "./ConnectorRow";
import { DiscoverPanel } from "./DiscoverPanel";
import { extensionsInventory } from "./extensionsState";
import {
  callbackOriginOf,
  collectProviderExtensionGroups,
  connectorsReach,
  EXTENSION_KIND_LABELS,
  type ExtensionKindFilter,
  worksWithOptions,
} from "./extensionsView";
import { ProviderPluginsSection } from "./ProviderPluginsSection";
import { ScientPluginsSection } from "./ScientPluginsSection";

type ExtensionsTab = "installed" | "discover";

const TAB_LABELS: Readonly<Record<ExtensionsTab, string>> = {
  installed: "Installed",
  discover: "Discover",
};

/** The tab that holds each settings-search target on this page. */
const SEARCH_TARGET_TABS: Readonly<Record<string, ExtensionsTab>> = {
  "extensions-discover": "discover",
  "extensions-connected-services": "installed",
  "extensions-scient-plugins": "installed",
  "extensions-provider-plugins": "installed",
};

/**
 * Settings ▸ Extensions for the one environment the settings scope chose (the
 * one its picker names), or the primary environment outside a scope.
 */
export function ExtensionsSettings() {
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const scope = useOptionalSettingsScope();
  const environmentId =
    scope === null ? primaryEnvironmentId : (scope.environment?.environmentId ?? null);
  return (
    <SettingsPageContainer>
      {environmentId === null ? (
        <SettingsSection
          {...searchableSetting("extensions")}
          icon={<PuzzleIcon className="size-4" />}
          variant="plain"
        >
          <SettingsRow
            title="No execution environment"
            description="Connect an execution environment to manage extensions."
          />
        </SettingsSection>
      ) : (
        <EnvironmentExtensionsSettings key={environmentId} environmentId={environmentId} />
      )}
    </SettingsPageContainer>
  );
}

function EnvironmentExtensionsSettings({
  environmentId,
}: {
  readonly environmentId: EnvironmentId;
}) {
  const providers = useAtomValue(providersIgnoringCheckedAtAtom(environmentId));
  const allProjects = useProjects();
  const inventory = useEnvironmentQuery(extensionsInventory({ environmentId, input: {} }));
  const canWrite = useEnvironmentScope(environmentId, AuthSettingsWriteScope);
  const callbackOrigin = callbackOriginOf(useEnvironmentHttpBaseUrl(environmentId));
  const searchTargetId = useSettingsSearchTargetId();
  const [tab, setTab] = useState<ExtensionsTab>(
    (searchTargetId === null ? undefined : SEARCH_TARGET_TABS[searchTargetId]) ?? "installed",
  );
  const [kind, setKind] = useState<ExtensionKindFilter>("all");
  const [handledTargetId, setHandledTargetId] = useState(searchTargetId);
  if (searchTargetId !== handledTargetId) {
    // A later search result on the same page shows its tab, unfiltered.
    setHandledTargetId(searchTargetId);
    const targetTab = searchTargetId === null ? undefined : SEARCH_TARGET_TABS[searchTargetId];
    if (targetTab !== undefined) {
      setTab(targetTab);
      setKind("all");
    }
  }
  const [worksWith, setWorksWith] = useState<ProviderInstanceId | null>(null);
  const [addDialog, setAddDialog] = useState<{ readonly entry: DiscoverEntry | null } | null>(null);

  const data = inventory.data;
  const options = worksWithOptions(data?.providerSupport ?? [], providers);
  const selectedOption = options.find((option) => option.instanceId === worksWith) ?? null;
  const projects = allProjects
    .filter((project) => project.environmentId === environmentId && project.isScratch !== true)
    .map((project) => ({ id: project.id, title: project.title }));
  const providerGroups = collectProviderExtensionGroups(
    providers,
    selectedOption?.instanceId ?? null,
  );
  const showConnectors = kind === "all" || kind === "connectors";
  const showScientPlugins = kind === "all" || kind === "scient-plugins";
  const showProviderPlugins = kind === "all" || kind === "provider-plugins";

  return (
    <>
      <SettingsSection
        {...searchableSetting("extensions")}
        icon={<PuzzleIcon className="size-4" />}
        variant="plain"
        headerAction={
          <ToggleGroup
            aria-label="Extensions view"
            variant="segmented"
            value={[tab]}
            onValueChange={(next) => {
              const value = next[0];
              if (value === "installed" || value === "discover") setTab(value);
            }}
          >
            {(Object.keys(TAB_LABELS) as ExtensionsTab[]).map((value) => (
              <Toggle key={value} value={value}>
                {TAB_LABELS[value]}
              </Toggle>
            ))}
          </ToggleGroup>
        }
      >
        {tab === "discover" ? (
          <DiscoverPanel
            environmentId={environmentId}
            canWrite={canWrite}
            onAdd={(entry) => setAddDialog({ entry })}
          />
        ) : (
          <div className="grid gap-6">
            <div className="flex flex-wrap items-center gap-3 px-3 sm:px-4">
              <ToggleGroup
                aria-label="Kind"
                variant="segmented"
                value={[kind]}
                onValueChange={(next) => {
                  const value = next[0] as ExtensionKindFilter | undefined;
                  if (value !== undefined && value in EXTENSION_KIND_LABELS) setKind(value);
                }}
              >
                {(Object.keys(EXTENSION_KIND_LABELS) as ExtensionKindFilter[]).map((value) => (
                  <Toggle key={value} value={value}>
                    {EXTENSION_KIND_LABELS[value]}
                  </Toggle>
                ))}
              </ToggleGroup>
              <label className="flex items-center gap-2 text-xs text-muted-foreground">
                Works with
                <span className="w-40">
                  <NativeSelect
                    size="sm"
                    aria-label="Works with"
                    value={worksWith ?? ""}
                    onChange={(event) =>
                      setWorksWith(
                        options.find((option) => option.instanceId === event.target.value)
                          ?.instanceId ?? null,
                      )
                    }
                  >
                    <option value="">Any agent</option>
                    {options.map((option) => (
                      <option key={option.instanceId} value={option.instanceId}>
                        {option.label}
                      </option>
                    ))}
                  </NativeSelect>
                </span>
              </label>
            </div>
            {inventory.error ? (
              <SettingsRow title="Extensions unavailable" description={inventory.error} />
            ) : null}
            {data?.diagnostics.map((diagnostic) => (
              <SettingsRow
                key={`${diagnostic.code}:${diagnostic.subject ?? ""}`}
                title="Needs attention"
                description={diagnostic.message}
                status={diagnostic.subject}
              />
            ))}
            {!canWrite ? (
              <p className="px-3 text-xs text-muted-foreground sm:px-4">
                This connection can view extensions but not change them.
              </p>
            ) : null}
            {showConnectors ? (
              <SettingsSection
                {...searchableSetting("extensions-connected-services")}
                headerAction={
                  <Button
                    size="xs"
                    variant="outline"
                    disabled={!canWrite}
                    onClick={() => setAddDialog({ entry: null })}
                  >
                    <PlusIcon aria-hidden />
                    Add
                  </Button>
                }
              >
                {data === null ? (
                  <SettingsRow title={inventory.error ? "Unavailable" : "Loading"} />
                ) : !connectorsReach(selectedOption) ? (
                  <SettingsRow
                    title={`Not available in ${selectedOption?.label ?? "this agent"}`}
                    description={
                      selectedOption?.support?.reason ??
                      "This agent does not report support for remote MCP servers."
                    }
                  />
                ) : data.connectors.length === 0 ? (
                  <SettingsRow
                    title="No connected services"
                    description="Add a remote MCP server by URL or from Discover."
                  />
                ) : (
                  <>
                    {selectedOption?.support?.status === "conditional" &&
                    selectedOption.support.reason ? (
                      <p className="px-3 pt-2 text-xs text-muted-foreground sm:px-4">
                        {selectedOption.support.reason}
                      </p>
                    ) : null}
                    {data.connectors.map((connector) => (
                      <ConnectorRow
                        key={connector.connectorId}
                        environmentId={environmentId}
                        connector={connector}
                        projects={projects}
                        selections={data.projectSelections.filter(
                          (selection) => selection.connectorId === connector.connectorId,
                        )}
                        canWrite={canWrite}
                        callbackOrigin={callbackOrigin}
                      />
                    ))}
                  </>
                )}
              </SettingsSection>
            ) : null}
            {showScientPlugins && data !== null ? (
              <ScientPluginsSection
                environmentId={environmentId}
                plugins={data.plugins}
                canWrite={canWrite}
              />
            ) : null}
            {showProviderPlugins ? (
              <ProviderPluginsSection
                environmentId={environmentId}
                groups={providerGroups}
                canWrite={canWrite}
              />
            ) : null}
          </div>
        )}
      </SettingsSection>
      {addDialog !== null ? (
        <AddConnectorDialog
          open
          onOpenChange={(open) => {
            if (!open) setAddDialog(null);
          }}
          environmentId={environmentId}
          entry={addDialog.entry}
          callbackOrigin={callbackOrigin}
        />
      ) : null}
    </>
  );
}
