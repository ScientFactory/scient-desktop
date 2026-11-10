import {
  type OrchestrationV2ThreadShell,
  type ProjectId,
  type ThreadId,
  isListedThreadLineage,
  repositoryGroupingKeyOf,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";

import { OrchestratorV2 } from "../../orchestration-v2/Orchestrator.ts";
import { ProjectStoreV2 } from "../../orchestration-v2/ProjectStore.ts";
import { ProjectionStoreV2 } from "../../orchestration-v2/ProjectionStore.ts";
import { RepositoryIdentityResolver } from "../../project/RepositoryIdentityResolver.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { ConversationSnapshotService } from "../conversationExport/ConversationSnapshotService.ts";
import { CloudSyncSource, type SyncThreadFacts } from "./CloudSync.ts";
import { ConversationExtras } from "./ConversationExtras.ts";

/** Where a project sits across computers: its repository grouping key and sub-folder. */
export interface ProjectPlacement {
  readonly projectKey: string;
  readonly projectLabel: string;
  readonly relativePath?: string | undefined;
  readonly repoWebUrl?: string | undefined;
}

export const makeProjectPlacement = Effect.gen(function* () {
  const projects = yield* ProjectStoreV2;
  const identities = yield* RepositoryIdentityResolver;
  const path = yield* Path.Path;
  return Effect.fn("CloudSync.projectPlacement")(function* (projectId: ProjectId) {
    const project = yield* projects.get(projectId).pipe(Effect.map(Option.getOrNull));
    if (project === null) return null;
    const identity = yield* identities.resolve(project.workspaceRoot);
    if (identity === null)
      return {
        projectKey: `local:${projectId}`,
        projectLabel: project.title,
      } satisfies ProjectPlacement;
    const relative =
      identity.rootPath === undefined
        ? ""
        : path.relative(identity.rootPath, project.workspaceRoot);
    return {
      projectKey: repositoryGroupingKeyOf(identity),
      projectLabel: project.title,
      ...(relative.length > 0 && !relative.startsWith("..") && !path.isAbsolute(relative)
        ? { relativePath: relative.split(path.sep).join("/") }
        : {}),
      ...(identity.webUrl === undefined ? {} : { repoWebUrl: identity.webUrl }),
    } satisfies ProjectPlacement;
  });
});

const isSettled = (shell: OrchestrationV2ThreadShell) =>
  shell.activeRunId === null && (shell.activityRunStatus ?? null) === null;

export const layer = Layer.effect(
  CloudSyncSource,
  Effect.gen(function* () {
    const projections = yield* ProjectionStoreV2;
    const orchestrator = yield* OrchestratorV2;
    const snapshots = yield* ConversationSnapshotService;
    const settings = yield* ServerSettingsService;
    const fileSystem = yield* FileSystem.FileSystem;
    const placement = yield* makeProjectPlacement;
    const extras = yield* ConversationExtras;
    const placements = new Map<ProjectId, ProjectPlacement | null>();

    const placeOf = (projectId: ProjectId) =>
      placements.has(projectId)
        ? Effect.succeed(placements.get(projectId) ?? null)
        : placement(projectId).pipe(
            Effect.orElseSucceed(() => null),
            Effect.tap((value) => Effect.sync(() => placements.set(projectId, value))),
          );

    const factsOf = Effect.fn("CloudSyncSource.facts")(function* (
      shell: OrchestrationV2ThreadShell,
    ) {
      const place = yield* placeOf(shell.projectId);
      return {
        threadId: shell.id,
        title: shell.title,
        updatedAt: DateTime.formatIso(shell.updatedAt),
        archived: shell.archivedAt !== null,
        settled: isSettled(shell),
        listed: isListedThreadLineage(shell.lineage),
        projectKey: place?.projectKey ?? `local:${shell.projectId}`,
        projectLabel: place?.projectLabel ?? "Project",
        relativePath: place?.relativePath,
        repoWebUrl: place?.repoWebUrl,
        branch: shell.branch ?? undefined,
      } satisfies SyncThreadFacts;
    });

    return CloudSyncSource.of({
      listThreads: Effect.gen(function* () {
        const snapshot = yield* projections.getShellSnapshot();
        const facts: SyncThreadFacts[] = [];
        for (const shell of [...snapshot.threads, ...snapshot.archivedThreads]) {
          facts.push(yield* factsOf(shell));
        }
        return facts;
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Cloud copy could not list threads.", { cause }).pipe(Effect.as([])),
        ),
      ),
      thread: Effect.fn("CloudSyncSource.thread")((threadId: ThreadId) =>
        projections.getThreadShell(threadId).pipe(
          Effect.flatMap((shell) => (shell === null ? Effect.succeed(null) : factsOf(shell))),
          Effect.orElseSucceed(() => null),
        ),
      ),
      capture: Effect.fn("CloudSyncSource.capture")((threadId, selection) =>
        snapshots.capture({ threadId, selection: { ...selection, throughMessageId: null } }).pipe(
          Effect.catchCause((cause) =>
            Effect.logInfo("Cloud copy could not capture a conversation.", {
              threadId,
              cause,
            }).pipe(Effect.as(null)),
          ),
        ),
      ),
      readFile: Effect.fn("CloudSyncSource.readFile")((path) =>
        fileSystem.readFile(path).pipe(Effect.orElseSucceed(() => null)),
      ),
      extras: extras.read,
      touched: orchestrator.streamDomainEvents.pipe(
        Stream.map((event) => event.threadId),
        Stream.catchCause((cause) =>
          Stream.fromEffect(
            Effect.logWarning("Cloud copy stopped following conversation changes.", { cause }),
          ).pipe(Stream.drain),
        ),
      ),
      enabled: settings.getSettings.pipe(
        Effect.map((value) => value.scientCloudSyncEnabled),
        Effect.orElseSucceed(() => false),
      ),
      enabledChanges: settings.streamChanges.pipe(
        Stream.map((value) => value.scientCloudSyncEnabled),
        Stream.changes,
      ),
    });
  }),
);
