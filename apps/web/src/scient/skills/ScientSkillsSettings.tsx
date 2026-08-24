import type { ScientSkillCatalogItem, ScientSkillInvocationPolicy } from "@t3tools/contracts";
import { SparklesIcon } from "lucide-react";
import { useState } from "react";

import { usePrimaryEnvironmentId } from "../../state/environments";
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

function invocationPolicyLabel(policy: ScientSkillInvocationPolicy): string {
  return policy === "automatic" ? "Agent may use" : "Only with $name";
}

export function ScientSkillsSettings() {
  const environmentId = usePrimaryEnvironmentId();
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
      <SettingsSection {...searchableSetting("skills")} icon={<SparklesIcon className="size-4" />}>
        <p className="px-3 pb-2 text-sm leading-relaxed text-muted-foreground sm:px-4">
          Make reusable guidance available to supported agents. Skills add instructions, never tools
          or permissions.
        </p>
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
          inventory.data.skills.map((skill) => {
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
                      <SelectTrigger size="sm" className="w-36" aria-label={`${skill.name} use`}>
                        <SelectValue>{invocationPolicyLabel(skill.invocationPolicy)}</SelectValue>
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
          })
        )}
        {inventory.data?.skills.some((skill) => skill.active) ? (
          <p className="px-3 pt-2 text-xs text-muted-foreground sm:px-4">
            Changes apply when an agent session starts or restarts.
          </p>
        ) : null}
      </SettingsSection>
    </SettingsPageContainer>
  );
}
