import type {
  OrchestrationCommand,
  OrchestrationProject,
  OrchestrationReadModel,
  OrchestrationThread,
  ProjectKind,
  ProjectId,
  ThreadId,
} from "@synara/contracts";
import { THREAD_NOT_ARCHIVED_INVARIANT_MARKER } from "@synara/shared/errorMessages";
import { collectSubagentDescendants } from "@synara/shared/threadHierarchy";
import { normalizeWorkspaceRootForComparison } from "@synara/shared/threadWorkspace";
import { Effect } from "effect";

import { OrchestrationCommandInvariantError } from "./Errors.ts";

function invariantError(commandType: string, detail: string): OrchestrationCommandInvariantError {
  return new OrchestrationCommandInvariantError({
    commandType,
    detail,
  });
}

export function findThreadById(
  readModel: OrchestrationReadModel,
  threadId: ThreadId,
): OrchestrationThread | undefined {
  return readModel.threads.find((thread) => thread.id === threadId);
}

export function findProjectById(
  readModel: OrchestrationReadModel,
  projectId: ProjectId,
): OrchestrationProject | undefined {
  return readModel.projects.find((project) => project.id === projectId);
}

// Finds active projects by workspace root using the same comparison rules as import flows.
export function listActiveProjectsByWorkspaceRoot(
  readModel: OrchestrationReadModel,
  workspaceRoot: string,
  options?: { readonly kinds?: ReadonlySet<ProjectKind> },
): ReadonlyArray<OrchestrationProject> {
  const normalizedWorkspaceRoot = normalizeWorkspaceRootForComparison(workspaceRoot, {
    platform: process.platform,
  });
  const acceptedKinds = options?.kinds ?? new Set<ProjectKind>(["project"]);
  return readModel.projects.filter(
    (project) =>
      project.deletedAt === null &&
      acceptedKinds.has(project.kind ?? "project") &&
      normalizeWorkspaceRootForComparison(project.workspaceRoot, {
        platform: process.platform,
      }) === normalizedWorkspaceRoot,
  );
}

export function listThreadsByProjectId(
  readModel: OrchestrationReadModel,
  projectId: ProjectId,
): ReadonlyArray<OrchestrationThread> {
  return readModel.threads.filter((thread) => thread.projectId === projectId);
}

export function requireProject(input: {
  readonly readModel: OrchestrationReadModel;
  readonly command: OrchestrationCommand;
  readonly projectId: ProjectId;
}): Effect.Effect<OrchestrationProject, OrchestrationCommandInvariantError> {
  const project = findProjectById(input.readModel, input.projectId);
  if (project) {
    return Effect.succeed(project);
  }
  return Effect.fail(
    invariantError(
      input.command.type,
      `Project '${input.projectId}' does not exist for command '${input.command.type}'.`,
    ),
  );
}

export function requireProjectAbsent(input: {
  readonly readModel: OrchestrationReadModel;
  readonly command: OrchestrationCommand;
  readonly projectId: ProjectId;
}): Effect.Effect<void, OrchestrationCommandInvariantError> {
  if (!findProjectById(input.readModel, input.projectId)) {
    return Effect.void;
  }
  return Effect.fail(
    invariantError(
      input.command.type,
      `Project '${input.projectId}' already exists and cannot be created twice.`,
    ),
  );
}

export function requireProjectWorkspaceRootAvailable(input: {
  readonly readModel: OrchestrationReadModel;
  readonly command: OrchestrationCommand;
  readonly workspaceRoot: string;
  readonly excludeProjectId?: ProjectId;
  readonly kinds?: ReadonlySet<ProjectKind>;
}): Effect.Effect<void, OrchestrationCommandInvariantError> {
  // Skip the excluded project BEFORE picking, not after: if corrupt state ever leaves two
  // active owners on one root, the project being updated must not mask the other owner.
  const existingProject = listActiveProjectsByWorkspaceRoot(
    input.readModel,
    input.workspaceRoot,
    input.kinds ? { kinds: input.kinds } : undefined,
  ).find((project) => project.id !== input.excludeProjectId);
  if (!existingProject) {
    return Effect.void;
  }
  return Effect.fail(
    invariantError(
      input.command.type,
      `Project '${existingProject.id}' already uses workspace root '${existingProject.workspaceRoot}'.`,
    ),
  );
}

