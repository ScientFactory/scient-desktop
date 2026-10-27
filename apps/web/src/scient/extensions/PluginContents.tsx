import { ExtensionContentDialog } from "./ExtensionContentDialog";
import { ConnectorToolsList } from "./ConnectorToolsList";
import { DialogFooter } from "../../components/ui/dialog";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../../components/ui/collapsible";
import { MCP_SERVER_STATUS_TEXT } from "./extensionsView";
import { scientSkillsInventory } from "../skills/scientSkillsState";
import {
  type ExtensionPluginContents,
  type ExtensionPluginContentsInput,
  type ExtensionPluginSkill,
  type ServerProvider,
} from "@t3tools/contracts";
import { nativePluginSkill } from "./pluginSkillInvocation";
import { formatProviderSkillDisplayName } from "@t3tools/shared/inlineSkills";
import { BookOpenIcon, ChevronDownIcon, ChevronRightIcon, ServerIcon } from "lucide-react";
import { useContext, useEffect, useRef, useState } from "react";
import { RegistryContext } from "@effect/atom-react";
import { Button } from "../../components/ui/button";
import { useEnvironmentQuery } from "../../state/query";
import { SkillCard } from "../skills/SkillCard";
import { useTryComposerSkill } from "../skills/composerSkills";
import { CardRow, DetailSection, GroupsCard } from "./ExtensionDetailPages";
import { ExtensionIcon } from "./ExtensionRow";
import { ProviderAppConnect } from "./ExtensionItems";
import { useExtensionsEnvironment, MutedLine } from "./ExtensionsPage";
import {
  extensionsPluginContents,
  extensionsSkillDocument,
  extensionsProviderStoreEntry,
} from "./extensionsState";

function PluginSkillCard({
  skill,
  input,
  provider,
  onClose,
  iconUrl,
}: {
  readonly iconUrl?: string | undefined;
  readonly skill: ExtensionPluginSkill;
  readonly input: ExtensionPluginContentsInput;
  readonly provider?: ServerProvider | undefined;
  readonly onClose: () => void;
}) {
  const { environmentId, providers } = useExtensionsEnvironment();
  const managed = useEnvironmentQuery(
    skill.releaseKey ? scientSkillsInventory({ environmentId, input: {} }) : null,
  );
  const document = useEnvironmentQuery(
    skill.documentAvailable
      ? extensionsSkillDocument({ environmentId, input: { ...input, skillId: skill.id } })
      : null,
  );
  const native = nativePluginSkill(provider, input, skill);
  const managedProvider =
    skill.enabled &&
    skill.releaseKey &&
    managed.data?.skills.some((item) => item.releaseKey === skill.releaseKey && item.active)
      ? providers.find(
          (item) =>
            item.enabled &&
            item.installed &&
            managed.data?.supportedProviders.includes(item.driver) &&
            !item.skills.some((candidate) => candidate.name === skill.name),
        )
      : undefined;
  const trySkill = useTryComposerSkill(
    environmentId,
    managedProvider ?? (native ? provider : undefined),
    native?.name ?? skill.name,
    input.cwd,
  );
  return (
    <SkillCard
      iconUrl={iconUrl}
      name={skill.name}
      displayName={skill.displayName}
      description={skill.description}
      environmentId={environmentId}
      instructions={document.data?.instructions ?? null}
      error={
        skill.documentAvailable ? document.error : "Install this plugin to read its skill document."
      }
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      onTry={trySkill}
    />
  );
}

