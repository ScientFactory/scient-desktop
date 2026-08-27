import { useAtomValue } from "@effect/atom-react";
import { ArrowLeftIcon, ChevronDownIcon, LibraryBigIcon } from "lucide-react";
import { Link } from "@tanstack/react-router";
import { useMemo, useState } from "react";

import { ProviderInstanceIcon } from "../../components/chat/ProviderInstanceIcon";
import {
  SettingsPageContainer,
  SettingsRow,
  SettingsSection,
} from "../../components/settings/settingsLayout";
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
  const environmentId = usePrimaryEnvironmentId();
  const providers = useAtomValue(primaryServerProvidersAtom);
  const groups = useMemo(() => collectExternalSkillProviders(providers), [providers]);
  const [expandedInstanceId, setExpandedInstanceId] = useState<string | null>(null);
  const [pendingPath, setPendingPath] = useState<string | null>(null);
  const setEnabled = useAtomCommand(setProviderSkillEnabled, { reportFailure: true });
  const expandedGroup = groups.find(({ provider }) => provider.instanceId === expandedInstanceId);

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
      <SettingsSection title="External skills" icon={<LibraryBigIcon className="size-4" />}>
        <p className="px-3 pb-1 text-sm leading-relaxed text-muted-foreground sm:px-4">
          Skills reported by your connected agent providers. Project skills stay with their
          workspace.
        </p>
        <Link
          className="group mb-2 ms-1 inline-flex min-h-8 cursor-pointer items-center gap-1.5 rounded-lg px-2 text-sm text-muted-foreground outline-none transition-colors hover:bg-foreground/[0.035] hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring sm:ms-2"
          to="/settings/skills"
        >
          <ArrowLeftIcon className="size-3.5 transition-transform group-hover:-translate-x-0.5" />
          Skills
        </Link>
        {groups.length === 0 ? (
          <SettingsRow
            title="No provider inventories"
            description="Connect an agent provider to view its external skills."
          />
        ) : (
          <div className="px-3 sm:px-4">
            <div className="flex items-center overflow-x-auto py-1 [&::-webkit-scrollbar]:h-[3px]">
              {groups.map(({ provider, skills }, index) => {
                const label = providerLabel(provider.driver, provider.displayName);
                const isOpen = expandedInstanceId === provider.instanceId;
                const panelId = `external-skills-${provider.instanceId}`;
                return (
                  <div key={provider.instanceId} className="flex shrink-0 items-center">
                    {index > 0 ? <span aria-hidden className="mx-2 h-7 w-px bg-border/65" /> : null}
                    <button
                      type="button"
                      aria-controls={panelId}
                      aria-expanded={isOpen}
                      className="group flex cursor-pointer items-center gap-2.5 rounded-lg px-2.5 py-2 text-left outline-none transition-colors hover:bg-foreground/[0.025] focus-visible:z-10 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring aria-expanded:bg-muted/35"
                      onClick={() =>
                        setExpandedInstanceId((current) =>
                          current === provider.instanceId ? null : provider.instanceId,
                        )
                      }
                    >
                      <ProviderInstanceIcon
                        driverKind={provider.driver}
                        displayName={label}
                        accentColor={provider.accentColor}
                        className="size-6"
                        iconClassName="size-5"
                      />
                      <span className="min-w-0">
                        <span className="flex items-center gap-1.5">
                          <span className="truncate text-sm font-medium text-foreground">
                            {label}
                          </span>
                          <ChevronDownIcon
                            aria-hidden
                            className="size-3.5 shrink-0 text-muted-foreground transition-transform group-aria-expanded:rotate-180"
                          />
                        </span>
                        <span className="block text-xs text-muted-foreground">
                          {skills.length} {skills.length === 1 ? "skill" : "skills"}
                        </span>
                      </span>
                    </button>
                  </div>
                );
              })}
            </div>
            {expandedGroup ? (
              <div
                id={`external-skills-${expandedGroup.provider.instanceId}`}
                className="border-b border-border/70 py-1"
              >
                {expandedGroup.skills.length === 0 ? (
                  <SettingsRow
                    title="No global skills reported"
                    description="Project skills stay with their workspace."
                  />
                ) : null}
                {expandedGroup.skills.map(({ skill, displayName, description, source }) => {
                  const pending = pendingPath === skill.path;
                  return (
                    <SettingsRow
                      key={skill.path}
                      className="sm:[&>div]:grid-cols-[minmax(0,1fr)_auto] [&>div>div>p]:max-w-none"
                      title={displayName}
                      description={description}
                      status={`${externalSkillSourceLabel(source)}${
                        skill.canSetEnabled === true
                          ? skill.enabled
                            ? ""
                            : " · Deactivated"
                          : " · Read-only in Scient"
                      }`}
                      control={
                        skill.canSetEnabled === true ? (
                          <Switch
                            checked={skill.enabled}
                            disabled={pending || pendingPath !== null}
                            aria-label={`${skill.enabled ? "Deactivate" : "Activate"} ${displayName}`}
                            onCheckedChange={(checked) =>
                              void updateSkill({
                                instanceId: expandedGroup.provider.instanceId,
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
            ) : null}
          </div>
        )}
      </SettingsSection>
    </SettingsPageContainer>
  );
}
