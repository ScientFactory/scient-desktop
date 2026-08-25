import type { ScientSkillCatalogItem, ScientSkillInvocationPolicy } from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { ChevronDownIcon, ChevronRightIcon, Layers3Icon } from "lucide-react";
import { useNavigate } from "@tanstack/react-router";
import { useMemo, useState } from "react";

import { usePrimaryEnvironmentId } from "../../state/environments";
import { primaryServerProvidersAtom } from "../../state/server";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  SettingsPageContainer,
  SettingsRow,
  SettingsSection,
} from "../../components/settings/settingsLayout";
import { searchableSetting } from "../../components/settings/settingsSearch";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "../../components/ui/select";
import { Switch } from "../../components/ui/switch";
import { scientSkillsInventory, setScientSkillUserActivation } from "./scientSkillsState";
import { collectExternalSkillProviders, summarizeExternalSkills } from "./externalSkills";

function invocationPolicyLabel(policy: ScientSkillInvocationPolicy): string {
  return policy === "automatic" ? "Agent may use" : "Only with $name";
}

function groupSkillsByCategory(skills: ReadonlyArray<ScientSkillCatalogItem>) {
  const groups = new Map<
    string,
    { category: string; description: string; skills: ScientSkillCatalogItem[] }
  >();
  for (const skill of skills) {
    const group = groups.get(skill.category);
    if (group) group.skills.push(skill);
    else {
      groups.set(skill.category, {
        category: skill.category,
        description: skill.categoryDescription,
        skills: [skill],
      });
    }
  }
  return [...groups.values()];
}

export function ScientSkillsSettings() {
  const navigate = useNavigate();
  const environmentId = usePrimaryEnvironmentId();
  const providers = useAtomValue(primaryServerProvidersAtom);
  const externalSkillGroups = useMemo(() => collectExternalSkillProviders(providers), [providers]);
  const inventory = useEnvironmentQuery(
    environmentId === null ? null : scientSkillsInventory({ environmentId, input: {} }),
  );
  const setActivation = useAtomCommand(setScientSkillUserActivation, {
    reportFailure: true,
  });
  const [pendingReleaseKey, setPendingReleaseKey] = useState<string | null>(null);

  const updateSkill = async (
    skill: ScientSkillCatalogItem,
    patch: { readonly active?: boolean; readonly invocationPolicy?: ScientSkillInvocationPolicy },
  ) => {
    if (environmentId === null || pendingReleaseKey !== null) return;
    setPendingReleaseKey(skill.releaseKey);
    try {
      await setActivation({
        environmentId,
        input: {
          releaseKey: skill.releaseKey,
          active: patch.active ?? skill.active,
          invocationPolicy: patch.invocationPolicy ?? skill.invocationPolicy,
        },
      });
    } finally {
      setPendingReleaseKey(null);
    }
  };

  return (
    <SettingsPageContainer>
      <SettingsSection {...searchableSetting("skills")} icon={<Layers3Icon className="size-4" />}>
        <p className="px-3 pb-2 text-sm leading-relaxed text-muted-foreground sm:px-4">
          Make reusable guidance available to supported agents. Skills add instructions, never tools
          or permissions.
        </p>
        <button
          type="button"
          className="group flex w-full items-center gap-3 rounded-xl px-3 py-3 text-left transition-colors hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:px-4"
          onClick={() => void navigate({ to: "/settings/skills/external" })}
        >
          <span className="min-w-0 flex-1">
            <span className="block text-sm font-medium text-foreground">External skills</span>
            <span className="block text-[13px] leading-[1.45] text-muted-foreground/80">
              {summarizeExternalSkills(externalSkillGroups)}
            </span>
          </span>
          <ChevronRightIcon className="size-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
        </button>
        {inventory.error ? (
          <SettingsRow title="Skills unavailable" description={inventory.error} />
        ) : inventory.data === null ? (
          <SettingsRow
            title={environmentId === null ? "No execution environment" : "Loading skills"}
            description={
              environmentId === null
                ? "Connect an execution environment to manage skills."
                : "Reading the skills available in this Scient build."
            }
          />
        ) : inventory.data.skills.length === 0 ? (
          <SettingsRow
            title="No built-in skills"
            description="This Scient build does not publish any managed skills."
          />
        ) : (
          groupSkillsByCategory(inventory.data.skills).map((group) => (
            <div key={group.category}>
              <div className="px-3 pt-4 pb-2 sm:px-4">
                <h3 className="text-base font-semibold tracking-[-0.01em] text-foreground">
                  {group.category}
                </h3>
                <p className="mt-1 max-w-xl text-[13.5px] leading-[1.45] text-muted-foreground/80">
                  {group.description}
                </p>
              </div>
              {group.skills.map((skill) => {
                const pending = pendingReleaseKey === skill.releaseKey;
                return (
                  <SettingsRow
                    key={skill.releaseKey}
                    title={skill.name
                      .split("-")
                      .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
                      .join(" ")}
                    description={skill.description}
                    status="Built into Scient · Personal"
                    control={
                      <div className="flex items-center gap-3">
                        <Select
                          value={skill.invocationPolicy}
                          disabled={!skill.active || pendingReleaseKey !== null}
                          onValueChange={(value) =>
                            void updateSkill(skill, {
                              invocationPolicy: value as ScientSkillInvocationPolicy,
                            })
                          }
                        >
                          <SelectTrigger
                            size="sm"
                            variant="ghost"
                            className="w-fit min-w-0 gap-1.5"
                            icon={
                              <ChevronDownIcon className="size-3 opacity-70" strokeWidth={2.25} />
                            }
                            aria-label={`${skill.name} use`}
                          >
                            <SelectValue>
                              {skill.active
                                ? invocationPolicyLabel(skill.invocationPolicy)
                                : "Deactivated"}
                            </SelectValue>
                          </SelectTrigger>
                          <SelectPopup>
                            <SelectItem value="automatic">Agent may use</SelectItem>
                            <SelectItem value="explicit">Only with $name</SelectItem>
                          </SelectPopup>
                        </Select>
                        <Switch
                          checked={skill.active}
                          disabled={pending || pendingReleaseKey !== null}
                          aria-label={`Make ${skill.name} available`}
                          onCheckedChange={(checked) =>
                            void updateSkill(skill, { active: Boolean(checked) })
                          }
                        />
                      </div>
                    }
                  />
                );
              })}
            </div>
          ))
        )}
        {inventory.data?.skills.some((skill) => skill.active) ? (
          <p className="px-3 pt-2 text-xs text-muted-foreground sm:px-4">
            Changes apply to the next message.
          </p>
        ) : null}
      </SettingsSection>
    </SettingsPageContainer>
  );
}
