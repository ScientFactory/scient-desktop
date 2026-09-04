import { useAtomValue } from "@effect/atom-react";
import { ArrowLeftIcon, LibraryBigIcon } from "lucide-react";
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
import { SkillSourceStrip, SkillSourceStripItem } from "./SkillSourceStrip";

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
      <SettingsSection
        title="External skills"
        icon={<LibraryBigIcon className="size-4" />}
        variant="plain"
      >
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
            <SkillSourceStrip label="Agent providers">
              {groups.map(({ provider, skills }, index) => {
                const label = providerLabel(provider.driver, provider.displayName);
                const isOpen = expandedInstanceId === provider.instanceId;
                const panelId = `external-skills-${provider.instanceId}`;
                return (
                  <SkillSourceStripItem
                    key={provider.instanceId}
                    controls={panelId}
                    detail={`${skills.length} ${skills.length === 1 ? "skill" : "skills"}`}
                    expanded={isOpen}
                    separated={index > 0}
                    label={label}
                    onToggle={() =>
                      setExpandedInstanceId((current) =>
                        current === provider.instanceId ? null : provider.instanceId,
                      )
                    }
                    icon={
                      <ProviderInstanceIcon
                        driverKind={provider.driver}
                        displayName={label}
                        accentColor={provider.accentColor}
                        className="size-6"
                        iconClassName="size-5"
                      />
                    }
                  />
                );
              })}
            </SkillSourceStrip>
            {expandedGroup ? (
              <div
                id={`external-skills-${expandedGroup.provider.instanceId}`}
                className="rounded-xl border border-border/60 bg-card/40 py-1 shadow-xs/5 [&>*+*]:border-t [&>*+*]:border-border/50"
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
