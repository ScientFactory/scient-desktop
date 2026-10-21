import type { EnvironmentId, ExtensionComponent, ScientPluginSummary } from "@t3tools/contracts";
import type { AtomCommandResult } from "@t3tools/client-runtime/state/runtime";
import { Link } from "@tanstack/react-router";
import { useState } from "react";

import { SettingsRow, SettingsSection } from "../../components/settings/settingsLayout";
import {
  searchableSetting,
  SETTINGS_SECTION_LABELS,
  type SettingsPath,
} from "../../components/settings/settingsSearch";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { Switch } from "../../components/ui/switch";
import { ensureLocalApi } from "../../localApi";
import { useAtomCommand } from "../../state/use-atom-command";
import { installScientPlugin, removeScientPlugin, setScientPluginEnabled } from "./extensionsState";
import { ActionError, commandFailureMessage } from "./ExtensionsFeedback";

const COMPONENT_LABELS: Readonly<Record<ExtensionComponent["type"], string>> = {
  skill: "Skill",
  "mcp-tools": "Tools",
  connector: "Connector",
  settings: "Settings",
  panel: "Panel",
};

/** Plugins name their settings page; only known settings sections are linked. */
function isSettingsPath(path: string | undefined): path is SettingsPath {
  return path !== undefined && Object.hasOwn(SETTINGS_SECTION_LABELS, path);
}

function ComponentList({ components }: { readonly components: ScientPluginSummary["components"] }) {
  if (components.length === 0) return null;
  return (
    <ul className="flex flex-wrap gap-1.5 pb-2">
      {components.map((component) => (
        <li key={`${component.type}:${component.name}`}>
          <Badge variant="outline" title={component.detail}>
            {COMPONENT_LABELS[component.type]} · {component.name}
          </Badge>
        </li>
      ))}
    </ul>
  );
}

export function ScientPluginsSection({
  environmentId,
  plugins,
  canWrite,
}: {
  readonly environmentId: EnvironmentId;
  readonly plugins: ReadonlyArray<ScientPluginSummary>;
  readonly canWrite: boolean;
}) {
  const setEnabled = useAtomCommand(setScientPluginEnabled, { reportFailure: true });
  const remove = useAtomCommand(removeScientPlugin, { reportFailure: true });
  const install = useAtomCommand(installScientPlugin, { reportFailure: true });
  const [busyPluginId, setBusyPluginId] = useState<string | null>(null);
  const [pluginError, setPluginError] = useState<{
    readonly pluginId: string;
    readonly message: string;
  } | null>(null);
  const [installPath, setInstallPath] = useState("");
  const [installing, setInstalling] = useState(false);
  const [installError, setInstallError] = useState<string | null>(null);
  const locked = !canWrite || busyPluginId !== null;

  const runFor = async (
    pluginId: string,
    execute: () => Promise<AtomCommandResult<unknown, unknown>>,
  ) => {
    if (locked) return;
    setBusyPluginId(pluginId);
    setPluginError(null);
    const message = commandFailureMessage(await execute().finally(() => setBusyPluginId(null)));
    if (message !== null) setPluginError({ pluginId, message });
  };

  const submitInstall = async () => {
    const path = installPath.trim();
    if (!canWrite || installing || path.length === 0) return;
    setInstalling(true);
    setInstallError(null);
    const result = await install({ environmentId, input: { path } });
    setInstalling(false);
    setInstallError(commandFailureMessage(result));
    if (result._tag === "Success") setInstallPath("");
  };

  const builtIns = plugins.filter((plugin) => plugin.origin === "built-in");
  const bundles = plugins.filter((plugin) => plugin.origin === "bundle");

  return (
    <SettingsSection {...searchableSetting("extensions-scient-plugins")}>
      {builtIns.map((plugin) => (
        <SettingsRow
          key={plugin.pluginId}
          data-plugin-id={plugin.pluginId}
          title={plugin.displayName}
          description={plugin.description}
          status={`Built into Scient · ${plugin.version}`}
          control={
            isSettingsPath(plugin.settingsPath) ? (
              <Link
                to={plugin.settingsPath}
                className="text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
              >
                Settings
              </Link>
            ) : undefined
          }
        >
          <ComponentList components={plugin.components} />
        </SettingsRow>
      ))}
      {bundles.map((plugin) => (
        <SettingsRow
          key={plugin.pluginId}
          data-plugin-id={plugin.pluginId}
          title={plugin.displayName}
          description={plugin.description}
          status={[
            `Bundle · ${plugin.version} · ${plugin.publisher}`,
            plugin.digest ? `sha256 ${plugin.digest.slice(0, 12)}` : null,
          ]
            .filter(Boolean)
            .join(" · ")}
          control={
            <>
              {plugin.canRemove ? (
                <Button
                  size="xs"
                  variant="destructive-outline"
                  disabled={locked}
                  onClick={async () => {
                    const confirmed = await ensureLocalApi().dialogs.confirm(
                      `Remove ${plugin.displayName}? Its skills and connected services are removed too.`,
                      { variant: "destructive" },
                    );
                    if (!confirmed) return;
                    await runFor(plugin.pluginId, () =>
                      remove({ environmentId, input: { pluginId: plugin.pluginId } }),
                    );
                  }}
                >
                  Remove
                </Button>
              ) : null}
              {plugin.canSetEnabled ? (
                <Switch
                  checked={plugin.enabled}
                  disabled={locked}
                  aria-label={`${plugin.enabled ? "Turn off" : "Turn on"} ${plugin.displayName}`}
                  onCheckedChange={(checked) =>
                    void runFor(plugin.pluginId, () =>
                      setEnabled({
                        environmentId,
                        input: { pluginId: plugin.pluginId, enabled: Boolean(checked) },
                      }),
                    )
                  }
                />
              ) : null}
            </>
          }
        >
          <ComponentList components={plugin.components} />
          <ActionError
            message={pluginError?.pluginId === plugin.pluginId ? pluginError.message : null}
          />
        </SettingsRow>
      ))}
      <SettingsRow
        title="Install a bundle"
        description="A folder with scient.plugin.json on the computer running this environment. Nothing in it is executed."
      >
        <form
          className="flex flex-wrap items-center gap-2 pb-2"
          onSubmit={(event) => {
            event.preventDefault();
            void submitInstall();
          }}
        >
          <span className="min-w-0 flex-1">
            <Input
              aria-label="Bundle folder path"
              placeholder="/path/to/bundle"
              value={installPath}
              disabled={!canWrite || installing}
              onChange={(event) => setInstallPath(event.target.value)}
            />
          </span>
          <Button
            type="submit"
            size="xs"
            variant="outline"
            disabled={!canWrite || installing || installPath.trim().length === 0}
          >
            {installing ? "Installing…" : "Install"}
          </Button>
        </form>
        <div className="pb-2">
          <ActionError message={installError} />
        </div>
      </SettingsRow>
    </SettingsSection>
  );
}
