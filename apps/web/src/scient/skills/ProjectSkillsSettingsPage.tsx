import { ArrowLeftIcon, FolderIcon } from "lucide-react";
import { Link } from "@tanstack/react-router";
import { useState } from "react";

import { ProjectFavicon } from "../../components/ProjectFavicon";
import {
  SettingsPageContainer,
  SettingsRow,
  SettingsSection,
} from "../../components/settings/settingsLayout";
import { useProjects } from "../../state/entities";
import { ProjectSkillsSettings } from "./ProjectSkillsSettings";
import { SkillSourceStrip, SkillSourceStripItem } from "./SkillSourceStrip";

const projectKey = (project: ReturnType<typeof useProjects>[number]): string =>
  `${project.environmentId}:${project.id}`;

export function ProjectSkillsSettingsPage() {
  const projects = useProjects();
  const [expandedProjectKey, setExpandedProjectKey] = useState<string | null>(null);
  const expandedProject = projects.find((project) => projectKey(project) === expandedProjectKey);

  return (
    <SettingsPageContainer>
      <SettingsSection title="Project skills" icon={<FolderIcon className="size-4" />}>
        <p className="px-3 pb-1 text-sm leading-relaxed text-muted-foreground sm:px-4">
          Skills stored in the selected workspace and available only to that project.
        </p>
        <Link
          className="group mb-2 ms-1 inline-flex min-h-8 cursor-pointer items-center gap-1.5 rounded-lg px-2 text-sm text-muted-foreground outline-none transition-colors hover:bg-foreground/[0.035] hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring sm:ms-2"
          to="/settings/skills"
        >
          <ArrowLeftIcon className="size-3.5 transition-transform group-hover:-translate-x-0.5" />
          Skills
        </Link>
        {projects.length > 0 ? (
          <>
            <div className="px-3 sm:px-4">
              <SkillSourceStrip label="Projects">
                {projects.map((project, index) => {
                  const key = projectKey(project);
                  const expanded = expandedProjectKey === key;
                  return (
                    <SkillSourceStripItem
                      key={key}
                      controls={`project-skills-${key}`}
                      expanded={expanded}
                      separated={index > 0}
                      label={project.title}
                      onToggle={() =>
                        setExpandedProjectKey((current) => (current === key ? null : key))
                      }
                      icon={
                        <ProjectFavicon
                          environmentId={project.environmentId}
                          cwd={project.workspaceRoot}
                          faviconPath={project.faviconPath}
                          className="size-5"
                        />
                      }
                    />
                  );
                })}
              </SkillSourceStrip>
            </div>
            {expandedProject ? (
              <div id={`project-skills-${projectKey(expandedProject)}`}>
                <ProjectSkillsSettings
                  environmentId={expandedProject.environmentId}
                  projectId={expandedProject.id}
                />
              </div>
            ) : null}
          </>
        ) : (
          <SettingsRow
            title="No projects"
            description="Add a project to create and manage project-specific skills."
          />
        )}
      </SettingsSection>
    </SettingsPageContainer>
  );
}
