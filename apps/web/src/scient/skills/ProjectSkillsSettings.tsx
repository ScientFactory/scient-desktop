import type { EnvironmentId, ProjectId, ScientSkillInvocationPolicy } from "@t3tools/contracts";
import { useEffect, useState } from "react";

import { SettingsRow } from "../../components/settings/settingsLayout";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { SkillSettingsRow } from "./SkillSettingsRow";
import { scientSkillsInventory, setScientSkillProjectPreference } from "./scientSkillsState";

export function ProjectSkillsSettings(props: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
}) {
  const inventory = useEnvironmentQuery(
    scientSkillsInventory({
      environmentId: props.environmentId,
      input: { projectId: props.projectId },
    }),
  );
  const setPreference = useAtomCommand(setScientSkillProjectPreference, {
    reportFailure: true,
  });
  const [pendingName, setPendingName] = useState<string | null>(null);
  const projectSkills = inventory.data?.skills.filter((skill) => skill.scope === "project") ?? [];

  useEffect(() => {
    inventory.refresh();
  }, [inventory.refresh, props.environmentId, props.projectId]);

  const updateSkill = async (
    name: string,
    active: boolean,
    invocationPolicy: ScientSkillInvocationPolicy,
  ) => {
    if (pendingName !== null) return;
    setPendingName(name);
    try {
      await setPreference({
        environmentId: props.environmentId,
        input: { projectId: props.projectId, name, active, invocationPolicy },
      });
    } finally {
      setPendingName(null);
    }
  };

  if (inventory.error) {
    return <SettingsRow title="Project skills unavailable" description={inventory.error} />;
  }
  if (inventory.data === null) {
    return <SettingsRow title="Loading project skills" />;
  }
  return (
    <>
      {projectSkills.length === 0 && inventory.data.diagnostics.length === 0 ? (
        <SettingsRow
          title="No project skills"
          description="Agents can add skills in .scient/skills. New valid skills are available automatically."
        />
      ) : null}
      {projectSkills.map((skill) => (
        <SkillSettingsRow
          key={skill.releaseKey}
          skill={skill}
          pending={pendingName === skill.name}
          disabled={pendingName !== null}
          status={skill.path ?? "Project"}
          onUpdate={(patch) =>
            void updateSkill(
              skill.name,
              patch.active ?? skill.active,
              patch.invocationPolicy ?? skill.invocationPolicy,
            )
          }
        />
      ))}
      {inventory.data.diagnostics.map((diagnostic) => (
        <SettingsRow
          key={`${diagnostic.code}:${diagnostic.path ?? diagnostic.message}`}
          title="Skill needs attention"
          description={diagnostic.message}
          status={diagnostic.path}
        />
      ))}
      {projectSkills.length > 0 ? (
        <p className="px-3 pt-2 text-xs text-muted-foreground sm:px-4">
          Changes apply to the next message.
        </p>
      ) : null}
    </>
  );
}