export function requireProjectHasNoThreads(input: {
  readonly readModel: OrchestrationReadModel;
  readonly command: OrchestrationCommand;
  readonly projectId: ProjectId;
}): Effect.Effect<void, OrchestrationCommandInvariantError> {
  const remainingThreads = listThreadsByProjectId(input.readModel, input.projectId).filter(
    (thread) => thread.deletedAt === null,
  );
  if (remainingThreads.length === 0) {
    return Effect.void;
  }
  return Effect.fail(
    invariantError(
      input.command.type,
      `Project '${input.projectId}' still has ${remainingThreads.length} thread${remainingThreads.length === 1 ? "" : "s"} and cannot be deleted.`,
    ),
  );
}

export function requireThread(input: {
  readonly readModel: OrchestrationReadModel;
  readonly command: OrchestrationCommand;
  readonly threadId: ThreadId;
}): Effect.Effect<OrchestrationThread, OrchestrationCommandInvariantError> {
  const thread = findThreadById(input.readModel, input.threadId);
  if (thread && thread.deletedAt === null) {
    return Effect.succeed(thread);
  }
  return Effect.fail(
    invariantError(
      input.command.type,
      thread
        ? `Thread '${input.threadId}' was deleted and cannot handle command '${input.command.type}'.`
        : `Thread '${input.threadId}' does not exist for command '${input.command.type}'.`,
    ),
  );
}

export function requireThreadAbsent(input: {
  readonly readModel: OrchestrationReadModel;
  readonly command: OrchestrationCommand;
  readonly threadId: ThreadId;
}): Effect.Effect<void, OrchestrationCommandInvariantError> {
  if (!findThreadById(input.readModel, input.threadId)) {
    return Effect.void;
  }
  return Effect.fail(
    invariantError(
      input.command.type,
      `Thread '${input.threadId}' already exists and cannot be created twice.`,
    ),
  );
}

export function requireThreadArchived(input: {
  readonly readModel: OrchestrationReadModel;
  readonly command: OrchestrationCommand;
  readonly threadId: ThreadId;
}): Effect.Effect<OrchestrationThread, OrchestrationCommandInvariantError> {
  return requireThread(input).pipe(
    Effect.flatMap((thread) =>
      thread.archivedAt != null
        ? Effect.succeed(thread)
        : Effect.fail(
            invariantError(
              input.command.type,
              `Thread '${input.threadId}' ${THREAD_NOT_ARCHIVED_INVARIANT_MARKER} '${input.command.type}'.`,
            ),
          ),
    ),
  );
}

export function requireThreadNotArchived(input: {
  readonly readModel: OrchestrationReadModel;
  readonly command: OrchestrationCommand;
  readonly threadId: ThreadId;
}): Effect.Effect<OrchestrationThread, OrchestrationCommandInvariantError> {
  return requireThread(input).pipe(
    Effect.flatMap((thread) =>
      thread.archivedAt == null
        ? Effect.succeed(thread)
        : Effect.fail(
            invariantError(
              input.command.type,
              `Thread '${input.threadId}' is already archived and cannot handle command '${input.command.type}'.`,
            ),
          ),
    ),
  );
}

export function requireThreadSubtreeIdle(input: {
  readonly readModel: OrchestrationReadModel;
  readonly command: OrchestrationCommand;
  readonly threadId: ThreadId;
}): Effect.Effect<void, OrchestrationCommandInvariantError> {
  const root = findThreadById(input.readModel, input.threadId);
  const subtree = [
    ...(root ? [root] : []),
    ...collectSubagentDescendants(
      root
        ? input.readModel.threads.filter(
            (thread) => thread.deletedAt === null && thread.projectId === root.projectId,
          )
        : [],
      input.threadId,
    ),
  ];
  const busyThreads = subtree.filter(
    (thread) =>
      thread.deletedAt === null &&
      (thread.session?.status === "starting" || thread.session?.status === "running"),
  );
  if (busyThreads.length === 0) {
    return Effect.void;
  }
  return Effect.fail(
    invariantError(
      input.command.type,
      `Thread subtree '${input.threadId}' has ${busyThreads.length} active session${busyThreads.length === 1 ? "" : "s"}; stop them before command '${input.command.type}'.`,
    ),
  );
}

