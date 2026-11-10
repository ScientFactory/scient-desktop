/**
 * What readers show that the snapshot format does not carry: which provider and model wrote each
 * answer, and the repository web URL with the commit file mentions link to.
 */
import type { SnapshotSidecar } from "@scientfactory/scient-cloud/api";
import type { ConversationSnapshotV1, ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { ProjectStoreV2 } from "../../orchestration-v2/ProjectStore.ts";
import { ProjectionStoreV2 } from "../../orchestration-v2/ProjectionStore.ts";
import { RepositoryIdentityResolver } from "../../project/RepositoryIdentityResolver.ts";
import { VcsProcess } from "../../vcs/VcsProcess.ts";

export interface ConversationExtrasResult {
  readonly sidecar: Pick<SnapshotSidecar, "answers" | "repository">;
  readonly headCommit?: string | undefined;
}

export class ConversationExtras extends Context.Service<
  ConversationExtras,
  {
    readonly read: (
      threadId: ThreadId,
      snapshot: ConversationSnapshotV1,
    ) => Effect.Effect<ConversationExtrasResult>;
  }
>()("t3/scient/cloud/ConversationExtras") {}

const COMMIT = /^[a-f0-9]{40,64}$/u;

export const layer = Layer.effect(
  ConversationExtras,
  Effect.gen(function* () {
    const projections = yield* ProjectionStoreV2;
    const projects = yield* ProjectStoreV2;
    const identities = yield* RepositoryIdentityResolver;
    const vcs = yield* VcsProcess;

    const headOf = (cwd: string) =>
      vcs
        .run({
          operation: "ScientCloud.headCommit",
          command: "git",
          args: ["rev-parse", "HEAD"],
          cwd,
          allowNonZeroExit: true,
          timeoutMs: 5_000,
          maxOutputBytes: 256,
        })
        .pipe(
          Effect.map((output) => {
            const sha = output.stdout.trim();
            return output.exitCode === 0 && COMMIT.test(sha) ? sha : undefined;
          }),
          Effect.orElseSucceed(() => undefined),
        );

    const read = Effect.fn("ConversationExtras.read")(function* (
      threadId: ThreadId,
      snapshot: ConversationSnapshotV1,
    ) {
      const records = yield* projections
        .getThreadRecords(threadId, ["runs", "providerThreads"])
        .pipe(Effect.option);
      if (Option.isNone(records)) return { sidecar: {} };
      const { thread, runs, providerThreads } = records.value;
      const driverOf = new Map(providerThreads.map((row) => [row.providerInstanceId, row.driver]));
      const runOf = new Map(runs.map((run) => [run.id as string, run]));
      const answers = snapshot.messages.flatMap((message) => {
        if (message.role !== "assistant" || message.turnId === null) return [];
        const run = runOf.get(message.turnId);
        if (run === undefined) return [];
        return [
          {
            messageId: message.id,
            provider: driverOf.get(run.providerInstanceId) ?? run.providerInstanceId,
            model: run.modelSelection.model,
          },
        ];
      });
      const project = yield* projects.get(thread.projectId).pipe(
        Effect.map(Option.getOrNull),
        Effect.orElseSucceed(() => null),
      );
      const cwd = thread.worktreePath ?? project?.workspaceRoot ?? null;
      const identity = cwd === null ? null : yield* identities.resolve(cwd);
      const headCommit = cwd === null || identity === null ? undefined : yield* headOf(cwd);
      return {
        sidecar: {
          ...(answers.length === 0 ? {} : { answers }),
          ...(identity?.webUrl !== undefined && headCommit !== undefined
            ? { repository: { webUrl: identity.webUrl, commit: headCommit } }
            : {}),
        },
        headCommit,
      } satisfies ConversationExtrasResult;
    });

    return ConversationExtras.of({ read });
  }),
);
