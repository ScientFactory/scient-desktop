/**
 * Scient's project folders: the per-environment Scratch project that hosts
 * threads without a project, and projects started from just a name. Both
 * follow Scient's product policy, so ws.ts builds them here per connection
 * and serves its config and project RPCs from the result.
 *
 * @module ScientProjectFolders
 */
import {
  type CommandId,
  OrchestrationDispatchCommandError,
  type ProjectCreateNewInput,
  ProjectId,
} from "@t3tools/contracts";
import { SCIENT_DESKTOP_IDENTITY } from "@t3tools/shared/scientDesktopIdentity";
import * as Cause from "effect/Cause";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import * as ServerConfig from "../../config.ts";
import type * as GitWorkflowService from "../../git/GitWorkflowService.ts";
import * as NewProject from "../../project/NewProject.ts";
import type * as ProjectService from "../../project/ProjectService.ts";

export const makeScientProjectFolders = ({
  config,
  gitWorkflow,
  projectService,
  randomUUID,
  serverCommandId,
  toDispatchCommandError,
}: {
  readonly config: ServerConfig.ServerConfig["Service"];
  readonly gitWorkflow: GitWorkflowService.GitWorkflowService["Service"];
  readonly projectService: ProjectService.ProjectService["Service"];
  readonly randomUUID: Effect.Effect<string, OrchestrationDispatchCommandError>;
  readonly serverCommandId: (
    tag: string,
  ) => Effect.Effect<CommandId, OrchestrationDispatchCommandError>;
  readonly toDispatchCommandError: (
    cause: unknown,
    fallbackMessage: string,
  ) => OrchestrationDispatchCommandError;
}) =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    // Scratch threads run in a plain folder. Production uses the data dir;
    // the dev runner can select isolated storage outside its checkout.
    // Offer it only when the selected parent is outside any work tree,
    // so it cannot inherit a repository's Git status and checkpoints. Detection failures and
    // defects fail closed and hide the folder, never the config.
    // Probed once per connection: a negative VCS detection is not cached.
    // An interrupt stays an interrupt, so a config load cancelled mid-probe
    // invalidates the cache and the next load probes again.
    // SCIENT-FORK:START — Product policy and environment capability share
    // this advertisement. Scratch retains a real owning project; each
    // thread's registered plain folder is also admitted by Scient's resolver.
    const scratchThreadsOffered = SCIENT_DESKTOP_IDENTITY.projectlessThreadsEnabled;
    const scratchWorkspaceRoot = ServerConfig.scratchWorkspaceRoot(config, path);
    // SCIENT-FORK:END
    const [cachedScratchWorkspaceRoot, invalidateScratchWorkspaceRoot] =
      yield* Effect.cachedInvalidateWithTTL(
        gitWorkflow.isRepository(path.dirname(scratchWorkspaceRoot)).pipe(
          Effect.map((isRepository) =>
            !scratchThreadsOffered || isRepository ? undefined : scratchWorkspaceRoot,
          ),
          Effect.catchCause((cause) =>
            Cause.hasInterrupts(cause) ? Effect.interrupt : Effect.succeed(undefined),
          ),
        ),
        Duration.infinity,
      );
    const resolveScratchWorkspaceRoot = cachedScratchWorkspaceRoot.pipe(
      Effect.onInterrupt(() => invalidateScratchWorkspaceRoot),
    );

    const fileSystem = yield* FileSystem.FileSystem;
    // Each Scratch thread gets its own folder under the Scratch root, named
    // from its date, first words, and id. It rides in worktreePath like any
    // thread that runs outside its project root, so the provider, terminal,
    // and file tree all use it. Threads that already name a folder keep it.
    // One Scratch project per environment, created the first time a client
    // asks. Two clients racing the create both reach dispatch; the loser's
    // duplicate-root rejection resolves to the project the winner made.
    // The folder is (re)made on every call so a deleted Scratch still runs.
    const ensureScratchProject = Effect.gen(function* () {
      const workspaceRoot = yield* resolveScratchWorkspaceRoot;
      if (workspaceRoot === undefined) {
        return yield* new OrchestrationDispatchCommandError({
          message: "Threads without a project are not available on this environment.",
        });
      }
      yield* fileSystem.makeDirectory(workspaceRoot, { recursive: true }).pipe(
        Effect.mapError(
          (cause) =>
            new OrchestrationDispatchCommandError({
              message: "Failed to create the folder for threads without a project.",
              cause,
            }),
        ),
      );
      const findScratchProjectId = projectService.getByWorkspaceRoot(workspaceRoot).pipe(
        Effect.map(Option.map((project) => project.id)),
        Effect.mapError(
          (cause) =>
            new OrchestrationDispatchCommandError({
              message: "Failed to look up the home for threads without a project.",
              cause,
            }),
        ),
      );
      const existingProjectId = yield* findScratchProjectId;
      if (Option.isSome(existingProjectId)) {
        return { projectId: existingProjectId.value };
      }
      const projectId = ProjectId.make(yield* randomUUID);
      return yield* Effect.gen(function* () {
        yield* projectService.create({
          commandId: yield* serverCommandId("scratch-project-create"),
          projectId,
          title: "No project",
          workspaceRoot,
        });
        yield* projectService.update({
          commandId: yield* serverCommandId("scratch-project-icon"),
          projectId,
          projectIcon: { kind: "lucide", name: "message-square-dashed", color: "gray" },
        });
        return { projectId };
      }).pipe(
        Effect.catch((error) =>
          findScratchProjectId.pipe(
            Effect.flatMap(
              Option.match({
                onNone: () => Effect.fail(error),
                onSome: (racedProjectId) => Effect.succeed({ projectId: racedProjectId }),
              }),
            ),
          ),
        ),
      );
    }).pipe(
      Effect.mapError((cause) =>
        toDispatchCommandError(cause, "Failed to create the Scratch project."),
      ),
    );

    // Projects started from just a name live beside Scratch and worktrees,
    // away from folders the user organizes by hand. A nested repository is
    // fine here (unlike Scratch) because each project gets its own `git init`.
    // SCIENT-FORK:START — Scient already creates a project from any typed
    // path ("Create & Add"), and that path also runs Scient's project
    // initialization. Upstream's name-only root skips all of that, so it stays
    // unadvertised until the owner picks between the two paths.
    const newProjectsRoot = SCIENT_DESKTOP_IDENTITY.createProjectFromNameEnabled
      ? path.resolve(config.baseDir, "projects")
      : undefined;
    // SCIENT-FORK:END
    const createNewProject = (input: ProjectCreateNewInput) =>
      Effect.gen(function* () {
        if (newProjectsRoot === undefined) {
          return yield* new OrchestrationDispatchCommandError({
            message: "Starting a project from just a name is not available on this environment.",
          });
        }
        const folder = yield* NewProject.createNewProjectFolder({
          root: newProjectsRoot,
          name: input.name,
        }).pipe(
          Effect.mapError(
            (cause) =>
              new OrchestrationDispatchCommandError({
                message: "Failed to create the project folder.",
                cause,
              }),
          ),
        );
        const projectId = ProjectId.make(yield* randomUUID);
        yield* Effect.gen(function* () {
          yield* projectService.create({
            commandId: yield* serverCommandId("project-create-new"),
            projectId,
            title: input.name,
            workspaceRoot: folder.workspaceRoot,
          });
        }).pipe(
          // Only a rejected command means no project uses the folder. An
          // interrupt can land after the command is queued, so keep it then.
          Effect.tapError(() =>
            projectService.getById(projectId).pipe(
              Effect.flatMap((project) =>
                Option.isSome(project)
                  ? Effect.void
                  : fileSystem.remove(folder.workspaceRoot, { recursive: true }),
              ),
              Effect.ignoreCause({ log: true }),
            ),
          ),
        );
        return {
          projectId,
          workspaceRoot: folder.workspaceRoot,
          ...(folder.commitError === undefined ? {} : { commitError: folder.commitError }),
        };
      }).pipe(
        Effect.provideService(FileSystem.FileSystem, fileSystem),
        Effect.provideService(Path.Path, path),
        Effect.mapError((cause) => toDispatchCommandError(cause, "Failed to create the project.")),
      );

    return { resolveScratchWorkspaceRoot, ensureScratchProject, newProjectsRoot, createNewProject };
  });
