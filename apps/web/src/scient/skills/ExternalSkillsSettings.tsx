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
import { primaryServerProvidersAtom, serverEnvironment } from "../../state/server";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { useAtomCommand } from "../../state/use-atom-command";
import { toastManager } from "../../components/ui/toast";
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

const skillKey = (environmentId: string | null, instanceId: string, path: string) =>
  JSON.stringify([environmentId, instanceId, path]);

export function ExternalSkillsSettings() {
  const environmentId = usePrimaryEnvironmentId();
  const providers = useAtomValue(primaryServerProvidersAtom);
  const groups = useMemo(() => collectExternalSkillProviders(providers), [providers]);
  const [expandedInstanceId, setExpandedInstanceId] = useState<string | null>(null);
  const [local, setLocal] = useState({
    environmentId,
    providers,
    pending: {} as Record<string, { enabled: boolean; confirmed: boolean }>,
  });
  const inFlight = useRef(new Map<string, { desired: boolean }>());
  const setEnabled = useAtomCommand(setProviderSkillEnabled, { reportFailure: true });
  const refreshProviders = useAtomCommand(serverEnvironment.refreshProviders, {
    reportFailure: false,
  });
  const expandedGroup = groups.find(({ provider }) => provider.instanceId === expandedInstanceId);

  // Keep the switch responsive while the provider writes and verifies its own
  // setting. Intermediate snapshots cannot settle a newer queued choice.
  let currentLocal = local;
  if (local.environmentId !== environmentId) {
    currentLocal = { environmentId, providers, pending: {} };
    setLocal(currentLocal);
  } else {
    let pending = local.pending;
    for (const group of groups) {
      for (const skill of group.provider.skills) {
        const key = skillKey(environmentId, group.provider.instanceId, skill.path);
        if (pending[key]?.confirmed && pending[key]?.enabled === skill.enabled) {
          pending = { ...pending };
          delete pending[key];
        }
      }
    }
    if (local.providers !== providers || pending !== local.pending) {
      currentLocal = { environmentId, providers, pending };
      setLocal(currentLocal);
    }
  }
  const pendingEnabled = currentLocal.pending;

  const updateSkill = (input: {
    readonly instanceId: (typeof groups)[number]["provider"]["instanceId"];
    readonly name: string;
    readonly path: string;
    readonly enabled: boolean;
  }) => {
    if (environmentId === null) return;
    const key = skillKey(environmentId, input.instanceId, input.path);
    const existing = inFlight.current.get(key);
    const lane = existing ?? { desired: input.enabled };
    lane.desired = input.enabled;
    if (!existing) inFlight.current.set(key, lane);
    setLocal((current) =>
      current.environmentId === environmentId
        ? {
            ...current,
            pending: { ...current.pending, [key]: { enabled: input.enabled, confirmed: false } },
          }
        : current,
    );
    if (existing) return;

    const reconcileFailure = async () => {
      let actual: boolean | undefined;
      try {
        const refreshed = await refreshProviders({
          environmentId,
          input: { instanceId: input.instanceId },
        });
        if (refreshed._tag === "Success") {
          actual = refreshed.value.providers
            .find((provider) => provider.instanceId === input.instanceId)
            ?.skills.find(
              (skill) => skill.path === input.path && skill.name === input.name,
            )?.enabled;
        }
      } catch {
        // The provider's current state cannot be verified; report that below.
      }
      setLocal((current) => {
        if (current.environmentId !== environmentId) return current;
        const pending = { ...current.pending };
        if (actual === undefined) delete pending[key];
        else pending[key] = { enabled: actual, confirmed: true };
        return { ...current, pending };
      });
      if (actual !== lane.desired) {
        toastManager.add({
          type: "error",
          title: `Could not update ${input.name}`,
          description:
            actual === undefined
              ? "Scient could not verify this skill's current state."
              : "The provider did not apply your latest choice.",
        });
      }
    };

    void (async () => {
      let nextEnabled = input.enabled;
      try {
        for (;;) {
          const result = await setEnabled({
            environmentId,
            input: { ...input, enabled: nextEnabled },
          });
          if (result._tag === "Failure") {
            await reconcileFailure();
            return;
          }
          if (lane.desired !== nextEnabled) {
            nextEnabled = lane.desired;
            continue;
          }
          setLocal((current) =>
            current.environmentId === environmentId && current.pending[key]
              ? {
                  ...current,
                  pending: {
                    ...current.pending,
                    [key]: { enabled: nextEnabled, confirmed: true },
                  },
                }
              : current,
          );
          return;
        }
      } catch {
        await reconcileFailure();
      } finally {
        inFlight.current.delete(key);
      }
    })();
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
                    const key = skillKey(
                      environmentId,
                      expandedGroup.provider.instanceId,
                      skill.path,
                    );
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
                              className="transition-none [&_[data-slot=switch-thumb]]:transition-none"
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
