import { useAtomValue } from "@effect/atom-react";
import { ArrowLeftIcon, LibraryBigIcon } from "lucide-react";
import { Link } from "@tanstack/react-router";
import { useMemo, useRef, useState } from "react";

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
import {
  collectExternalSkillProviders,
  externalSkillSourceLabel,
  externalSkillStatus,
} from "./externalSkills";
import { setProviderSkillEnabled } from "./scientSkillsState";
import {
  SettingsSourcePanel,
  SettingsSourceGroup,
  SettingsSourceStrip,
  SettingsSourceStripItem,
} from "../../components/settings/SettingsSourceStrip";

function providerLabel(driver: string, displayName: string | undefined): string {
  if (displayName) return displayName;
  return AVAILABLE_PROVIDER_OPTIONS.find((option) => option.value === driver)?.label ?? driver;
}

const skillKey = (instanceId: string, path: string) => JSON.stringify([instanceId, path]);

export function ExternalSkillsSettings() {
  const environmentId = usePrimaryEnvironmentId();
  const providers = useAtomValue(primaryServerProvidersAtom);
  const groups = useMemo(() => collectExternalSkillProviders(providers), [providers]);
  const [expandedInstanceId, setExpandedInstanceId] = useState<string | null>(null);
  const [local, setLocal] = useState({
    providers,
    pending: {} as Record<string, { enabled: boolean; confirmed: boolean }>,
  });
  const inFlight = useRef(new Set<string>());
  const setEnabled = useAtomCommand(setProviderSkillEnabled, { reportFailure: true });
  const expandedGroup = groups.find(({ provider }) => provider.instanceId === expandedInstanceId);

  // Keep the switch responsive while the provider writes and verifies its own
  // setting. Once the streamed provider snapshot catches up, it owns the state.
  let currentLocal = local;
  if (local.providers !== providers) {
    const pending = { ...local.pending };
    for (const group of groups) {
      for (const skill of group.provider.skills) {
        const key = skillKey(group.provider.instanceId, skill.path);
        if (pending[key]?.enabled === skill.enabled) {
          delete pending[key];
        }
      }
    }
    currentLocal = { providers, pending };
    setLocal(currentLocal);
  }
  const pendingEnabled = currentLocal.pending;

  const updateSkill = async (input: {
    readonly instanceId: (typeof groups)[number]["provider"]["instanceId"];
    readonly name: string;
    readonly path: string;
    readonly enabled: boolean;
  }) => {
    if (environmentId === null) return;
    const key = skillKey(input.instanceId, input.path);
    if (inFlight.current.has(key)) return;
    inFlight.current.add(key);
    setLocal((current) => ({
      ...current,
      pending: { ...current.pending, [key]: { enabled: input.enabled, confirmed: false } },
    }));
    let confirmed = false;
    try {
      const result = await setEnabled({ environmentId, input });
      confirmed = result._tag === "Success";
      if (confirmed) {
        setLocal((current) =>
          current.pending[key]
            ? {
                ...current,
                pending: {
                  ...current.pending,
                  [key]: { enabled: input.enabled, confirmed: true },
                },
              }
            : current,
        );
      }
    } finally {
      inFlight.current.delete(key);
      if (!confirmed) {
        setLocal((current) => {
          const pending = { ...current.pending };
          delete pending[key];
          return { ...current, pending };
        });
      }
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
            <SettingsSourceGroup
              activePanelId={
                expandedGroup ? `external-skills-${expandedGroup.provider.instanceId}` : null
              }
            >
              <SettingsSourceStrip label="Agent providers">
                {groups.map(({ provider, skills }, index) => {
                  const label = providerLabel(provider.driver, provider.displayName);
                  const isOpen = expandedInstanceId === provider.instanceId;
                  const panelId = `external-skills-${provider.instanceId}`;
                  return (
                    <SettingsSourceStripItem
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
              </SettingsSourceStrip>
              {expandedGroup ? (
                <SettingsSourcePanel id={`external-skills-${expandedGroup.provider.instanceId}`}>
                  {expandedGroup.skills.length === 0 ? (
                    <SettingsRow
                      title="No global skills reported"
                      description="Project skills stay with their workspace."
                    />
                  ) : null}
                  {expandedGroup.skills.map(({ skill, displayName, description, source }) => {
                    const key = skillKey(expandedGroup.provider.instanceId, skill.path);
                    const pending = pendingEnabled[key];
                    const shownEnabled = pending?.enabled ?? skill.enabled;
                    return (
                      <SettingsRow
                        key={skill.path}
                        className="sm:[&>div]:grid-cols-[minmax(0,1fr)_auto] [&>div>div>p]:max-w-none"
                        title={displayName}
                        description={description}
                        status={
                          pending && !pending.confirmed
                            ? `${externalSkillSourceLabel(source)} · Updating`
                            : externalSkillStatus({ ...skill, enabled: shownEnabled }, source)
                        }
                        control={
                          skill.canSetEnabled === true ? (
                            <Switch
                              checked={shownEnabled}
                              disabled={pending !== undefined && !pending.confirmed}
                              className="data-disabled:opacity-100 transition-none [&_[data-slot=switch-thumb]]:transition-none"
                              aria-label={`${shownEnabled ? "Deactivate" : "Activate"} ${displayName}`}
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
                </SettingsSourcePanel>
              ) : null}
            </SettingsSourceGroup>
          </div>
        )}
      </SettingsSection>
    </SettingsPageContainer>
  );
}
