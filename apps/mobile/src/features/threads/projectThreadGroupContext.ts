import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";

export interface ProjectThreadGroupContext {
  readonly kind: "project";
  readonly project: EnvironmentProject;
}

export function projectThreadGroupEnvironmentId(
  context: ProjectThreadGroupContext,
): EnvironmentProject["environmentId"] {
  return context.project.environmentId;
}
