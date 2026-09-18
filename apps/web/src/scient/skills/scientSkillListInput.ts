import type { ProjectId, ThreadId } from "@t3tools/contracts";

export function resolveScientSkillListInput(input: {
  readonly routeKind: "server" | "draft";
  readonly threadId: ThreadId | null;
  readonly projectId: ProjectId | null;
}): { readonly threadId?: ThreadId; readonly projectId?: ProjectId } {
  const projectInput = input.projectId === null ? {} : { projectId: input.projectId };

  // Draft routes use a preallocated local thread ID before the server has
  // created that thread. Project identity is the strongest valid context at
  // this point; sending the provisional ID would make the server correctly
  // reject the entire inventory request.
  if (input.routeKind === "draft" || input.threadId === null) {
    return projectInput;
  }

  return { threadId: input.threadId, ...projectInput };
}
