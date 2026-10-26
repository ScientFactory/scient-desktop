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
import { BookOpenIcon, ChevronDownIcon, ServerIcon } from "lucide-react";
import { useContext, useEffect, useState } from "react";
import { RegistryContext } from "@effect/atom-react";
import { Button } from "../../components/ui/button";
import { useEnvironmentQuery } from "../../state/query";
import { SkillCard } from "../skills/SkillCard";
import { useTryComposerSkill } from "../skills/composerSkills";
import { CardRow, DetailCard, DetailSection, GroupsCard } from "./ExtensionDetailPages";
import { ExtensionIcon } from "./ExtensionRow";
import { ProviderAppConnect } from "./ExtensionItems";
import { useExtensionsEnvironment, MutedLine } from "./ExtensionsPage";
import { extensionsPluginContents, extensionsSkillDocument } from "./extensionsState";

function PluginSkillCard({
  skill,
  input,
  provider,
  onClose,
}: {
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
  onConnectionChange,
  canConnectApps = true,
}: {
  readonly contents: ExtensionPluginContents;
  readonly provider?: ServerProvider | undefined;
  readonly pluginId: string;
  readonly onSkill: (skill: ExtensionPluginSkill) => void;
  readonly onConnectionChange?: (() => void) | undefined;
  readonly canConnectApps?: boolean | undefined;
}) {
  const [expanded, setExpanded] = useState(false);
  const hidden = contents.skills.slice(5);
  const more = `See ${hidden
    .slice(0, 2)
    .map((skill) => formatProviderSkillDisplayName(skill))
    .join(", ")}${hidden.length > 2 ? `, and ${hidden.length - 2} more` : ""}`;
  return (
    <>
      {contents.apps.length ? (
        <DetailSection title={`Apps ${contents.apps.length}`}>
          <DetailCard>
            {contents.apps.map((app) => (
              <CardRow key={app.id ?? app.name}>
                <ExtensionIcon name={app.name} iconUrl={app.iconUrl} />
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium">{app.name}</p>
                  {app.description ? (
                    <p className="truncate text-sm text-muted-foreground">{app.description}</p>
                  ) : null}
                </div>
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
              </CardRow>
            ))}
          </DetailCard>
        </DetailSection>
      ) : null}
      {contents.mcpServers.length ? (
        <DetailSection title={`MCP servers ${contents.mcpServers.length}`}>
          <DetailCard>
            {contents.mcpServers.map((server) => (
              <CardRow key={server.name}>
                <ServerIcon aria-hidden className="size-5 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1 text-sm">{server.name}</span>
                {server.status ? (
                  <span className="text-sm text-muted-foreground">{server.status}</span>
                ) : null}
              </CardRow>
            ))}
          </DetailCard>
        </DetailSection>
      ) : null}
      {contents.skills.length ? (
        <DetailSection title={`Skills ${contents.skills.length}`}>
          <DetailCard>
            {(expanded ? contents.skills : contents.skills.slice(0, 5)).map((skill) => (
              <CardRow key={skill.id}>
                <button
                  type="button"
                  className="flex min-w-0 flex-1 items-center gap-3 rounded-md text-left outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                  onClick={() => onSkill(skill)}
                >
                  <ExtensionIcon name={skill.name} glyph={BookOpenIcon} />
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm font-medium">
                      {formatProviderSkillDisplayName(skill)}
                    </span>
                    <span className="block truncate text-sm text-muted-foreground">
                      {skill.description}
                    </span>
                  </span>
                </button>
              </CardRow>
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
          </DetailCard>
        </DetailSection>
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
}: {
  readonly input: ExtensionPluginContentsInput;
  readonly provider?: ServerProvider | undefined;
  readonly canConnectApps?: boolean | undefined;
}) {
  const { environmentId } = useExtensionsEnvironment();
  const registry = useContext(RegistryContext);
  const atom = extensionsPluginContents({ environmentId, input });
  const contents = useEnvironmentQuery(atom);
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
        canConnectApps={canConnectApps}
        provider={provider}
        pluginId={input.pluginId ?? input.entryId ?? ""}
        onSkill={setSelected}
        onConnectionChange={() => registry.refresh(atom)}
      />
      {selected ? (
        <PluginSkillCard
          key={selected.id}
          skill={selected}
          input={input}
          provider={provider}
          onClose={() => setSelected(null)}
        />
      ) : null}
    </>
  );
}
