import { useRef, useState } from "react";

import { ProviderInstanceIcon } from "../../components/chat/ProviderInstanceIcon";
import { SettingsRow } from "../../components/settings/settingsLayout";
import { Switch } from "../../components/ui/switch";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { toastManager } from "../../components/ui/toast";
import { AVAILABLE_PROVIDER_OPTIONS } from "../../components/chat/providerIconUtils";
import {
  collectExternalSkillProviders,
  externalSkillSourceLabel,
  externalSkillStatus,
} from "./externalSkills";
import { SkillCard } from "./SkillCard";
import { useEnvironmentQuery } from "../../state/query";
import {
  type EnvironmentId,
  type ServerProvider,
  type ServerProviderSkill,
  type ProviderInstanceId,
} from "@t3tools/contracts";
import { providerSkillDocument, setProviderSkillEnabled } from "./scientSkillsState";
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

/** Each agent's own skills, one agent open at a time, with their switches. */
export function AgentSkills({
  environmentId,
  providers,
}: {
  readonly environmentId: EnvironmentId;
  readonly providers: ReadonlyArray<ServerProvider>;
}) {
  const groups = collectExternalSkillProviders(providers);
  const [selected, setSelected] = useState<{
    readonly iconUrl?: string | undefined;
    instanceId: ProviderInstanceId;
    skill: ServerProviderSkill;
    displayName: string;
    description: string;
  } | null>(null);
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
    const pending = { ...local.pending };
    let pendingChanged = false;
    for (const group of groups) {
      for (const skill of group.provider.skills) {
        const key = skillKey(environmentId, group.provider.instanceId, skill.path);
        if (pending[key]?.confirmed && pending[key]?.enabled === skill.enabled) {
          delete pending[key];
          pendingChanged = true;
        }
      }
    }
    if (local.providers !== providers || pendingChanged) {
      currentLocal = {
        environmentId,
        providers,
        pending: pendingChanged ? pending : local.pending,
      };
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
      let actionFailure: { readonly cause: unknown } | undefined;
      finishAction: {
        try {
          try {
            for (;;) {
              const result = await setEnabled({
                environmentId,
                input: { ...input, enabled: nextEnabled },
              });
              if (result._tag === "Failure") {
                await reconcileFailure();
                {
                  break finishAction;
                }
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
              {
                break finishAction;
              }
            }
          } catch {
            await reconcileFailure();
          }
        } catch (cause) {
          actionFailure = { cause };
        }
      }
      inFlight.current.delete(key);
      if (actionFailure) throw actionFailure.cause;
    })();
  };

  return (
    <>
      {selected ? (
        <ExternalSkillCard
          key={JSON.stringify([environmentId, selected.instanceId, selected.skill.path])}
          environmentId={environmentId}
          {...selected}
          onClose={() => setSelected(null)}
        />
      ) : null}
      {groups.length === 0 ? (
        <p className="text-sm text-muted-foreground">No agent reports its own skills yet.</p>
      ) : (
        <div>
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
                      title={
                        <button
                          type="button"
                          className="cursor-pointer rounded-sm text-left outline-none focus-visible:outline-1 focus-visible:outline-solid focus-visible:outline-ring"
                          onClick={() =>
                            setSelected({
                              instanceId: expandedGroup.provider.instanceId,
                              iconUrl: expandedGroup.provider.iconUrl,
                              skill,
                              displayName,
                              description: skill.description ?? description ?? "",
                            })
                          }
                        >
                          {displayName}
                        </button>
                      }
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
                            motion="none"
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
    </>
  );
}

function ExternalSkillCard({
  environmentId,
  instanceId,
  iconUrl,
  skill,
  displayName,
  description,
  onClose,
}: {
  readonly environmentId: EnvironmentId;
  readonly instanceId: ProviderInstanceId;
  readonly iconUrl?: string | undefined;
  readonly skill: ServerProviderSkill;
  readonly displayName: string;
  readonly description: string;
  readonly onClose: () => void;
}) {
  const document = useEnvironmentQuery(
    providerSkillDocument({
      environmentId,
      input: { instanceId, name: skill.name, path: skill.path },
    }),
  );
  return (
    <SkillCard
      name={skill.name}
      displayName={displayName}
      iconUrl={iconUrl}
      description={description}
      environmentId={environmentId}
      instructions={document.data?.unavailableReason ? null : (document.data?.instructions ?? null)}
      error={document.data?.unavailableReason ?? document.error}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    />
  );
}