export function requireThreadSubtreeNotStarting(input: {
  readonly readModel: OrchestrationReadModel;
  readonly command: OrchestrationCommand;
  readonly threadId: ThreadId;
}): Effect.Effect<void, OrchestrationCommandInvariantError> {
  const root = findThreadById(input.readModel, input.threadId);
  const liveProjectThreads = root
    ? input.readModel.threads.filter(
        (thread) => thread.deletedAt === null && thread.projectId === root.projectId,
      )
    : [];
  const subtree = [
    ...(root ? [root] : []),
    ...collectSubagentDescendants(liveProjectThreads, input.threadId),
  ];
  const startingThreads = subtree.filter((thread) => thread.session?.status === "starting");
  return startingThreads.length === 0
    ? Effect.void
    : Effect.fail(
        invariantError(
          input.command.type,
          `Thread subtree '${input.threadId}' has ${startingThreads.length} starting session${startingThreads.length === 1 ? "" : "s"}; wait for startup to settle before command '${input.command.type}'.`,
        ),
      );
}

export function requireValidThreadParent(input: {
  readonly readModel: OrchestrationReadModel;
  readonly command: OrchestrationCommand;
  readonly threadId: ThreadId;
  readonly projectId: ProjectId;
  readonly parentThreadId: ThreadId | null;
}): Effect.Effect<void, OrchestrationCommandInvariantError> {
  if (input.parentThreadId === null) return Effect.void;
  if (input.parentThreadId === input.threadId) {
    return Effect.fail(invariantError(input.command.type, "A thread cannot be its own parent."));
  }
  const parent = findThreadById(input.readModel, input.parentThreadId);
  if (
    !parent ||
    parent.deletedAt !== null ||
    parent.archivedAt !== null ||
    parent.projectId !== input.projectId
  ) {
    return Effect.fail(
      invariantError(
        input.command.type,
        `Parent thread '${input.parentThreadId}' must be an active thread in project '${input.projectId}'.`,
      ),
    );
  }

  const threadById = new Map(input.readModel.threads.map((thread) => [thread.id, thread] as const));
  const visited = new Set<ThreadId>();
  let current: OrchestrationThread | undefined = parent;
  while (current) {
    if (
      current.deletedAt !== null ||
      current.archivedAt !== null ||
      current.projectId !== input.projectId
    ) {
      return Effect.fail(
        invariantError(
          input.command.type,
          `Every parent ancestor must be active in project '${input.projectId}'.`,
        ),
      );
    }
    if (current.id === input.threadId || visited.has(current.id)) {
      return Effect.fail(
        invariantError(input.command.type, "Thread parent assignment would create a cycle."),
      );
    }
    visited.add(current.id);
    if (!current.parentThreadId) break;
    const nextParent = threadById.get(current.parentThreadId);
    if (!nextParent) {
      return Effect.fail(
        invariantError(
          input.command.type,
          `Parent ancestry is incomplete at '${current.parentThreadId}'.`,
        ),
      );
    }
    current = nextParent;
  }
  return Effect.void;
}

export function requireNonNegativeInteger(input: {
  readonly commandType: OrchestrationCommand["type"];
  readonly field: string;
  readonly value: number;
}): Effect.Effect<void, OrchestrationCommandInvariantError> {
  if (Number.isInteger(input.value) && input.value >= 0) {
    return Effect.void;
  }
  return Effect.fail(
    invariantError(
      input.commandType,
      `${input.field} must be an integer greater than or equal to 0.`,
    ),
  );
}
