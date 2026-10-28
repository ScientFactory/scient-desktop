import type { EnvironmentId } from "@t3tools/contracts";
import { useState } from "react";

import { ProjectFavicon } from "../../components/ProjectFavicon";
import { useProjects } from "../../state/entities";
import { ProjectSkillsSettings } from "./ProjectSkillsSettings";
import {
  SettingsSourceStrip,
  SettingsSourceGroup,
  SettingsSourcePanel,
  SettingsSourceStripItem,
} from "../../components/settings/SettingsSourceStrip";

/** Skills that belong to one project, for each project on this environment. */
export function ProjectSkills({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const projects = useProjects().filter(
    (project) => project.environmentId === environmentId && project.isScratch !== true,
  );
  const [expandedProjectId, setExpandedProjectId] = useState<string | null>(null);
  const expandedProject = projects.find((project) => project.id === expandedProjectId);

  if (projects.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">Add a project to give it its own skills.</p>
    );
  }
  return (
    <SettingsSourceGroup
      activePanelId={expandedProject ? `project-skills-${expandedProject.id}` : null}
    >
      <SettingsSourceStrip label="Projects">
        {projects.map((project, index) => {
          const expanded = expandedProjectId === project.id;
          return (
            <SettingsSourceStripItem
              key={project.id}
              controls={`project-skills-${project.id}`}
              expanded={expanded}
              separated={index > 0}
              label={project.title}
              onToggle={() =>
                setExpandedProjectId((current) => (current === project.id ? null : project.id))
              }
              icon={<ProjectFavicon project={project} className="size-5" />}
            />
          );
        })}
      </SettingsSourceStrip>
      {expandedProject ? (
        <SettingsSourcePanel id={`project-skills-${expandedProject.id}`}>
          <ProjectSkillsSettings
            environmentId={expandedProject.environmentId}
            projectId={expandedProject.id}
          />
        </SettingsSourcePanel>
      ) : null}
    </SettingsSourceGroup>
  );
}
