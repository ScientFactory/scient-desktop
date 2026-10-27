import type {
  EnvironmentId,
  ProjectId,
  ScientSkillCatalogItem,
  ServerProvider,
} from "@t3tools/contracts";
import { useEnvironmentQuery } from "../../state/query";
import { scientSkillDocument } from "./scientSkillsState";
import { SkillCard } from "./SkillCard";
import { useTryComposerSkill } from "./composerSkills";

export function ManagedSkillCard({
  environmentId,
  skill,
  provider,
  projectId,
  onClose,
}: {
  readonly environmentId: EnvironmentId;
  readonly skill: ScientSkillCatalogItem;
  readonly projectId?: ProjectId | undefined;
  readonly provider?: ServerProvider | undefined;
  readonly onClose: () => void;
}) {
  const document = useEnvironmentQuery(
    scientSkillDocument({
      environmentId,
      input: { releaseKey: skill.releaseKey, ...(projectId ? { projectId } : {}) },
    }),
  );
  const trySkill = useTryComposerSkill(
    environmentId,
    skill.active ? provider : undefined,
    skill.name,
  );
  return (
    <SkillCard
      name={skill.name}
      description={skill.description}
      environmentId={environmentId}
      instructions={document.data?.instructions ?? null}
      error={document.error}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      onTry={trySkill}
    />
  );
}