function PluginContentsView({
  contents,
  provider,
  pluginId,
  onSkill,
  onSkillPrefetch,
  onConnectionChange,
  canConnectApps = true,
  iconUrl,
}: {
  readonly contents: ExtensionPluginContents;
  readonly provider?: ServerProvider | undefined;
  readonly pluginId: string;
  readonly onSkill: (skill: ExtensionPluginSkill) => void;
  readonly onSkillPrefetch: (skill: ExtensionPluginSkill) => void;
  readonly onConnectionChange?: (() => void) | undefined;
  readonly canConnectApps?: boolean | undefined;
  readonly iconUrl?: string | undefined;
}) {
  const { environmentId } = useExtensionsEnvironment();
  const [appDialog, setAppDialog] = useState<ExtensionPluginContents["apps"][number] | null>(null);
  const toolCounts = appDialog?.toolCounts ?? {
    read: appDialog?.toolSummaries?.filter((tool) => tool.isReadOnly).length ?? 0,
    write: appDialog?.toolSummaries?.filter((tool) => !tool.isReadOnly).length ?? 0,
  };
  const [expanded, setExpanded] = useState(false);
  const hidden = contents.skills.slice(5);
  const more = `See ${hidden
    .slice(0, 2)
    .map((skill) => formatProviderSkillDisplayName(skill))
    .join(", ")}${hidden.length > 2 ? `, and ${hidden.length - 2} more` : ""}`;
  return (
    <>
      {contents.apps.length ? (
        <DetailSection title="Apps" count={contents.apps.length}>
          <div>
            {contents.apps.map((app) => (
              <div
                key={app.id ?? app.name}
                className="flex items-center gap-3 rounded-lg px-3 hover:bg-muted/50 focus-within:bg-muted/50"
              >
                <button
                  type="button"
                  aria-label={`View ${app.name} app`}
                  onClick={() => setAppDialog(app)}
                  className="flex min-w-0 flex-1 items-center gap-3 rounded-lg py-3 text-left outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring"
                >
                  <ExtensionIcon name={app.name} iconUrl={app.iconUrl} />
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium">{app.name}</p>
                    {app.description ? (
                      <p className="truncate text-sm text-muted-foreground">{app.description}</p>
                    ) : null}
                  </div>
                </button>
                {!app.enabled ? (
                  <span className="text-sm text-muted-foreground">Disabled</span>
                ) : app.connected ? (
                  <span className="text-sm text-muted-foreground">Connected</span>
                ) : !canConnectApps ? (
                  <span className="text-sm text-muted-foreground">Install to connect</span>
                ) : provider?.driver === "codex" && app.installUrl ? (
                  <ProviderAppConnect
                    provider={provider}
                    pluginId={pluginId}
                    app={app}
                    onConnectionChange={onConnectionChange}
                  />
                ) : (
                  <span className="text-sm text-muted-foreground">Not connected</span>
                )}
              </div>
            ))}
          </div>
        </DetailSection>
      ) : null}
      {contents.mcpServers.length ? (
        <DetailSection title="MCP servers" count={contents.mcpServers.length}>
          <div>
            {contents.mcpServers.map((server) => (
              <div
                key={server.name}
                className="flex min-h-14 items-center gap-3 rounded-lg px-3 py-3 hover:bg-muted/50"
              >
                <ServerIcon aria-hidden className="size-5 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1 text-sm">{server.name}</span>
                {server.status ? (
                  <span className="text-sm text-muted-foreground">{server.status}</span>
                ) : null}
              </div>
            ))}
          </div>
        </DetailSection>
      ) : null}
      {contents.skills.length ? (
        <DetailSection title="Skills" count={contents.skills.length}>
          <div>
            {(expanded ? contents.skills : contents.skills.slice(0, 5)).map((skill) => (
              <button
                key={skill.id}
                type="button"
                className="flex w-full min-w-0 items-center gap-3 rounded-lg px-3 py-3 text-left outline-none hover:bg-muted/50 focus-visible:bg-muted/50 focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring"
                onClick={() => onSkill(skill)}
                onMouseEnter={() => onSkillPrefetch(skill)}
                onFocus={() => onSkillPrefetch(skill)}
              >
                <ExtensionIcon
                  name={skill.name}
                  iconUrl={iconUrl}
                  glyph={iconUrl ? undefined : BookOpenIcon}
                  unframed
                />
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-medium">
                    {formatProviderSkillDisplayName(skill)}
                  </span>
                  <span className="block truncate text-sm text-muted-foreground">
                    {skill.description}
                  </span>
                </span>
              </button>
            ))}
            {hidden.length && !expanded ? (
              <CardRow>
                <Button
                  size="sm"
                  variant="ghost-muted"
                  onClick={() => setExpanded(true)}
                  aria-expanded={expanded}
                >
                  <ChevronDownIcon aria-hidden />
                  {more}
                </Button>
              </CardRow>
            ) : null}
          </div>
        </DetailSection>
      ) : null}
      {appDialog ? (
        <ExtensionContentDialog
          name={appDialog.name}
          kind="App"
          framed={false}
          iconUrl={appDialog.iconUrl}
          description={appDialog.description ?? ""}
          onOpenChange={(open) => {
            if (!open) setAppDialog(null);
          }}
          footer={
            <DialogFooter variant="bare" padding="compact">
              {canConnectApps &&
              appDialog.enabled &&
              provider?.driver === "codex" &&
              appDialog.installUrl &&
              !appDialog.connected ? (
                <ProviderAppConnect
                  provider={provider}
                  pluginId={pluginId}
                  app={appDialog}
                  onConnectionChange={onConnectionChange}
                />
              ) : (
                <Button variant="outline" onClick={() => setAppDialog(null)}>
                  Close
                </Button>
              )}
            </DialogFooter>
          }
        >
          <div className="space-y-3 px-4 pb-4">
            {appDialog.toolSummaries ? (
              <>
                <p className="text-sm text-muted-foreground">
                  The {appDialog.name} app contains {toolCounts.read + toolCounts.write} tools (
                  {toolCounts.write} write, {toolCounts.read} read)
                  {appDialog.toolSummaries.length < toolCounts.read + toolCounts.write
                    ? `. Showing the first ${appDialog.toolSummaries.length}.`
                    : null}
                </p>
                <div className="divide-y divide-border overflow-hidden rounded-xl border bg-card">
                  {[false, true].map((readOnly) => {
                    const tools = appDialog.toolSummaries!.filter(
                      (tool) => tool.isReadOnly === readOnly,
                    );
                    if (tools.length === 0) return null;
                    return (
                      <Collapsible key={String(readOnly)}>
                        <CollapsibleTrigger className="group flex w-full items-center gap-2 px-4 py-3 text-left text-sm outline-none transition-colors hover:bg-foreground/[0.035] focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring">
                          {readOnly ? "Read" : "Write"}{" "}
                          <span className="text-muted-foreground">
                            {readOnly ? toolCounts.read : toolCounts.write}
                          </span>
                          <ChevronRightIcon
                            aria-hidden
                            className="ml-auto size-4 text-muted-foreground transition-transform group-data-[panel-open]:rotate-90"
                          />
                        </CollapsibleTrigger>
                        <CollapsiblePanel>
                          <ConnectorToolsList
                            embedded
                            environmentId={environmentId}
                            tools={tools.map((tool) => ({
                              name: tool.name,
                              ...(tool.title ? { title: tool.title } : {}),
                              description: tool.description,
                              readOnly: tool.isReadOnly,
                            }))}
                          />
                        </CollapsiblePanel>
                      </Collapsible>
                    );
                  })}
                </div>
              </>
            ) : (
              <p className="text-sm text-muted-foreground">Tool details are not available.</p>
            )}
          </div>
        </ExtensionContentDialog>
      ) : null}
      {contents.commands.length || contents.agents.length || contents.hooks?.length ? (
        <DetailSection title="More">
          <GroupsCard
            label="Other contents"
            groups={[
              { label: "Commands", rows: contents.commands.map((name) => ({ key: name, name })) },
              { label: "Agents", rows: contents.agents.map((name) => ({ key: name, name })) },
              {
                label: "Hooks",
                rows: [...new Set(contents.hooks ?? [])].map((name) => ({ key: name, name })),
              },
            ]}
          />
        </DetailSection>
      ) : null}
    </>
  );
}

