import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import {
  AuthOrchestrationOperateScope,
  type EnvironmentId,
  type PersonalSkillCandidate,
} from "@t3tools/contracts";
import { serializeComposerFileLink } from "@t3tools/shared/composerTrigger";

import { useNewThreadHandler } from "../../hooks/useHandleNewThread";
import { useScratchProject } from "../../hooks/useScratchProject";
import { readPreparedConnection, useEnvironmentScope } from "../../state/session";
import { recordScientAnalytics } from "../analytics/client";

/** Scient's built-in guide for writing skills, selected by name in the first message. */
const AUTHORING = "$scient-skill-authoring";

/** Why a chat about a skill was opened: finish rough material, rename one, improve or fix one. */
export type SkillChatPurpose = "finish" | "rename" | "improve" | "fix";

/**
 * Opens a new chat, outside any project, with a first message written for the user. The user
 * reads it, can add to it, and sends it; the default agent then works on the skill.
 */
export function useSkillAgentChat(environmentId: EnvironmentId) {
  const newThread = useNewThreadHandler();
  const { openScratchProject, scratchWorkspaceRootFor } = useScratchProject();
  const canOperate = useEnvironmentScope(environmentId, AuthOrchestrationOperateScope);
  if (!canOperate || scratchWorkspaceRootFor(environmentId) === null) return undefined;
  const record = (purpose: SkillChatPurpose, outcome: "ok" | "error") =>
    recordScientAnalytics(readPreparedConnection(environmentId), {
      name: "feature.used",
      properties: { feature: "skills.personal.agent_chat", variant: purpose, outcome },
    });
  return async (prompt: string, purpose: SkillChatPurpose): Promise<boolean> => {
    try {
      const project = await openScratchProject(environmentId);
      const opened = project
        ? await newThread(scopeProjectRef(project.environmentId, project.id), { prompt })
        : null;
      record(purpose, opened ? "ok" : "error");
      return opened !== null;
    } catch (error) {
      record(purpose, "error");
      throw error;
    }
  };
}

const material = (candidate: PersonalSkillCandidate) => {
  const source = candidate.material;
  if (!source) return "";
  if (source.text === undefined) {
    return `\n\nThe material is here: ${serializeComposerFileLink(source.path)}`;
  }
  // A fence longer than any run of backticks in the text keeps it whole.
  const longest = Math.max(2, ...(source.text.match(/`+/gu) ?? []).map((run) => run.length));
  const fence = "`".repeat(longest + 1);
  return `\n\n${fence}markdown\n${source.text}\n${fence}`;
};

/** Turn rough material into a skill the user keeps, or rename one whose name is taken. */
export const finishSkillPrompt = (candidate: PersonalSkillCandidate, sourceLabel: string) => {
  const name = candidate.name ? ` It is meant to be called “${candidate.name}”.` : "";
  const problem = candidate.conflict
    ? ` Scient says: ${candidate.conflict} Give it another name.`
    : candidate.reason
      ? ` Scient says: ${candidate.reason}`
      : "";
  return (
    `${AUTHORING} Turn this into a skill I can use in every project, and save it for me with scient_skill_save.` +
    ` It came from ${sourceLabel}.${name}${problem}` +
    material(candidate)
  );
};

/** Improve one of the user's skills. */
export const improveSkillPrompt = (name: string) =>
  `${AUTHORING} Help me improve my skill “${name}”. Read it with scient_skill_read, ask me what I want changed if I have not said, then save it with scient_skill_save.`;

/** Repair a skill folder Scient cannot load. */
export const fixSkillPrompt = (name: string, problem: string, folder: string) =>
  `${AUTHORING} My skill “${name}” does not load: ${problem} Fix it and save it with scient_skill_save. Its files are here: ${serializeComposerFileLink(folder)}`;
