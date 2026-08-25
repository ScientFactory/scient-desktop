import { useAtomValue } from "@effect/atom-react";
import { ArrowLeftIcon, ChevronRightIcon, PuzzleIcon } from "lucide-react";
import { useNavigate } from "@tanstack/react-router";
import { useMemo, useState } from "react";

import { ProviderInstanceIcon } from "../../components/chat/ProviderInstanceIcon";
import {
  SettingsPageContainer,
  SettingsRow,
  SettingsSection,
} from "../../components/settings/settingsLayout";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../../components/ui/collapsible";
import { Switch } from "../../components/ui/switch";
import { primaryServerProvidersAtom } from "../../state/server";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { useAtomCommand } from "../../state/use-atom-command";
import { AVAILABLE_PROVIDER_OPTIONS } from "../../components/chat/providerIconUtils";
import { collectExternalSkillProviders, externalSkillSourceLabel } from "./externalSkills";
import { setProviderSkillEnabled } from "./scientSkillsState";

function providerLabel(driver: string, displayName: string | undefined): string {
  if (displayName) return displayName;
  return AVAILABLE_PROVIDER_OPTIONS.find((option) => option.value === driver)?.label ?? driver;
}

export function ExternalSkillsSettings() {
  const navigate = useNavigate();
  const environmentId = usePrimaryEnvironmentId();
  const providers = useAtomValue(primaryServerProvidersAtom);
  const groups = useMemo(() => collectExternalSkillProviders(providers), [providers]);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const [pendingPath, setPendingPath] = useState<string | null>(null);
  const setEnabled = useAtomCommand(setProviderSkillEnabled, { reportFailure: true });

  const updateSkill = async (input: {
    readonly instanceId: (typeof groups)[number]["provider"]["instanceId"];
    readonly name: string;
    readonly path: string;
    readonly enabled: boolean;
  }) => {
    if (environmentId === null || pendingPath !== null) return;
    setPendingPath(input.path);
    try {
      await setEnabled({ environmentId, input });
    } finally {
      setPendingPath(null);
    }
  };

  return (
    <SettingsPageContainer>
      <SettingsSection title="External skills" icon={<PuzzleIcon className="size-4" />}>
        <button
          type="button"
          className="mb-2 flex min-h-8 items-center gap-1.5 rounded-md px-3 text-sm text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:px-4"
          onClick={() => void navigate({ to: "/settings/skills" })}
        >
          <ArrowLeftIcon className="size-3.5" />
          Skills
        </button>
        <p className="px-3 pb-2 text-sm leading-relaxed text-muted-foreground sm:px-4">
          Skills reported by your connected agent providers. Project skills stay with their
          workspace.
        </p>
        {groups.length === 0 ? (
          <SettingsRow
            title="No provider inventories"
            description="Connect an agent provider to view its external skills."
          />
        ) : (
          groups.map(({ provider, skills }) => {
            const label = providerLabel(provider.driver, provider.displayName);
            const isOpen = expanded.has(provider.instanceId);
            return (
              <Collapsible
                key={provider.instanceId}
                open={isOpen}
                onOpenChange={(open) =>
                  setExpanded((current) => {
                    const next = new Set(current);
                    if (open) next.add(provider.instanceId);
                    else next.delete(provider.instanceId);
                    return next;
                  })
                }
              >
                <CollapsibleTrigger className="group flex w-full items-center gap-3 rounded-xl px-3 py-3 text-left transition-colors hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:px-4">
                  <ProviderInstanceIcon
                    driverKind={provider.driver}
                    displayName={label}
                    accentColor={provider.accentColor}
                    className="size-6"
                    iconClassName="size-5"
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium text-foreground">
                      {label}
                    </span>
                    <span className="block text-xs text-muted-foreground">
                      {skills.length} {skills.length === 1 ? "skill" : "skills"}
                    </span>
                  </span>
                  <ChevronRightIcon className="size-4 shrink-0 text-muted-foreground transition-transform group-data-panel-open:rotate-90" />
                </CollapsibleTrigger>
                <CollapsiblePanel>
                  <div className="ms-9 border-s border-border/60 ps-3 sm:ms-10 sm:ps-4">
                    {skills.length === 0 ? (
                      <SettingsRow
                        title="No global skills reported"
                        description="Project skills stay with their workspace."
                        className="rounded-lg px-2 sm:px-3"
                      />
                    ) : null}
                    {skills.map(({ skill, displayName, description, source }) => {
                      const pending = pendingPath === skill.path;
                      return (
                        <SettingsRow
                          key={skill.path}
                          title={displayName}
                          description={description}
                          status={`${externalSkillSourceLabel(source)}${
                            skill.canSetEnabled === true
                              ? skill.enabled
                                ? ""
                                : " · Deactivated"
                              : " · Read-only in Scient"
                          }`}
                          className="rounded-lg px-2 sm:px-3"
                          control={
                            skill.canSetEnabled === true ? (
                              <Switch
                                checked={skill.enabled}
                                disabled={pending || pendingPath !== null}
                                aria-label={`${skill.enabled ? "Deactivate" : "Activate"} ${displayName}`}
                                onCheckedChange={(checked) =>
                                  void updateSkill({
                                    instanceId: provider.instanceId,
                                    name: skill.name,
                                    path: skill.path,
                                    enabled: Boolean(checked),
                                  })
                                }
                              />
                            ) : undefined
                          }
                        />
                      );
                    })}
                  </div>
                </CollapsiblePanel>
              </Collapsible>
            );
          })
        )}
      </SettingsSection>
    </SettingsPageContainer>
  );
}