export function PluginContents({
  input,
  provider,
  canConnectApps = true,
  iconUrl,
}: {
  readonly input: ExtensionPluginContentsInput;
  readonly provider?: ServerProvider | undefined;
  readonly canConnectApps?: boolean | undefined;
  readonly iconUrl?: string | undefined;
}) {
  const { environmentId } = useExtensionsEnvironment();
  const registry = useContext(RegistryContext);
  const atom = extensionsPluginContents({ environmentId, input });
  const contents = useEnvironmentQuery(atom);
  const prefetches = useRef(new Map<string, () => void>());
  useEffect(() => {
    const mounted = prefetches.current;
    return () => {
      for (const unmount of mounted.values()) unmount();
      mounted.clear();
    };
  }, []);
  const prefetch = (skill: ExtensionPluginSkill) => {
    const key = JSON.stringify([environmentId, input, skill.id]);
    if (!skill.documentAvailable || prefetches.current.has(key)) return;
    if (prefetches.current.size >= 200) {
      const first = prefetches.current.entries().next().value!;
      first[1]();
      prefetches.current.delete(first[0]);
    }
    prefetches.current.set(
      key,
      registry.mount(
        extensionsSkillDocument({ environmentId, input: { ...input, skillId: skill.id } }),
      ),
    );
  };

  const pluginEntry = useEnvironmentQuery(
    !iconUrl && provider?.driver === "codex" && (input.pluginId || input.entryId)
      ? extensionsProviderStoreEntry({
          environmentId,
          input: { instanceId: provider.instanceId, entryId: (input.pluginId ?? input.entryId)! },
        })
      : null,
  );
  const pluginIcon = iconUrl ?? pluginEntry.data?.iconUrl;

  useEffect(() => {
    const refresh = () => registry.refresh(atom);
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, [atom, registry]);
  const [selected, setSelected] = useState<ExtensionPluginSkill | null>(null);
  const knownServers = input.cwd ? [] : (provider?.mcpServers ?? []);
  if (!contents.data) return <MutedLine>{contents.error ?? "Loading contents…"}</MutedLine>;
  const value = {
    ...contents.data,
    mcpServers: contents.data.mcpServers.map((server) => ({
      ...server,
      status: (() => {
        const status = knownServers.find((item) => item.name === server.name)?.status;
        return status === "connected"
          ? "Connected"
          : status
            ? (MCP_SERVER_STATUS_TEXT[status] ?? undefined)
            : server.status;
      })(),
    })),
  };
  return (
    <>
      {contents.data.deferred ? (
        <MutedLine>Skills and tools appear after you install it.</MutedLine>
      ) : null}
      <PluginContentsView
        contents={value}
        iconUrl={pluginIcon}
        canConnectApps={canConnectApps}
        provider={provider}
        pluginId={input.pluginId ?? input.entryId ?? ""}
        onSkill={setSelected}
        onSkillPrefetch={prefetch}
        onConnectionChange={() => registry.refresh(atom)}
      />
      {selected ? (
        <PluginSkillCard
          key={selected.id}
          skill={selected}
          iconUrl={pluginIcon}
          input={input}
          provider={provider}
          onClose={() => setSelected(null)}
        />
      ) : null}
    </>
  );
}
