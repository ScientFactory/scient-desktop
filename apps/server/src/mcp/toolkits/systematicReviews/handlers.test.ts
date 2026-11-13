// @effect-diagnostics nodeBuiltinImport:off -- Tests exercise the real project filesystem boundary.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { initializeScientProject, readScientProjectIdentity } from "@scientfactory/project-init";
import { SCIENT_SOURCE_RECORDS_DIRECTORY } from "@scientfactory/scient-sources/store";
import { EnvironmentId, ProjectId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { afterEach, describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import * as AgentInvocationContext from "../../../scient/operations/AgentInvocationContext.ts";
import { WorkspaceBindingResolver } from "../../../scient/projectScope/WorkspaceBindingResolver.ts";
import { ScientSourcesBackend } from "../../../scient/sources/SourcesBackend.ts";
import {
  workspaceResolverForTest,
  workspaceScopeForTest,
} from "../../../scient/projectScope/WorkspaceBindingTestUtils.ts";
import {
  readSystematicReviewsForInvocation,
  updateSystematicReviewForInvocation,
} from "./handlers.ts";

const fixtures: string[] = [];
const environmentId = EnvironmentId.make("environment-systematic-review");
const threadId = ThreadId.make("thread-systematic-review");

afterEach(async () => {
  await Promise.all(
    fixtures.splice(0).map((root) => NodeFSP.rm(root, { recursive: true, force: true })),
  );
});

async function project(
  sources: ReadonlyArray<{
    readonly sourceId: string;
    readonly title: string;
    readonly tags?: ReadonlyArray<string>;
  }>,
) {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "scient-systematic-review-"));
  fixtures.push(root);
  await initializeScientProject({ root });
  const identity = await readScientProjectIdentity(root);
  const directory = NodePath.join(root, SCIENT_SOURCE_RECORDS_DIRECTORY);
  await NodeFSP.mkdir(directory, { recursive: true });
  for (const source of sources) {
    const record = {
      formatVersion: 1,
      sourceId: source.sourceId,
      projectId: identity.projectId,
      revision: 1,
      type: "article",
      title: source.title,
      creators: [],
      issuedRaw: null,
      issuedYear: 2024,
      identifiers: [],
      abstract: null,
      containerTitle: null,
      publisher: null,
      volume: null,
      issue: null,
      pages: null,
      language: null,
      url: null,
      tags: source.tags ?? [],
      externalReferences: [],
      attachments: [],
      fieldProvenance: [],
      importedAt: "2026-11-10T12:00:00.000Z",
    };
    await NodeFSP.writeFile(
      NodePath.join(directory, `${source.sourceId}.json`),
      JSON.stringify(record),
      "utf8",
    );
  }
  return root;
}

const provide = <A, E, R>(effect: Effect.Effect<A, E, R>, root: string) => {
  const projectId = ProjectId.make("project-systematic-review");
  const base = workspaceResolverForTest(
    new Map([[root, { projectId, scope: workspaceScopeForTest(`binding:${root}`, root) }]]),
  );
  const resolveThread = () =>
    base.resolveWorkspaceRoot(root).pipe(
      Effect.map((resolved) => ({
        ...resolved,
        binding: { ...resolved.binding, environmentId, hostProjectId: projectId },
      })),
    );
  return effect.pipe(
    Effect.provideService(
      AgentInvocationContext.AgentInvocationContext,
      AgentInvocationContext.AgentInvocationContext.of({
        environmentId,
        threadId,
        providerSessionId: "session-systematic-review",
        providerInstanceId: ProviderInstanceId.make("codex"),
        capabilities: new Set(["sources:read", "sources:write"]),
        issuedAt: 1,
      }),
    ),
    Effect.provideService(WorkspaceBindingResolver, {
      ...base,
      resolveThread,
      assertCurrentThreadScope: () =>
        resolveThread().pipe(Effect.map((resolved) => resolved.binding)),
    }),
    Effect.provideService(ScientSourcesBackend, "project"),
  );
};

describe("Systematic review tools", () => {
  it.effect("lets an agent log a search, screen with reasons and read the PRISMA flow", () =>
    Effect.gen(function* () {
      const root = yield* Effect.promise(() =>
        project([
          { sourceId: "source_trial", title: "Early resuscitation in septic shock" },
          { sourceId: "source_cohort", title: "Fluids in septic shock: a cohort" },
        ]),
      );
      const created = yield* provide(
        updateSystematicReviewForInvocation({
          change: { action: "create-review", title: "Septic shock" },
        }),
        root,
      );
      const reviewId = created.reviewId ?? "";
      const again = yield* provide(
        updateSystematicReviewForInvocation({
          change: { action: "create-review", title: "septic SHOCK" },
        }),
        root,
      );
      expect(again).toEqual({ outcome: "unchanged", reviewId });

      const search = {
        action: "log-search" as const,
        reviewId,
        database: "PubMed",
        query: "septic shock[mh]",
        searchedOn: "2026-11-10",
        resultCount: 3,
        sourceIds: ["source_trial", "source_cohort"],
      };
      const logged = yield* provide(updateSystematicReviewForInvocation({ change: search }), root);
      const relogged = yield* provide(
        updateSystematicReviewForInvocation({ change: { ...search, resultCount: 2 } }),
        root,
      );
      expect(relogged.searchId).toBe(logged.searchId);

      const pending = yield* provide(readSystematicReviewsForInvocation({ reviewId }), root);
      expect(pending.review?.pending.map((record) => record.sourceId)).toEqual([
        "source_trial",
        "source_cohort",
      ]);
      expect(pending.review?.searches).toEqual([
        expect.objectContaining({ database: "PubMed", resultCount: 2, recordCount: 2 }),
      ]);

      yield* provide(
        updateSystematicReviewForInvocation({
          change: {
            action: "screen",
            reviewId,
            stage: "title-abstract",
            decisions: [
              { sourceId: "source_trial", decision: "include" },
              { sourceId: "source_cohort", decision: "exclude", reason: "Wrong study design" },
            ],
          },
        }),
        root,
      );
      const read = yield* provide(
        readSystematicReviewsForInvocation({ reviewId, includeDecisions: true }),
        root,
      );
      expect(read.review?.pendingTotal).toBe(0);
      expect(read.review?.decisions).toEqual([
        { sourceId: "source_trial", decision: "include", decidedBy: "agent" },
        {
          sourceId: "source_cohort",
          decision: "exclude",
          reason: "Wrong study design",
          decidedBy: "agent",
        },
      ]);
      expect(read.review?.prisma).toMatchObject({
        identified: { databases: 2 },
        screened: 2,
        titleAbstract: { included: 1, excluded: 1 },
        retrieval: { sought: 1, pending: 1 },
      });
      expect(read.review?.prismaMermaid).toContain("Records screened (n = 2)");

      const listed = yield* provide(readSystematicReviewsForInvocation({}), root);
      expect("reviews" in listed ? listed.reviews.map((review) => review.title) : null).toEqual([
        "Septic shock",
      ]);
    }),
  );

  it.effect("reports an unknown review", () =>
    Effect.gen(function* () {
      const root = yield* Effect.promise(() => project([]));
      const result = yield* provide(
        readSystematicReviewsForInvocation({ reviewId: "review_missing" }),
        root,
      ).pipe(Effect.result);
      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure") expect(result.failure.code).toBe("not-found");
    }),
  );
});
