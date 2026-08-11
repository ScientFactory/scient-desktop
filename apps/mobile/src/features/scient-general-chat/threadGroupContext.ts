import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import type { EnvironmentId } from "@t3tools/contracts";

/**
 * Mobile presentation context for a thread group.
 *
 * General Chat is deliberately not represented as an EnvironmentProject: it
 * has no project identity and must never inherit project-only actions.
 */
export type ScientThreadGroupContext =
  | { readonly kind: "project"; readonly project: EnvironmentProject }
  | {
      readonly kind: "general-chat";
      readonly environmentId: EnvironmentId;
      readonly workspaceRoot: string;
    };

export function scientThreadGroupEnvironmentId(context: ScientThreadGroupContext): EnvironmentId {
  return context.kind === "project" ? context.project.environmentId : context.environmentId;
}
